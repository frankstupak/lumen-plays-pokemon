// wq#1181 (LPP roadmap item 5): Gen 1 damage arithmetic and the winnability
// verdict — the numbers behind "can this fight actually be won".
//
// Everything here is PURE: no emulator, no ROM, no model call. The caller reads
// live battle RAM (levels, HP, Attack/Defense/Special/Speed, both type bytes for
// both sides — all of which Gen 1 keeps in WRAM, see roms/pokeblue.sym
// wBattleMon*/wEnemyMon*) and hands it in. That is why no species base-stat
// table appears in this file: the battle struct already holds the *computed*
// stats, which beats re-deriving them from base stats + DVs + stat experience.
//
// ITEM-4 SEAM (wq#1180, ROM decodes): the type chart below is the only piece of
// static game data here, transcribed from pokered `data/types/type_matchups.asm`
// (the TypeEffects table). It is NOT ROM-verified in this worktree — roms/ ships
// only .sym files, never the cart. `setTypeChart()` exists so item 4's decoded
// table replaces it at boot with zero changes to callers; until then this table
// is the documented fallback.
//
// Formula (Gen 1, pokered engine/battle/effects.asm):
//   base = floor(floor(floor(2*L/5 + 2) * Power * A / D) / 50) + 2
//   base = floor(base * STAB) * effectiveness, then * random(217..255)/255
// A/D are Special for a special-type move and Attack/Defense otherwise; Gen 1
// splits physical vs special by TYPE, not per move.

import { MOVES } from "./moves";

export type TypeName =
  | "NORMAL" | "FIGHTING" | "FLYING" | "POISON" | "GROUND" | "ROCK" | "BUG"
  | "GHOST" | "FIRE" | "WATER" | "GRASS" | "ELECTRIC" | "PSYCHIC" | "ICE" | "DRAGON";

/** Gen 1 type bytes as stored in wBattleMonType1/2 and wEnemyMonType1/2.
 *  6 and 9..0x13 are unused in Gen 1; an unknown byte decodes to null. */
export const TYPE_BY_ID: Record<number, TypeName> = {
  0x00: "NORMAL", 0x01: "FIGHTING", 0x02: "FLYING", 0x03: "POISON",
  0x04: "GROUND", 0x05: "ROCK", 0x07: "BUG", 0x08: "GHOST",
  0x14: "FIRE", 0x15: "WATER", 0x16: "GRASS", 0x17: "ELECTRIC",
  0x18: "PSYCHIC", 0x19: "ICE", 0x1a: "DRAGON",
};

export function typeOf(byte: number): TypeName | null {
  return TYPE_BY_ID[byte] ?? null;
}

/** Gen 1 has no per-move physical/special flag: the move's TYPE decides. */
const SPECIAL_TYPES: ReadonlySet<string> =
  new Set(["FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON"]);

export function isSpecial(t: TypeName | null): boolean {
  return t !== null && SPECIAL_TYPES.has(t);
}

/** [attacking type, defending type, multiplier]. Only non-1x pairs are listed,
 *  exactly as the ROM stores them. Gen 1 oddities kept deliberately: POISON and
 *  BUG are super-effective on each other, GHOST does nothing to PSYCHIC, and
 *  ICE is neutral into FIRE. */
export type Matchup = readonly [TypeName, TypeName, number];

export const GEN1_MATCHUPS: readonly Matchup[] = [
  ["WATER", "FIRE", 2], ["FIRE", "GRASS", 2], ["FIRE", "ICE", 2],
  ["GRASS", "WATER", 2], ["ELECTRIC", "WATER", 2], ["WATER", "ROCK", 2],
  ["GROUND", "FLYING", 0], ["WATER", "WATER", 0.5], ["FIRE", "FIRE", 0.5],
  ["ELECTRIC", "ELECTRIC", 0.5], ["ICE", "ICE", 0.5], ["GRASS", "GRASS", 0.5],
  ["PSYCHIC", "PSYCHIC", 0.5], ["FIRE", "WATER", 0.5], ["WATER", "GRASS", 0.5],
  ["ELECTRIC", "GRASS", 0.5], ["NORMAL", "ROCK", 0.5], ["NORMAL", "GHOST", 0],
  ["GHOST", "GHOST", 2], ["FIRE", "BUG", 2], ["FIRE", "ROCK", 0.5],
  ["WATER", "GROUND", 2], ["ELECTRIC", "GROUND", 0], ["ELECTRIC", "FLYING", 2],
  ["GRASS", "GROUND", 2], ["GRASS", "BUG", 0.5], ["GRASS", "POISON", 0.5],
  ["GRASS", "ROCK", 2], ["GRASS", "FLYING", 0.5], ["ICE", "WATER", 0.5],
  ["ICE", "GRASS", 2], ["ICE", "GROUND", 2], ["ICE", "FLYING", 2],
  ["FIGHTING", "NORMAL", 2], ["FIGHTING", "POISON", 0.5], ["FIGHTING", "FLYING", 0.5],
  ["FIGHTING", "PSYCHIC", 0.5], ["FIGHTING", "BUG", 0.5], ["FIGHTING", "ROCK", 2],
  ["FIGHTING", "ICE", 2], ["FIGHTING", "GHOST", 0], ["POISON", "GRASS", 2],
  ["POISON", "POISON", 0.5], ["POISON", "GROUND", 0.5], ["POISON", "BUG", 2],
  ["POISON", "ROCK", 0.5], ["POISON", "GHOST", 0.5], ["GROUND", "FIRE", 2],
  ["GROUND", "ELECTRIC", 2], ["GROUND", "GRASS", 0.5], ["GROUND", "BUG", 0.5],
  ["GROUND", "ROCK", 2], ["GROUND", "POISON", 2], ["FLYING", "ELECTRIC", 0.5],
  ["FLYING", "FIGHTING", 2], ["FLYING", "BUG", 2], ["FLYING", "GRASS", 2],
  ["FLYING", "ROCK", 0.5], ["PSYCHIC", "FIGHTING", 2], ["PSYCHIC", "POISON", 2],
  ["BUG", "FIRE", 0.5], ["BUG", "GRASS", 2], ["BUG", "FIGHTING", 0.5],
  ["BUG", "FLYING", 0.5], ["BUG", "PSYCHIC", 2], ["BUG", "GHOST", 0.5],
  ["BUG", "POISON", 2], ["ROCK", "FIRE", 2], ["ROCK", "FIGHTING", 0.5],
  ["ROCK", "GROUND", 0.5], ["ROCK", "FLYING", 2], ["ROCK", "BUG", 2],
  ["ROCK", "ICE", 2], ["GHOST", "NORMAL", 0], ["GHOST", "PSYCHIC", 0],
  ["FIRE", "DRAGON", 0.5], ["WATER", "DRAGON", 0.5], ["ELECTRIC", "DRAGON", 0.5],
  ["GRASS", "DRAGON", 0.5], ["ICE", "DRAGON", 2], ["DRAGON", "DRAGON", 2],
];

function buildChart(rows: readonly Matchup[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const [a, d, x] of rows) m.set(`${a}>${d}`, x);
  return m;
}

let CHART = buildChart(GEN1_MATCHUPS);

/** ITEM-4 SEAM: swap the static table for a ROM-decoded one at boot. */
export function setTypeChart(rows: readonly Matchup[]): void { CHART = buildChart(rows); }

/** Damage multiplier of `atk` into a defender of `d1`/`d2`. Unknown types are
 *  treated as neutral rather than guessed — a missing decode must never invent
 *  an immunity that force-flees a winnable fight. */
export function effectiveness(atk: TypeName | null, d1: TypeName | null, d2: TypeName | null = null): number {
  if (!atk) return 1;
  let x = 1;
  if (d1) x *= CHART.get(`${atk}>${d1}`) ?? 1;
  if (d2 && d2 !== d1) x *= CHART.get(`${atk}>${d2}`) ?? 1;
  return x;
}

export interface Combatant {
  level: number;
  hp: number; maxHp: number;
  attack: number; defense: number; special: number; speed: number;
  type1: TypeName | null; type2: TypeName | null;
}

export interface MoveInfo {
  id: number; name: string;
  type: TypeName | null; power: number;
  lockIn?: boolean;
  /** Set when this entry is a stand-in for a move the table does not know.
   *  Stand-ins are always neutral-typed mid-power attacks: they can make a
   *  fight look winnable (safe — we stay) but never unwinnable (unsafe — we
   *  flee a fight we could have taken). Any stand-in on the FOE's side drops
   *  the verdict to low confidence, which bars it from forcing anything. */
  assumed?: boolean;
}

/** One side's battle stats exactly as Gen 1 keeps them in WRAM (the wBattleMon
 *  and wEnemyMon stat blocks in roms/pokeblue.sym). These are the COMPUTED
 *  stats — base, DVs and stat experience are already folded in — which is why
 *  nothing here needs a species base-stat table. */
export interface SideStats {
  attack: number; defense: number; speed: number; special: number;
  type1: number; type2: number;      // raw Gen 1 type bytes; see TYPE_BY_ID
}

/** RAM numbers -> the shape the calc wants. */
export function combatant(level: number, hp: number, maxHp: number, s: SideStats): Combatant {
  return {
    level, hp, maxHp,
    attack: s.attack, defense: s.defense, special: s.special, speed: s.speed,
    type1: typeOf(s.type1), type2: typeOf(s.type2),
  };
}

/** Move IDs -> move metadata. With `pp` supplied, only slots with PP left are
 *  returned (our side); without it every non-empty slot is (the foe's, whose PP
 *  we deliberately do not trust). A move src/moves.ts does not carry becomes a
 *  neutral 30-power stand-in flagged `assumed`. */
export function moveInfos(ids: number[], pp?: number[]): MoveInfo[] {
  const out: MoveInfo[] = [];
  ids.forEach((id, i) => {
    if (!id) return;
    if (pp && (pp[i] & 0x3f) <= 0) return;
    const meta = MOVES[id];
    if (meta) out.push({ id, name: meta.name, type: meta.type as TypeName, power: meta.power, lockIn: meta.lockIn });
    else out.push({ id, name: `MOVE${id}`, type: null, power: 30, assumed: true });
  });
  return out;
}

export interface DamageRange {
  min: number; max: number; avg: number;
  eff: number;      // type multiplier applied
  stab: boolean;
}

/** Gen 1 damage for one hit of `move`. Returns all-zero when the move cannot
 *  damage (status move, immunity, or missing stats). */
export function damageRange(attacker: Combatant, defender: Combatant, move: MoveInfo): DamageRange {
  const eff = effectiveness(move.type, defender.type1, defender.type2);
  const stab = !!move.type && (move.type === attacker.type1 || move.type === attacker.type2);
  const zero: DamageRange = { min: 0, max: 0, avg: 0, eff, stab };
  if (move.power <= 0 || eff === 0) return zero;
  // Gen 1 reads Special on both sides for a special-type move, Attack/Defense
  // otherwise — there is no per-move category, only the type's.
  const special = isSpecial(move.type);
  const a = special ? attacker.special : attacker.attack;
  const dStat = special ? defender.special : defender.defense;
  if (!(a > 0) || !(dStat > 0) || !(attacker.level > 0)) return zero;
  let base = Math.floor(Math.floor(Math.floor((2 * attacker.level) / 5 + 2) * move.power * a / dStat) / 50) + 2;
  if (stab) base = Math.floor(base * 1.5);
  base = Math.floor(base * eff);
  if (base < 1) base = 1;             // a connecting hit always does at least 1
  const max = base;
  const min = Math.max(1, Math.floor((base * 217) / 255));
  return { min, max, avg: Math.max(1, Math.floor((min + max) / 2)), eff, stab };
}

/** Turns to drop `hp` at `perTurn` damage. Infinity when we cannot damage. */
export function hitsToKO(hp: number, perTurn: number): number {
  if (!(perTurn > 0)) return Infinity;
  return Math.ceil(hp / perTurn);
}

export type Verdict = "fight" | "flee" | "unknown";

export interface WinnabilityInput {
  me: Combatant;
  foe: Combatant;
  myMoves: MoveInfo[];       // moves with PP left; callers filter first
  foeMoves: MoveInfo[];      // decoded enemy moves; [] when unknown
  wild: boolean;
  healHp?: number;           // total HP the bag can restore mid-battle (potions)
}

export interface Winnability {
  verdict: Verdict;
  /** "high" only when both sides' numbers were fully known. Only a high-confidence
   *  "flee" is ever allowed to FORCE an action. */
  confidence: "high" | "low";
  best: { move: MoveInfo; dmg: DamageRange } | null;
  turnsToKOFoe: number;
  turnsToKOMe: number;
  meFirst: boolean;
  reason: string;
  line: string;
}

/** Foe damage when its moveset is unknown: a same-type 40-power attack, which is
 *  roughly the early-game median. Used only to keep the verdict honest — any
 *  verdict resting on it is confidence "low" and never forces. */
const ASSUMED_FOE_POWER = 40;

/**
 * Can this fight be won from here? Compares "turns we need to KO it" against
 * "turns it needs to KO us", respecting who moves first and what the bag can
 * heal. Deliberately conservative: anything it cannot compute returns "unknown"
 * (hand back to the brain), and only a fight we provably cannot win returns a
 * high-confidence "flee".
 */
export function winnability(inp: WinnabilityInput): Winnability {
  const { me, foe } = inp;
  const unknown = (reason: string): Winnability => ({
    verdict: "unknown", confidence: "low", best: null,
    turnsToKOFoe: Infinity, turnsToKOMe: Infinity,
    meFirst: false, reason, line: `WINNABILITY unknown - ${reason}`,
  });
  if (!(me.maxHp > 0) || !(foe.maxHp > 0) || !(me.level > 0) || !(foe.level > 0))
    return unknown("battle stats not settled yet");
  if (!(me.attack > 0) || !(foe.defense > 0))
    return unknown("stat block unreadable");

  let best: { move: MoveInfo; dmg: DamageRange } | null = null;
  for (const mv of inp.myMoves) {
    const dmg = damageRange(me, foe, mv);
    if (dmg.avg <= 0) continue;
    if (!best || dmg.avg > best.dmg.avg) best = { move: mv, dmg };
  }

  // Their side. An unknown moveset gets an assumed same-type attack rather than
  // zero: assuming the foe is harmless is how a losing fight looks winnable.
  let foeDmg = 0;
  let foeKnown = inp.foeMoves.length > 0 && !inp.foeMoves.some(m => m.assumed);
  for (const mv of inp.foeMoves) {
    const d = damageRange(foe, me, mv);
    if (d.avg > foeDmg) foeDmg = d.avg;
  }
  if (foeDmg <= 0) {
    foeKnown = false;
    const assumed: MoveInfo = {
      id: -1, name: "assumed", power: ASSUMED_FOE_POWER,
      type: foe.type1 ?? "NORMAL",
    };
    foeDmg = damageRange(foe, me, assumed).avg;
  }

  const effectiveHp = me.hp + Math.max(0, inp.healHp ?? 0);
  const turnsToKOFoe = best ? hitsToKO(foe.hp, best.dmg.avg) : Infinity;
  const turnsToKOMe = hitsToKO(effectiveHp, foeDmg);
  // Gen 1 breaks a speed tie randomly; treating a tie as "they move first" keeps
  // the verdict on the safe side of the coin flip.
  const meFirst = me.speed > foe.speed;
  const need = meFirst ? turnsToKOMe : turnsToKOMe - 1;

  const summary = (verdict: Verdict, confidence: "high" | "low", reason: string): Winnability => ({
    verdict, confidence, best, turnsToKOFoe, turnsToKOMe, meFirst, reason,
    line: `WINNABILITY ${verdict}${confidence === "low" ? "?" : ""} - ${reason}` +
      ` (we KO in ${turnsToKOFoe === Infinity ? "never" : turnsToKOFoe},` +
      ` they KO in ${turnsToKOMe === Infinity ? "never" : turnsToKOMe},` +
      ` ${meFirst ? "we" : "they"} move first)` +
      // A trainer battle cannot be run from, so "flee" there is a warning about
      // the fight we are already committed to, not an instruction.
      (verdict === "flee" && !inp.wild ? " [TRAINER - no exit, this is a warning]" : ""),
  });

  if (!best) {
    // No move of ours can deal a point of damage — immunity or status-only.
    // This one does not depend on their numbers at all, so it is high
    // confidence even with an unknown enemy moveset.
    const why = inp.myMoves.length
      ? "no move of ours damages this foe (immune or status-only)"
      : "no usable move with PP";
    return summary("flee", "high", why);
  }
  if (turnsToKOMe === Infinity) return summary("fight", foeKnown ? "high" : "low", "it cannot damage us");
  if (turnsToKOFoe <= need)
    return summary("fight", foeKnown ? "high" : "low",
      `we out-race it${(inp.healHp ?? 0) > 0 ? " with the bag's heals" : ""}`);
  return summary("flee", foeKnown ? "high" : "low",
    `it out-races us — ${best.move.name} needs ${turnsToKOFoe} turns, we survive ${turnsToKOMe}`);
}
