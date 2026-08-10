// LPP Multiplayer — M3 LINK BATTLE (wq#431, 2026-08-10).
//
// Drives a complete Gen1 Cable Club LINK BATTLE between two independent
// serverboy cores over our SerialBus: attendant dialog -> Cable Club handshake
// -> COLOSSEUM room select -> party block -> turn-by-turn move exchange.
//
// ------------------------------------------------------------------------
// ROM FACTS THIS DRIVER DEPENDS ON (read out of pokeblue.gb, not remembered)
// ------------------------------------------------------------------------
// LoadSpecialWarpData, bank 1:
//   $62FE  cp $EF -> TRADE CENTER          $6314  cp $F0 -> COLOSSEUM
//   7 bytes are copied to wCurMap($D35E)..wXBlockCoord($D364). The colosseum
//   specs at $6438/$6440 are `f0 0b c7 04 03 00 01` / `f0 0d c7 04 06 00 00`,
//   i.e. map $F0 at (3,4) and (6,4) — the SAME spots as the trade tables, so
//   both sides spawn already standing where they need to be.
//
// CableClub_DoBattleOrTradeAgain, bank 1 $54D8 — this is where trade and battle
// diverge, and it pins the wLinkState values that matter:
//   54D8  ld a,[wLinkState] / cp 3        ; 3 = start battle
//   54DD  ld a,$32 / ld [wLinkState],a    ; 50 = TRADING  (the trade path)
//   54E2  jr nz,.trading
//   54E4  ld a,4  / ld [wLinkState],a     ; 4  = BATTLING  <- measured in vivo
//   54E9  ld a,$E1 / ld [wCurOpponent],a  ; $E1 = the link-battle opponent
// So a link battle is wLinkState 1 -> 3 -> 4, and 4 is NOT "reset" whatever
// other numbering suggests. Confirmed in vivo: both cores reach wLinkState 4
// with wIsInBattle 2 (trainer battle).
//
// ------------------------------------------------------------------------
// WHY THE VERDICT IS WHAT IT IS
// ------------------------------------------------------------------------
// A link battle is verified by MIRRORING, which no single-core bug can fake:
// each side's wPlayerSelectedMove ($CCDC) must equal the other side's
// wEnemySelectedMove ($CCDD), and each side's wBattleMonHP must equal the
// other side's wEnemyMonHP. Both cores also share the random-number list at
// wLinkBattleRandomNumberList ($D148) that the master generates and sends —
// identical lists on both sides prove the block crossed our bus and make the
// battle reproducible (research/link/R3).

import { Emulator, KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Navigator } from "../nav";
import { Screen } from "../screen";
import { SerialBus } from "./serialbus";
import { installSerialHook } from "./hook";
import { runCycles, setSlice, clearSlice } from "./lockstep";

export const COLOSSEUM_MAP = 0xF0;
export const LINK_STATE_START_BATTLE = 3;
export const LINK_STATE_BATTLING = 4;

const ADDR = {
  curMap: 0xD35E,
  linkState: 0xD12B,
  menuCursor: 0xCC26,
  menuMax: 0xCC28,
  menuKeys: 0xCC29,
  playerMove: 0xCCDC,
  enemyMove: 0xCCDD,
  rngList: 0xD148,
  rngListLen: 9,
};

export interface BattleSide {
  tag: string;
  emu: Emulator;
  sym: SymbolTable;
  nav: Navigator;
  scr: Screen;
}

/** What a brain is shown when it is asked to choose a move. */
export interface BattleView {
  tag: string;
  turn: number;
  myNick: string; foeNick: string;
  mySpecies: number; myLevel: number; myHp: number; myMaxHp: number;
  foeSpecies: number; foeLevel: number; foeHp: number; foeMaxHp: number;
  moves: number[]; pp: number[];
  lastFoeMove: number;
}

export interface LinkBattleOptions {
  fineDiv?: number;
  attendant?: { x: number; y: number };
  spotA?: { x: number; y: number };
  spotB?: { x: number; y: number };
  catchUpCycles?: number;
  catchUpMaxSteps?: number;
  /** Move slot each side picks every turn. */
  moveSlotA?: number;
  moveSlotB?: number;
  /** Give up after this many turn-loop iterations. */
  maxRounds?: number;
  /** Rounds of NO observable change before the driver nudges with A. */
  stuckRounds?: number;
  /** Rounds the HP tuple must hold still before a turn is recorded. */
  settleRounds?: number;
  /**
   * Chooses this side's move slot (0-3) for the coming turn. Called ONCE per
   * turn, at the battle menu, before FIGHT is opened — a side that is already
   * committed must not be interrupted. Returning out of range falls back to the
   * configured static slot, so a confused brain cannot wedge the battle.
   * This is the M4 seam: two of these, two BrainProfiles, one link cable.
   */
  pickMove?: ((view: BattleView) => Promise<number>) | null;
  /** Called every frame-batch with each side's PNG, for the duel stream grid. */
  onFrame?: ((tag: string, png: Buffer) => void) | null;
  log?: (line: string) => void;
}

export interface TurnRecord {
  round: number;
  aPlayerMove: number; aEnemyMove: number;
  bPlayerMove: number; bEnemyMove: number;
  aHp: number; aFoeHp: number;
  bHp: number; bFoeHp: number;
  mirrored: boolean;
}

export interface LinkBattleResult {
  started: boolean;
  ended: boolean;
  turns: TurnRecord[];
  mirroredTurns: number;
  rngListsMatch: boolean;
  exchanges: number;
  winner: "A" | "B" | "none";
  note: string;
}

const DEFAULTS = {
  fineDiv: 64,
  attendant: { x: 11, y: 3 },
  spotA: { x: 3, y: 4 },
  spotB: { x: 6, y: 4 },
  catchUpCycles: 64,
  catchUpMaxSteps: 256,
  moveSlotA: 0,
  moveSlotB: 0,
  maxRounds: 120,
  stuckRounds: 25,
  settleRounds: 3,
  pickMove: null,
  onFrame: null,
};

export class LinkBattleSession {
  private o: Required<LinkBattleOptions>;
  private bus = new SerialBus();
  private stale: Record<string, number> = { A: 0, B: 0 };
  private lastTuple = "";
  private settled = 0;
  picksRejected: Record<string, number> = { A: 0, B: 0 };
  private sig: Record<string, string> = { A: "", B: "" };
  private retries: Record<string, number> = { A: 0, B: 0 };
  private log: (s: string) => void;

  constructor(private a: BattleSide, private b: BattleSide, opts: LinkBattleOptions = {}) {
    this.o = { ...DEFAULTS, log: (s: string) => console.log(s), ...opts } as Required<LinkBattleOptions>;
    this.log = this.o.log;
  }

  private frameTick = 0;
  private step(n: number, keyA?: number, keyB?: number): void {
    for (let i = 0; i < n; i++) {
      if (keyA !== undefined) (this.a.emu as any).gb.pressKey(keyA);
      if (keyB !== undefined) (this.b.emu as any).gb.pressKey(keyB);
      (this.a.emu as any).gb.doFrame();
      (this.b.emu as any).gb.doFrame();
      this.bus.tick();
      // Frames are best-effort video for the duel grid. The pair runs many
      // times realtime, so sample sparsely rather than per frame; the stream
      // server throttles again on its own side.
      if (this.o.onFrame && ++this.frameTick % 240 === 0) {
        this.o.onFrame("A", this.a.emu.screenPngBuffer());
        this.o.onFrame("B", this.b.emu.screenPngBuffer());
      }
    }
  }

  private m(s: BattleSide, a: number): number { return s.emu.mem()[a] & 0xFF; }
  private r16(s: BattleSide, name: string): number {
    const m = s.emu.mem(), a = s.sym.addr(name);
    return ((m[a] & 0xFF) << 8) | (m[a + 1] & 0xFF);
  }
  private hp(s: BattleSide): number { return this.r16(s, "wBattleMonHP"); }
  private foeHp(s: BattleSide): number { return this.r16(s, "wEnemyMonHP"); }
  private inBattle(s: BattleSide): number { return this.m(s, s.sym.addr("wIsInBattle")); }
  private grid(s: BattleSide): string { return (s.scr.textGrid?.() ?? []).join("\n"); }
  private rngList(s: BattleSide): number[] {
    const m = s.emu.mem();
    return Array.from({ length: ADDR.rngListLen }, (_, i) => m[ADDR.rngList + i] & 0xFF);
  }
  private snap(s: BattleSide): string {
    return `${s.tag}[map=$${this.m(s, ADDR.curMap).toString(16)} ls=${this.m(s, ADDR.linkState)} ` +
      `bt=${this.inBattle(s)} hp=${this.hp(s)} foe=${this.foeHp(s)} ` +
      `pm=${this.m(s, ADDR.playerMove)} em=${this.m(s, ADDR.enemyMove)} ` +
      `cur=${this.m(s, ADDR.menuCursor)}/${this.m(s, ADDR.menuMax)} keys=$${this.m(s, ADDR.menuKeys).toString(16)}]`;
  }

  /**
   * Attendant dialog, handshake, then room-select entry 1 (COLOSSEUM).
   * The cursor is READ BACK from wCurrentMenuItem rather than counted, the same
   * discipline the trade party list needed: entry 2 is CANCEL and selecting it
   * drops the session.
   */
  async connect(): Promise<void> {
    await this.a.nav.goto(this.o.attendant.x, this.o.attendant.y);
    await this.b.nav.goto(this.o.attendant.x, this.o.attendant.y);
    this.step(20, KEYS.UP, KEYS.UP);
    this.step(20);
    installSerialHook(this.a.emu.core, this.bus, 0);
    installSerialHook(this.b.emu.core, this.bus, 1);

    const onMenu = (s: BattleSide) => this.grid(s).includes("TRADE CENTER");
    for (let r = 0; r < 90; r++) {
      const ma = onMenu(this.a), mb = onMenu(this.b);
      if (ma && mb) {
        const ca = this.m(this.a, ADDR.menuCursor), cb = this.m(this.b, ADDR.menuCursor);
        if (ca === 1 && cb === 1) { this.step(8, KEYS.A, KEYS.A); this.step(24); }
        else { this.step(8, ca === 1 ? undefined : KEYS.DOWN, cb === 1 ? undefined : KEYS.DOWN); this.step(24); }
      } else {
        // Only press A on a side that is not already parked on the menu —
        // blind-tapping both desyncs them (wq#434).
        this.step(8, ma ? undefined : KEYS.A, mb ? undefined : KEYS.A);
        this.step(22);
      }
      if (this.m(this.a, ADDR.curMap) === COLOSSEUM_MAP && this.m(this.b, ADDR.curMap) === COLOSSEUM_MAP) break;
    }
    // The room has to finish loading before the tiles respond to input; without
    // this settle both sides sit at wLinkState 1 forever (learned in M3 trade).
    this.step(180);
    this.log(`  in colosseum: ${this.snap(this.a)} ${this.snap(this.b)} ex=${this.bus.exchanges}`);
  }

  /** Face off and run the party block until both cores are in the battle. */
  async openBattle(): Promise<boolean> {
    const fine = this.o.fineDiv;
    setSlice(this.a.emu.core, fine);
    setSlice(this.b.emu.core, fine);
    this.bus.deferTicks = 1;
    const cores = [this.a.emu.core, this.b.emu.core];
    this.bus.peerRunner = (p: 0 | 1, c: number) => runCycles(cores[p], c);
    this.bus.catchUpCycles = this.o.catchUpCycles;
    this.bus.catchUpMaxSteps = this.o.catchUpMaxSteps;

    await this.a.nav.goto(this.o.spotA.x, this.o.spotA.y);
    await this.b.nav.goto(this.o.spotB.x, this.o.spotB.y);
    this.step(16 * fine, KEYS.RIGHT, KEYS.LEFT);
    this.step(16 * fine);
    for (let k = 0; k < 20; k++) {
      this.step(8, KEYS.A, KEYS.A);
      this.step(24);
      if (this.m(this.a, ADDR.linkState) >= LINK_STATE_START_BATTLE &&
          this.m(this.b, ADDR.linkState) >= LINK_STATE_START_BATTLE) break;
    }
    for (let k = 0; k < 60; k++) {
      this.step(8 * fine, KEYS.A, KEYS.A);
      this.step(24 * fine);
      if (this.inBattle(this.a) !== 0 && this.inBattle(this.b) !== 0) break;
    }
    const ok = this.inBattle(this.a) !== 0 && this.inBattle(this.b) !== 0;
    this.log(`  battle open=${ok}: ${this.snap(this.a)} ${this.snap(this.b)} ex=${this.bus.exchanges}`);
    return ok;
  }

  /** Instrumentation hooks — used by probes, not by the driver. */
  probeStep(n: number, keyA?: number, keyB?: number): void { this.step(n, keyA, keyB); }
  probeLine(): string { return `${this.snap(this.a)} ${this.snap(this.b)} ex=${this.bus.exchanges}`; }
  probeScreens(): string { return `--- A ---\n${this.grid(this.a)}\n--- B ---\n${this.grid(this.b)}`; }
  probeMoves(s: "A" | "B"): number[] {
    const side = s === "A" ? this.a : this.b, m = side.emu.mem(), a = side.sym.addr("wBattleMonMoves");
    return [0, 1, 2, 3].map(i => m[a + i] & 0xFF);
  }
  get sides(): [BattleSide, BattleSide] { return [this.a, this.b]; }

  async run(): Promise<LinkBattleResult> {
    await this.connect();
    const started = await this.openBattle();
    const turns: TurnRecord[] = [];
    if (!started) {
      clearSlice(this.a.emu.core); clearSlice(this.b.emu.core);
      return { started, ended: false, turns, mirroredTurns: 0, rngListsMatch: false,
               exchanges: this.bus.exchanges, winner: "none", note: "battle never started" };
    }

    const rngA = this.rngList(this.a), rngB = this.rngList(this.b);
    const rngListsMatch = rngA.every((v, i) => v === rngB[i]);
    this.log(`  rng list A=[${rngA.join(",")}] B=[${rngB.join(",")}] match=${rngListsMatch}`);

    const ended = await this.fight(turns);
    clearSlice(this.a.emu.core);
    clearSlice(this.b.emu.core);

    const mirroredTurns = turns.filter(t => t.mirrored).length;
    const aDown = this.hp(this.a) === 0, bDown = this.hp(this.b) === 0;
    const winner: "A" | "B" | "none" = aDown && !bDown ? "B" : bDown && !aDown ? "A" : "none";
    const note = !ended ? `ran ${turns.length} turns without the battle ending`
      : winner === "none" ? "battle ended with no clear winner"
      : `battle ended, ${winner} standing`;
    return { started, ended, turns, mirroredTurns, rngListsMatch, exchanges: this.bus.exchanges, winner, note };
  }

  /**
   * Turn loop.
   *
   * MEASURED 2026-08-10 (probe_linkbattle_menu.ts), and it decides the whole
   * design: with A held down on both sides the bus NEVER moved past the party
   * block (exchanges frozen at 720) while wPlayerSelectedMove cycled through
   * all four move ids forever. Move selection in a link battle is exchanged
   * through Serial_ExchangeLinkMenuSelection, and — exactly like the trade
   * nybble sync — a keypress during that window knocks a waiting side out of
   * the loop, so the selection is never agreed and the menu simply reopens.
   *
   * Therefore this driver presses a key ONLY when the side is sitting on a menu
   * that is waiting for it. Battle narration is not advanced with A at all:
   * ManualTextScroll has an in-link-battle path (`ManualTextScroll.inLinkBattle`)
   * that scrolls on a timer instead of on a keypress, so silence is correct and
   * A is actively harmful. Everything else — intro, send-out, damage narration,
   * the selection exchange — runs on no input.
   */
  /** Staleness = screen AND both HP values unchanged since the last round. */
  private track(s: BattleSide): void {
    const sig = `${this.grid(s)}|${this.hp(s)}|${this.foeHp(s)}`;
    if (sig === this.sig[s.tag]) this.stale[s.tag]++;
    else { this.sig[s.tag] = sig; this.stale[s.tag] = 0; }
  }

  /** Gen1 text codec, enough for a nickname: $80-$99 = A-Z, $50 terminates. */
  private name(s: BattleSide, addr: number): string {
    const m = s.emu.mem();
    let out = "";
    for (let i = 0; i < 11; i++) {
      const c = m[addr + i] & 0xFF;
      if (c === 0x50) break;
      out += c >= 0x80 && c <= 0x99 ? String.fromCharCode(65 + c - 0x80) : c === 0x7F ? " " : "";
    }
    return out || "?";
  }

  private view(s: BattleSide, turn: number): BattleView {
    const m = s.emu.mem(), mv = s.sym.addr("wBattleMonMoves"), pp = s.sym.addr("wBattleMonPP");
    return {
      tag: s.tag, turn,
      myNick: this.name(s, s.sym.addr("wBattleMonNick")),
      foeNick: this.name(s, s.sym.addr("wEnemyMonNick")),
      mySpecies: this.m(s, s.sym.addr("wBattleMonSpecies")),
      myLevel: this.m(s, s.sym.addr("wBattleMonLevel")),
      myHp: this.hp(s), myMaxHp: this.r16(s, "wBattleMonMaxHP"),
      foeSpecies: this.m(s, s.sym.addr("wEnemyMonSpecies")),
      foeLevel: this.m(s, s.sym.addr("wEnemyMonLevel")),
      foeHp: this.foeHp(s), foeMaxHp: this.r16(s, "wEnemyMonMaxHP"),
      moves: [0, 1, 2, 3].map(i => m[mv + i] & 0xFF),
      pp: [0, 1, 2, 3].map(i => m[pp + i] & 0x3F),
      lastFoeMove: this.m(s, ADDR.enemyMove),
    };
  }

  private classify(s: BattleSide): "moveMenu" | "battleMenu" | "text" {
    const g = this.grid(s);
    if (g.includes("TYPE/") || g.includes("PP")) return "moveMenu";
    if (g.includes("FIGHT")) return "battleMenu";
    return "text";
  }

  private async fight(turns: TurnRecord[]): Promise<boolean> {
    const fine = this.o.fineDiv;
    // A side that has committed its move issues NO input until the next turn's
    // battle menu comes back. A timed quiet window is not enough: the partner
    // may still be choosing, and the committed side sits on a screen that still
    // looks like the move menu, so any resumed input walks the cursor and
    // breaks the exchange that is mid-flight.
    const committed: Record<string, boolean> = { A: false, B: false };
    const slot: Record<string, number> = { A: this.o.moveSlotA, B: this.o.moveSlotB };
    let lastPair = "";

    // Keyed on TURN, not a boolean: an un-dispatched commit press un-commits
    // the side, and a boolean latch would re-ask (and re-bill) the brain for a
    // turn it has already decided.
    const chosenTurn: Record<string, number> = { A: -1, B: -1 };
    const keyFor = async (s: BattleSide): Promise<number | undefined> => {
      const where = this.classify(s);
      const cur = this.m(s, ADDR.menuCursor);
      if (where === "battleMenu") {
        committed[s.tag] = false;                       // a new turn has begun
        // 2x2 grid, FIGHT is top-left; wCurrentMenuItem tracks the row.
        return cur === 0 ? KEYS.A : KEYS.UP;
      }
      if (committed[s.tag]) {
        // Silence while a selection is in flight — but silence with a deadman.
        // A committed side that is genuinely mid-exchange changes SOMETHING
        // every few rounds (screen, HP). A committed side whose A never
        // dispatched changes nothing at all, and because this driver then
        // presses nothing, the run deadlocks on its own latch. So the nudge is
        // driven by STALENESS, not by a timer and not by wEnemySelectedMove
        // (which stays populated from the previous turn and would block a
        // retry forever).
        if (this.stale[s.tag] < this.o.stuckRounds) return undefined;
        this.stale[s.tag] = 0;
        this.retries[s.tag]++;
        this.log(`    ${s.tag} nudge #${this.retries[s.tag]} — nothing changed for ${this.o.stuckRounds} rounds on ${where}`);
        // Un-commit and fall through to the normal logic. A nudge must NOT be a
        // blind A: on the move menu that commits whatever happens to be
        // highlighted, which silently overrode the requested slot and made
        // every side fight with move 1 regardless of configuration.
        committed[s.tag] = false;
        if (where !== "moveMenu") return KEYS.A;
      }
      if (where === "moveMenu") {
        // Ask the brain HERE, not at the battle menu. The battle menu is on
        // screen for only a few rounds between turns and this driver often
        // steps straight past it, so a hook there fires about once per battle.
        // The move menu is where the choice is actually needed, and the cores
        // do not advance while the request is in flight — both are stepped only
        // after BOTH sides' keys have resolved.
        const turnNo = turns.length + 1;
        if (this.o.pickMove && chosenTurn[s.tag] !== turnNo) {
          chosenTurn[s.tag] = turnNo;
          const fallback = s.tag === "A" ? this.o.moveSlotA : this.o.moveSlotB;
          try {
            const want = await this.o.pickMove(this.view(s, turnNo));
            const ok = Number.isInteger(want) && want >= 0 && want <= 3 && !!this.view(s, 0).moves[want];
            slot[s.tag] = ok ? want : fallback;
            if (!ok) this.picksRejected[s.tag]++;
          } catch (e) {
            slot[s.tag] = fallback;
            this.picksRejected[s.tag]++;
            this.log(`    ${s.tag} pickMove failed (${e}) — falling back to slot ${fallback}`);
          }
        }
        // MEASURED: the move list is ONE-INDEXED. Cursor 1..4 maps to the four
        // move ids and wPlayerSelectedMove ($CCDC) follows the highlighted
        // entry. Targeting slot 0 never matches and walks the cursor forever.
        // wMenuWatchedKeys here is $C3 (UP|DOWN|B|A).
        const target = slot[s.tag] + 1;
        if (cur !== target) return KEYS.DOWN;
        committed[s.tag] = true;
        return KEYS.A;
      }
      // Narration: link battles scroll their own text (ManualTextScroll has an
      // in-link-battle path), so silence is correct here — with the same
      // deadman in case a prompt really is waiting on a press.
      if (this.stale[s.tag] >= this.o.stuckRounds) {
        this.stale[s.tag] = 0;
        this.log(`    ${s.tag} nudge — stalled on ${where}`);
        return KEYS.A;
      }
      return undefined;
    };

    for (let round = 0; round < this.o.maxRounds; round++) {
      if (this.inBattle(this.a) === 0 || this.inBattle(this.b) === 0) return true;
      this.track(this.a); this.track(this.b);
      const [ka, kb] = [await keyFor(this.a), await keyFor(this.b)];
      this.step(6 * fine, ka, kb);
      this.step(10 * fine);

      const pmA = this.m(this.a, ADDR.playerMove), emA = this.m(this.a, ADDR.enemyMove);
      const pmB = this.m(this.b, ADDR.playerMove), emB = this.m(this.b, ADDR.enemyMove);
      // A turn is recorded only when the two cores have SETTLED. Sampling the
      // instant both selections are populated reads torn state: the sides run
      // their damage animations a few rounds apart, so one has already applied
      // the hit while the other has not, and an instantaneous HP comparison
      // reports a mismatch that resolves itself one round later. Waiting for
      // the HP tuple to stop moving compares like with like.
      const tuple = `${this.hp(this.a)}/${this.foeHp(this.a)}/${this.hp(this.b)}/${this.foeHp(this.b)}`;
      if (tuple === this.lastTuple) this.settled++; else { this.lastTuple = tuple; this.settled = 0; }
      // Settled is necessary but not sufficient: a side can be paused mid
      // damage animation while its HP happens to sit still. Requiring BOTH
      // sides to be back on a menu means both turns have fully resolved, which
      // is the only moment the two RAM views are directly comparable.
      const bothAtMenu = this.classify(this.a) !== "text" && this.classify(this.b) !== "text";
      if (this.settled >= this.o.settleRounds && bothAtMenu && tuple !== lastPair &&
          pmA !== 0 && emA !== 0 && pmB !== 0 && emB !== 0) {
        lastPair = tuple;
        const mirrored = pmA === emB && pmB === emA &&
          this.hp(this.a) === this.foeHp(this.b) && this.hp(this.b) === this.foeHp(this.a);
        turns.push({
          round, aPlayerMove: pmA, aEnemyMove: emA, bPlayerMove: pmB, bEnemyMove: emB,
          aHp: this.hp(this.a), aFoeHp: this.foeHp(this.a),
          bHp: this.hp(this.b), bFoeHp: this.foeHp(this.b),
          mirrored,
        });
        const t = turns[turns.length - 1];
        this.log(`    TURN ${turns.length}: A picked ${pmA}/sees ${emA} hp ${t.aHp}(foe ${t.aFoeHp}) | ` +
          `B picked ${pmB}/sees ${emB} hp ${t.bHp}(foe ${t.bFoeHp}) | mirror=${t.mirrored}`);
      }
      if (round % 10 === 0) {
        this.log(`    r=${round} ${this.classify(this.a)}/${this.classify(this.b)} ${this.probeLine()}`);
      }
    }
    return this.inBattle(this.a) === 0 || this.inBattle(this.b) === 0;
  }
}
