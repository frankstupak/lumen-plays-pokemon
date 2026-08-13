// wq#481 — M5a: ROM<->TCP serial bridge. Binds ONE emulated core's serial port
// (SB $FF01 / SC $FF02) to a BgbLink endpoint, so the peer end of the cable is
// a socket instead of an in-process SerialBus port.
//
// The SB/SC instrumentation mirrors src/link/hook.ts (the proven M1-M4
// in-process hook — see its comments for WHY each wrap exists: the external-
// clock SB-write rescue, the duplicate-IRQ suppression, staged-byte tracking).
// hook.ts itself is UNTOUCHED per the ticket constraints; the load-bearing
// difference here is the COMPLETION MODEL:
//
//   in-process: master's SC=$81 completes the swap synchronously (or on a
//               deferred bus tick) — the peer core is right there.
//   bridge:     master's SC=$81 emits a sync1 packet and the transfer stays
//               OPEN until the peer's sync2 arrives over TCP. The core is NOT
//               stepped while a remote byte is pending (stepFrame awaits), so
//               EMULATED time freezes during network latency: the ROM never
//               sees the delay, timeouts don't fire, and — because the link
//               timestamp advances with emulated cycles only (M5 spec rule 5)
//               — the remote side observes us waiting, not free-running.
//
// serverboy's serialTimer is zeroed after every master start exactly like
// hook.ts, so the emulator can never fake-complete a transfer with open-cable
// $FF while the real reply is still in flight.

import { BgbLink } from "./bgblink";

const SB = 0xFF01;
const SC = 0xFF02;

interface Core {
  memory: number[] | Uint8Array;
  memoryWriter: Array<(p: any, a: number, d: number) => void>;
  memoryHighWriter: Array<(p: any, a: number, d: number) => void>;
  interruptsRequested: number;
  checkIRQMatching?: () => void;
  CPUCyclesTotalBase: number;
}

export interface BridgeStats {
  sent: number; received: number; resends: number;
  slaveServed: number; forcedSbWrites: number; suppressedDupIrq: number;
}

export class SerialBridge {
  private stagedOut: number;
  private inflight = false;
  private waiters: (() => void)[] = [];
  /** byte log for probes/evidence: what we sent as master, what came back */
  log: { out: number; in: number }[] = [];
  private stats: BridgeStats = { sent: 0, received: 0, resends: 0, slaveServed: 0, forcedSbWrites: 0, suppressedDupIrq: 0 };
  private uninstallers: (() => void)[] = [];
  /** The bridge OWNS its link end (handlers must be ours); callers use
   *  bridge.link.listen(...) or bridge.link.connect(...). */
  readonly link: BgbLink;
  /** wq#483: set when the peer's socket goes away. A pending transfer can
   *  never complete after this, so waiters are failed immediately instead of
   *  each burning the full settled() timeout — measured in vivo: a dropper
   *  spent 15s PER FRAME after closing, wedging the abort path for minutes. */
  closed = false;
  private closeReason = "";

  constructor(private core: Core) {
    this.stagedOut = core.memory[SB] & 0xFF;
    this.link = new BgbLink({
      // Peer answered our sync1: THIS is the remote byte the core was waiting on.
      onSlaveByte: (data: number) => this.deliver(data),
      // Peer is master: serve our staged byte back, deliver theirs to the core.
      onMasterByte: (data: number) => { this.stats.slaveServed++; const out = this.stagedOut; this.deliver(data); return out; },
      onClose: (why: string) => this.onLinkClosed(why),
    });
    this.installSbWrap();
    this.installScWrap();
  }

  /** Fail fast on disconnect: no byte can arrive, so release every waiter. */
  private onLinkClosed(why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = why;
    this.inflight = false;
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w();          // resolve; callers check .closed
  }

  /** True while a master transfer awaits its remote reply. Do not step the
   *  core while this is set — that is the stall the ticket requires. */
  get pending(): boolean { return this.inflight; }
  get telemetry(): BridgeStats { return { ...this.stats }; }

  /** Advance the link timestamp by EMULATED cycles (call per executed step). */
  advance(cycles: number): void { this.link.advance(cycles); }

  /** Resolves when no remote byte is pending (immediately if none, or if the
   *  link is gone — callers check .closed to distinguish). */
  settled(timeoutMs = 5000): Promise<void> {
    if (!this.inflight || this.closed) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("bridge: remote byte still pending after " + timeoutMs + "ms")), timeoutMs);
      this.waiters.push(() => { clearTimeout(t); res(); });
    });
  }

  private deliver(inByte: number): void {
    // Same completion semantics as hook.ts endpoint.deliver: latch SB, clear
    // SC bit7 (transfer complete), raise the serial IRQ exactly once.
    this.core.memory[SB] = inByte & 0xFF;
    this.core.memory[SC] &= 0x7F;
    this.core.interruptsRequested |= 0x8;
    this.core.checkIRQMatching && this.core.checkIRQMatching();
    if (this.inflight) {
      this.stats.received++;
      if (this.log.length) this.log[this.log.length - 1].in = inByte & 0xFF;
    }
    this.inflight = false;
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w();
  }

  /** SB wrap — identical rationale to hook.ts: track the staged out-byte, and
   *  rescue SB writes that serverboy wrongly blocks while armed on an external
   *  clock with no partner pulses (Gen1's establishConnectionLoop depends on
   *  that write; see hook.ts for the full in-vivo evidence). */
  private installSbWrap(): void {
    const core = this.core;
    const origSbWriter = core.memoryWriter[SB];
    const origSbHighWriter = core.memoryHighWriter[0x1];
    const self = this;
    const sbWrapped = function (parentObj: any, address: number, data: number) {
      const r = (origSbWriter as any)(parentObj, address, data);
      const sc = parentObj.memory[SC] & 0xFF;
      const took = (parentObj.memory[SB] & 0xFF) === (data & 0xFF);
      if (!took && (sc & 0x01) === 0) {
        parentObj.memory[SB] = data & 0xFF;
        self.stagedOut = data & 0xFF;
        self.stats.forcedSbWrites++;
      } else if (took) {
        self.stagedOut = data & 0xFF;
      }
      return r;
    };
    core.memoryWriter[SB] = sbWrapped as any;
    core.memoryHighWriter[0x1] = sbWrapped as any;
    this.uninstallers.push(() => { core.memoryWriter[SB] = origSbWriter; core.memoryHighWriter[0x1] = origSbHighWriter; });
  }

  /** SC wrap — on a master start (bit7|bit0) with the link up, emit sync1 and
   *  leave the transfer OPEN for the remote sync2. serialTimer is zeroed like
   *  hook.ts so serverboy cannot fake-complete with open-cable $FF. */
  private installScWrap(): void {
    const core = this.core;
    const origWriter = core.memoryWriter[SC];
    const origHighWriter = core.memoryHighWriter[0x2];
    const self = this;
    const wrapped = function (parentObj: any, address: number, data: number) {
      const start = (data & 0x80) === 0x80;
      const internal = (data & 0x1) === 0x1;
      const r = (origWriter as any)(parentObj, address, data);
      if (start && internal && self.link.ready) {
        if (self.inflight) self.stats.resends++;   // ROM re-clocked before the reply: newest wins (peer answers every sync1)
        self.inflight = true;
        self.stats.sent++;
        self.log.push({ out: self.stagedOut & 0xFF, in: -1 });
        self.link.sendMaster(self.stagedOut & 0xFF, (data & 0x7F) | 0x80);
        // exactly ONE completion per transfer, and it comes from the network
        parentObj.serialTimer = 0;
        parentObj.serialShiftTimer = parentObj.serialShiftTimerAllocated = 0;
        self.stats.suppressedDupIrq++;
      }
      return r;
    };
    core.memoryWriter[SC] = wrapped as any;
    core.memoryHighWriter[0x2] = wrapped as any;
    this.uninstallers.push(() => { core.memoryWriter[SC] = origWriter; core.memoryHighWriter[0x2] = origHighWriter; });
  }

  uninstall(): void {
    for (const u of this.uninstallers.splice(0)) u();
  }
}
