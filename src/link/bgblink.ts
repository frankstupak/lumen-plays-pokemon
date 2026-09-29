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

/**
 * wq#484 — one master transfer's WALL-CLOCK round trip: sync1 written to the
 * socket, answer (sync2 or a sync3 ack) parsed out of the stream.
 *
 * This has to be wall clock, and the reason is the whole point of M5a: the
 * protocol's own `i1` timestamps count EMULATED cycles and deliberately do NOT
 * advance while a byte is pending (spec rule 5), which is exactly what lets a
 * remote peer wait for us correctly. A link running across a continent and one
 * running on loopback therefore produce the SAME timestamp deltas. `linkTs` is
 * recorded beside each sample anyway, so a distribution can be read against
 * emulated time as well — but the network only shows up in `rttUs`.
 */
export interface LatencySample {
  seq: number;
  rttUs: number;
  kind: "sync2" | "sync3";
  /** our link timestamp when the sync1 went out (2 MiHz ticks, emulated). */
  linkTs: number;
  /** the peer's link timestamp as of its answer. */
  peerTs: number;
}

/**
 * Slave side: sync1 arrived -> our answer written. This is OUR OWN service
 * cost, not the network's, and it is kept in a separate series precisely so a
 * slow core can never be read as a slow link.
 *
 * `deferred` distinguishes the two shapes, because they measure different
 * things and averaging them together is meaningless. An inline reply is pure
 * handler cost (microseconds). A DEFERRED one (wq#481/wq#511: hold the peer's
 * transfer open until our core has actually consumed the byte) includes every
 * step the ROM needed to take it — which is exactly how long WE made the remote
 * master wait, and therefore the number to look at when a peer complains about
 * us rather than about the network.
 */
export interface ServeSample { seq: number; serveUs: number; deferred: boolean; }

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

  // wq#484 latency instrumentation. Bounded on purpose: a long session clocks
  // hundreds of transfers per party block and this must never be the reason a
  // side runs out of memory. Oldest samples are dropped, not newest — a tail
  // stall is the interesting event.
  latency: LatencySample[] = [];
  serve: ServeSample[] = [];
  latencyCap = 200000;
  private sync1At: bigint | null = null;
  private sync1Seq = 0;
  private sync1Ts = 0;
  private servedAt: bigint | null = null;

  constructor(private h: BgbHandlers = {}) {}

  private pushCapped<T>(arr: T[], s: T): void {
    arr.push(s);
    if (arr.length > this.latencyCap) arr.shift();
  }

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
        const t0 = process.hrtime.bigint();
        const reply = this.h.onMasterByte?.(p.b2, p.b3, p.i1);
        if (reply === DEFER_REPLY) {
          // The handler owns the reply (wq#481), so the clock keeps running until
          // it writes one — see servedAt in send(). This is the case that matters:
          // SerialBridge defers every passive transfer (wq#511 pacing rule 3,
          // hold the peer's transfer open until our core consumed the byte), so a
          // slave that only sampled inline replies would produce an empty series
          // and a cross-node evidence pack with nothing in it from that side.
          this.servedAt = t0;
          return;
        }
        // No passive transfer staged -> sync3 ack rather than a bogus byte.
        this.send(reply === undefined || reply === null ? sync3Ack() : sync2Packet(reply));
        this.pushCapped(this.serve, {
          seq: this.serve.length,
          serveUs: Number(process.hrtime.bigint() - t0) / 1000,
          deferred: false,
        });
        return;
      }
      case CMD.sync2:
        this.sampleRtt("sync2", p.i1);
        this.h.onSlaveByte?.(p.b2);
        return;
      case CMD.sync3:
        // b2=1 is the ack of an active transfer, i.e. an ANSWER to our sync1 and
        // a completed round trip. b2=0 is an unsolicited timestamp-only sync and
        // closes nothing, so counting it would fabricate short samples.
        if (p.b2 === 1) this.sampleRtt("sync3", p.i1);
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

  /** Close the open master transfer's round trip, if there is one. An answer
   *  with no outstanding sync1 is ignored rather than timed against a stale
   *  start — a fabricated sample is worse than a missing one. */
  private sampleRtt(kind: "sync2" | "sync3", peerTs: number): void {
    if (this.sync1At === null) return;
    this.pushCapped(this.latency, {
      seq: this.sync1Seq,
      rttUs: Number(process.hrtime.bigint() - this.sync1At) / 1000,
      kind, linkTs: this.sync1Ts, peerTs,
    });
    this.sync1At = null;
  }

  send(p: BgbPacket): void {
    if (!this.sock) return;
    this.packetsOut++;
    // Stamp the start AFTER the write, so the sample measures the peer's turn
    // around and the wire, not our own serialisation.
    this.sock.write(encodePacket(p));
    if (p.b1 === CMD.sync1) {
      this.sync1At = process.hrtime.bigint();
      this.sync1Seq++;
      this.sync1Ts = p.i1;
      return;
    }
    // Close a DEFERRED passive transfer. Only a real answer counts: a sync2, or a
    // sync3 ACK (b2=1). A sync3 with b2=0 is the timestamp-only sync we send in
    // reply to the peer's own, unrelated to any transfer, and closing on it would
    // report a serve time for a transfer still open.
    if (this.servedAt !== null && (p.b1 === CMD.sync2 || (p.b1 === CMD.sync3 && p.b2 === 1))) {
      this.pushCapped(this.serve, {
        seq: this.serve.length,
        serveUs: Number(process.hrtime.bigint() - this.servedAt) / 1000,
        deferred: true,
      });
      this.servedAt = null;
    }
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
