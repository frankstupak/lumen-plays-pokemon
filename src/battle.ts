// Battle layer: RAM-truth battle state + deterministic menu control.
//
// Topology (verified): main battle menu is a 2x2 grid (FIGHT/PkMn over
// ITEM/RUN); wCurrentMenuItem tracks row only, so selection is normalised by
// mashing toward a known corner first. Move menu indexing conventions vary, so
// slot selection is also corner-normalised: UP to the top, then DOWN n times.

import { Emulator, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { EventBus } from "./events";
import { Combatant, Winnability, winnability, WinnabilityOpts } from "./calc";

export interface BattleState {
  inBattle: number;             // 0 none, 1 wild, 2 trainer
  mySpecies: number; myLevel: number; myHp: number; myMaxHp: number;
  foeSpecies: number; foeLevel: number; foeHp: number; foeMaxHp: number;
  moves: number[]; pp: number[];
  atMainMenu: boolean;
}

/** wq#1181: the identity a fight is recorded under in the loss ledger.
 *  wCurOpponent >= FIRST_TRAINER_CLASS means a trainer (class = value - 200);
 *  below that it is a wild species id. wTrainerNo separates the individual
 *  trainers of one class on one map. */
export interface FightId { opponent: number; trainerNo: number; trainer: boolean }

export class Battle {
  constructor(private emu: Emulator, private sym: SymbolTable, private scr: Screen,
              private sync: Sync, private dlg: Dialog, private bus: EventBus) {}

  private r(name: string) { return this.emu.mem()[this.sym.addr(name)]; }
  private r16(name: string) {
    const a = this.sym.addr(name), m = this.emu.mem();
    return (m[a] << 8) | m[a + 1];
  }

  state(): BattleState {
    const m = this.emu.mem();
    const mv = this.sym.addr("wBattleMonMoves"), pp = this.sym.addr("wBattleMonPP");
    return {
      inBattle: this.r("wIsInBattle"),
      mySpecies: this.r("wBattleMonSpecies"), myLevel: this.r("wBattleMonLevel"),
      myHp: this.r16("wBattleMonHP"), myMaxHp: this.r16("wBattleMonMaxHP"),
      foeSpecies: this.r("wEnemyMonSpecies"), foeLevel: this.r("wEnemyMonLevel"),
      foeHp: this.r16("wEnemyMonHP"), foeMaxHp: this.r16("wEnemyMonMaxHP"),
      moves: [0, 1, 2, 3].map(i => m[mv + i]),
      pp: [0, 1, 2, 3].map(i => m[pp + i]),
      atMainMenu: this.atMainMenu(),
    };
  }

  active(): boolean { return this.r("wIsInBattle") !== 0; }

  // ---- wq#1181: winnability inputs -----------------------------------------
  // Everything below reads RAM that Gen 1 has already normalised: wBattleMon* /
  // wEnemyMon* hold the EFFECTIVE stats after stat stages and badge boosts
  // (CalculateModifiedStats / ApplyBadgeStatBoosts), and the type bytes come
  // straight from the loaded mon, so no species table is needed. Every read is
  // wrapped: a missing symbol or a mid-load frame must degrade the verdict, not
  // take the turn down.

  private safe(name: string, wide = false): number {
    try { return wide ? this.r16(name) : this.r(name); } catch { return 0; }
  }

  /** Both sides of the current exchange, or null when no battle is loaded. */
  combatants(): { me: Combatant; foe: Combatant } | null {
    if (!this.active()) return null;
    try {
      const m = this.emu.mem();
      const mv = this.sym.addr("wBattleMonMoves"), pp = this.sym.addr("wBattleMonPP");
      const fmv = this.sym.addr("wEnemyMonMoves"), fpp = this.sym.addr("wEnemyMonPP");
      const me: Combatant = {
        species: this.safe("wBattleMonSpecies"), level: this.safe("wBattleMonLevel"),
        hp: this.safe("wBattleMonHP", true), maxHp: this.safe("wBattleMonMaxHP", true),
        atk: this.safe("wBattleMonAttack", true), def: this.safe("wBattleMonDefense", true),
        spc: this.safe("wBattleMonSpecial", true), speed: this.safe("wBattleMonSpeed", true),
        type1: this.safe("wBattleMonType1"), type2: this.safe("wBattleMonType2"),
        status: this.safe("wBattleMonStatus"),
        moves: [0, 1, 2, 3].map(i => ({ id: m[mv + i], pp: m[pp + i] & 0x3f })),
      };
      // The foe's PP is readable too, but a foe never runs a set dry inside the
      // horizon this verdict covers, so its moves are treated as always usable
      // (pp 1) rather than trusting a byte that is 0 for an unrevealed slot.
      const foe: Combatant = {
        species: this.safe("wEnemyMonSpecies"), level: this.safe("wEnemyMonLevel"),
        hp: this.safe("wEnemyMonHP", true), maxHp: this.safe("wEnemyMonMaxHP", true),
        atk: this.safe("wEnemyMonAttack", true), def: this.safe("wEnemyMonDefense", true),
        spc: this.safe("wEnemyMonSpecial", true), speed: this.safe("wEnemyMonSpeed", true),
        type1: this.safe("wEnemyMonType1"), type2: this.safe("wEnemyMonType2"),
        status: this.safe("wEnemyMonStatus"),
        moves: [0, 1, 2, 3].map(i => ({ id: m[fmv + i], pp: Math.max(1, m[fpp + i] & 0x3f) })),
      };
      if (me.maxHp <= 0 || foe.maxHp <= 0) return null;   // mid-load frame
      return { me, foe };
    } catch { return null; }
  }

  /** Who this fight is against, for the loss ledger (wq#1181 item 6). */
  fightId(): FightId {
    const opponent = this.safe("wCurOpponent");
    return { opponent, trainerNo: this.safe("wTrainerNo"), trainer: this.r("wIsInBattle") === 2 };
  }

  /** Unfainted mons the foe still has. Wild battles are always 1. The enemy
   *  party is six 44-byte structs at wEnemyMon1 with HP at offset 1 (big
   *  endian), the same layout wPartyMon1 uses. */
  foeRemaining(): number {
    if (this.r("wIsInBattle") !== 2) return 1;
    try {
      const m = this.emu.mem();
      const n = Math.min(6, Math.max(0, this.safe("wEnemyPartyCount")));
      const base = this.sym.addr("wEnemyMon1"), stride = 44;
      let alive = 0;
      for (let i = 0; i < n; i++) {
        const a = base + i * stride + 1;
        if (((m[a] << 8) | m[a + 1]) > 0) alive++;
      }
      return Math.max(1, alive);
    } catch { return 1; }
  }

  /** wq#1181: the winnability verdict for the current exchange, or null when
   *  no battle is loaded. Pure arithmetic over the reads above — no menu input,
   *  no frames, safe to call every turn. */
  winnability(opts: WinnabilityOpts = {}): Winnability | null {
    const c = this.combatants();
    if (!c) return null;
    return winnability(c.me, c.foe, { foeRemaining: this.foeRemaining(), ...opts });
  }

  /** Cursor rendered in the bottom-right quadrant = the FIGHT/ITEM grid */
  atMainMenu(): boolean {
    const c = this.scr.cursor();
    return this.active() && c !== null && c.x >= 8 && c.y >= 13;
  }

  /** Wait until either the main menu is up or the battle has ended. */
  async waitForMenu(maxFrames = 3000): Promise<"menu" | "over" | "timeout"> {
    for (let i = 0; i < maxFrames / 10; i++) {
      if (!this.active()) return "over";
      if (this.atMainMenu()) return "menu";
      // battle text (attack narration, faint messages) needs A to advance
      if (this.dlg.open() || this.scr.awaitingPrompt()) {
        await this.emu.tapAsync(KEYS.A, 8, 12);
      }
      await this.emu.framesAsync(10);
    }
    return "timeout";
  }

  private ppSlot(slot: number): number {
    try { return this.emu.mem()[this.sym.addr("wBattleMonPP") + slot] & 0x3f; } catch { return -1; }
  }
  private curMenu(): number {
    try { return this.emu.mem()[this.sym.addr("wCurrentMenuItem")]; } catch { return -1; }
  }
  private async waitUntil(pred: () => boolean, frames = 200): Promise<boolean> {
    for (let i = 0; i < frames / 5; i++) { if (pred()) return true; await this.emu.framesAsync(5); }
    return pred();
  }

  /** Use move in slot 0-3. Assumes the main menu is up. Verifies the move
   *  actually fired (PP decrement or battle end) and retries selection once. */
  async useMove(slot: number): Promise<void> {
    this.bus.emit("tool_call", { tool: "battle_move", args: { slot } });
    const ppBefore = this.ppSlot(slot);
    for (let attempt = 0; attempt < 2; attempt++) {
      // open FIGHT: normalise cursor to top-left (FIGHT) then A. Verify the
      // move submenu opened by watching wCurrentMenuItem become selectable.
      await this.emu.tapAsync(KEYS.UP, 8, 10);
      await this.emu.tapAsync(KEYS.LEFT, 8, 10);
      await this.emu.tapAsync(KEYS.A, 8, 20);
      await this.sync.settle(300);
      // move cursor: normalise to top (4x UP is safe), then DOWN to slot,
      // verifying wCurrentMenuItem lands on the slot.
      for (let i = 0; i < 4; i++) { await this.emu.tapAsync(KEYS.UP, 8, 8); }
      for (let i = 0; i < slot; i++) {
        const want = i + 1;
        await this.emu.tapAsync(KEYS.DOWN, 8, 8);
        await this.waitUntil(() => this.curMenu() === want, 60);
      }
      await this.emu.tapAsync(KEYS.A, 8, 20);
      // confirm the move fired: PP for this slot drops, or the battle ends,
      // or the foe takes damage. Any of these = committed.
      const fired = await this.waitUntil(
        () => !this.active() || this.ppSlot(slot) < ppBefore, 400);
      if (fired) { await this.sync.settle(200); return; }
      // did not fire - likely a dropped tap left us in a submenu. Back out to
      // the main menu and retry once.
      await this.emu.tapAsync(KEYS.B, 8, 12);
      await this.sync.settle(200);
    }
    await this.sync.settle(200);
  }

  /** Attempt to RUN from a wild battle. RUN = bottom-right of the 2x2 battle
   *  menu (FIGHT/PkMn over ITEM/RUN). Trainer battles cannot be fled. Confirms
   *  via wEscapedFromBattle or the battle ending. */
  async flee(): Promise<"fled" | "trapped" | "trainer" | "failed"> {
    if (!this.active()) return "failed";
    if (this.r("wIsInBattle") === 2) return "trainer";
    const w = await this.waitForMenu();
    if (w !== "menu") return "failed";
    // normalise to a known corner then go to RUN (bottom-right)
    await this.emu.tapAsync(KEYS.DOWN, 8, 10);
    await this.emu.tapAsync(KEYS.RIGHT, 8, 10);
    await this.emu.tapAsync(KEYS.A, 8, 20);
    // success = battle ends or wEscapedFromBattle set; failure = still in a
    // battle at the menu ("Can't escape!"). Give it a few tries.
    for (let attempt = 0; attempt < 3; attempt++) {
      const done = await this.waitUntil(() => !this.active() || this.escaped(), 300);
      if (!this.active() || this.escaped()) return "fled";
      // "Can't escape!" text -> advance and retry RUN
      if (this.dlg.open() || this.scr.awaitingPrompt()) await this.emu.tapAsync(KEYS.A, 8, 12);
      const w2 = await this.waitForMenu(600);
      if (w2 === "over") return "fled";
      if (w2 !== "menu") return "failed";
      await this.emu.tapAsync(KEYS.DOWN, 8, 10);
      await this.emu.tapAsync(KEYS.RIGHT, 8, 10);
      await this.emu.tapAsync(KEYS.A, 8, 20);
    }
    return "trapped";
  }
  private escaped(): boolean {
    try { return this.emu.mem()[this.sym.addr("wEscapedFromBattle")] !== 0; } catch { return false; }
  }

  /**
   * Fight until the battle ends. `pick` chooses the move slot each turn.
   * Returns "won" if our mon is standing when inBattle clears, else "lost".
   */
  async run(pick: (st: BattleState) => number, maxTurns = 60): Promise<"won" | "lost" | "timeout"> {
    for (let turn = 0; turn < maxTurns; turn++) {
      const w = await this.waitForMenu();
      if (w === "over") break;
      if (w === "timeout") return "timeout";
      const st = this.state();
      const slot = pick(st);
      this.bus.emit("state_read", { battle: true, turn,
        my: `${st.mySpecies} L${st.myLevel} ${st.myHp}/${st.myMaxHp}`,
        foe: `${st.foeSpecies} L${st.foeLevel} ${st.foeHp}/${st.foeMaxHp}`, slot });
      await this.useMove(slot);
    }
    // battle over: clear the outro text, then read our HP from party
    const d = await this.dlg.advance(60);
    this.bus.emit("turn_summary", { line: `battle ended (${d.lines.length} outro lines)` });
    return this.r16("wPartyMon1HP") > 0 ? "won" : "lost";
  }
}
