// wq#1180 — the three ROM tables every battle fact ultimately comes from:
// Moves, TypeEffects and BaseStats, decoded from THIS ROM through the pret
// symbol table. Item 4 of kb/lpp-improvement-plan.md, and the foundation the
// winnability verdict (item 5) is built on.
//
// WHY THIS EXISTS. moves.ts carried a hand-typed table of 34 moves and, for
// everything else, `power ?? 30`. The ROM has all 165. Every move the party
// learns for the rest of the campaign — every TM, every level-up past Cerulean —
// was a guess, and pickBestMove was choosing between guesses. The type chart
// did not exist at all, so "is this move any good against that foe" had no
// answer even in principle. All three tables are ~5KB of ROM sitting behind a
// symbol we already parse.
//
// SAME PATTERN AS names.ts AND trainers.ts, deliberately:
//   - every length comes from SymbolTable.nextAddr(), never a literal, so a
//     different ROM build fails loudly instead of reading off the end of a table;
//   - nothing is transcribed by hand except the GOLDEN_* anchors below, whose
//     only job is to catch a misaligned decode;
//   - FAIL-CLOSED: a table that disagrees with its anchor is dropped whole and
//     reported, and the caller keeps its previous behaviour. A confidently wrong
//     move table is worse than the guess it replaced, because the guess at least
//     announced itself.
//
// THE ANCHORS ARE NOT DECORATION. Two of the three tables live in the same bank
// ($0e) back to back; an off-by-one in the entry stride reads plausible-looking
// numbers for hundreds of entries before it reads anything obviously wrong. The
// anchors are the only thing standing between that and a silent lie.
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import { decodeGen1 } from "./names";

// ── type ids ───────────────────────────────────────────────────────────────
// Gen 1 numbers the physical types 0..8 and the special types 20..26, with the
// gap in between unused (6 = BIRD, a cut type that appears in no moveset). The
// split is that gap: attacks of type < 20 use Attack/Defense, >= 20 use Special.
// These are format constants, not table data — the ROM has no id->name table
// this decoder could read instead — so they are verified in the other direction:
// the GOLDEN_MOVES anchor asserts EMBER is FIRE and DIG is GROUND, which cannot
// hold unless these ids are right.
export const TYPE_NAMES: Record<number, string> = {
  0: "NORMAL", 1: "FIGHTING", 2: "FLYING", 3: "POISON", 4: "GROUND",
  5: "ROCK", 6: "BIRD", 7: "BUG", 8: "GHOST",
  20: "FIRE", 21: "WATER", 22: "GRASS", 23: "ELECTRIC", 24: "PSYCHIC",
  25: "ICE", 26: "DRAGON",
};
/** First special-category type id. Below this, damage uses Attack/Defense. */
export const TYPE_SPECIAL_MIN = 20;
export function typeName(id: number): string { return TYPE_NAMES[id] ?? `TYPE${id}`; }
export function isSpecialType(id: number): boolean { return id >= TYPE_SPECIAL_MIN; }

// ── Moves ──────────────────────────────────────────────────────────────────

export interface RomMove {
  id: number;
  name: string;
  /** Display type name, e.g. "FIRE". */
  type: string;
  typeId: number;
  power: number;
  /** Accuracy as a percentage, 0..100 (rounded from the ROM byte). */
  accuracy: number;
  /** The raw accuracy byte, 0..255 — what the Gen 1 hit test actually rolls
   *  against. Kept alongside the percentage so a damage/hit model never has to
   *  re-derive it from a rounded number. */
  accRaw: number;
  pp: number;
  /** The move's effect id. Exposed because lockIn is derived from it. */
  effect: number;
  /** wq#587 policy, now DERIVED rather than hand-listed: this move costs the
   *  harness at least one menu-less turn, so the menu-driven battle loop cannot
   *  steer while it runs. See LOCK_IN_EFFECTS. */
  lockIn: boolean;
}

/**
 * Effect ids that take the move menu away for one or more turns.
 *
 * MEASURED OUT OF THIS ROM, not recalled: grouping all 165 moves by effect byte
 * yields exactly these closed sets, and each set is exactly the Gen 1 mechanic
 * named beside it. That mutual agreement is the check — an effect id that meant
 * something else would not partition the move list this cleanly.
 *
 *   39 charge   RAZOR WIND, SOLARBEAM, DIG, SKULL BASH, SKY ATTACK
 *   43 fly      FLY (its own effect: the semi-invulnerable turn)
 *   27 thrash   THRASH, PETAL DANCE                (3-4 locked turns)
 *   42 trapping BIND, WRAP, FIRE SPIN, CLAMP       (2-5 locked turns)
 *   26 bide     BIDE                               (2-3 storing turns)
 *   80 recharge HYPER BEAM                         (the turn after a KO-less hit)
 *   81 rage     RAGE                               (locked until the battle ENDS)
 *
 * wq#587 shipped with three of these hand-listed (DIG, BIDE, RAGE); the other
 * twelve moves were a wedge waiting for the party to learn one.
 */
export const LOCK_IN_EFFECTS: Record<number, string> = {
  39: "charge", 43: "fly", 27: "thrash", 42: "trapping",
  26: "bide", 80: "recharge", 81: "rage",
};

/** Bytes per Moves entry: id, effect, power, type, accuracy, pp. */
const MOVE_ENTRY = 6;

/**
 * All 165 moves, keyed by internal move id (1-based, as stored in a party
 * mon's move slots). Throws if the table length is not a whole number of
 * entries or the names do not run out exactly — loadRomTables() turns that into
 * a fallback rather than letting it reach a caller.
 */
export function decodeMoves(rom: Rom, sym: SymbolTable): Record<number, RomMove> {
  const mv = sym.sym("Moves");
  const span = sym.nextAddr(mv.bank, mv.addr) - mv.addr;
  if (span % MOVE_ENTRY !== 0)
    throw new Error(`Moves span ${span} is not a multiple of ${MOVE_ENTRY}`);
  const count = span / MOVE_ENTRY;

  // MoveNames is the LAST symbol in its bank, so nextAddr() cannot bound it.
  // Parse exactly `count` 0x50-terminated strings instead and let running out
  // early be the error — that is the same alignment check from the other side.
  const mn = sym.sym("MoveNames");
  const names: string[] = [];
  let cur: number[] = [];
  for (const b of rom.bytes(mn.bank, mn.addr, 0x2000)) {
    if (b === 0x50) { names.push(decodeGen1(cur)); cur = []; if (names.length >= count) break; }
    else cur.push(b);
  }
  if (names.length !== count)
    throw new Error(`MoveNames yielded ${names.length} names for ${count} moves`);

  const out: Record<number, RomMove> = {};
  for (let id = 1; id <= count; id++) {
    const b = rom.bytes(mv.bank, mv.addr + (id - 1) * MOVE_ENTRY, MOVE_ENTRY);
    // Byte 0 is the move's own animation id, which equals the move id for every
    // entry. Free alignment check, so take it.
    if (b[0] !== id) throw new Error(`Moves entry ${id} self-identifies as ${b[0]}`);
    out[id] = {
      id, name: names[id - 1], typeId: b[3], type: typeName(b[3]),
      power: b[2],
      accuracy: Math.round(b[4] * 100 / 255), accRaw: b[4],
      pp: b[5], effect: b[1], lockIn: b[1] in LOCK_IN_EFFECTS,
    };
  }
  return out;
}

/**
 * The retired hand-typed table (wq#587's 25 moves), kept for exactly two jobs:
 * it is the ANCHOR decodeMoves() is checked against, and it is the FALLBACK the
 * harness runs on when that check fails. It is no longer the source of truth
 * for anything, and it must not grow — a 35th entry would be a hand-typed fact
 * about a ROM we now read directly.
 *
 * Every entry below was re-verified byte-for-byte against pokeblue.gb when it
 * was demoted to an anchor, so a disagreement means the DECODE moved, which is
 * the only thing worth reporting.
 */
export const GOLDEN_MOVES: Record<number, { name: string; type: string; power: number }> = {
  1:  { name: "POUND",         type: "NORMAL",  power: 40 },
  10: { name: "SCRATCH",       type: "NORMAL",  power: 40 },
  33: { name: "TACKLE",        type: "NORMAL",  power: 35 },
  28: { name: "SAND-ATTACK",   type: "NORMAL",  power: 0 },
  31: { name: "FURY ATTACK",   type: "NORMAL",  power: 15 },
  40: { name: "POISON STING",  type: "POISON",  power: 15 },
  43: { name: "LEER",          type: "NORMAL",  power: 0 },
  45: { name: "GROWL",         type: "NORMAL",  power: 0 },
  52: { name: "EMBER",         type: "FIRE",    power: 40 },
  55: { name: "WATER GUN",     type: "WATER",   power: 40 },
  64: { name: "PECK",          type: "FLYING",  power: 35 },
  71: { name: "ABSORB",        type: "GRASS",   power: 20 },
  74: { name: "GROWTH",        type: "NORMAL",  power: 0 },
  77: { name: "POISONPOWDER",  type: "POISON",  power: 0 },
  78: { name: "STUN SPORE",    type: "GRASS",   power: 0 },
  79: { name: "SLEEP POWDER",  type: "GRASS",   power: 0 },
  81: { name: "STRING SHOT",   type: "BUG",     power: 0 },
  91: { name: "DIG",           type: "GROUND",  power: 100 },
  93: { name: "CONFUSION",     type: "PSYCHIC", power: 50 },
  98: { name: "QUICK ATTACK",  type: "NORMAL",  power: 40 },
  99: { name: "RAGE",          type: "NORMAL",  power: 20 },
  106:{ name: "HARDEN",        type: "NORMAL",  power: 0 },
  111:{ name: "DEFENSE CURL",  type: "NORMAL",  power: 0 },
  116:{ name: "FOCUS ENERGY",  type: "NORMAL",  power: 0 },
  117:{ name: "BIDE",          type: "NORMAL",  power: 0 },
};

/** wq#587's three lock-in moves, as the anchor for the derived set: whatever
 *  LOCK_IN_EFFECTS decides, it has to still agree with what shipped. */
export const GOLDEN_LOCK_IN = [91, 99, 117];

// ── TypeEffects ────────────────────────────────────────────────────────────

export interface TypeEffect { atk: number; def: number; x10: number }

/** Bytes per TypeEffects entry: attacking type, defending type, multiplier x10. */
const TE_ENTRY = 3;

/**
 * The full Gen 1 type chart as the ROM stores it: a flat list of non-1.0
 * matchups terminated by 0xFF. Absence means 1.0 — the table has no neutral
 * entries, which is why a "type chart" hardcoded from a modern generation would
 * be wrong in both directions (Gen 1 has PSYCHIC->GHOST as neutral, the famous
 * bug, and GHOST->PSYCHIC as 0).
 */
export function decodeTypeEffects(rom: Rom, sym: SymbolTable): TypeEffect[] {
  const te = sym.sym("TypeEffects");
  const span = sym.nextAddr(te.bank, te.addr) - te.addr;
  const out: TypeEffect[] = [];
  // The terminator is ONE byte, so the table's span is 3n+1 and the last read
  // is a single byte past the last whole entry. Bounding the loop at
  // `o + TE_ENTRY <= span` puts the terminator out of reach and turns a healthy
  // table into a "no terminator" error — which is exactly what it did until
  // probe_romdecode1180 caught it.
  for (let o = 0; o < span; o += TE_ENTRY) {
    const atk = rom.byte(te.bank, te.addr + o);
    if (atk === 0xff) return out;                       // terminator: the only clean exit
    if (o + TE_ENTRY > span)
      throw new Error(`TypeEffects has a partial entry at offset ${o} of ${span}`);
    out.push({ atk, def: rom.byte(te.bank, te.addr + o + 1), x10: rom.byte(te.bank, te.addr + o + 2) });
  }
  throw new Error(`TypeEffects ran ${span} bytes without a 0xFF terminator`);
}

/**
 * Effectiveness of `atk` against a defender of type1 (+ optional type2).
 *
 * Gen 1 walks the WHOLE table and applies every matching entry, so a dual-type
 * defender multiplies both — this loop is that loop. Pass type2 === type1 (which
 * is how the ROM stores single-type species) and the second match is skipped,
 * because applying it twice is exactly the 4x-against-Pikachu bug.
 */
export function typeMultiplier(chart: TypeEffect[], atk: number, t1: number, t2?: number): number {
  let m = 1;
  for (const e of chart) {
    if (e.atk !== atk) continue;
    if (e.def === t1) m *= e.x10 / 10;
    if (t2 !== undefined && t2 !== t1 && e.def === t2) m *= e.x10 / 10;
  }
  return m;
}

/** Known Gen 1 matchups, including the two the generation gets famously wrong.
 *  A modern type chart fails on the last two rows, which is the point. */
export const GOLDEN_TYPE_EFFECTS: [number, number, number][] = [
  [21, 20, 20],   // WATER -> FIRE      2.0
  [20, 21, 5],    // FIRE -> WATER      0.5
  [22, 21, 20],   // GRASS -> WATER     2.0
  [23, 21, 20],   // ELECTRIC -> WATER  2.0
  [4, 2, 0],      // GROUND -> FLYING   0.0
  [23, 4, 0],     // ELECTRIC -> GROUND 0.0
  [0, 5, 5],      // NORMAL -> ROCK     0.5
  [0, 8, 0],      // NORMAL -> GHOST    0.0
  [1, 8, 0],      // FIGHTING -> GHOST  0.0
  [8, 24, 0],     // GHOST -> PSYCHIC   0.0  (Gen 1: the bugged 0, not 2x)
];
/** Matchups that must be ABSENT, i.e. neutral. PSYCHIC->GHOST is the other half
 *  of the Gen 1 ghost bug: the pair GHOST->PSYCHIC x0 above and this neutral one
 *  are both wrong relative to the designers' intent and both what the game does,
 *  so a chart transcribed from any later generation fails on exactly these two
 *  rows. That is why they are anchored and BUG->PSYCHIC (a real 2x, in this
 *  generation as in every other) is not. */
export const GOLDEN_TYPE_NEUTRAL: [number, number][] = [[24, 8]];

// ── BaseStats ──────────────────────────────────────────────────────────────

export interface BaseStat {
  /** Pokedex number, 1..151. */
  dex: number;
  hp: number; atk: number; def: number; spd: number; spc: number;
  type1: number; type2: number;
  catchRate: number;
  baseExp: number;
}

/** Bytes per BaseStats entry (pokered's MON_BASE_STATS block). */
const BS_ENTRY = 28;

export interface BaseStatTables {
  /** Pokedex number -> base stats. */
  byDex: Record<number, BaseStat>;
  /** INTERNAL species id (what RAM holds) -> base stats. */
  byInternal: Record<number, BaseStat>;
  /** INTERNAL species id -> Pokedex number, 0 for the unused slots. */
  dexOf: Record<number, number>;
}

/**
 * Base stats keyed BOTH ways, because the two halves of the system disagree
 * about what a species is: RAM holds internal ids (0xB2 = Charmeleon) and the
 * BaseStats table is in Pokedex order (Charmeleon is #5). PokedexOrder is the
 * ROM's own translation between them, so nothing here is transcribed.
 *
 * Mew is the special case the ROM itself special-cases: MewBaseStats sits alone
 * in bank 1 because the main table has room for 150. Missing it would leave the
 * one species with an internal id under 0x20 that a player can actually own
 * silently absent.
 */
export function decodeBaseStats(rom: Rom, sym: SymbolTable): BaseStatTables {
  const bs = sym.sym("BaseStats");
  const span = sym.nextAddr(bs.bank, bs.addr) - bs.addr;
  if (span % BS_ENTRY !== 0)
    throw new Error(`BaseStats span ${span} is not a multiple of ${BS_ENTRY}`);
  const count = span / BS_ENTRY;

  const read = (bank: number, addr: number): BaseStat => {
    const b = rom.bytes(bank, addr, BS_ENTRY);
    return {
      dex: b[0], hp: b[1], atk: b[2], def: b[3], spd: b[4], spc: b[5],
      type1: b[6], type2: b[7], catchRate: b[8], baseExp: b[9],
    };
  };

  const byDex: Record<number, BaseStat> = {};
  for (let i = 0; i < count; i++) {
    const e = read(bs.bank, bs.addr + i * BS_ENTRY);
    // Entry 0 is the species' OWN dex number. It must equal its position, and
    // that identity is the whole alignment check for a 4200-byte table.
    if (e.dex !== i + 1) throw new Error(`BaseStats entry ${i} self-identifies as dex ${e.dex}`);
    byDex[e.dex] = e;
  }
  const mew = sym.sym("MewBaseStats");
  const me = read(mew.bank, mew.addr);
  if (me.dex !== count + 1) throw new Error(`MewBaseStats self-identifies as dex ${me.dex}`);
  byDex[me.dex] = me;

  const po = sym.sym("PokedexOrder");
  const poSpan = sym.nextAddr(po.bank, po.addr) - po.addr;
  const dexOf: Record<number, number> = {};
  const byInternal: Record<number, BaseStat> = {};
  for (let i = 0; i < poSpan; i++) {
    const dex = rom.byte(po.bank, po.addr + i);
    const internal = i + 1;           // PokedexOrder is indexed by internal id - 1
    dexOf[internal] = dex;
    if (dex && byDex[dex]) byInternal[internal] = byDex[dex];   // dex 0 = unused slot
  }
  return { byDex, byInternal, dexOf };
}

/** Hand-checkable Gen 1 base stats, keyed by INTERNAL species id so the anchor
 *  exercises the PokedexOrder translation as well as the table itself. */
export const GOLDEN_BASE_STATS: Record<number, { dex: number; hp: number; atk: number; def: number; spd: number; spc: number; type1: number; type2: number }> = {
  0x99: { dex: 1,   hp: 45,  atk: 49,  def: 49,  spd: 45, spc: 65,  type1: 22, type2: 3 },  // BULBASAUR
  0xb0: { dex: 4,   hp: 39,  atk: 52,  def: 43,  spd: 65, spc: 50,  type1: 20, type2: 20 }, // CHARMANDER
  0xb2: { dex: 5,   hp: 58,  atk: 64,  def: 58,  spd: 80, spc: 65,  type1: 20, type2: 20 }, // CHARMELEON
  0x54: { dex: 25,  hp: 35,  atk: 55,  def: 30,  spd: 90, spc: 50,  type1: 23, type2: 23 }, // PIKACHU
  0x01: { dex: 112, hp: 105, atk: 130, def: 120, spd: 40, spc: 45,  type1: 4,  type2: 5 },  // RHYDON
  0x15: { dex: 151, hp: 100, atk: 100, def: 100, spd: 100, spc: 100, type1: 24, type2: 24 },// MEW
};

// ── the fail-closed front door ─────────────────────────────────────────────

export interface RomTables {
  /** null when the decode failed its anchor — callers fall back. */
  moves: Record<number, RomMove> | null;
  typeChart: TypeEffect[] | null;
  baseStats: BaseStatTables | null;
  /** One human-readable line per disagreement. Empty means all three are trusted. */
  problems: string[];
  /** True when ANY table was dropped. */
  degraded: boolean;
}

function checkMoves(t: Record<number, RomMove>): string[] {
  const bad: string[] = [];
  for (const [k, g] of Object.entries(GOLDEN_MOVES)) {
    const m = t[Number(k)];
    if (!m) { bad.push(`move ${k} missing from decode`); continue; }
    if (m.name !== g.name || m.type !== g.type || m.power !== g.power)
      bad.push(`move ${k}: decoded ${m.name}/${m.type}/${m.power}, expected ${g.name}/${g.type}/${g.power}`);
  }
  for (const id of GOLDEN_LOCK_IN)
    if (!t[id]?.lockIn) bad.push(`move ${id} lost its lockIn flag`);
  // A decode that produced a handful of entries would pass every anchor above.
  if (Object.keys(t).length < 100) bad.push(`only ${Object.keys(t).length} moves decoded`);
  return bad;
}

function checkTypeEffects(chart: TypeEffect[]): string[] {
  const bad: string[] = [];
  for (const [a, d, x] of GOLDEN_TYPE_EFFECTS) {
    const hit = chart.filter(e => e.atk === a && e.def === d);
    if (hit.length !== 1) bad.push(`type ${typeName(a)}->${typeName(d)}: ${hit.length} entries, expected 1`);
    else if (hit[0].x10 !== x)
      bad.push(`type ${typeName(a)}->${typeName(d)}: decoded x${hit[0].x10 / 10}, expected x${x / 10}`);
  }
  for (const [a, d] of GOLDEN_TYPE_NEUTRAL)
    if (chart.some(e => e.atk === a && e.def === d))
      bad.push(`type ${typeName(a)}->${typeName(d)} should be absent (neutral in Gen 1)`);
  if (chart.length < 50) bad.push(`only ${chart.length} type matchups decoded`);
  return bad;
}

function checkBaseStats(t: BaseStatTables): string[] {
  const bad: string[] = [];
  for (const [k, g] of Object.entries(GOLDEN_BASE_STATS)) {
    const b = t.byInternal[Number(k)];
    if (!b) { bad.push(`species 0x${Number(k).toString(16)} missing from decode`); continue; }
    for (const f of ["dex", "hp", "atk", "def", "spd", "spc", "type1", "type2"] as const)
      if (b[f] !== g[f]) bad.push(`species 0x${Number(k).toString(16)} ${f}: decoded ${b[f]}, expected ${g[f]}`);
  }
  if (Object.keys(t.byDex).length < 151) bad.push(`only ${Object.keys(t.byDex).length} species decoded`);
  return bad;
}

/**
 * Decode all three tables, each independently verified and independently
 * droppable.
 *
 * INDEPENDENTLY is the design choice worth defending: the three decodes share a
 * ROM and a symbol table but nothing else, so one bad table should cost the
 * harness that table's capability, not all of them. A caller checks the field it
 * needs for null. Nothing here throws; a thrown decode becomes a problem line.
 */
export function loadRomTables(rom: Rom, sym: SymbolTable): RomTables {
  const problems: string[] = [];
  const attempt = <T>(label: string, decode: () => T, check: (t: T) => string[]): T | null => {
    let t: T;
    try { t = decode(); }
    catch (e) { problems.push(`${label}: decode failed: ${(e as Error).message}`); return null; }
    const bad = check(t);
    if (!bad.length) return t;
    problems.push(...bad.map(b => `${label}: ${b}`));
    return null;
  };
  const moves = attempt("Moves", () => decodeMoves(rom, sym), checkMoves);
  const typeChart = attempt("TypeEffects", () => decodeTypeEffects(rom, sym), checkTypeEffects);
  const baseStats = attempt("BaseStats", () => decodeBaseStats(rom, sym), checkBaseStats);
  return { moves, typeChart, baseStats, problems, degraded: problems.length > 0 };
}

/** One line for the boot log / event bus. Says what was trusted, and — the part
 *  that matters at 3am — what was not, and why. */
export function summarizeRomTables(t: RomTables): string {
  const parts = [
    t.moves ? `${Object.keys(t.moves).length} moves` : "moves FALLBACK",
    t.typeChart ? `${t.typeChart.length} type matchups` : "types FALLBACK",
    t.baseStats ? `${Object.keys(t.baseStats.byDex).length} base stats` : "stats FALLBACK",
  ];
  return `romtables: ${parts.join(", ")}` + (t.degraded ? ` — ${t.problems.join("; ")}` : "");
}
