// wq#1180 (roadmap item 4): Moves, TypeEffects and BaseStats, read out of THIS
// cartridge instead of recalled.
//
// WHY THIS EXISTS
//   moves.ts was 25 hand-typed entries with a string type name and no accuracy,
//   no PP and no effect byte. Item 5 (calc.ts) then had to transcribe the whole
//   82-row type chart by hand as well, and left a note saying so: "This table is
//   UNVERIFIED against the cartridge; item 4's ROM decode is the verification
//   path". This module is that path. It is also the foundation for the
//   winnability verdict: a verdict computed from a recalled power number is a
//   guess wearing a number's clothes.
//
// EVERY LAYOUT FACT BELOW WAS MEASURED ON roms/pokeblue.gb, not recalled:
//   Moves        0e:4000, region 0x3de = 165 entries x 6 bytes
//                [0] id  [1] effect  [2] power  [3] type  [4] accuracy  [5] pp
//   MoveNames    2c:4000, 165 back-to-back 0x50-terminated strings. It is the
//                ONLY symbol in its bank, so its length cannot be derived from
//                the next symbol — the count comes from Moves and the walk is
//                bounded by it.
//   TypeEffects  0f:6474, region 247 = 82 triples x 3 + one 0xFF terminator
//                [attacker type, defender type, multiplier x10]
//   BaseStats    0e:43de, region 4200 = 150 entries x 28 bytes, indexed by
//                POKEDEX number - 1 (not by species id). Byte [0] of each entry
//                repeats the dex number, which is the decode's own checksum.
//   MewBaseStats 01:425b — dex 151 lives outside the table in Gen 1.
//   PokedexOrder 10:5024, 190 bytes: internal species id - 1 -> dex number.
//                39 of the 190 slots are 0 (the MissingNo holes).
//   MonsterNames 07:421e, region 1900 = 190 fixed 10-byte names.
//
// FAIL-CLOSED, and the failure is LOUD. Every decoder derives its table length
// from the symbol table and throws if the arithmetic does not come out whole,
// exactly like items.ts's backfills: a ROM whose layout moved must produce a
// throw, never a plausible number. loadRomTables() catches those throws per
// table, re-checks each decode against a golden set of independently known Gen 1
// values, and returns null for any table that disagrees — the caller keeps its
// fallback and logs. A wrong power silently replacing a right one is the one
// outcome this module must not be able to produce.

import { SymbolTable } from "./symbols";
import { decodeGen1Bytes } from "./names";

/** The one method the decoders need. Keeps this module testable against a
 *  synthetic cartridge (probe_romtables1180) and matches items.ts's RomLike. */
export interface RomLike { byte(bank: number, addr: number): number }

// ---------------------------------------------------------------- types

/** Gen 1 internal type ids (constants/type_constants.asm). These are the raw
 *  values in the BaseStats type bytes, in the Moves type byte and in
 *  wBattleMonType1/wEnemyMonType1 — one id space, no translation anywhere.
 *  Physical types are 0-8, special types 20-26: the split is BY TYPE in Gen 1,
 *  not by move, which is why isPhysical() is a comparison and not a table.
 *  BIRD (6) is unused by any real species; it is here so a garbage read during
 *  a map load resolves to a name instead of undefined. */
export const TYPE = {
  NORMAL: 0, FIGHTING: 1, FLYING: 2, POISON: 3, GROUND: 4, ROCK: 5,
  BIRD: 6, BUG: 7, GHOST: 8,
  FIRE: 20, WATER: 21, GRASS: 22, ELECTRIC: 23, PSYCHIC: 24, ICE: 25, DRAGON: 26,
} as const;

export const TYPE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(TYPE).map(([k, v]) => [v, k]));

export const TYPE_ID: Record<string, number> = Object.fromEntries(
  Object.entries(TYPE).map(([k, v]) => [k, v as number]));

/** First special type id. Gen 1 splits physical/special by TYPE. */
export const FIRST_SPECIAL_TYPE = TYPE.FIRE;
export const isPhysical = (t: number): boolean => t < FIRST_SPECIAL_TYPE;

const VALID_TYPE = new Set<number>(Object.values(TYPE));

/** One TypeEffects row in the ROM's own shape: [attacking type, defending type,
 *  multiplier x10]. Tenths are kept, not floats, because Gen 1 truncates between
 *  the two applications and the damage formula has to reproduce that. */
export type TypeTriple = [number, number, number];

// ---------------------------------------------------------------- Moves

export const MOVE_ENTRY_BYTES = 6;

export interface RomMove {
  id: number;
  name: string;
  type: number;
  power: number;
  accuracy: number;     // 255 == 100%
  pp: number;
  effect: number;       // move_effect_constants.asm index
  lockIn: boolean;      // derived from `effect` — see LOCK_IN_EFFECTS
}

/**
 * Effects that cost the harness a MENU, and the moves that carry each one on
 * this ROM (censused by decoding all 165 entries, not recalled):
 *
 *   26 BIDE            BIDE                  — stores for 2-3 menu-less turns
 *   27 THRASH          THRASH, PETAL DANCE   — locked 2-3 turns, then confusion
 *   39 CHARGE          RAZOR WIND, SOLARBEAM, DIG, SKULL BASH, SKY ATTACK
 *   43 FLY             FLY                   — same two-turn shape, own effect id
 *   80 HYPER_BEAM      HYPER BEAM            — the recharge turn takes no input
 *   81 RAGE            RAGE                  — locked until the battle ENDS
 *
 * This REPLACES the three hand-set lockIn flags in the old table (DIG, RAGE,
 * BIDE) and finds the other nine moves nobody had typed in. wq#587's rule is
 * unchanged: the harness drives every battle through the menu, so a menu that
 * never comes back is a wedge risk, not a damage upgrade.
 *
 * Multi-hit moves (FURY ATTACK and friends) are deliberately NOT here: all
 * their hits land inside one turn and the menu returns normally.
 */
export const LOCK_IN_EFFECTS: Record<number, string> = {
  26: "BIDE", 27: "THRASH", 39: "CHARGE", 43: "FLY", 80: "HYPER_BEAM", 81: "RAGE",
};

/** How many entries the Moves table holds on this ROM. Derived, never assumed:
 *  the region between `Moves` and the next symbol must divide by 6 exactly. */
export function moveCount(sym: SymbolTable): number {
  const t = sym.sym("Moves");
  const span = sym.nextAddr(t.bank, t.addr) - t.addr;
  const n = span / MOVE_ENTRY_BYTES;
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`Moves spans ${span} bytes = ${n} entries of ${MOVE_ENTRY_BYTES} — ROM layout moved`);
  return n;
}

/** MoveNames, walked for exactly `count` entries. Unmapped bytes throw rather
 *  than rendering "?" — the same rule backfillItemNames enforces, and for the
 *  same reason: a name that decoded wrong means we are not reading the table we
 *  think we are reading. */
function moveNames(rom: RomLike, sym: SymbolTable, count: number): string[] {
  const t = sym.sym("MoveNames");
  const out: string[] = [];
  let addr = t.addr, buf: number[] = [];
  // 16 bytes per name is already generous (the longest Gen 1 move name is 12);
  // the bound exists so a table that moved cannot walk the whole bank.
  const end = t.addr + count * 16;
  while (addr < end && out.length < count) {
    const b = rom.byte(t.bank, addr++);
    if (b !== 0x50) { buf.push(b); continue; }
    const { text, unmapped } = decodeGen1Bytes(buf);
    if (unmapped.length)
      throw new Error(`MoveNames entry ${out.length + 1} has unmapped byte(s) ${unmapped.map(x => "0x" + x.toString(16)).join(",")} -> "${text}" — ROM layout moved`);
    if (!text)
      throw new Error(`MoveNames entry ${out.length + 1} is empty — ROM layout moved`);
    out.push(text);
    buf = [];
  }
  if (out.length !== count)
    throw new Error(`MoveNames yielded ${out.length} names for ${count} moves — ROM layout moved`);
  return out;
}

export function decodeMoves(rom: RomLike, sym: SymbolTable): Map<number, RomMove> {
  const t = sym.sym("Moves");
  const count = moveCount(sym);
  const names = moveNames(rom, sym, count);
  const out = new Map<number, RomMove>();
  for (let id = 1; id <= count; id++) {
    const a = t.addr + (id - 1) * MOVE_ENTRY_BYTES;
    const b = [0, 1, 2, 3, 4, 5].map(k => rom.byte(t.bank, a + k));
    // Byte [0] repeats the move id (it doubles as the animation index). It is
    // the table's own checksum: if it disagrees we are not reading Moves.
    if (b[0] !== id)
      throw new Error(`Moves entry ${id} self-identifies as ${b[0]} — ROM layout moved`);
    if (!VALID_TYPE.has(b[3]))
      throw new Error(`Moves entry ${id} (${names[id - 1]}) has type ${b[3]}, not a Gen 1 type id — ROM layout moved`);
    out.set(id, {
      id, name: names[id - 1], type: b[3], power: b[2],
      accuracy: b[4], pp: b[5], effect: b[1],
      lockIn: LOCK_IN_EFFECTS[b[1]] !== undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------- TypeEffects

/** Every matchup the cartridge bothers to list; anything absent is 1x. The walk
 *  is bounded by the symbol region and the terminator position is checked
 *  against it, so a table that grew or moved throws instead of reading code as
 *  matchups. */
export function decodeTypeEffects(rom: RomLike, sym: SymbolTable): TypeTriple[] {
  const t = sym.sym("TypeEffects");
  const span = sym.nextAddr(t.bank, t.addr) - t.addr;
  const out: TypeTriple[] = [];
  let i = 0;
  while (i + 2 < span) {
    const a = rom.byte(t.bank, t.addr + i);
    if (a === 0xff) break;
    const d = rom.byte(t.bank, t.addr + i + 1), x = rom.byte(t.bank, t.addr + i + 2);
    if (!VALID_TYPE.has(a) || !VALID_TYPE.has(d))
      throw new Error(`TypeEffects row ${out.length} is ${a}->${d}, not Gen 1 type ids — ROM layout moved`);
    if (x > 20)
      throw new Error(`TypeEffects row ${out.length} multiplier ${x} exceeds 2.0x — ROM layout moved`);
    out.push([a, d, x]);
    i += 3;
  }
  if (rom.byte(t.bank, t.addr + i) !== 0xff)
    throw new Error(`TypeEffects has no 0xFF terminator inside its ${span}-byte region — ROM layout moved`);
  // The region is exactly the triples plus the terminator, or the table is not
  // what the symbol says it is.
  if (i + 1 !== span)
    throw new Error(`TypeEffects terminates at ${i} but spans ${span} bytes — ROM layout moved`);
  if (!out.length) throw new Error("TypeEffects decoded 0 rows — ROM layout moved");
  return out;
}

// ---------------------------------------------------------------- BaseStats

export const BASE_STATS_ENTRY_BYTES = 28;

export interface RomBaseStats {
  species: number;      // internal id (what wBattleMonSpecies holds)
  dex: number;          // pokedex number (what BaseStats is indexed by)
  name: string;
  hp: number; atk: number; def: number; speed: number; spc: number;
  type1: number; type2: number;
  catchRate: number;
  baseExp: number;
}

/** MonsterNames: 190 fixed-width 10-byte entries, index = species id - 1. */
function monsterNames(rom: RomLike, sym: SymbolTable): string[] {
  const t = sym.sym("MonsterNames");
  const span = sym.nextAddr(t.bank, t.addr) - t.addr;
  const n = span / 10;
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`MonsterNames spans ${span} bytes = ${n} 10-byte entries — ROM layout moved`);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const buf: number[] = [];
    for (let k = 0; k < 10; k++) {
      const b = rom.byte(t.bank, t.addr + i * 10 + k);
      if (b === 0x50) break;
      buf.push(b);
    }
    out.push(decodeGen1Bytes(buf).text);
  }
  return out;
}

/**
 * Base stats for every species the cartridge actually defines, keyed by
 * INTERNAL species id — the id RAM holds, so a caller never has to know that
 * the table itself is in pokedex order.
 *
 * The two Gen 1 traps are handled explicitly rather than worked around:
 * PokedexOrder has 39 zero slots (the MissingNo holes) which are skipped, and
 * dex 151 (MEW) is not in the table at all — pokered keeps it at MewBaseStats.
 */
export function decodeBaseStats(rom: RomLike, sym: SymbolTable): Map<number, RomBaseStats> {
  const t = sym.sym("BaseStats");
  const span = sym.nextAddr(t.bank, t.addr) - t.addr;
  const entries = span / BASE_STATS_ENTRY_BYTES;
  if (!Number.isInteger(entries) || entries <= 0)
    throw new Error(`BaseStats spans ${span} bytes = ${entries} entries of ${BASE_STATS_ENTRY_BYTES} — ROM layout moved`);
  const po = sym.sym("PokedexOrder");
  const species = sym.nextAddr(po.bank, po.addr) - po.addr;
  const names = monsterNames(rom, sym);
  if (names.length !== species)
    throw new Error(`PokedexOrder has ${species} slots but MonsterNames has ${names.length} — ROM layout moved`);
  const mew = sym.has("MewBaseStats") ? sym.sym("MewBaseStats") : null;

  const out = new Map<number, RomBaseStats>();
  for (let sp = 1; sp <= species; sp++) {
    const dex = rom.byte(po.bank, po.addr + sp - 1);
    if (dex === 0) continue;                       // MissingNo hole
    let bank = t.bank, addr = t.addr + (dex - 1) * BASE_STATS_ENTRY_BYTES;
    if (dex > entries) {
      if (!mew) continue;                          // no out-of-table entry to read
      bank = mew.bank; addr = mew.addr;
    }
    const b = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => rom.byte(bank, addr + k));
    // Byte [0] repeats the dex number: the decode's own checksum, and the thing
    // that catches an off-by-one in the pokedex-order indirection.
    if (b[0] !== dex)
      throw new Error(`BaseStats for species ${sp} (${names[sp - 1]}) self-identifies as dex ${b[0]}, expected ${dex} — ROM layout moved`);
    if (!VALID_TYPE.has(b[6]) || !VALID_TYPE.has(b[7]))
      throw new Error(`BaseStats dex ${dex} has types ${b[6]}/${b[7]}, not Gen 1 type ids — ROM layout moved`);
    out.set(sp, {
      species: sp, dex, name: names[sp - 1],
      hp: b[1], atk: b[2], def: b[3], speed: b[4], spc: b[5],
      type1: b[6], type2: b[7], catchRate: b[8], baseExp: b[9],
    });
  }
  if (!out.size) throw new Error("BaseStats decoded 0 species — ROM layout moved");
  return out;
}

// ---------------------------------------------------------------- golden set

/**
 * Independently known Gen 1 values, used to REJECT a decode rather than to
 * produce one. Nothing here comes from the tables above; these are facts about
 * the game that any source agrees on, which is what makes them able to catch a
 * decoder that is confidently reading the wrong bytes.
 *
 * Keep this set small and load-bearing: one move of each shape (plain attacker,
 * typed attacker, status, each lock-in family), the matchups the corridor's
 * fights actually turn on, and the species the run meets.
 */
export const GOLDEN_MOVES: { id: number; name: string; type: number; power: number; pp: number; lockIn: boolean }[] = [
  { id: 1,   name: "POUND",      type: TYPE.NORMAL, power: 40,  pp: 35, lockIn: false },
  { id: 52,  name: "EMBER",      type: TYPE.FIRE,   power: 40,  pp: 25, lockIn: false },
  { id: 55,  name: "WATER GUN",  type: TYPE.WATER,  power: 40,  pp: 25, lockIn: false },
  { id: 45,  name: "GROWL",      type: TYPE.NORMAL, power: 0,   pp: 40, lockIn: false },
  { id: 91,  name: "DIG",        type: TYPE.GROUND, power: 100, pp: 10, lockIn: true  },
  { id: 99,  name: "RAGE",       type: TYPE.NORMAL, power: 20,  pp: 20, lockIn: true  },
  { id: 117, name: "BIDE",       type: TYPE.NORMAL, power: 0,   pp: 10, lockIn: true  },
  { id: 63,  name: "HYPER BEAM", type: TYPE.NORMAL, power: 150, pp: 5,  lockIn: true  },
  { id: 165, name: "STRUGGLE",   type: TYPE.NORMAL, power: 50,  pp: 10, lockIn: false },
];

export const GOLDEN_TYPE: TypeTriple[] = [
  [TYPE.WATER, TYPE.FIRE, 20],        // the Misty problem, from the other side
  [TYPE.FIRE, TYPE.WATER, 5],
  [TYPE.ELECTRIC, TYPE.GROUND, 0],
  [TYPE.NORMAL, TYPE.GHOST, 0],
  [TYPE.GHOST, TYPE.PSYCHIC, 0],      // the Gen 1 bug — a chart without it is Gen 2's
  [TYPE.NORMAL, TYPE.ROCK, 5],
  [TYPE.POISON, TYPE.BUG, 20],        // Gen 1 only; Gen 2 flipped it
  [TYPE.GROUND, TYPE.FLYING, 0],
  [TYPE.ICE, TYPE.DRAGON, 20],
];

export const GOLDEN_STATS: { species: number; dex: number; name: string; hp: number; atk: number;
                             def: number; speed: number; spc: number; type1: number; type2: number }[] = [
  { species: 153, dex: 1,   name: "BULBASAUR",  hp: 45,  atk: 49, def: 49,  speed: 45,  spc: 65,  type1: TYPE.GRASS,    type2: TYPE.POISON  },
  { species: 176, dex: 4,   name: "CHARMANDER", hp: 39,  atk: 52, def: 43,  speed: 65,  spc: 50,  type1: TYPE.FIRE,     type2: TYPE.FIRE    },
  { species: 177, dex: 7,   name: "SQUIRTLE",   hp: 44,  atk: 48, def: 65,  speed: 43,  spc: 50,  type1: TYPE.WATER,    type2: TYPE.WATER   },
  { species: 84,  dex: 25,  name: "PIKACHU",    hp: 35,  atk: 55, def: 30,  speed: 90,  spc: 50,  type1: TYPE.ELECTRIC, type2: TYPE.ELECTRIC},
  { species: 107, dex: 41,  name: "ZUBAT",      hp: 40,  atk: 45, def: 35,  speed: 55,  spc: 40,  type1: TYPE.POISON,   type2: TYPE.FLYING  },
  { species: 169, dex: 74,  name: "GEODUDE",    hp: 40,  atk: 80, def: 100, speed: 20,  spc: 30,  type1: TYPE.ROCK,     type2: TYPE.GROUND  },
  { species: 34,  dex: 95,  name: "ONIX",       hp: 35,  atk: 45, def: 160, speed: 70,  spc: 30,  type1: TYPE.ROCK,     type2: TYPE.GROUND  },
  { species: 152, dex: 121, name: "STARMIE",    hp: 60,  atk: 75, def: 85,  speed: 115, spc: 100, type1: TYPE.WATER,    type2: TYPE.PSYCHIC },
  { species: 21,  dex: 151, name: "MEW",        hp: 100, atk: 100, def: 100, speed: 100, spc: 100, type1: TYPE.PSYCHIC, type2: TYPE.PSYCHIC },
];

export function checkMoves(t: Map<number, RomMove>): string[] {
  const bad: string[] = [];
  for (const g of GOLDEN_MOVES) {
    const m = t.get(g.id);
    if (!m) { bad.push(`move ${g.id} (${g.name}) missing from the decode`); continue; }
    if (m.name !== g.name) bad.push(`move ${g.id} decoded "${m.name}", golden "${g.name}"`);
    if (m.type !== g.type) bad.push(`move ${g.id} (${g.name}) type ${m.type}, golden ${g.type}`);
    if (m.power !== g.power) bad.push(`move ${g.id} (${g.name}) power ${m.power}, golden ${g.power}`);
    if (m.pp !== g.pp) bad.push(`move ${g.id} (${g.name}) pp ${m.pp}, golden ${g.pp}`);
    if (m.lockIn !== g.lockIn) bad.push(`move ${g.id} (${g.name}) lockIn ${m.lockIn}, golden ${g.lockIn}`);
  }
  return bad;
}

export function checkTypeEffects(t: TypeTriple[]): string[] {
  const m = new Map(t.map(([a, d, x]) => [a * 256 + d, x]));
  const bad: string[] = [];
  for (const [a, d, x] of GOLDEN_TYPE) {
    const got = m.get(a * 256 + d);
    if (got === undefined) bad.push(`matchup ${TYPE_NAME[a]}->${TYPE_NAME[d]} absent, golden x${x / 10}`);
    else if (got !== x) bad.push(`matchup ${TYPE_NAME[a]}->${TYPE_NAME[d]} decoded x${got / 10}, golden x${x / 10}`);
  }
  return bad;
}

export function checkBaseStats(t: Map<number, RomBaseStats>): string[] {
  const bad: string[] = [];
  for (const g of GOLDEN_STATS) {
    const s = t.get(g.species);
    if (!s) { bad.push(`species ${g.species} (${g.name}) missing from the decode`); continue; }
    if (s.name !== g.name) bad.push(`species ${g.species} decoded "${s.name}", golden "${g.name}"`);
    if (s.dex !== g.dex) bad.push(`${g.name} dex ${s.dex}, golden ${g.dex}`);
    for (const k of ["hp", "atk", "def", "speed", "spc", "type1", "type2"] as const)
      if (s[k] !== g[k]) bad.push(`${g.name} ${k} ${s[k]}, golden ${g[k]}`);
  }
  return bad;
}

// ---------------------------------------------------------------- loader

export interface RomTableLoad {
  moves: Map<number, RomMove> | null;
  typeEffects: TypeTriple[] | null;
  baseStats: Map<number, RomBaseStats> | null;
  /** Per-table failures, ready to log. Empty = all three decoded and agreed. */
  errors: string[];
  counts: { moves: number; typeEffects: number; baseStats: number };
}

/**
 * Decode all three tables, verify each against the golden set, and return null
 * for any that threw or disagreed.
 *
 * PER TABLE, not all-or-nothing: a BaseStats decode that fails on some future
 * ROM must not also cost the harness its move powers. Each null is a table the
 * caller keeps its own fallback for, and each error is a line worth logging —
 * silence here would mean the run quietly went back to 25 recalled moves with
 * nobody able to tell from the outside.
 */
let installedStats: Map<number, RomBaseStats> | null = null;

/**
 * Hand the harness THIS cartridge's base stats, keyed by internal species id.
 *
 * SEAM, NOT YET A CONSUMER — say so plainly rather than let a reader assume.
 * The table is item 5/6's missing input: ledger.ts's GateCtx.estimate is
 * documented as "item 4's BaseStats decode is what will let trainers.ts produce
 * this from a decoded roster", and trainers.rosterLevels currently throws the
 * species ids away, so producing that estimate is a change to trainers.ts and
 * belongs with the estimator, not here. Today the only caller is
 * probe_romtables1180. The decode ships now because the verdict it feeds cannot
 * be built on a table nobody has read out of the cartridge.
 */
export function installBaseStats(table: Map<number, RomBaseStats> | null): boolean {
  if (!table || table.size === 0) return false;
  installedStats = table;
  return true;
}

export function baseStatsFor(species: number): RomBaseStats | undefined {
  return installedStats?.get(species);
}

export function baseStatsInfo(): { source: "rom" | "none"; entries: number } {
  return installedStats ? { source: "rom", entries: installedStats.size } : { source: "none", entries: 0 };
}

export function loadRomTables(rom: RomLike, sym: SymbolTable): RomTableLoad {
  const errors: string[] = [];
  const attempt = <T>(label: string, decode: () => T, check: (v: T) => string[]): T | null => {
    let v: T;
    try { v = decode(); }
    catch (e: any) { errors.push(`${label}: ${String(e?.message ?? e)}`); return null; }
    const bad = check(v);
    if (bad.length) { errors.push(`${label} disagrees with the golden set: ${bad.join("; ")}`); return null; }
    return v;
  };
  const moves = attempt("Moves", () => decodeMoves(rom, sym), checkMoves);
  const typeEffects = attempt("TypeEffects", () => decodeTypeEffects(rom, sym), checkTypeEffects);
  const baseStats = attempt("BaseStats", () => decodeBaseStats(rom, sym), checkBaseStats);
  return {
    moves, typeEffects, baseStats, errors,
    counts: { moves: moves?.size ?? 0, typeEffects: typeEffects?.length ?? 0, baseStats: baseStats?.size ?? 0 },
  };
}
