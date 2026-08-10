// LPP Multiplayer M1 — serial hook installer (wq#429)
//
// Installs a SerialEndpoint onto a live serverboy GameBoyCore instance WITHOUT
// editing node_modules: we wrap the SC ($FF02) write handler at runtime. Safe
// against serverboy updates (we patch the instance, not the source).
//
// serverboy internals verified in-tree 2026-08-08 (research/link/R1,R2):
//  - SC write handler: memoryWriter[0xFF02] / memoryHighWriter[0x2]. On
//    internal-clock+start (data & 0x1) it stages memory[0xFF02]=data&0x7F (bit7
//    already cleared here, not at end) and sets serialTimer=4096 (IRQ counter) +
//    serialShiftTimer=512. The serialTimer expiry (run loop L1595) raises the
//    serial IRQ (interruptsRequested |= 0x8). External-clock branch zeros the
//    timers ("as if nothing connected").
//  - The bit-shift stub (L1603/L1773) fills SB with open-cable bits; irrelevant
//    once we deliver the real received byte directly into $FF01.
//
// Our wrap: on an internal-clock start with a partner attached, perform the bus
// byte exchange NOW (staging our SB out, latching the peer's byte into $FF01),
// then call the original handler so the IRQ timer still arms and fires normally.
// The follower side's start (external clock) is a no-op wire-wise — it simply
// stages its next SB; the master's exchange reads that staged byte.

import { SerialBus, SerialEndpoint } from "./serialbus";

const SB = 0xFF01;
const SC = 0xFF02;

interface Core {
  memory: number[] | Uint8Array;
  memoryWriter: Array<(p: any, a: number, d: number) => void>;
  memoryHighWriter: Array<(p: any, a: number, d: number) => void>;
  interruptsRequested: number;
  checkIRQMatching?: () => void;
}

/**
 * Attach `core` to `bus` at `port`. Returns the SerialEndpoint (for tests) and
 * an uninstall() that restores the original SC handler.
 */
export function installSerialHook(core: Core, bus: SerialBus, port: 0 | 1) {
  const origWriter = core.memoryWriter[SC];
  const origHighWriter = core.memoryHighWriter[0x2];
  const origSbWriter = core.memoryWriter[SB];
  const origSbHighWriter = core.memoryHighWriter[0x1];

  // The staged out-byte = "the next byte that will go out" (gg8/Pan Docs): it is
  // latched when the ROM WRITES SB, and it PERSISTS across a received byte. This
  // is the load-bearing distinction: deliver() overwrites SB with the incoming
  // byte, but stagedOut keeps the last ROM-written value, so if the follower
  // never loads a fresh SB, "the last one goes out again" (R2 forgiving-timing).
  // We track it by wrapping the SB writer.
  let stagedOut = core.memory[SB] & 0xFF;
  let suppressedDupIrq = 0;   // telemetry: duplicate serial IRQs prevented
  let forcedSbWrites = 0;   // telemetry: SB writes rescued from serverboy's over-broad guard
  const sbWrapped = function (parentObj: any, address: number, data: number) {
    const r = (origSbWriter as any)(parentObj, address, data);
    // serverboy blocks ALL SB writes while SC bit7 is set. That guard is wrong
    // for an EXTERNAL-clock arm: with SC=$80 and no partner pulses, no transfer
    // is actually in progress, so hardware accepts the SB write. Because
    // serverboy never clears bit7 in that state (no clock ever arrives), the
    // block becomes permanent and silently DISCARDS the ROM's next staged byte.
    //
    // Gen1's establishConnectionLoop depends on exactly that write:
    //     SB=2 ; SC=$80   (stage "waiting" byte, arm as follower)
    //     SB=1 ; SC=$81   (stage "probing" byte, drive clock)
    // With the write dropped, BOTH sides send 2, BOTH receive 2, and both set
    // $FFAA=2 = MASTER -> no slave -> the link-menu nybble exchange can never
    // converge. (Observed in vivo 2026-08-08: role=2 on both cores.)
    //
    // Fix: when the original write was blocked AND the core is in external-clock
    // mode (SC bit0 == 0), apply the write ourselves and latch it.
    const sc = parentObj.memory[SC] & 0xFF;
    const took = (parentObj.memory[SB] & 0xFF) === (data & 0xFF);
    if (!took && (sc & 0x01) === 0) {
      parentObj.memory[SB] = data & 0xFF;      // external-clock idle: hardware accepts it
      stagedOut = data & 0xFF;
      forcedSbWrites++;
      if (data !== 0xFE) bus.markStaged(port);   // $FE = ISR "no data" default, not real staging
    } else if (took) {
      stagedOut = data & 0xFF;
      if (data !== 0xFE) bus.markStaged(port);
    }
    return r;
  };
  core.memoryWriter[SB] = sbWrapped as any;
  core.memoryHighWriter[0x1] = sbWrapped as any;

  const FFAC = 0xFFAC;   // Gen1 "next byte to send"; ISR resets it to $FE after each transfer
  const endpoint: SerialEndpoint = {
    peekOut: () => stagedOut & 0xFF,
    // Readiness = this core's serial ISR has loaded a REAL byte into SB.
    // NOT $FFAC: that is the ROM's LOOKAHEAD (the byte queued for the transfer
    // AFTER the current one). Sending $FFAC in place of SB removes the spurious
    // $FE but SKIPS the current byte — measured: master received 2 name chars
    // instead of 7. So we gate on the staged SB value and let the follower's ISR
    // catch up instead of substituting.
    // READINESS = SB already holds a real byte, OR the main loop has queued one.
    // Gen1 pipelines by one transfer: the main loop writes the next byte to
    // $FFAC; the serial ISR moves $FFAC into SB and resets $FFAC=$FE at the
    // completion of the current transfer. Consequences:
    //  - Gating on SB alone is CIRCULAR: SB only refreshes when a transfer
    //    completes, which is the thing being gated (measured: 60k waits).
    //  - Gating on $FFAC alone WRONGLY BLOCKS a ready follower: $FFAC==$FE is
    //    also the normal waiting state AFTER the ISR has loaded a real SB, so the
    //    gate times out and injects a stale $FE, permanently misaligning the
    //    master's preamble scan (any non-$FD byte ends the skip phase).
    // The union is correct: the follower can send iff SB is real or $FFAC is.
    hasData: () => (core.memory[FFAC] & 0xFF) !== 0xFE,
    dataByte: () => core.memory[FFAC] & 0xFF,
    deliver: (inByte: number) => {
      // Latch received byte into SB, exactly like a completed hardware transfer.
      core.memory[SB] = inByte & 0xFF;
      // Transfer complete: auto-clear SC bit7 on THIS side too (hardware clears
      // it on both master and follower at end of transfer). Without this a
      // follower stays "armed", its SB writes stay blocked, and it re-sends its
      // first byte forever.
      core.memory[SC] &= 0x7F;
      // Raise the serial interrupt so the ROM's handler runs. serverboy's timer
      // path also raises it; setting it here makes delivery immediate and
      // idempotent (|=), which the ROM tolerates (it checks + clears IF).
      core.interruptsRequested |= 0x8;
      core.checkIRQMatching && core.checkIRQMatching();
    },
  };
  bus.attach(port, endpoint);

  const wrapped = function (parentObj: any, address: number, data: number) {
    const start = (data & 0x80) === 0x80;
    const internal = (data & 0x1) === 0x1;
    if (start && internal && bus.attached) {
      // We are master for this byte: swap our staged out with the follower's
      // staged out; both sides latch the received byte + raise the serial IRQ.
      bus.beginTransfer(port, stagedOut);
      // Fall through to the original handler so the IRQ timer arms and bit7
      // clears as the ROM expects. deliver() already wrote the received byte to
      // SB; the original handler does not overwrite SB.
    }
    const r = (origWriter as any)(parentObj, address, data);
    if (start && internal && bus.attached) {
      // DUPLICATE-IRQ SUPPRESSION. Our deliver() already completed the transfer
      // and raised the serial IRQ. origWriter (serverboy's DMG SC handler) then
      // arms serialTimer=4096, whose expiry raises the serial IRQ a SECOND time
      // for this same byte. The master would run its serial ISR twice per
      // transfer while the follower runs it once — the ISR stages the next byte
      // from $FFAC and advances the protocol, so the master drifts ahead by 2x
      // and the two sides end up in different protocol phases (observed: master
      // in Serial_ExchangeLinkMenuSelection while the slave was still in
      // Serial_SyncAndExchangeNybble). Zero the timers so exactly ONE completion
      // is signalled per transfer.
      parentObj.serialTimer = 0;
      parentObj.serialShiftTimer = parentObj.serialShiftTimerAllocated = 0;
      suppressedDupIrq++;
    }
    return r;
  };

  core.memoryWriter[SC] = wrapped as any;
  core.memoryHighWriter[0x2] = wrapped as any;

  return {
    endpoint,
    get forcedSbWrites() { return forcedSbWrites; },
    get suppressedDupIrq() { return suppressedDupIrq; },
    uninstall() {
      core.memoryWriter[SC] = origWriter;
      core.memoryHighWriter[0x2] = origHighWriter;
      core.memoryWriter[SB] = origSbWriter;
      core.memoryHighWriter[0x1] = origSbHighWriter;
      bus.detach();
    },
  };
}
