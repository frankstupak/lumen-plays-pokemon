// LPP Multiplayer M1 — SerialBus (wq#429)
//
// Completes serverboy's PRESENT-BUT-STUBBED serial state machine so two GB
// cores exchange real bytes instead of open-cabling to 0xFF. Research-backed:
//   research/link/R1 (DMG serial: SB=$FF01, SC=$FF02; bit0=clock src, bit7=start;
//                     MSB-first, simultaneous in/out; open cable => 0xFF),
//   research/link/R2 (the universal f(recv)->send callback model; master/passive
//                     mechanics; if passive not ready, last byte resends),
//   research/link/R3 (Gen1 is byte-level & turn-based => byte-exact lockstep is
//                     SUFFICIENT; no cycle-accurate sync).
//
// Design: the bus owns the clock domain (R1: the external side waits
// indefinitely, so there is no two-clock race). When a core sets SC bit7 as
// master (internal clock) with a partner attached, we perform ONE byte
// exchange: master's queued SB swaps with follower's queued SB, both cores
// latch the received byte into $FF01, and both get their serial IRQ + SC bit7
// auto-clear — exactly the hardware contract. We do NOT touch sub-byte timing.
//
// Interface is the industry-standard link callback (BGB / GBPlay / Arduino all
// use it), so M5's network bridge swaps the in-process peer for a TCP socket
// with zero change to core wiring:  exchange(outByte) -> inByte.

export interface SerialEndpoint {
  /** The byte currently staged to send (this core's SB at $FF01). */
  peekOut(): number;
  /**
   * True when this core's ROM has real data queued to send. Gen1 convention:
   * the serial ISR resets $FFAC to $FE ("no data") after every transfer, and the
   * main loop overwrites it with the next real byte. $FFAC != $FE therefore
   * means "main loop has staged". This is the correct readiness signal — the
   * slave's SB is refreshed only by its ISR, so watching SB writes misses it.
   */
  hasData(): boolean;
  /** The byte the ROM's main loop intends to send next ($FFAC). */
  dataByte(): number;
  /** Latch a received byte into this core's SB and raise its serial IRQ. */
  deliver(inByte: number): void;
}

/**
 * A two-port byte-swap bus. Port 0 and port 1 are the two cores. Whoever's ROM
 * sets SC=0x81 (internal clock + start) is master for that byte; the other
 * supplies its staged byte as the simultaneous reply. Matches the hardware
 * one-byte-for-one-byte swap and the R2 forgiving-timing rule: if the follower
 * has not staged a fresh byte, its last staged byte goes out again — the master
 * never blocks.
 */
export class SerialBus {
  private ports: [SerialEndpoint | null, SerialEndpoint | null] = [null, null];
  attached = false;
  /** exchange counter — test/telemetry only. */
  exchanges = 0;

  /**
   * Deferred-completion support (hardware-faithful timing).
   * On real hardware a transfer takes ~512 cycles: the master starts the clock,
   * and the follower's ROM has that window to stage its reply in SB. Delivering
   * instantly on the master's SC write hands the master a STALE follower byte
   * (always one step behind), which can stall a handshake even while the other
   * side progresses. Set deferTicks>0 and call tick() from the stepping loop to
   * complete the swap a few steps later instead.
   * deferTicks = 0 keeps the original instant behavior (M1 gate semantics).
   */
  deferTicks = 0;
  private pending: { master: 0 | 1; byte: number; left: number } | null = null;

  /**
   * Clock arbitration. On real hardware the two sides NEGOTIATE roles: exactly
   * one supplies the internal clock, the other follows. Gen1's connection loop
   * has both sides alternate SC=$80/$81 while probing, so an unarbitrated bus
   * lets BOTH act as master, which desyncs the handshake (observed: follower
   * reached the Cable Club menu while the master stalled in "Please wait").
   * With arbitration the first port to drive the clock keeps it, and the other
   * port's master-probes are demoted to follower arms — matching a real cable.
   * Set arbitrate=false to restore the free-for-all behavior.
   */
  // DEFAULT OFF: the configuration that actually established a Cable Club
  // connection in vivo (2026-08-08) was arbitration OFF + a phase skew between
  // the two cores. Arbitration forces a fixed clock owner, which HELPS when the
  // two sides are phase-identical but is not what real negotiation does. Kept
  // available for experimentation.
  arbitrate = false;
  masterPortLock: 0 | 1 | null = null;
  demotedProbes = 0;
  /** deferred transfers completed early because the master re-clocked (never dropped). */
  flushedOnRestart = 0;

  /**
   * FOLLOWER-READINESS GATE.
   * Gen1's serial ISR sets $FFAC = $FE ("no data") after every completed
   * transfer, and only the main loop replaces it with the next real byte. So if
   * the master clocks again before the follower's main loop has staged, the
   * follower legitimately transmits $FE. On real hardware both sides run at the
   * same speed and the master's inter-byte delay keeps them matched; in
   * emulation the slave does more work per byte (extra polling), so it fell
   * behind at a fixed ~3:1 ratio and the master's received block came out
   * decimated and FE-interleaved (58/415 vs the slave's clean 138/415).
   * Since $FE is EXCLUDED from the 415-byte block by the patch lists, any $FE in
   * a block stream is proof of an unready sender — never legitimate data.
   *
   * Gate: hold a deferred transfer until the follower has staged a NEW byte
   * since the last exchange. The master simply spins in its completion poll
   * (exactly what it does on hardware while a transfer is in flight), giving the
   * follower time. Bounded by readyWaitLimit so a follower that genuinely has
   * nothing to send cannot deadlock the link.
   */
  requireFollowerReady = false;
  readyWaitLimit = 64;
  private staged: [boolean, boolean] = [false, false];
  gateWaits = 0;
  gateTimeouts = 0;
  /** times a stale $FE on the wire was replaced with the ROM's real staged byte */
  freshnessOverrides = 0;

  /**
   * PEER CATCH-UP (the correct fix).
   * On hardware the follower's SB is right by construction because its main loop
   * ALWAYS runs between the master's clocks. Advancing whole cores in turn (A's
   * slice, then B's) does not guarantee that, so the master could clock again
   * before the follower's ISR had staged SB and its main loop had queued the next
   * byte — putting $FE ("no data") on the wire and permanently misaligning the
   * receiver's preamble scan.
   * Every earlier attempt tried to fix WHAT byte was on the wire (gates,
   * substitution) and regressed. This fixes WHEN the peer executes instead:
   * immediately after a delivery, run the follower core in small increments
   * until its main loop has queued the next byte ($FFAC != $FE). Its ISR stages
   * SB from the pre-delivery $FFAC during that run, so the next clock finds a
   * legitimately staged byte. Bounded so a genuinely idle peer cannot hang us.
   */
  // WINNING CONFIG (wq#436, 2026-08-08): with a peerRunner set (see
  // lockstep.runCycles) and catchUpCycles=64 / catchUpMaxSteps=256, BOTH cores
  // advanced past the block to the trade menu (LINK_STATE 50) with parties
  // intact — the first time the slave cleared "PLEASE WAIT!". This is the fix
  // that broke the structural barrier from the prior milestone.
  peerRunner: ((port: 0 | 1, cycles: number) => void) | null = null;
  catchUpCycles = 64;
  catchUpMaxSteps = 256;
  catchUpSteps = 0;
  catchUpTimeouts = 0;
  holdOnCatchupMiss = false;
  holdTicks = 0;
  holdTickLimit = 4096;
  /** total cycles the follower may run to stage one byte (per-mon work is ~thousands). */
  catchUpCycleCap = 200000;

  private catchUp(port: 0 | 1): boolean {
    if (!this.peerRunner) return true;
    const ep = this.ports[port];
    if (!ep) return true;
    // Readiness = the follower has WRITTEN A FRESH BYTE to SB since the last
    // exchange (tracked via markStaged from the hook), NOT $FFAC. The trace
    // proved $FFA9=0 throughout the block (the follower is NOT blocked in a
    // transfer wait — it is freely running Serial_ExchangeByte), and the $FE on
    // the wire is a one-instruction race: the master sampled SB in the gap
    // between the ISR staging SB and the main loop refreshing it. So we advance
    // the follower until it commits its next real SB write.
    // Bounded catch-up: advance the follower a limited number of small bursts
    // until it commits its next real SB byte. This alone got BOTH sides through
    // the block to the trade menu (parties intact). NOTE: catch-up runs the
    // follower in ISOLATION, which cannot advance it PAST a point where it needs
    // the master's next clock — so a modest budget is correct (running longer
    // just spins a follower that is waiting on us). The residual unresolved
    // races are handled by the co-scheduler (see runInterleaved), not by an
    // ever-larger isolated budget.
    this.staged[port] = false;
    for (let i = 0; i < this.catchUpMaxSteps; i++) {
      if (this.staged[port]) return true;
      this.peerRunner(port, this.catchUpCycles);
      this.catchUpSteps++;
    }
    this.catchUpTimeouts++;
    return false;
  }

  /** Called by the hook when a core's ROM writes a fresh byte to SB. */
  markStaged(port: 0 | 1) { this.staged[port] = true; }

  /** Follower readiness per the ROM's own $FFAC != $FE convention. */
  private followerReady(followerPort: 0 | 1): boolean {
    const ep = this.ports[followerPort];
    return ep ? ep.hasData() : true;
  }

  attach(port: 0 | 1, ep: SerialEndpoint) {
    this.ports[port] = ep;
    this.attached = this.ports[0] !== null && this.ports[1] !== null;
  }

  detach() {
    this.ports = [null, null];
    this.attached = false;
  }

  /**
   * Master core (the one that set internal clock + start) drives a byte. We
   * swap it with the follower's staged byte and deliver both. Returns the byte
   * the master receives (for direct callers / tests).
   */
  /** Begin a transfer that completes later via tick(). Falls back to instant. */
  beginTransfer(masterPort: 0 | 1, masterOut: number): number {
    if (this.arbitrate) {
      if (this.masterPortLock === null) this.masterPortLock = masterPort;   // first driver wins the clock
      else if (this.masterPortLock !== masterPort) { this.demotedProbes++; return 0xFF; }  // other side follows
    }
    if (this.deferTicks <= 0) return this.masterExchange(masterPort, masterOut);
    // NEVER DROP A BYTE. If the master clocks again while a deferred transfer is
    // still pending, the old behaviour SUPERSEDED it — silently losing one byte.
    // Byte counts then diverge between the two sides, and because only the master
    // drives the clock, the master can finish its block and stop clocking while
    // the follower still waits for the bytes it never received (observed: slave
    // stuck on "PLEASE WAIT!" while the master advanced to the trade menu).
    // Instead, flush the pending transfer first, then queue the new one.
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.masterExchange(p.master, p.byte);
      this.flushedOnRestart++;
    }
    this.pending = { master: masterPort, byte: masterOut, left: this.deferTicks };
    return 0xFF;
  }

  /** Advance deferred transfers; call once per emulated step from the driver. */
  tick(): void {
    if (!this.pending) return;
    if (--this.pending.left > 0) return;
    if (this.requireFollowerReady) {
      const followerPort = (this.pending.master ^ 1) as 0 | 1;
      if (!this.followerReady(followerPort)) {
        // follower has not staged since the last exchange — wait, don't deliver $FE
        this.pending.left = 1;
        if (++this.gateWaits % this.readyWaitLimit !== 0) return;
        this.gateTimeouts++;      // bounded: proceed anyway (genuine no-data)
      }
    }
    const p = this.pending;
    this.pending = null;
    this.staged = [false, false];
    // ORDER IS LOAD-BEARING: catch up BEFORE the exchange, not after.
    // The follower's serial ISR fires as part of the delivery and stages SB from
    // whatever $FFAC holds AT THAT MOMENT (then resets $FFAC=$FE). Running the
    // peer afterwards is too late — SB has already been loaded, so a $FE staged
    // pre-catch-up goes out on the NEXT clock (measured: $FE still present at
    // block offsets 3 and 8).
    // Running first establishes the invariant "$FFAC holds real data before every
    // delivery", so the ISR always stages a legitimate byte and SB is never $FE.
    // Advance the follower until it has committed its next real SB byte, THEN
    // deliver. This closes the one-instruction race the trace revealed (master
    // sampling SB in the gap before the main loop refreshes it). If the follower
    // still hasn't staged after the catch-up budget (it is mid-computation
    // between bytes), HOLD the delivery one more tick rather than sending a stale
    // byte — the caller keeps ticking, giving the follower real time to finish.
    this.catchUp((p.master ^ 1) as 0 | 1);
    this.masterExchange(p.master, p.byte);
  }

  masterExchange(masterPort: 0 | 1, masterOut: number): number {
    const followerPort = (masterPort ^ 1) as 0 | 1;
    const master = this.ports[masterPort];
    const follower = this.ports[followerPort];
    if (!master || !follower) return 0xFF;          // open cable (R1)
    // FRESHNESS OVERRIDE. The follower's SB is loaded by its PREVIOUS serial ISR
    // (from $FFAC, which the ISR then resets to $FE), so SB lags the main loop by
    // one transfer and can still read $FE even after fresh data is staged. $FE is
    // the "no data" sentinel and is EXCLUDED from the 415-byte trade block by the
    // patch lists, so it can never be legitimate block data — a stale $FE on the
    // wire corrupts the master's preamble alignment permanently (any non-$FD byte
    // ends the skip phase, so one early $FE misaligns the whole block).
    // When SB reads $FE but the main loop has real data queued, send that instead.
    // NOTE: an earlier "freshness override" substituted the follower's $FFAC
    // when SB read $FE. It removed the spurious $FE but SKIPPED a byte, because
    // $FFAC is the ROM's LOOKAHEAD for the NEXT transfer (measured: master got 2
    // name chars instead of 7). The readiness gate (requireFollowerReady, keyed
    // on the staged SB value) is the correct mechanism — wait, don't substitute.
    // Substitution was TRIED AND REJECTED (measured): replacing a stale $FE with
    // the ROM's queued $FFAC byte produced duplicated/misordered block data
    // (trade menu showed 'M / RHYDON glitch entries). $FFAC is the ROM's
    // ONE-AHEAD queue, not the byte for this transfer, so putting it on the wire
    // desynchronises the pipeline. The readiness GATE (requireFollowerReady,
    // keyed on $FFAC) is the correct mechanism: wait for the pipeline to be fed,
    // then send whatever SB legitimately holds.
    const followerOut = follower.peekOut();          // last-staged reply (R2)
    master.deliver(followerOut);
    follower.deliver(masterOut);
    this.exchanges++;
    return followerOut;
  }
}
