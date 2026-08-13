// wq#481 — scripted mock peer: the SLAVE side of the Cable Club attendant
// handshake, spoken over bgblink. Response rules are derived from the captured
// in-process tape (docs/multiplayer/evidence/m5a-handshake-tape.json, two real
// cores over SerialBus, 30 exchanges to Trade Center):
//
//   0: 01->02                 connection probe: master sends USING_INTERNAL(1),
//                             the waiting side's staged byte is USING_EXTERNAL(2)
//   1-3: 00 -> 00/FE          post-connect pads
//   4-15: 60 -> 60            Serial_SyncAndExchangeNybble sync bytes
//   16-24: 00 -> 60/FE/00     sync trailer pads
//   25-29: D4/00 -> 00,FE,D0  Serial_ExchangeLinkMenuSelection: master's room
//                             choice ($D0|n), slave answers its own ($D0 =
//                             TRADE CENTER); master then warps to map $EF.
//
// The rules are phase-based rather than a verbatim index-replay because pad
// COUNTS legitimately vary with timing (even two in-process runs with
// different SKEW differ); the protocol-bearing bytes do not. Where the tape
// showed interchangeable pad replies ($00 vs $FE, both "nothing staged"
// states of the real slave), the mock uses the value the master's exchange
// loop treats as neutral, and the probe proves the choice by completing the
// room-select end-to-end.
import { BgbLink, DEFER_REPLY, sync2Packet } from "./bgblink";

export interface MockPeerOptions {
  /** our room selection byte ($D0 = TRADE CENTER, matching the tape) */
  selection?: number;
  /** inject latency: defer the reply to the Nth received sync1 (1-indexed)... */
  delayAtSent?: number;
  /** ...by this many wall milliseconds. */
  delayMs?: number;
}

export class MockPeer {
  readonly link: BgbLink;
  /** every mastered byte we saw and what we answered */
  log: { in: number; out: number; deferredMs?: number }[] = [];
  phase: "connect" | "pad" | "sync" | "select" | "done" = "connect";
  received = 0;
  selectionSent = 0;

  constructor(private opts: MockPeerOptions = {}) {
    this.link = new BgbLink({
      onMasterByte: (data: number) => this.onByte(data & 0xFF),
    });
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> { return this.link.listen(port, host); }
  close(): void { this.link.close("mock done"); }

  /** The slave state machine (see header for the tape this encodes). */
  private respond(b: number): number {
    switch (this.phase) {
      case "connect":
        if (b === 0x01) this.phase = "pad";       // probe answered; connection made
        return 0x02;                              // staged USING_EXTERNAL_CLOCK
      case "pad":
        if ((b & 0xF0) === 0x60) { this.phase = "sync"; return 0x60; }
        return 0x00;
      case "sync":
        if ((b & 0xF0) === 0x60) return 0x60;     // nybble sync echo
        if (b >= 0xD0 && b <= 0xDF) {             // master's room selection arrived
          this.phase = "select";
          return 0xD0;                            // our selection, immediately
        }
        return 0x00;
      case "select":
        // pokered main_menu.asm: selection byte = $D0 + item + (A pressed -> +4),
        // and the master's .exchangeMenuSelectionLoop spins until a RECEIVED
        // byte has (x & $F0) == $D0. The master may enter that loop well after
        // its first $D0-family send (hover heartbeats precede the A-confirmed
        // $D4), so the ONLY safe policy is: once selection talk has started,
        // answer $D0 (TRADE CENTER, item 0) to EVERYTHING, forever. The master
        // stops clocking when it warps; a premature $FE here starves its loop
        // permanently (measured: 800+ $D4 retries against a "done" mock).
        this.selectionSent++;
        return this.opts.selection ?? 0xD0;
      case "done":
        return 0xFE;                              // unreachable in the current machine; kept for future teardown logic
    }
  }

  private onByte(data: number): number {
    this.received++;
    const out = this.respond(data);
    const { delayAtSent, delayMs } = this.opts;
    if (delayAtSent && delayMs && this.received === delayAtSent) {
      this.log.push({ in: data, out, deferredMs: delayMs });
      setTimeout(() => this.link.send(sync2Packet(out)), delayMs);
      return DEFER_REPLY;
    }
    this.log.push({ in: data, out });
    return out;
  }
}
