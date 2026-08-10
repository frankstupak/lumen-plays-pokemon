// LPP Multiplayer — M3 TRADE SESSION (promoted from sandbox 2026-08-10).
//
// Drives a complete Gen1 Cable Club trade between two independent serverboy
// cores over our SerialBus: attendant dialog -> Cable Club handshake -> the
// 415-byte party-block exchange -> mon selection -> confirm -> real two-way swap.
// VERIFIED end-to-end: side A ended holding side B's exact mon identity and vice
// versa, from a cold start with nothing patched mid-flight.
//
// ------------------------------------------------------------------------
// READ THIS BEFORE "FIXING" A TRADE THAT LOOKS BROKEN
// ------------------------------------------------------------------------
// Every earlier run booted both cores from ONE snapshot, so the two sides were
// byte-identical: same wPlayerName, same wPlayerID, same party, same OT, same
// nickname (a diff over $D163-$D2F7 returned zero differing bytes). A trade
// between clones leaves RAM unchanged, so "OT is still 49699 on both sides"
// looked like failure when it was the only possible result either way. The ROM
// was completing the trade the whole time.
//
// Therefore: give the two sides DIFFERENT identities before any link traffic
// (see identity.writeIdentity) or the run proves nothing. TradeSession refuses
// to report success from a clone pair for exactly this reason.
//
// ------------------------------------------------------------------------
// ROM FACTS THIS DRIVER DEPENDS ON (pokeblue.sym + in-vivo confirmation)
// ------------------------------------------------------------------------
//   $01:5530 TradeCenter_SelectMon          $01:5679 .displayStatsTradeMenu
//   $01:56F9 .choseTrade                    $01:5849 TradeCenter_Trade
//   $00:227F Serial_SyncAndExchangeNybble   $00:22C3 Serial_ExchangeNybble
// .displayStatsTradeMenu sets wMaxMenuItem($CC28)=0, wTopMenuItemY($CC24)=$10
// and wMenuWatchedKeys($CC29)=$13 (RIGHT|B|A). The STATS|TRADE submenu is
// HORIZONTAL and DOWN is not in the watch mask -- which is why every attempt to
// walk the cursor down failed. RIGHT reaches TRADE, A selects -> .choseTrade.
// After that both sides must sit UNDISTURBED inside the nybble sync: a keypress
// knocks a waiting side out of $226E and the sync never converges.

import { Emulator, KEYS } from "../emulator";
import { Navigator } from "../nav";
import { Screen } from "../screen";
import { SerialBus } from "./serialbus";
import { installSerialHook } from "./hook";
import { runCycles, setSlice, clearSlice } from "./lockstep";
import { readLinkState } from "./linkstate";
import { Identity, MonIdentity, readIdentity, sameMon, describeMon } from "./identity";

export interface TradeSide {
  tag: string;
  emu: Emulator;
  nav: Navigator;
  scr: Screen;
}

export interface TradeOptions {
  /** doFrame divisor for the block phase. 64 ~= one 512-cycle serial window. */
  fineDiv?: number;
  /** Tile the Cable Club attendant is spoken to from (both sides walk here). */
  attendant?: { x: number; y: number };
  /** Trade-table tiles: A stands left and faces RIGHT, B stands right and faces LEFT. */
  tableA?: { x: number; y: number };
  tableB?: { x: number; y: number };
  catchUpCycles?: number;
  catchUpMaxSteps?: number;
  /** Max rendezvous attempts. The first attempt does not always converge. */
  maxRendezvous?: number;
  log?: (line: string) => void;
}

export interface TradeResult {
  swapped: boolean;
  aBefore: Identity; aAfter: Identity;
  bBefore: Identity; bAfter: Identity;
  exchanges: number;
  rendezvousAttempts: number;
  /** True when the two sides were clones, i.e. the run could not prove anything. */
  blind: boolean;
  note: string;
}

const DEFAULTS = {
  fineDiv: 64,
  attendant: { x: 11, y: 3 },
  tableA: { x: 3, y: 4 },
  tableB: { x: 6, y: 4 },
  catchUpCycles: 64,
  catchUpMaxSteps: 256,
  maxRendezvous: 6,
};

/** wLinkState ($D12B) == 50 is the trade menu; >= 2 means the session started. */
const LINK_STATE_TRADE_MENU = 50;

export class TradeSession {
  private o: Required<TradeOptions>;
  private bus = new SerialBus();
  private log: (s: string) => void;

  constructor(private a: TradeSide, private b: TradeSide, opts: TradeOptions = {}) {
    this.o = { ...DEFAULTS, log: (s: string) => console.log(s), ...opts } as Required<TradeOptions>;
    this.log = this.o.log;
  }

  private ls(s: TradeSide): number { return readLinkState(s.emu.mem()).linkState; }
  private grid(s: TradeSide): string { return (s.scr.textGrid?.() ?? []).join("\n"); }

  /** Step both cores one slice and settle the bus. Keys are per-side. */
  private step(n: number, keyA?: number, keyB?: number): void {
    for (let i = 0; i < n; i++) {
      if (keyA !== undefined) (this.a.emu as any).gb.pressKey(keyA);
      if (keyB !== undefined) (this.b.emu as any).gb.pressKey(keyB);
      (this.a.emu as any).gb.doFrame();
      (this.b.emu as any).gb.doFrame();
      this.bus.tick();
    }
  }

  /**
   * Where a side is inside TradeCenter_SelectMon, from the rendered text.
   * "TRADE" appears ONLY in the STATS|TRADE submenu; the stats page shows
   * STATUS/OK; the party list shows CANCEL. Screen text is used only for this
   * three-way discrimination -- every result is still verified from RAM.
   */
  private phase(s: TradeSide): "stats" | "submenu" | "list" | "other" {
    const g = this.grid(s);
    if (g.includes("STATUS/OK")) return "stats";
    if (g.includes("TRADE")) return "submenu";
    if (g.includes("CANCEL")) return "list";
    return "other";
  }

  /** Walk both sides to the attendant and complete the Cable Club handshake. */
  private async connect(): Promise<void> {
    await this.a.nav.goto(this.o.attendant.x, this.o.attendant.y);
    await this.b.nav.goto(this.o.attendant.x, this.o.attendant.y);
    this.step(20, KEYS.UP, KEYS.UP);
    this.step(20);
    installSerialHook(this.a.emu.core, this.bus, 0);
    installSerialHook(this.b.emu.core, this.bus, 1);
    for (let r = 0; r < 60; r++) {
      this.step(8, KEYS.A, KEYS.A);
      this.step(22);
      // $D35E is the current map id; $EF (239) is the Trade Center.
      if ((this.a.emu.mem()[0xD35E] & 0xFF) === 0xEF && (this.b.emu.mem()[0xD35E] & 0xFF) === 0xEF) break;
    }
    // SETTLE. The warp into the Trade Center is not instant: the room has to
    // finish loading and both sprites have to come to rest before the tiles in
    // front of the table respond to input. Dropping this settle (first promoted
    // build, 2026-08-10) left both sides stuck at wLinkState 1 — the A-presses
    // landed during the warp and did nothing. 180 COARSE frames, before the fine
    // slice is applied, so it costs ~3 seconds of game time and little wall time.
    this.step(180);
    this.log(`  connected: A map=${this.a.emu.mem()[0xD35E] & 0xFF} B map=${this.b.emu.mem()[0xD35E] & 0xFF} exchanges=${this.bus.exchanges}`);
  }

  /**
   * Fine-slice both cores and run the 415-byte party block. Coarse full-frame
   * stepping freezes the follower for ~70k cycles, so it cannot stage a fresh
   * reply and the master clocks hundreds of bytes against one stale value.
   */
  private async exchangeParties(): Promise<void> {
    const fine = this.o.fineDiv;
    setSlice(this.a.emu.core, fine);
    setSlice(this.b.emu.core, fine);
    this.bus.deferTicks = 1;
    const cores = [this.a.emu.core, this.b.emu.core];
    this.bus.peerRunner = (port: 0 | 1, cycles: number) => runCycles(cores[port], cycles);
    this.bus.catchUpCycles = this.o.catchUpCycles;
    this.bus.catchUpMaxSteps = this.o.catchUpMaxSteps;

    await this.a.nav.goto(this.o.tableA.x, this.o.tableA.y);
    await this.b.nav.goto(this.o.tableB.x, this.o.tableB.y);
    this.step(16 * fine, KEYS.RIGHT, KEYS.LEFT);   // face each other across the table
    this.step(16 * fine);
    for (let k = 0; k < 20; k++) {
      this.step(8, KEYS.A, KEYS.A);
      this.step(24);
      if (this.ls(this.a) >= 2 && this.ls(this.b) >= 2) break;
    }
    // "Just a moment." -> "PLEASE WAIT!" -> both sides land on the trade menu.
    for (let k = 0; k < 60; k++) {
      this.step(8 * fine, KEYS.A, KEYS.A);
      this.step(24 * fine);
      if (this.ls(this.a) === LINK_STATE_TRADE_MENU && this.ls(this.b) === LINK_STATE_TRADE_MENU) break;
    }
    this.log(`  party block done: A ls=${this.ls(this.a)} B ls=${this.ls(this.b)} exchanges=${this.bus.exchanges} cuTimeouts=${this.bus.catchUpTimeouts}`);
  }

  /**
   * Selection -> confirm. Blind A-presses do NOT work here: each side cycles
   * list -> submenu -> stats -> list independently, so the two are almost never
   * in the submenu together, and the trade needs both to confirm at once.
   * Drive each side by its own phase and park whoever arrives first.
   */
  private confirm(before: { a: MonIdentity; b: MonIdentity }): number {
    const fine = this.o.fineDiv;
    const moved = () =>
      !sameMon(readIdentity(this.a.emu.mem()).mon1, before.a) ||
      !sameMon(readIdentity(this.b.emu.mem()).mon1, before.b);
    let attempts = 0;

    for (let k = 0; k < 80 && !moved() && attempts < this.o.maxRendezvous; k++) {
      const pa = this.phase(this.a), pb = this.phase(this.b);
      if (pa === "submenu" && pb === "submenu") {
        attempts++;
        // Horizontal submenu: RIGHT selects TRADE, A dispatches to .choseTrade.
        this.step(6 * fine, KEYS.RIGHT, KEYS.RIGHT);
        this.step(8 * fine);
        this.step(8 * fine, KEYS.A, KEYS.A);
        this.log(`  rendezvous #${attempts}: both parked, confirming`);
        // QUIET PHASE. Serial_SyncAndExchangeNybble spins until $CC3D/$CC3E
        // agree on a non-zero, non-$0F selection. No input, or a waiting side
        // is knocked out of the sync loop and it never converges.
        for (let q = 0; q < 14 && !moved(); q++) {
          this.step(30 * fine);
          const d = [this.a.emu.mem()[0xCC3D] & 0xFF, this.b.emu.mem()[0xCC3D] & 0xFF];
          const e = [this.a.emu.mem()[0xCC3E] & 0xFF, this.b.emu.mem()[0xCC3E] & 0xFF];
          if (d[0] !== 0 && d[0] === e[0] && d[0] !== 0x0F && d[1] === d[0]) {
            this.log(`    nybble sync converged on $${d[0].toString(16)} -> TradeCenter_Trade`);
          }
        }
        continue;
      }
      // Back out of a stats page, select from a list, park inside a submenu.
      // "other" (blank/transition frames, and the state both sides land in after
      // a rendezvous that fails to converge) must still get an A-press: leaving
      // it with no input deadlocked the loop on the first promoted build — the
      // run sat at 80 iterations with a single rendezvous attempt.
      const keyFor = (p: string) => (p === "stats" ? KEYS.B : p === "submenu" ? undefined : KEYS.A);
      if (k % 5 === 0) this.log(`    k=${k} phases A=${pa} B=${pb} ex=${this.bus.exchanges}`);
      this.step(8 * fine, keyFor(pa), keyFor(pb));
      this.step(16 * fine);
    }
    this.step(60 * fine);   // let the trade animation finish
    return attempts;
  }

  async run(): Promise<TradeResult> {
    const aBefore = readIdentity(this.a.emu.mem());
    const bBefore = readIdentity(this.b.emu.mem());
    const blind = sameMon(aBefore.mon1, bBefore.mon1);
    this.log(`  A ${describeMon(aBefore.mon1)}`);
    this.log(`  B ${describeMon(bBefore.mon1)}`);
    if (blind) this.log("  WARNING: both sides carry an identical mon — a swap will be INVISIBLE (see identity.ts)");

    await this.connect();
    await this.exchangeParties();
    const rendezvousAttempts = this.confirm({ a: aBefore.mon1, b: bBefore.mon1 });

    const aAfter = readIdentity(this.a.emu.mem());
    const bAfter = readIdentity(this.b.emu.mem());
    clearSlice(this.a.emu.core);
    clearSlice(this.b.emu.core);

    const aGotB = sameMon(aAfter.mon1, bBefore.mon1);
    const bGotA = sameMon(bAfter.mon1, aBefore.mon1);
    const swapped = !blind && aGotB && bGotA;
    const note = blind
      ? "BLIND RUN: the two sides were clones, so this proves nothing either way"
      : swapped ? "full two-way swap"
      : aGotB || bGotA ? "HALF SWAP: only one side received its partner's mon"
      : "no swap";
    return { swapped, aBefore, aAfter, bBefore, bAfter, exchanges: this.bus.exchanges, rendezvousAttempts, blind, note };
  }
}
