// wq#1180 acceptance, ROM HALF: the decoded tables against known Gen 1 values.
//
//   npx tsx src/probe_romdecode1180.ts
//
// Needs roms/pokeblue.gb, so it runs on the Lumen host (scripts/probes-main.sh)
// and never on GitHub CI. The contract half — fail-closed behaviour, fallback
// semantics, picker policy — is in probe_romtables1180.ts and IS CI-safe.
//
// The values checked below are not re-derived from the same decode that
// produced them. They are Gen 1 facts a person can look up, chosen so that any
// stride, bank or index error moves them: a wrong entry stride breaks the power
// column, a wrong bank breaks the names, and a missing PokedexOrder hop breaks
// every base-stat lookup by internal id (which is what RAM actually holds).
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import {
  GOLDEN_BASE_STATS, GOLDEN_MOVES, GOLDEN_TYPE_EFFECTS, GOLDEN_TYPE_NEUTRAL,
  decodeBaseStats, decodeMoves, decodeTypeEffects, isSpecialType,
  loadRomTables, summarizeRomTables, typeMultiplier,
} from "./romtables";
import { installRomMoves, moveLabel, moveMeta, moveTableSize, moveTableSource, pickBestMove, setMoveTable } from "./moves";

const BASE = "/home/lumen/pokemon";
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(`${BASE}/roms/pokeblue.gb`);

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

// ── Moves ─────────────────────────────────────────────────────────────────
const moves = decodeMoves(rom, sym);
eq("all 165 moves decode", Object.keys(moves).length, 165);
ok("every move has a name with no undecoded byte in it",
  Object.values(moves).every(m => m.name.length > 0 && !m.name.includes("?")),
  Object.values(moves).filter(m => m.name.includes("?")).map(m => m.id).join(","));

// The anchor set, checked here rather than only inside loadRomTables, so a
// disagreement names the move instead of arriving as a summary line.
for (const [id, g] of Object.entries(GOLDEN_MOVES)) {
  const m = moves[Number(id)];
  eq(`golden move ${id} ${g.name}`, [m?.name, m?.type, m?.power], [g.name, g.type, g.power]);
}

// Moves the hand-typed table never had — the whole reason for this ticket.
eq("165 STRUGGLE", [moves[165].name, moves[165].power, moves[165].type], ["STRUGGLE", 50, "NORMAL"]);
eq("63 HYPER BEAM", [moves[63].name, moves[63].power, moves[63].accuracy], ["HYPER BEAM", 150, 90]);
eq("19 FLY", [moves[19].name, moves[19].power, moves[19].type], ["FLY", 70, "FLYING"]);
eq("76 SOLARBEAM", [moves[76].name, moves[76].power, moves[76].type], ["SOLARBEAM", 120, "GRASS"]);
eq("58 ICE BEAM", [moves[58].name, moves[58].power, moves[58].type], ["ICE BEAM", 95, "ICE"]);
eq("85 THUNDERBOLT", [moves[85].name, moves[85].power, moves[85].type], ["THUNDERBOLT", 95, "ELECTRIC"]);
eq("94 PSYCHIC", [moves[94].name, moves[94].power, moves[94].type], ["PSYCHIC", 90, "PSYCHIC"]);

// Accuracy is stored as pct*255/100 and PP is a plain byte; both are new columns
// this ticket adds, so both get anchored.
eq("POUND is 100% accurate, 35 PP", [moves[1].accuracy, moves[1].accRaw, moves[1].pp], [100, 255, 35]);
eq("TACKLE is 95% in Gen 1", moves[33].accuracy, 95);
eq("FIRE SPIN is the 70% outlier", moves[83].accuracy, 70);
ok("no move claims over 100% accuracy", Object.values(moves).every(m => m.accuracy <= 100));
ok("every move has PP", Object.values(moves).every(m => m.pp > 0));

// lockIn, derived from the effect byte, must be exactly the fifteen menu-less
// moves — not a superset that would make the picker refuse ordinary attacks.
// wq#587 hand-listed three of these (DIG, RAGE, BIDE); the other twelve were a
// wedge waiting for the party to learn one.
const locks = Object.values(moves).filter(m => m.lockIn).map(m => m.name).sort();
eq("the lock-in set is exactly Gen 1's menu-less moves", locks, [
  "BIDE", "BIND", "CLAMP", "DIG", "FIRE SPIN", "FLY", "HYPER BEAM", "PETAL DANCE",
  "RAGE", "RAZOR WIND", "SKULL BASH", "SKY ATTACK", "SOLARBEAM", "THRASH", "WRAP",
]);
ok("EMBER, TACKLE and PSYCHIC are NOT lock-ins",
  ![52, 33, 94].some(id => moves[id].lockIn));
ok("the physical/special split falls where the type ids do",
  !isSpecialType(moves[33].typeId) && isSpecialType(moves[52].typeId));

// ── TypeEffects ───────────────────────────────────────────────────────────
const chart = decodeTypeEffects(rom, sym);
eq("82 non-neutral matchups decode", chart.length, 82);
ok("every multiplier is one of Gen 1's four values",
  chart.every(e => [0, 5, 20].includes(e.x10)),
  [...new Set(chart.map(e => e.x10))].join(","));
for (const [a, d, x] of GOLDEN_TYPE_EFFECTS)
  eq(`golden matchup ${a}->${d}`, chart.filter(e => e.atk === a && e.def === d).map(e => e.x10), [x]);
for (const [a, d] of GOLDEN_TYPE_NEUTRAL)
  eq(`golden neutral ${a}->${d} is absent`, chart.filter(e => e.atk === a && e.def === d).length, 0);
eq("WATER on a ROCK/GROUND Onix is 4x", typeMultiplier(chart, 21, 5, 4), 4);
eq("ELECTRIC on a WATER/FLYING Gyarados is 4x", typeMultiplier(chart, 23, 21, 2), 4);
eq("ELECTRIC on a GROUND/ROCK Rhydon is 0", typeMultiplier(chart, 23, 4, 5), 0);
eq("FIRE on a WATER Squirtle is 0.5", typeMultiplier(chart, 20, 21, 21), 0.5);

// ── BaseStats ─────────────────────────────────────────────────────────────
const bs = decodeBaseStats(rom, sym);
eq("all 151 species decode by dex", Object.keys(bs.byDex).length, 151);
eq("Mew is dex 151 and comes from its own table", bs.byDex[151].hp, 100);
ok("every dex entry self-identifies correctly",
  Object.entries(bs.byDex).every(([d, e]) => e.dex === Number(d)));
ok("no species has a zero HP base", Object.values(bs.byDex).every(e => e.hp > 0));
for (const [id, g] of Object.entries(GOLDEN_BASE_STATS)) {
  const b = bs.byInternal[Number(id)];
  eq(`golden species 0x${Number(id).toString(16)} (dex ${g.dex})`,
    b && [b.dex, b.hp, b.atk, b.def, b.spd, b.spc, b.type1, b.type2],
    [g.dex, g.hp, g.atk, g.def, g.spd, g.spc, g.type1, g.type2]);
}
eq("PokedexOrder maps internal 0xB2 to Charmeleon's dex #5", bs.dexOf[0xb2], 5);
eq("PokedexOrder maps internal 0x15 to Mew's dex #151", bs.dexOf[0x15], 151);
eq("an unused internal slot maps to dex 0, not to a neighbour", bs.dexOf[0x1f], 0);
ok("every internal id that maps to a dex number resolves to stats",
  Object.entries(bs.dexOf).every(([i, d]) => d === 0 || !!bs.byInternal[Number(i)]));
eq("base stats reach the type chart: WATER GUN on the live lead (FIRE Charmeleon)",
  typeMultiplier(chart, moves[55].typeId, bs.byInternal[0xb2].type1, bs.byInternal[0xb2].type2), 2);

// ── the front door, and the table the harness actually runs on ────────────
const t = loadRomTables(rom, sym);
ok("a real ROM produces no problems", !t.degraded, t.problems.join(" | "));
ok("the summary line reports all three tables",
  summarizeRomTables(t) === "romtables: 165 moves, 82 type matchups, 151 base stats",
  summarizeRomTables(t));

setMoveTable(null);
eq("before install the harness is on the fallback", moveTableSource(), "fallback");
eq("...where SKY ATTACK has no name", moveLabel(143), "MOVE143");
eq("...and reads as a 30-power unknown that loses to TACKLE",
  pickBestMove([143, 33, 0, 0], [5, 5, 0, 0]), 1);

const installed = installRomMoves(rom, sym);
ok("install reports a clean load", !installed.degraded, installed.problems.join(" | "));
eq("after install the harness is on the ROM", moveTableSource(), "rom");
eq("...with all 165 moves", moveTableSize(), 165);
eq("...SKY ATTACK is named", moveLabel(143), "SKY ATTACK[FLYING 140]");
eq("...and is correctly refused as a lock-in in favour of TACKLE",
  pickBestMove([143, 33, 0, 0], [5, 5, 0, 0]), 1);
eq("a move that is neither hand-typed nor a lock-in now wins on real power",
  pickBestMove([33, 85, 0, 0], [5, 5, 0, 0]), 1);   // TACKLE 35 vs THUNDERBOLT 95
eq("moveMeta carries the ROM columns through", [moveMeta(85)?.pp, moveMeta(85)?.accuracy], [15, 100]);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
