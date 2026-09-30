// wq#3201 (M5e) — a link battle to knockout, driven from ONE side.
//
// M3's LinkBattleSession (battle.ts) holds both cores: it opens the battle when
// BOTH wLinkStates say so, records a turn when BOTH sides are back on a menu,
// and decides a stall by comparing the two sides' SC registers. A remote side
// can do none of that. So this driver reads its own screen and RAM only, and
// the one rule M3 measured still holds: move selection is exchanged through
// LinkBattleExchangeData ($0F:5605), and — exactly like the trade nybble sync —
// a keypress while a side is waiting there knocks it out of the loop. Once we
// commit a move we therefore PARK: no input until our own battle menu comes
// back, however long the peer takes to choose.
//
// The park has a deadman, as in battle.ts, but its staleness signal includes
// the bridge's byte count. A side parked in the exchange sees the master clock
// a byte every few frames, so "nothing changed" can only mean the link itself
// stopped, which is the one case a nudge is for.
import { KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { BATTLE_ADDR, battlePhaseOf, menuKeyFor, hpOf, foeHpOf, inBattleOf, cursorOf,
  BattlePhase } from "./battle_menu";
import type { TurnSample } from "./invariants";

export interface OneSidedBattleDeps {
  mem: () => number[];
  sym: SymbolTable;
  grid: () => string;
  /** Step n frames, optionally holding `key`. MUST pace the link itself. */
  step: (n: number, key?: number) => Promise<void>;
  closed: () => boolean;
  /** Every byte the bridge has received from the peer so far, in order. */
  received: () => number[];
  /** doFrame divisor for this phase; one slice ~= one transfer window. */
  fine: number;
  /** Our move slot (0-3), every turn. */
  slot: number;
  maxRounds?: number;
  /** Rounds of no change (screen, HP, link bytes) before a nudge. */
  stuckRounds?: number;
  /** Rounds a commit may sit on the move menu without entering the exchange. */
  commitRounds?: number;
  /** Rounds our HP pair must hold still before a turn is recorded. */
  settleRounds?: number;
  /** Extra state for the nudge log line (PC, SC, ...). */
  describe?: () => string;
  log?: (s: string) => void;
}

export interface OneSidedBattleOut {
  ended: boolean;
  /** Our final HP pair, read while wIsInBattle was still set. */
  hp: number; foeHp: number;
  knockout: "us" | "foe" | "none";
  turns: TurnSample[];
  rounds: number;
  nudges: number;
  commits: number;
  /** Commit presses the ROM never acted on, caught and re-pressed. */
  misfires: number;
  phases: Partial<Record<BattlePhase, number>>;
  note: string;
}

export async function driveBattle(d: OneSidedBattleDeps): Promise<OneSidedBattleOut> {
  const fine = d.fine;
  // MEASURED: one turn is ~80-130 rounds of ROM-paced narration (link battles
  // scroll text on a timer), and a knockout here is 6-10 turns.
  const maxRounds = d.maxRounds ?? 3000;
  const stuckRounds = d.stuckRounds ?? 60;
  const settleRounds = d.settleRounds ?? 3;
  const log = d.log ?? (() => {});
  const phases: Partial<Record<BattlePhase, number>> = {};
  const turns: TurnSample[] = [];
  const commitRounds = d.commitRounds ?? 4;
  const enemyIndexAddr = d.sym.addr("wEnemyMoveListIndex");
  const nybAddr = d.sym.addr("wSerialExchangeNybbleReceiveData");

  let committed = false, commits = 0, nudges = 0, stale = 0, settled = 0;
  // A $FF already there at commit time proves nothing, so the commit marks
  // itself entered at once and falls back to the staleness deadman.
  let entered = false, sinceCommit = 0, misfires = 0;
  let sig = "", lastTuple = "", lastSampled = "", wireMark = d.received().length;
  let hp = hpOf(d.mem(), d.sym), foeHp = foeHpOf(d.mem(), d.sym);
  let round = 0;

  for (; round < maxRounds && !d.closed(); round++) {
    const m = d.mem();
    if (inBattleOf(m, d.sym) === 0) break;
    hp = hpOf(m, d.sym); foeHp = foeHpOf(m, d.sym);
    const grid = d.grid();
    const phase = battlePhaseOf(grid);
    phases[phase] = (phases[phase] ?? 0) + 1;

    const s = `${grid}|${hp}|${foeHp}|${d.received().length}`;
    if (s === sig) stale++; else { sig = s; stale = 0; }

    let key: number | undefined;
    if (phase === "battleMenu") committed = false;           // a new turn has begun
    // Did the commit press land? LinkBattleExchangeData's first act is
    // `ld a,$ff / ld [wSerialExchangeNybbleReceiveData],a` ($0F:5605), so a $FF
    // there is our own ROM saying it entered the exchange. A side still on the
    // move menu without it never saw the press (MEASURED: every turn, one side
    // sat with the cursor on its slot and the old index in $CC3E until the
    // 60-round deadman fired — and the peer, parked in the sync, waited as long).
    // Re-pressing there is safe for the reason a press in the sync is not: the
    // ROM is still in the menu loop, not the exchange.
    const parked = (m[nybAddr] & 0xFF) === 0xFF;
    if (committed && !entered) {
      if (parked) entered = true;
      else if (phase === "moveMenu" && ++sinceCommit >= commitRounds) { committed = false; misfires++; }
    }
    // Parked in the sync waiting for the peer's nybble is the one state that
    // is provably healthy however long it lasts — the peer may still be
    // narrating its last turn, several hundred frames behind us — so it never
    // feeds the deadman. A dead peer ends the loop through closed() instead.
    if (committed && entered && parked) stale = 0;
    if (committed && stale >= stuckRounds) {
      // Un-commit and re-decide from the screen: a nudge must not be a blind A
      // on the move menu, which would commit whatever is highlighted.
      stale = 0; nudges++; committed = false;
      log(`  nudge #${nudges}: no change for ${stuckRounds} rounds on ${phase} (link bytes frozen too) ${d.describe?.() ?? ""}`);
    }
    if (!committed) {
      if (phase === "text") {
        if (stale >= stuckRounds) {
          stale = 0; nudges++; key = KEYS.A;
          log(`  nudge #${nudges}: stalled on text ${d.describe?.() ?? ""} :: ${grid.replace(/\s+/g, " ").trim().slice(0, 60)}`);
        }
      } else {
        const k = menuKeyFor(phase, cursorOf(m), d.slot);
        key = k.key;
        if (k.commits) { committed = true; commits++; sinceCommit = 0; entered = (m[nybAddr] & 0xFF) === 0xFF; }
      }
    }
    await d.step(6 * fine, key);
    await d.step(10 * fine);

    // A turn is recorded only once OUR state has settled on a menu: the HP pair
    // held still for settleRounds and we are no longer narrating. Torn samples
    // (mid-animation) are the failure battle.ts measured; the same discipline
    // applies one-sided.
    const after = d.mem();
    if (inBattleOf(after, d.sym) === 0) break;
    const h = hpOf(after, d.sym), f = foeHpOf(after, d.sym);
    const tuple = `${h}/${f}`;
    if (tuple === lastTuple) settled++; else { lastTuple = tuple; settled = 0; }
    const pm = after[BATTLE_ADDR.playerMove] & 0xFF, em = after[BATTLE_ADDR.enemyMove] & 0xFF;
    const atMenu = battlePhaseOf(d.grid()) !== "text";
    if (settled >= settleRounds && atMenu && tuple !== lastSampled && pm !== 0 && em !== 0) {
      lastSampled = tuple;
      const rx = d.received();
      turns.push({
        round, playerMove: pm, enemyMove: em, enemyIndex: after[enemyIndexAddr] & 0xFF,
        wire: rx.slice(wireMark), hp: h, foeHp: f, settled: true,
      });
      wireMark = rx.length;
      const t = turns[turns.length - 1];
      log(`  TURN ${turns.length}: picked ${pm} / peer ${em} (index ${t.enemyIndex}, ${t.wire.length} bytes this turn) hp ${h} foe ${f}`);
    }
  }

  // Our last in-battle reading is the verdict: after the battle closes the ROM
  // is free to reuse these fields.
  const ended = inBattleOf(d.mem(), d.sym) === 0;
  const knockout = hp === 0 && foeHp !== 0 ? "us" : foeHp === 0 && hp !== 0 ? "foe" : "none";
  return {
    ended, hp, foeHp, knockout, turns, rounds: round, nudges, commits, misfires, phases,
    note: !ended ? (d.closed() ? "peer closed the link mid-battle" : `battle still running after ${round} rounds`)
      : knockout === "none" ? `battle ended without a knockout (hp ${hp}, foe ${foeHp})`
      : `battle ended, ${knockout === "foe" ? "we" : "the peer"} won by knockout`,
  };
}
