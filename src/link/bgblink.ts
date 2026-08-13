// M5 (wq#433) — BGB link-over-TCP transport.
//
// Spec: https://bgb.bircd.org/bgblink.html ("bgb 1.4 link protocol"), read
// directly; the field table is reproduced in research/link/R5_bgb_link_over_tcp.md.
// This is the de-facto standard for emulated link cables over a network, so
// speaking it means a REMOTE orchestrator — ours, someone else's agent, or a
// plain BGB instance with a human at the controls — can plug into our link.
//
// R2's lock-in holds: the callback model send = f(received) is unchanged, so
// this swaps the PEER END of the bus and nothing above it.
//
// ------------------------------------------------------------------------
// TWO RULES FROM THE SPEC THAT ARE SILENT BUGS IF MISSED
// ------------------------------------------------------------------------
// 1. TCP_NODELAY must be set or the OS inserts delays.
// 2. "packet boundaries are not guaranteed: multiple commands may be in a
//    single TCP packet, and a command may be split over multiple TCP packets."
//    A reader that treats one 'data' event as one packet WILL corrupt the
//    stream under load. Everything here goes through a byte buffer that only
//    emits on 8-byte boundaries.

import { createServer, createConnection, Socket, Server } from "net";

export const CMD = {
  version: 1,
  joypad: 101,
  sync1: 104,      // send a byte as MASTER
  sync2: 105,      // send a byte as SLAVE, answering a sync1
  sync3: 106,      // b2=1 ack of an active transfer; b2=0 timestamp-only sync
  status: 108,
  wantdisconnect: 109,
} as const;

export const STATUS = { running: 0x01, paused: 0x02, supportReconnect: 0x04 } as const;

export interface BgbPacket { b1: number; b2: number; b3: number; b4: number; i1: number; }

export const PACKET_SIZE = 8;

/** i1 is little endian; timestamps are 31-bit (top bit always 0) and wrap. */
export function encodePacket(p: BgbPacket): Buffer {
  const b = Buffer.alloc(PACKET_SIZE);
  b[0] = p.b1 & 0xFF; b[1] = p.b2 & 0xFF; b[2] = p.b3 & 0xFF; b[3] = p.b4 & 0xFF;
  b.writeUInt32LE((p.i1 >>> 0) & 0x7FFFFFFF, 4);
  return b;
}

export function decodePacket(b: Buffer, off = 0): BgbPacket {
  return { b1: b[off], b2: b[off + 1], b3: b[off + 2], b4: b[off + 3], i1: b.readUInt32LE(off + 4) };
}

/**
 * Byte-oriented reassembler. Feed it whatever TCP hands over; it yields whole
 * packets only. This is the direct answer to spec rule 2 above.
 */
export class PacketReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): BgbPacket[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: BgbPacket[] = [];
    let off = 0;
    while (this.buf.length - off >= PACKET_SIZE) { out.push(decodePacket(this.buf, off)); off += PACKET_SIZE; }
    this.buf = off ? this.buf.subarray(off) : this.buf;
    return out;
  }
  get pending(): number { return this.buf.length; }
}

export const versionPacket = (): BgbPacket => ({ b1: CMD.version, b2: 1, b3: 4, b4: 0, i1: 0 });
export const statusPacket = (flags = STATUS.running): BgbPacket =>
  ({ b1: CMD.status, b2: flags, b3: 0, b4: 0, i1: 0 });
/** Master transfer. control = SC | $80; bit0=1 marks the internal clock. */
export const sync1Packet = (data: number, timestamp: number, control = 0x81): BgbPacket =>
  ({ b1: CMD.sync1, b2: data & 0xFF, b3: control & 0xFF, b4: 0, i1: timestamp });
/** Slave answer to a sync1. Control is fixed at $80 by the spec. */
export const sync2Packet = (data: number): BgbPacket =>
  ({ b1: CMD.sync2, b2: data & 0xFF, b3: 0x80, b4: 0, i1: 0 });
export const sync3Ack = (): BgbPacket => ({ b1: CMD.sync3, b2: 1, b3: 0, b4: 0, i1: 0 });
export const sync3Time = (timestamp: number): BgbPacket =>
  ({ b1: CMD.sync3, b2: 0, b3: 0, b4: 0, i1: timestamp });

export const versionMatches = (p: BgbPacket): boolean =>
  p.b1 === CMD.version && p.b2 === 1 && p.b3 === 4 && p.b4 === 0;

/** onMasterByte sentinel: "I will send the reply myself, later" (wq#481). */
export const DEFER_REPLY = -2;

export interface BgbHandlers {
  /** Peer is master: return OUR staged byte, which is sent back as sync2.
   *  Return DEFER_REPLY to take over the reply yourself (send sync2Packet /
   *  sync3Ack later via send()) — wq#481, lets a mock peer inject latency. */
  onMasterByte?: (data: number, control: number, timestamp: number) => number;
  /** Peer answered our sync1: this is the byte our core receives. */
  onSlaveByte?: (data: number) => void;
  onSync3?: (p: BgbPacket) => void;
  onStatus?: (flags: number) => void;
  onHandshake?: () => void;
  onClose?: (why: string) => void;
}

/**
 * One end of a BGB link. Either side may listen or connect — the spec says only
 * that one does each — and the roles are otherwise symmetric.
 *
 * Timestamps are in 2 MiHz clocks (2^21/s). The caller advances ours with
 * `advance(cycles)` from its stepping loop, so the value tracks EMULATED time
 * rather than wall time; that is what lets a remote side wait for us correctly
 * when we run many times faster than a real Game Boy.
 */
export class BgbLink {
  private sock: Socket | null = null;
  private server: Server | null = null;
  private reader = new PacketReader();
  private versionSeen = false;
  private handshakeDone = false;
  timestamp = 0;
  peerTimestamp = 0;
  peerStatus = 0;
  packetsIn = 0;
  packetsOut = 0;

  constructor(private h: BgbHandlers = {}) {}

  /** 31-bit, wrapping — the spec forbids the top bit. */
  advance(cycles: number): void { this.timestamp = (this.timestamp + cycles) & 0x7FFFFFFF; }

  /**
   * Resolves when the socket is BOUND, not when a peer arrives. Resolving on
   * the connection callback instead deadlocks any single-process test: the
   * client connect that would satisfy it runs after the await.
   * `peer` resolves separately for callers that need to wait for the partner.
   */
  peer: Promise<void> = Promise.resolve();
  async listen(port: number, host = "0.0.0.0"): Promise<void> {
    let onPeer: () => void = () => {};
    this.peer = new Promise<void>(res => { onPeer = res; });
    return new Promise((resolve, reject) => {
      this.server = createServer(sock => { this.attach(sock); onPeer(); });
      this.server.on("error", reject);
      this.server.listen(port, host, () => resolve());
    });
  }

  async connect(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ port, host }, () => { this.attach(sock); resolve(); });
      sock.on("error", reject);
    });
  }

  private attach(sock: Socket): void {
    this.sock = sock;
    sock.setNoDelay(true);                       // spec: required
    sock.on("data", (c: Buffer) => this.feed(Buffer.from(c)));
    sock.on("close", () => this.h.onClose?.("closed"));
    sock.on("error", e => this.h.onClose?.(String(e)));
    this.send(versionPacket());
  }

  /** Exposed for tests: drive the state machine without a socket. */
  feed(chunk: Buffer): void {
    for (const p of this.reader.push(chunk)) { this.packetsIn++; this.handle(p); }
  }

  private handle(p: BgbPacket): void {
    switch (p.b1) {
      case CMD.version:
        // Mismatched version = drop the connection, per spec.
        if (!versionMatches(p)) { this.close("version mismatch"); return; }
        this.versionSeen = true;
        this.send(statusPacket());               // status answers version...
        this.finishHandshake();
        return;
      case CMD.status:
        // ...but a status must NEVER answer a status.
        this.peerStatus = p.b2;
        this.h.onStatus?.(p.b2);
        this.finishHandshake();
        return;
      case CMD.sync1: {
        this.peerTimestamp = p.i1;
        const reply = this.h.onMasterByte?.(p.b2, p.b3, p.i1);
        if (reply === DEFER_REPLY) return;         // handler sends its own reply (wq#481)
        // No passive transfer staged -> sync3 ack rather than a bogus byte.
        this.send(reply === undefined || reply === null ? sync3Ack() : sync2Packet(reply));
        return;
      }
      case CMD.sync2:
        this.h.onSlaveByte?.(p.b2);
        return;
      case CMD.sync3:
        if (p.b2 === 0) { this.peerTimestamp = p.i1; this.send(sync3Time(this.timestamp)); }
        this.h.onSync3?.(p);
        return;
      case CMD.joypad:
      case CMD.wantdisconnect:
      default:
        return;                                   // ignored, per spec
    }
  }

  private finishHandshake(): void {
    if (this.handshakeDone || !this.versionSeen) return;
    this.handshakeDone = true;
    this.h.onHandshake?.();
  }

  get ready(): boolean { return this.handshakeDone; }

  send(p: BgbPacket): void {
    if (!this.sock) return;
    this.packetsOut++;
    this.sock.write(encodePacket(p));
  }

  /** Our core is master for this byte. */
  sendMaster(data: number, control = 0x81): void { this.send(sync1Packet(data, this.timestamp, control)); }

  close(why = "local close"): void {
    this.sock?.destroy();
    this.server?.close();
    this.sock = null; this.server = null;
    this.h.onClose?.(why);
  }
}
