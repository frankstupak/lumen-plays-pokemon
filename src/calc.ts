// wq#1181 (roadmap item 5): Gen 1 damage calc + winnability verdict.
//
// WHY THIS EXISTS
//   Battles had no winnability model. moves.ts is a hand-typed 34-move table
//   with no type chart and no damage formula, so every "can I win this fight"
//   question in the harness was answered by a level number (MISTY_MIN_LEVEL) or
//   by a stall counter that only fires after 15 wasted turns (softlock.ts). Both
//   are proxies. The damage formula is the fact, and every input for it is
//   already in RAM: Gen 1 recomputes the EFFECTIVE stats after stat stages and
//   badge boosts (CalculateModifiedStats/ApplyBadgeStatBoosts) into
//   wBattleMon*/wEnemyMon*, so reading them needs no stat-stage math.
//
// PURE MODULE. No emulator, no fs, no symbols — battle.ts collects the RAM into
// Combatants and this file does arithmetic, which is what makes the whole thing
// probe-testable without a ROM (probe_calc1181.ts).
//
// ITEM-4 SEAM (read this before editing the table below). Roadmap item 4
// (wq#1180) decodes `Moves`, `TypeEffects` and `BaseStats` out of the ROM; at
// the time this landed that branch was still empty, so the type chart here is
// transcribed from pret/pokered `data/types/type_matchups.asm` and the move
// metadata comes from moves.ts. BOTH are injected, never reached for directly:
// pass a MoveSource and a TypeChart and this file has no opinion about where
// they came from. When item 4 lands, `chartFromTriples(romTypeEffects(...))`
// and a ROM-backed MoveSource replace the defaults at the two call sites in
// battle.ts and nothing in here changes.
import { MOVES } from "./moves";

// ---------------------------------------------------------------- types

/** Gen 1 internal type ids (constants/type_constants.asm). These are the raw
 *  values in wBattleMonType1/wEnemyMonType1, so no translation is needed.
 *  Physical types are 0-8, special types 20-26 — the split is BY TYPE in Gen 1,
 *  not by move, which is why isPhysical() below is a comparison and not a
 *  table. BIRD (6) is unused by any real species; it is here so a garbage read
 *  during a map load resolves to a name instead of undefined. */
export const TYPE = {
  NORMAL: 0, FIGHTING: 1, FLYING: 2, POISON: 3, GROUND: 4, ROCK: 5,
  BIRD: 6, BUG: 7, GHOST: 8,
  FIRE: 20, WATER: 21, GRASS: 22, ELECTRIC: 23, PSYCHIC: 24, ICE: 25, DRAGON: 26,
} as const;

export const TYPE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(TYPE).map(([k, v]) => [v, k]));

/** moves.ts stores move types as STRINGS; this is the bridge until item 4's
 *  ROM decode makes the ids primary. PSYCHIC is spelled the same on both sides. */
export const TYPE_ID: Record<string, number> = Object.fromEntries(
  Object.entries(TYPE).map(([k, v]) => [k, v as number]));

/** First special type id. Gen 1 splits physical/special by TYPE. */
export const FIRST_SPECIAL_TYPE = TYPE.FIRE;
export const isPhysical = (t: number): boolean => t < FIRST_SPECIAL_TYPE;

// ---------------------------------------------------------------- type chart

/** One TypeEffects row, in the ROM's own shape: [attacking type, defending
 *  type, multiplier x10]. Item 4's decode emits exactly this, which is why the
 *  built-in table below is written in it rather than as a nested map. */
export type TypeTriple = [number, number, number];

/** Transcribed from pret/pokered data/types/type_matchups.asm. Anything not
 *  listed is 1x. Gen 1 quirks are deliberate and load-bearing: Poison IS super
 *  effective against Bug (and Bug against Poison), Ghost does nothing to
 *  Psychic, and Ice is NOT resisted by Fire. This table is UNVERIFIED against
 *  the cartridge (roms/*.gb is untracked — copyright); item 4's ROM decode is
 *  the verification path, and chartFromTriples() takes its output unchanged. */
export const TYPE_EFFECTS: TypeTriple[] = [
  [TYPE.WATER, TYPE.FIRE, 20], [TYPE.FIRE, TYPE.GRASS, 20], [TYPE.FIRE, TYPE.ICE, 20],
  [TYPE.GRASS, TYPE.WATER, 20], [TYPE.ELECTRIC, TYPE.WATER, 20], [TYPE.WATER, TYPE.ROCK, 20],
  [TYPE.GROUND, TYPE.FLYING, 0],
  [TYPE.WATER, TYPE.WATER, 5], [TYPE.FIRE, TYPE.FIRE, 5], [TYPE.ELECTRIC, TYPE.ELECTRIC, 5],
  [TYPE.ICE, TYPE.ICE, 5], [TYPE.GRASS, TYPE.GRASS, 5], [TYPE.PSYCHIC, TYPE.PSYCHIC, 5],
  [TYPE.FIRE, TYPE.WATER, 5], [TYPE.GRASS, TYPE.FIRE, 5], [TYPE.WATER, TYPE.GRASS, 5],
  [TYPE.ELECTRIC, TYPE.GRASS, 5], [TYPE.NORMAL, TYPE.ROCK, 5], [TYPE.NORMAL, TYPE.GHOST, 0],
  [TYPE.GHOST, TYPE.GHOST, 20], [TYPE.FIRE, TYPE.BUG, 20], [TYPE.FIRE, TYPE.ROCK, 5],
  [TYPE.WATER, TYPE.GROUND, 20], [TYPE.ELECTRIC, TYPE.GROUND, 0], [TYPE.ELECTRIC, TYPE.FLYING, 20],
  [TYPE.GRASS, TYPE.GROUND, 20], [TYPE.GRASS, TYPE.BUG, 5], [TYPE.GRASS, TYPE.POISON, 5],
  [TYPE.GRASS, TYPE.ROCK, 20], [TYPE.GRASS, TYPE.FLYING, 5],
  [TYPE.ICE, TYPE.WATER, 5], [TYPE.ICE, TYPE.GRASS, 20], [TYPE.ICE, TYPE.GROUND, 20],
  [TYPE.ICE, TYPE.FLYING, 20],
  [TYPE.FIGHTING, TYPE.NORMAL, 20], [TYPE.FIGHTING, TYPE.POISON, 5], [TYPE.FIGHTING, TYPE.FLYING, 5],
  [TYPE.FIGHTING, TYPE.PSYCHIC, 5], [TYPE.FIGHTING, TYPE.BUG, 5], [TYPE.FIGHTING, TYPE.ROCK, 20],
  [TYPE.FIGHTING, TYPE.ICE, 20], [TYPE.FIGHTING, TYPE.GHOST, 0],
  [TYPE.POISON, TYPE.GRASS, 20], [TYPE.POISON, TYPE.POISON, 5], [TYPE.POISON, TYPE.GROUND, 5],
  [TYPE.POISON, TYPE.BUG, 20], [TYPE.POISON, TYPE.ROCK, 5], [TYPE.POISON, TYPE.GHOST, 5],
  [TYPE.GROUND, TYPE.POISON, 20], [TYPE.GROUND, TYPE.ROCK, 20], [TYPE.GROUND, TYPE.BUG, 5],
  [TYPE.GROUND, TYPE.GRASS, 5], [TYPE.GROUND, TYPE.FIRE, 20], [TYPE.GROUND, TYPE.ELECTRIC, 20],
  [TYPE.FLYING, TYPE.ELECTRIC, 5], [TYPE.FLYING, TYPE.FIGHTING, 20], [TYPE.FLYING, TYPE.BUG, 20],
  [TYPE.FLYING, TYPE.GRASS, 20], [TYPE.FLYING, TYPE.ROCK, 5],
  [TYPE.PSYCHIC, TYPE.FIGHTING, 20], [TYPE.PSYCHIC, TYPE.POISON, 20],
  [TYPE.BUG, TYPE.FIRE, 5], [TYPE.BUG, TYPE.GRASS, 20], [TYPE.BUG, TYPE.FIGHTING, 5],
  [TYPE.BUG, TYPE.FLYING, 5], [TYPE.BUG, TYPE.PSYCHIC, 20], [TYPE.BUG, TYPE.GHOST, 5],
  [TYPE.BUG, TYPE.POISON, 20],
  [TYPE.ROCK, TYPE.FIRE, 20], [TYPE.ROCK, TYPE.FIGHTING, 5], [TYPE.ROCK, TYPE.GROUND, 5],
  [TYPE.ROCK, TYPE.FLYING, 20], [TYPE.ROCK, TYPE.BUG, 20], [TYPE.ROCK, TYPE.ICE, 20],
  [TYPE.GHOST, TYPE.NORMAL, 0], [TYPE.GHOST, TYPE.PSYCHIC, 0],
  [TYPE.FIRE, TYPE.DRAGON, 5], [TYPE.WATER, TYPE.DRAGON, 5], [TYPE.ELECTRIC, TYPE.DRAGON, 5],
  [TYPE.GRASS, TYPE.DRAGON, 5], [TYPE.ICE, TYPE.DRAGON, 20], [TYPE.DRAGON, TYPE.DRAGON, 20],
];

/** Lookup built from triples. `x10` is kept as the ROM's tenths so the caller
 *  can apply Gen 1's per-type truncation in the right order. */
export interface TypeChart { x10(atk: number, def: number): number }

export function chartFromTriples(triples: TypeTriple[]): TypeChart {
  const m = new Map<number, number>();
  for (const [a, d, x] of triples ?? []) m.set(a * 256 + d, x);
  return { x10: (a, d) => m.get(a * 256 + d) ?? 10 };
}

export const DEFAULT_CHART: TypeChart = chartFromTriples(TYPE_EFFECTS);

/** Combined multiplier against a (possibly dual-typed) defender. Gen 1 applies
 *  each type separately with truncation between them, so 2x then 0.5x is not
 *  always exactly 1x on the damage value — see damage(). This returns the
 *  FLOAT product, which is what the verdict prose quotes; damage() does the
 *  faithful integer version. Mono-typed mons repeat type1 in type2, so the
 *  second application is skipped when the ids match. */
export function effectiveness(chart: TypeChart, atkType: number, d1: number, d2: number): number {
  const a = chart.x10(atkType, d1) / 10;
  const b = d2 === d1 ? 1 : chart.x10(atkType, d2) / 10;
  return a * b;
}

// ---------------------------------------------------------------- move source

export interface MoveMeta { id: number; name: string; type: number; power: number; lockIn?: boolean }

/** Where move metadata comes from. Item 4's ROM `Moves` decode implements this
 *  with full 165-move coverage; the default below is the hand-typed table. */
export interface MoveSource { get(id: number): MoveMeta | undefined }

/** moves.ts adapter. Returns undefined for the ~130 moves the hand-typed table
 *  does not cover — deliberately NOT the old "assume power 30" guess, because
 *  the verdict has to be able to tell "weak move" from "unknown move" to know
 *  whether it is allowed to make a claim (see UNKNOWN_POWER). */
export const DEFAULT_MOVES: MoveSource = {
  get(id: number): MoveMeta | undefined {
    const m = MOVES[id];
    if (!m) return undefined;
    const type = TYPE_ID[m.type];
    if (type === undefined) return undefined;
    return { id, name: m.name, type, power: m.power, lockIn: m.lockIn };
  },
};

/** Power assumed for a move whose metadata is missing. Same 30-power spirit as
 *  moves.ts's picker, nudged to a plausible mid attacker so an unknown-heavy
 *  moveset still produces a usable estimate. Any verdict that had to lean on
 *  this is reported at LOW confidence and is barred from forcing an action. */
export const UNKNOWN_POWER = 40;

// ---------------------------------------------------------------- damage

/** Gen 1 damage roll range: the final multiplier is rand(217..255)/255. */
export const ROLL_MIN = 217;
export const ROLL_MAX = 255;

export interface DamageInput {
  level: number;
  power: number;
  atk: number;          // effective Attack (physical) or Special (special)
  def: number;          // effective Defense (physical) or Special (special)
  stab: boolean;
  /** Attacker type vs each defender type, as ROM tenths (10 = 1x). */
  eff1x10: number;
  eff2x10: number;
  roll: number;         // 217..255
}

/**
 * The Gen 1 formula, with its truncations in the cartridge's order:
 *
 *   base = ((2*L/5 + 2) * power * A / D) / 50 + 2
 *   then x1.5 STAB, then each type multiplier as *x10/10, then *roll/255
 *
 * Every division truncates. Critical hits are NOT modelled: in Gen 1 they are a
 * speed-derived probability that doubles the level term, and a verdict that
 * assumed them would systematically over-promise. They are part of the reason a
 * CLOSE fight is called CLOSE and not WINNABLE.
 */
export function damage(i: DamageInput): number {
  if (i.power <= 0 || i.atk <= 0 || i.def <= 0) return 0;
  let d = Math.floor(Math.floor(Math.floor(2 * i.level / 5 + 2) * i.power * i.atk / i.def) / 50) + 2;
  if (i.stab) d = Math.floor(d * 3 / 2);
  d = Math.floor(d * i.eff1x10 / 10);
  d = Math.floor(d * i.eff2x10 / 10);
  if (d === 0) return 0;                       // immunity, or rounded away
  d = Math.floor(d * i.roll / 255);
  return Math.max(1, d);                       // a connecting hit always does >=1
}

// ---------------------------------------------------------------- combatants

export interface CombatantMove { id: number; pp: number }

/** One side of the exchange, as read from RAM (battle.ts collects this). All
 *  stats are the EFFECTIVE in-battle values, already carrying stat stages and
 *  badge boosts, because that is what Gen 1 keeps in the wBattleMon and
 *  wEnemyMon blocks. */
export interface Combatant {
  species: number;
  level: number;
  hp: number; maxHp: number;
  atk: number; def: number; spc: number; speed: number;
  type1: number; type2: number;
  status: number;                 // wBattleMonStatus / wEnemyMonStatus bitfield
  moves: CombatantMove[];
}

/** Gen 1 status bits (wBattleMonStatus): SLP is the low 3 bits (turn counter),
 *  then PSN/BRN/FRZ/PAR. Only SLP and FRZ matter here — they are the two that
 *  cost the holder its turn outright. */
export const STATUS = { SLP_MASK: 0x07, PSN: 0x08, BRN: 0x10, FRZ: 0x20, PAR: 0x40 } as const;
export const isIncapacitated = (status: number): boolean =>
  (status & STATUS.SLP_MASK) !== 0 || (status & STATUS.FRZ) !== 0;

export interface MoveEstimate {
  slot: number;
  move: MoveMeta | null;          // null = metadata unknown for this move id
  id: number;
  dmg: number;                    // damage at the requested roll
  eff: number;                    // type multiplier as a float, for prose
  unknown: boolean;
}

/** Damage every usable move in `me`'s set would do to `foe` at one roll.
 *  Moves with no PP are skipped: a move that cannot be selected is not part of
 *  this exchange. Lock-in moves ARE included — the harness dislikes them
 *  (moves.ts) but they still do damage, and pretending otherwise would make a
 *  RAGE-only Charmeleon look like it deals nothing. */
export function moveEstimates(me: Combatant, foe: Combatant, src: MoveSource,
                              chart: TypeChart, roll: number): MoveEstimate[] {
  const out: MoveEstimate[] = [];
  me.moves.forEach((mv, slot) => {
    if (!mv || !mv.id || (mv.pp & 0x3f) <= 0) return;
    const meta = src.get(mv.id);
    const type = meta?.type ?? TYPE.NORMAL;
    const power = meta ? meta.power : UNKNOWN_POWER;
    const phys = isPhysical(type);
    const eff1x10 = chart.x10(type, foe.type1);
    const eff2x10 = foe.type2 === foe.type1 ? 10 : chart.x10(type, foe.type2);
    const dmg = damage({
      level: me.level, power,
      atk: phys ? me.atk : me.spc,
      def: phys ? foe.def : foe.spc,
      stab: type === me.type1 || type === me.type2,
      eff1x10, eff2x10, roll,
    });
    out.push({ slot, move: meta ?? null, id: mv.id, dmg,
               eff: (eff1x10 / 10) * (eff2x10 / 10), unknown: !meta });
  });
  return out;
}

const best = (es: MoveEstimate[]): MoveEstimate | null =>
  es.reduce<MoveEstimate | null>((b, e) => (b === null || e.dmg > b.dmg ? e : b), null);

const turnsToKO = (hp: number, dmg: number): number =>
  dmg <= 0 ? Infinity : Math.ceil(hp / dmg);

// ---------------------------------------------------------------- verdict

export type Verdict = "WINNABLE" | "CLOSE" | "UNWINNABLE" | "UNKNOWN";

export interface WinnabilityOpts {
  src?: MoveSource;
  chart?: TypeChart;
  /** Unfainted mons the FOE still has (wEnemyPartyCount minus fainted). 1 for
   *  a wild battle. Only widens the estimate — see `clearTurns`. */
  foeRemaining?: number;
}

export interface Winnability {
  verdict: Verdict;
  confidence: "high" | "low";     // low = some move metadata was missing
  bestSlot: number;               // best move by expected damage, -1 if none
  bestName: string;
  myDmg: number;                  // pessimistic damage per turn (roll 217)
  foeDmg: number;                 // pessimistic-for-me foe damage (roll 255)
  myTurns: number;                // turns for me to KO the ACTIVE foe (pessimistic)
  foeTurns: number;               // turns for the foe to KO me (pessimistic)
  clearTurns: number;             // turns to clear the foe's remaining party
  faster: boolean;
  eff: number;                    // type multiplier of my best move
  reason: string;
}

/**
 * Verdict for THIS exchange, computed twice under opposite assumptions.
 *
 * The asymmetry is the whole design. A verdict is a claim, and each claim is
 * evaluated against the assumption that would refute it:
 *   - UNWINNABLE is claimed only if I lose even at my BEST roll (255) against
 *     the foe's WORST (217), with credit for a sleeping/frozen foe.
 *   - WINNABLE is claimed only if I win at my WORST roll against the foe's
 *     BEST, with no status credit.
 *   - Everything in between is CLOSE, which forces nothing and says so.
 * That is what makes it safe to hang a forced flee off UNWINNABLE later: the
 * verdict cannot be produced by a lucky rounding.
 *
 * Fail-closed on data: if any move in the exchange had no metadata, confidence
 * is "low" and UNWINNABLE is downgraded to CLOSE. An unknown move might be the
 * one that wins the fight, and the caller is about to spend a real action on
 * this answer (softlock.ts refuses to force at low confidence).
 */
export function winnability(me: Combatant, foe: Combatant, opts: WinnabilityOpts = {}): Winnability {
  const src = opts.src ?? DEFAULT_MOVES;
  const chart = opts.chart ?? DEFAULT_CHART;
  const remaining = Math.max(1, Math.floor(opts.foeRemaining ?? 1));

  const mineOpt = moveEstimates(me, foe, src, chart, ROLL_MAX);
  const minePes = moveEstimates(me, foe, src, chart, ROLL_MIN);
  const foeOpt = moveEstimates(foe, me, src, chart, ROLL_MAX);
  const foePes = moveEstimates(foe, me, src, chart, ROLL_MIN);

  const bOpt = best(mineOpt), bPes = best(minePes);
  const fOpt = best(foeOpt), fPes = best(foePes);
  const mineUnknown = mineOpt.some(e => e.unknown);
  const unknown = mineUnknown || foeOpt.some(e => e.unknown);
  // A Gen 1 speed tie is resolved randomly, so "I move first" is an optimistic
  // reading of it and "the foe moves first" is the pessimistic one. Each pass
  // takes the version that argues against its own claim.
  const faster = me.speed > foe.speed;
  const fasterOpt = me.speed >= foe.speed;

  // Pessimistic pass (me at 217 vs foe at 255): the WINNABLE claim.
  const myTurnsPes = turnsToKO(foe.hp, bPes?.dmg ?? 0);
  const foeTurnsPes = turnsToKO(me.hp, fOpt?.dmg ?? 0);
  const clearTurns = myTurnsPes === Infinity ? Infinity : myTurnsPes * remaining;
  const iWinPes = faster ? clearTurns <= foeTurnsPes : clearTurns < foeTurnsPes;

  // Optimistic pass (me at 255 vs foe at 217, foe loses turns to SLP/FRZ):
  // the UNWINNABLE claim. A sleeping foe is credited exactly ONE free turn —
  // Gen 1 sleep lasts 1-7 turns and assuming more would be wishful.
  const freeTurns = isIncapacitated(foe.status) ? 1 : 0;
  const myTurnsOpt = turnsToKO(foe.hp, bOpt?.dmg ?? 0);
  const foeTurnsOpt = turnsToKO(me.hp, fPes?.dmg ?? 0) + freeTurns;
  const iWinOpt = fasterOpt ? myTurnsOpt <= foeTurnsOpt : myTurnsOpt < foeTurnsOpt;

  const effOf = (e: MoveEstimate | null) => e ? e.eff : 1;
  let verdict: Verdict;
  if (iWinPes) verdict = "WINNABLE";
  else if (!iWinOpt) verdict = "UNWINNABLE";
  else verdict = "CLOSE";

  // No usable damaging move at all is its own answer: an all-status moveset (or
  // a fully immune matchup — Normal into Ghost) can never end the fight. Only
  // MY unknowns can rescue that reading; the foe's have no bearing on whether
  // I can deal damage.
  if ((bOpt?.dmg ?? 0) <= 0) verdict = mineUnknown ? "UNKNOWN" : "UNWINNABLE";
  else if (verdict === "UNWINNABLE" && unknown) verdict = "CLOSE";

  const eff = effOf(bPes ?? bOpt);
  const name = bPes?.move?.name ?? (bPes ? `MOVE${bPes.id}` : "none");
  const effWord = eff === 0 ? "no effect" : eff >= 2 ? `${eff}x super effective`
    : eff <= 0.5 ? `${eff}x resisted` : "neutral";
  const turnsWord = (t: number) => t === Infinity ? "never" : `${t}`;
  const reason =
    `${name} ${effWord}, ${turnsWord(clearTurns)} turn(s) to clear` +
    `${remaining > 1 ? ` ${remaining} foes` : ""} vs ${turnsWord(foeTurnsPes)} to be KO'd` +
    `, ${faster ? "I move first" : fasterOpt ? "speed tie (coin flip)" : "foe moves first"}` +
    `${unknown ? " (some move data unknown — LOW confidence)" : ""}`;

  return {
    verdict, confidence: unknown ? "low" : "high",
    bestSlot: bPes?.slot ?? bOpt?.slot ?? -1, bestName: name,
    myDmg: bPes?.dmg ?? 0, foeDmg: fOpt?.dmg ?? 0,
    myTurns: myTurnsPes, foeTurns: foeTurnsPes, clearTurns,
    faster, eff, reason,
  };
}
