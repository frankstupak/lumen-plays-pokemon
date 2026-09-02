// wq#1180 acceptance, PURE HALF: the parts that must hold without pokeblue.gb.
//
//   npx tsx src/probe_romtables1180.ts
//
// CI-safe by construction (scripts/probes-pure.sh): the only file it opens is
// roms/pokeblue.sym, which IS tracked. The ROM half — do the decoded tables
// carry the right numbers — lives in probe_romdecode1180.ts, because it needs
// the .gb that copyright keeps out of the repo.
//
// What this probe is actually for. A fail-closed decode has two halves and the
// interesting one is never the happy path: it is whether the anchors CATCH a
// bad decode, and whether the harness still works after they do. So the ROM
// here is a synthetic all-zero one, which is the cheapest possible wrong ROM,
// and the assertions are that all three tables get dropped, that the reason is
// reported rather than swallowed, and that the pickers keep the exact wq#587
// behaviour they had before this ticket existed.
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import {
  GOLDEN_BASE_STATS, GOLDEN_LOCK_IN, GOLDEN_MOVES, GOLDEN_TYPE_EFFECTS,
  GOLDEN_TYPE_NEUTRAL, LOCK_IN_EFFECTS, RomMove, TYPE_NAMES, TYPE_SPECIAL_MIN,
  isSpecialType, loadRomTables, summarizeRomTables, typeMultiplier, typeName,
} from "./romtables";
import {
  UNKNOWN_POWER, moveLabel, moveMeta, moveTableSize, moveTableSource,
  pickBestMove, pickWeakestMove, setMoveTable,
} from "./moves";
import { romPath } from "./fixtures";

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : `  :: ${detail}`}`);
};

const sym = new SymbolTable(romPath("pokeblue.sym"));

// ── the symbol layout the decoders stand on ───────────────────────────────
// Every one of these is a length DERIVED from nextAddr(), which is the whole
// reason a different ROM build fails loudly here instead of reading garbage.
const span = (name: string) => {
  const s = sym.sym(name);
  return sym.nextAddr(s.bank, s.addr) - s.addr;
};
eq("Moves spans 165 six-byte entries", span("Moves"), 165 * 6);
eq("BaseStats spans 150 twenty-eight-byte entries", span("BaseStats"), 150 * 28);
eq("MewBaseStats is one entry", span("MewBaseStats"), 28);
eq("TypeEffects spans 82 three-byte entries plus a terminator", span("TypeEffects"), 82 * 3 + 1);
eq("PokedexOrder covers 190 internal ids", span("PokedexOrder"), 190);
ok("MoveNames is the last symbol in its bank (why its length is parsed, not derived)",
  (() => { const s = sym.sym("MoveNames"); try { sym.nextAddr(s.bank, s.addr); return false; } catch { return true; } })());

// ── type constants ────────────────────────────────────────────────────────
eq("the physical/special split sits in the type-id gap", TYPE_SPECIAL_MIN, 20);
ok("NORMAL is physical", !isSpecialType(0));
ok("FIRE is special", isSpecialType(20));
eq("known type id renders its name", typeName(23), "ELECTRIC");
eq("unknown type id renders the id, not a guess", typeName(9), "TYPE9");
eq("the cut BIRD type is still present in the id space", TYPE_NAMES[6], "BIRD");

// ── fail-closed: an all-zero ROM must drop all three tables, loudly ────────
// Structurally a Rom, byte-for-byte a lie. Every anchor should reject it, and
// the failure must arrive as `problems`, never as a thrown exception through a
// caller that only wanted a move name.
const zeroRom = {
  data: Buffer.alloc(0),
  offset: () => 0,
  byte: () => 0,
  bytes: (_b: number, _a: number, n: number) => Buffer.alloc(n),
} as unknown as Rom;

const bad = loadRomTables(zeroRom, sym);
eq("zero ROM: moves dropped", bad.moves, null);
eq("zero ROM: type chart dropped", bad.typeChart, null);
eq("zero ROM: base stats dropped", bad.baseStats, null);
ok("zero ROM: degraded flag set", bad.degraded);
ok("zero ROM: all three failures reported, not one",
  ["Moves", "TypeEffects", "BaseStats"].every(t => bad.problems.some(p => p.startsWith(t + ":"))),
  bad.problems.join(" | "));
ok("zero ROM: the summary line names the fallbacks",
  summarizeRomTables(bad).includes("moves FALLBACK") &&
  summarizeRomTables(bad).includes("types FALLBACK") &&
  summarizeRomTables(bad).includes("stats FALLBACK"), summarizeRomTables(bad));

// A decode that is merely SHORT — plausible entries, not enough of them — is
// the failure an anchor set alone would wave through, so it is checked too.
const shortRom = {
  data: Buffer.alloc(0),
  offset: () => 0,
  // Self-identifying byte 0 is right for entry 1 and wrong after it, so
  // decodeMoves throws on entry 2 rather than returning a one-move table.
  byte: () => 1,
  bytes: (_b: number, _a: number, n: number) => Buffer.alloc(n, 1),
} as unknown as Rom;
ok("a decode that goes wrong mid-table is reported, not returned",
  loadRomTables(shortRom, sym).moves === null);

// ── fallback path: the harness after the anchors fire ──────────────────────
setMoveTable(null);
eq("no table installed -> fallback", moveTableSource(), "fallback");
eq("the fallback is the demoted hand-typed set, all 25 of it", moveTableSize(), 25);
eq("...and that set is GOLDEN_MOVES itself", moveTableSize(), Object.keys(GOLDEN_MOVES).length);
eq("fallback resolves a known move", moveMeta(52)?.name, "EMBER");
eq("fallback carries the wq#587 lock-ins", GOLDEN_LOCK_IN.map(id => moveMeta(id)?.lockIn), [true, true, true]);
eq("fallback has no opinion on a move it never covered", moveMeta(143), undefined);
eq("an unresolvable id labels as its number, never as a fake move", moveLabel(143), "MOVE143");
eq("fallback: Ember beats Rage (wq#587 P3, unchanged)", pickBestMove([99, 45, 52, 43], [10, 10, 10, 10]), 2);
eq("fallback: Ember dry -> RAGE is the last damage standing (wq#587 P4)",
  pickBestMove([99, 45, 52, 43], [10, 10, 0, 10]), 0);
eq("fallback: a lock-in loses to a weaker non-lock attacker (wq#587 P5)",
  pickBestMove([91, 33, 0, 0], [5, 5, 0, 0]), 1);
eq("fallback: all-zero PP falls back to a slot (wq#587 P6)",
  pickBestMove([99, 45, 52, 43], [0, 0, 0, 0]), 0);
eq("fallback: catch weakening still prefers status (wq#696)",
  pickWeakestMove([52, 45, 43, 99], [10, 10, 10, 10]), 1);
// THE BUG THIS TICKET REMOVES, stated as a test. On the fallback path SKY
// ATTACK (140, and a lock-in) is unresolvable, so it scores UNKNOWN_POWER 30
// and loses to TACKLE. Correct given no data — and wrong about the game. The
// installed-path section below runs the same two slots with the ROM table.
eq("fallback: an unresolvable id scores UNKNOWN_POWER and loses to TACKLE",
  pickBestMove([143, 33, 0, 0], [5, 5, 0, 0]), 1);
eq("UNKNOWN_POWER is still the wq#587 constant", UNKNOWN_POWER, 30);

// ── installed path: the same pickers, now seeing the whole move list ───────
// A synthetic table, so this half stays pure. The point is the CONTRACT — a
// table with lockIn on FLY changes the choice — not the ROM's numbers, which
// probe_romdecode1180 checks against the ROM itself.
const mk = (id: number, name: string, type: string, power: number, lockIn: boolean): RomMove =>
  ({ id, name, type, typeId: 0, power, accuracy: 100, accRaw: 255, pp: 10, effect: lockIn ? 39 : 0, lockIn });
setMoveTable({
  19: mk(19, "FLY", "FLYING", 70, true),
  33: mk(33, "TACKLE", "NORMAL", 35, false),
  63: mk(63, "HYPER BEAM", "NORMAL", 150, true),
  143: mk(143, "SKY ATTACK", "FLYING", 140, true),
});
eq("installed -> rom source", moveTableSource(), "rom");
eq("a move the hand-typed table never had now resolves", moveLabel(143), "SKY ATTACK[FLYING 140]");
eq("FLY is a lock-in and loses to TACKLE — the wq#587 rule, now applied to it",
  pickBestMove([19, 33, 0, 0], [5, 5, 0, 0]), 1);
eq("with only lock-ins available the strongest one is still picked",
  pickBestMove([19, 63, 0, 0], [5, 5, 0, 0]), 1);
eq("catch weakening refuses every lock-in and falls through to TACKLE",
  pickWeakestMove([19, 63, 33, 143], [5, 5, 5, 5]), 2);
eq("accuracy and PP reach the consumer on the ROM path", [moveMeta(33)?.accuracy, moveMeta(33)?.pp], [100, 10]);
setMoveTable(null);

// ── the lock-in derivation, as a set ──────────────────────────────────────
eq("seven effect ids take the menu away", Object.keys(LOCK_IN_EFFECTS).length, 7);
ok("charge, bide and rage are all represented",
  [39, 26, 81].every(e => e in LOCK_IN_EFFECTS));

// ── anchors are internally coherent ───────────────────────────────────────
ok("every golden move names a type the id space knows",
  Object.values(GOLDEN_MOVES).every(m => Object.values(TYPE_NAMES).includes(m.type)));
ok("every golden lock-in is in the golden move set",
  GOLDEN_LOCK_IN.every(id => id in GOLDEN_MOVES));
ok("golden type multipliers are all x0, x0.5 or x2",
  GOLDEN_TYPE_EFFECTS.every(([, , x]) => [0, 5, 20].includes(x)));
ok("the two Gen 1 ghost quirks are both anchored",
  GOLDEN_TYPE_EFFECTS.some(([a, d, x]) => a === 8 && d === 24 && x === 0) &&
  GOLDEN_TYPE_NEUTRAL.some(([a, d]) => a === 24 && d === 8));
ok("golden base stats cover the live party lead and both table halves",
  0xb2 in GOLDEN_BASE_STATS && 0x15 in GOLDEN_BASE_STATS);

// ── typeMultiplier composes the way Gen 1's loop does ─────────────────────
const chart = [
  { atk: 21, def: 20, x10: 20 },   // WATER -> FIRE   x2
  { atk: 21, def: 5, x10: 20 },    // WATER -> ROCK   x2
  { atk: 21, def: 22, x10: 5 },    // WATER -> GRASS  x0.5
  { atk: 4, def: 2, x10: 0 },      // GROUND -> FLYING x0
];
eq("single type", typeMultiplier(chart, 21, 20), 2);
eq("no entry means neutral", typeMultiplier(chart, 21, 0), 1);
eq("dual type multiplies both halves", typeMultiplier(chart, 21, 20, 5), 4);
eq("resistance and weakness cancel", typeMultiplier(chart, 21, 20, 22), 1);
eq("an immunity zeroes the product", typeMultiplier(chart, 4, 2, 5), 0);
eq("a single-type mon stored as type1==type2 is NOT counted twice",
  typeMultiplier(chart, 21, 5, 5), 2);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
