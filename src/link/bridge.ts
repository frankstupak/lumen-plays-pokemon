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

// wq#511 — HANDING A BYTE TO A ROM IS NOT THE SAME AS THE ROM RECEIVING IT.
//
// Delivering a byte the instant its packet lands races Gen1's serial ISR. The
// ISR parks the received byte in a ONE-DEEP slot (hSerialReceiveData) and raises
// a flag for the main loop; a second delivery before the main loop has read that
// slot silently overwrites the first. Nothing on the wire shows it — both sides'
// transfer tapes stay byte-identical — and the damage surfaces 400 bytes later
// as a party block one byte short with its whole tail shifted.
//
// So incoming master bytes are QUEUED, and handed over at most one per executed
// step, only when the ROM can actually take it (see canTake). The peer's
// transfer is left OPEN (DEFER_REPLY) until ours has consumed the byte, which is
// what stops a free-running master from out-pacing its partner: on the wire, our
// sync2 IS the backpressure.
import { BgbLink, DEFER_REPLY, sync2Packet } from "./bgblink";

const SB = 0xFF01;
const SC = 0xFF02;
const IRQ_SERIAL = 0x8;

interface Core {
  memory: number[] | Uint8Array;
  memoryWriter: Array<(p: any, a: number, d: number) => void>;
  memoryHighWriter: Array<(p: any, a: number, d: number) => void>;
  memoryReader: Array<(p: any, a: number) => number>;
  memoryHighReader: Array<(p: any, a: number) => number>;
  interruptsRequested: number;
  checkIRQMatching?: () => void;
  CPUCyclesTotalBase: number;
}

export interface BridgeStats {
  sent: number; received: number; resends: number;
  slaveServed: number; forcedSbWrites: number; suppressedDupIrq: number;
  /** wq#511 pacing: bytes the peer clocked at us, how often the gate held one
   *  back, and how often patience ran out. queuedIn > slaveServed = a byte in
   *  hand; `gate` says which clause is holding it. */
  queuedIn: number; blocked: number; collisions: number; forced: number;
  gate: { tooSoon: number; notArmed: number; internal: number; irq: number; staged: number; taken: number };
  /** program counters where a forced hand-over landed — the ROM routine that
   *  was NOT consuming, which is the only useful thing to know about a force */
  forcedAt: number[];
}

export interface BridgeOptions {
  /** wq#511: HRAM address of the serial ISR's one-deep receive slot (pokered's
   *  hSerialReceiveData, $FFAD). The bridge watches READS of it, so "the ROM has
   *  taken the previous byte" is an observation, not a timer.
   *
   *  The flag beside it (hSerialReceivedNewData, $FFA9) looks like the natural
   *  signal and is NOT: other link routines clear it before they wait, which
   *  reopens the gate a step early and reinstates the very overwrite this
   *  exists to prevent. A read of the DATA is unambiguous.
   *
   *  Omit it and the bridge falls back to delivering as soon as the other gates
   *  allow — fine for the short handshake, lossy for a 415-byte block. */
  takenSignal?: number;
  /** DEADLOCK BREAKER, not a pacing knob: how long the gate may hold a byte, in
   *  link ticks (2 MiHz — the same units as advance()), before handing it over
   *  anyway. Default 524288 ~= 15 frames, a quarter second of emulated time.
   *
   *  A bound is needed because holding forever hangs BOTH sides: the peer is
   *  keeping its transfer open for us. Measured (wq#511): an unbounded gate
   *  deadlocked the Cable Club handshake at 17 bytes with the master parked in
   *  the ROM's serial loop.
   *
   *  But it must be FAR longer than the ROM needs to take a byte, because
   *  forcing one through is a guaranteed loss — the ISR slot still holds the
   *  last one. Measured: at 4096 ticks the escape fired 89 times in one block
   *  and the receiving party came out a byte short with its tail shifted, the
   *  wq#511 symptom exactly. The bound has to clear the longest LEGITIMATE
   *  pause a ROM takes before consuming, and the measured one is text: forces
   *  land at $390A PrintLetterDelay and $1DD7 TransferBgRows, several frames
   *  each. A quarter second is still far below the timeouts above it (15 s to
   *  settle a transfer, 25 s of link idle). */
  holdCycles?: number;
  /** Minimum emulated time between deliveries, in link ticks. Default 2048 =
   *  4096 CPU cycles = the DMG serial byte period (8192 Hz bit clock, 1 KB/s).
   *
   *  This is the constraint that keeps the two ROMs IN PHASE. A socket can hand
   *  us bytes far faster than a cable ever could; deliver at that rate and our
   *  ROM's game loop falls behind the peer's while both think they are in the
   *  same routine. Since our reply is the master's backpressure, pacing our own
   *  deliveries paces the master too — which is what a cable does. */
  byteTicks?: number;
}

export class SerialBridge {
  private stagedOut: number;
  private inflight = false;
  private waiters: (() => void)[] = [];
  /** byte log for probes/evidence: what we sent as master, what came back */
  log: { out: number; in: number }[] = [];
  private stats: BridgeStats = {
    sent: 0, received: 0, resends: 0, slaveServed: 0, forcedSbWrites: 0, suppressedDupIrq: 0,
    queuedIn: 0, blocked: 0, collisions: 0, forced: 0,
    gate: { tooSoon: 0, notArmed: 0, internal: 0, irq: 0, staged: 0, taken: 0 },
    forcedAt: [],
  };
  /** link ticks the head of the queue has been held by a closed gate */
  private held = 0;
  /** link ticks since the last byte reached the core (hardware byte period) */
  private sinceDelivery = 1 << 30;
  /** wq#511: peer-master bytes waiting for a gap our ROM can receive in. */
  private inQueue: number[] = [];
  /** has the ROM read the byte we last handed it out of the ISR's slot? */
  private taken = true;
  /** has the ROM staged a fresh out-byte since that delivery? */
  private staged = true;
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

  constructor(private core: Core, private opts: BridgeOptions = {}) {
    this.stagedOut = core.memory[SB] & 0xFF;
    this.link = new BgbLink({
      // Peer answered our sync1: THIS is the remote byte the core was waiting on.
      // Our ROM is parked in its serial wait loop, so nothing can overwrite the
      // slot before it reads — this one is safe to deliver on arrival.
      onSlaveByte: (data: number) => this.deliver(data),
      // Peer is master: queue the byte and keep ITS transfer open until our ROM
      // has actually taken ours. pump() answers, possibly several steps later.
      onMasterByte: (data: number) => {
        this.stats.queuedIn++;
        this.inQueue.push(data & 0xFF);
        this.pump();
        return DEFER_REPLY;
      },
      onClose: (why: string) => this.onLinkClosed(why),
    });
    this.installSbWrap();
    this.installScWrap();
    if (this.opts.takenSignal !== undefined) this.installTakenWrap(this.opts.takenSignal);
  }

  /** Fail fast on disconnect: no byte can arrive, so release every waiter. */
  private onLinkClosed(why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = why;
    this.inflight = false;
    this.inQueue.length = 0;          // nothing can be answered now
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w();          // resolve; callers check .closed
  }

  /** True while a master transfer awaits its remote reply. Do not step the
   *  core while this is set — that is the stall the ticket requires. */
  get pending(): boolean { return this.inflight; }
  /** Why the link closed ("" while open). */
  get closedWhy(): string { return this.closeReason; }
  get telemetry(): BridgeStats {
    return { ...this.stats, gate: { ...this.stats.gate }, forcedAt: this.stats.forcedAt.slice() };
  }

  /** Advance the link timestamp by EMULATED cycles (call per executed step).
   *  Doubles as the pacing tick: one queued byte may cross here, which is what
   *  makes "at most one per step" true for every existing caller. */
  advance(cycles: number): void {
    this.link.advance(cycles);
    this.sinceDelivery += cycles;
    this.pump(cycles);
  }

  /** Peer bytes still waiting for a gap. Non-zero for long is a jammed gate. */
  get queued(): number { return this.inQueue.length; }

  /** Resolves when no remote byte is pending (immediately if none, or if the
   *  link is gone — callers check .closed to distinguish). */
  settled(timeoutMs = 5000): Promise<void> {
    if (!this.inflight || this.closed) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("bridge: remote byte still pending after " + timeoutMs + "ms")), timeoutMs);
      this.waiters.push(() => { clearTimeout(t); res(); });
    });
  }

  /** wq#511: can the ROM take a byte RIGHT NOW without losing one?
   *  Every clause is an observation of the core, never a delay. */
  private canTake(): boolean {
    const g = this.stats.gate;
    if (this.sinceDelivery < (this.opts.byteTicks ?? 2048)) { g.tooSoon++; return false; }
    const sc = this.core.memory[SC] & 0xFF;
    if ((sc & 0x80) === 0) { g.notArmed++; return false; }        // no transfer armed
    if ((sc & 0x01) !== 0) { g.internal++; return false; }        // armed on the INTERNAL clock: we are master here, not a listener
    if ((this.core.interruptsRequested & IRQ_SERIAL) !== 0) { g.irq++; return false; }   // last serial IRQ not serviced yet
    if (!this.staged) { g.staged++; return false; }               // no fresh out-byte staged for this transfer
    if (!this.taken) { g.taken++; return false; }                 // ISR slot still holds the previous byte
    return true;
  }

  /**
   * Hand at most ONE queued peer byte to the core, then close the peer's
   * transfer with our staged byte. Call once per executed step; returns whether
   * a byte moved. Safe to call with an empty queue or a closed link.
   */
  pump(cycles = 0): boolean {
    if (this.closed || !this.inQueue.length) return false;
    // COLLISION: both ROMs armed the internal clock at once. Gen1's connection
    // loop does exactly that until one side switches to the external clock, and
    // our transfer will never complete on its own — the peer is not listening,
    // it is clocking. Its byte IS our completion; deliver it or the two sides
    // deadlock, each holding the other's transfer open.
    if (this.inflight) { this.stats.collisions++; this.handOver(); return true; }
    if (!this.canTake()) {
      this.stats.blocked++;
      this.held += cycles;
      if (this.held < (this.opts.holdCycles ?? 524288)) return false;
      this.stats.forced++;                    // patience spent; hardware would have shifted it in
      if (this.stats.forcedAt.length < 8) this.stats.forcedAt.push((this.core as any).programCounter | 0);
    }
    this.handOver();
    return true;
  }

  private handOver(): void {
    this.held = 0;
    this.sinceDelivery = 0;
    const inByte = this.inQueue.shift()!;
    const out = this.stagedOut & 0xFF;
    this.stats.slaveServed++;
    this.log.push({ out, in: inByte });
    this.deliver(inByte);
    this.link.send(sync2Packet(out));      // the deferred reply: backpressure released
  }

  private deliver(inByte: number): void {
    // Same completion semantics as hook.ts endpoint.deliver: latch SB, clear
    // SC bit7 (transfer complete), raise the serial IRQ exactly once.
    // wq#511: this byte now occupies the ISR's one-deep slot, and the ROM owes
    // us both a read of it and a fresh staged out-byte before we may send another.
    this.taken = this.opts.takenSignal === undefined;
    this.staged = false;
    this.core.memory[SB] = inByte & 0xFF;
    this.core.memory[SC] &= 0x7F;
    this.core.interruptsRequested |= IRQ_SERIAL;
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
        self.staged = true;
      } else if (took) {
        self.stagedOut = data & 0xFF;
        self.staged = true;
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

  /** wq#511: watch READS of the ISR's receive slot. serverboy dispatches
   *  `ldh a,[$xx]` through memoryHighReader[low] and `ld a,[$FFxx]` through
   *  memoryReader[addr]; rgbasm picks either, so both are wrapped. */
  private installTakenWrap(addr: number): void {
    if (addr < 0xFF00 || addr > 0xFFFF)
      throw new Error(`bridge: takenSignal $${addr.toString(16)} is not an HRAM/IO address`);
    const core = this.core as any;
    const self = this;
    const watch = (orig: (p: any, a: number) => number) =>
      function (parentObj: any, address: number) { self.taken = true; return orig(parentObj, address); };
    const lo = addr & 0xFF;
    const origHigh = core.memoryHighReader?.[lo];
    const origLow = core.memoryReader?.[addr];
    if (!origHigh || !origLow)
      throw new Error("bridge: serverboy internals changed — memoryReader/memoryHighReader unavailable");
    core.memoryHighReader[lo] = watch(origHigh);
    core.memoryReader[addr] = watch(origLow);
    this.uninstallers.push(() => { core.memoryHighReader[lo] = origHigh; core.memoryReader[addr] = origLow; });
  }

  uninstall(): void {
    for (const u of this.uninstallers.splice(0)) u();
  }
}
