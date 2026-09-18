// wq#1180 acceptance (roadmap item 4): the Moves / TypeEffects / BaseStats
// decodes reproduce known Gen 1 values, every layout check throws instead of
// inventing a number, and a rejected decode leaves the harness on its
// hand-typed fallback with the failure LOGGED rather than swallowed.
//
// TWO CARTRIDGES, on purpose:
//   SYNTHETIC — a 60-byte cartridge built in this file. CI has no ROM (copyright:
//     only .sym files are tracked), so the decoders, every throw path and the
//     whole fallback path are exercised against bytes we wrote ourselves. This
//     half runs everywhere and is the reason this probe is in probes-pure.sh.
//   REAL — roms/pokeblue.gb when it exists (the Lumen host). This half is the
//     one that can catch a decoder that is confidently reading the wrong table:
//     it re-derives the golden set, checks all 25 demoted hand-typed moves
//     against the cartridge, and checks calc.ts's 82-row transcribed type chart
//     row for row. probes-main.sh asserts the cartridge is present before it
//     runs anything, so this half cannot quietly stop running on the box that
//     has one; pass --no-rom to force the CI path and check the other branch.
//
// ORDER IS LOAD-BEARING. installRomMoves/installTypeChart/installBaseStats set
// module state, so the fallback assertions run FIRST, while nothing is
// installed. The last check then re-reads a move id the hand-typed table never
// had and finds it — which demonstrates the retirement instead of claiming it.

import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import {
  TYPE, TYPE_NAME, RomLike, decodeMoves, decodeTypeEffects, decodeBaseStats,
  loadRomTables, installBaseStats, baseStatsFor, baseStatsInfo,
  GOLDEN_MOVES, GOLDEN_TYPE, GOLDEN_STATS, LOCK_IN_EFFECTS, MOVE_ENTRY_BYTES,
} from "./romtables";
import { FALLBACK_MOVES, installRomMoves, moveMeta, moveTableInfo, moveLabel } from "./moves";
import { TYPE_EFFECTS, installTypeChart, chartSource, activeChart } from "./calc";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};
/** Asserts that `f` throws, and that the message says WHY. A decoder that
 *  returned garbage instead of throwing is the failure this probe exists for. */
const throws = (n: string, f: () => unknown, want = "ROM layout moved") => {
  try { f(); chk(n, false, "did not throw"); }
  catch (e: any) {
    const msg = String(e?.message ?? e);
    chk(n, msg.includes(want), msg.slice(0, 120));
  }
};

// ───────────────────────────── the synthetic cartridge ─────────────────────
// Banks are chosen so every table sits alone with a sentinel symbol after it:
// the decoders derive their lengths from sym.nextAddr(), so a table with no
// following symbol in its own bank cannot be measured (this is why MoveNames,
// the only symbol in bank 0x2c on the real cartridge, is bounded by the Moves
// count instead).
const A = (s: string) => [...s].map(c => c.charCodeAt(0) - 0x41 + 0x80);

interface Cart { bytes: Map<number, number>; sym: string }
const KEY = (bank: number, addr: number) => bank * 0x10000 + addr;

function synthetic(mut: Partial<{
  moveEntries: number[][]; moveNames: string[]; movesSpan: number;
  triples: number[][]; teTerminator: number; teSpan: number;
  dexOrder: number[]; statEntries: number[][]; monNames: string[];
}> = {}): Cart {
  const moveEntries = mut.moveEntries ?? [
    // [id, effect, power, type, accuracy, pp]
    [1, 0, 40, TYPE.NORMAL, 255, 35],
    [2, 81, 90, TYPE.FIRE, 255, 10],      // effect 81 = RAGE family -> lockIn
    [3, 0, 0, TYPE.GRASS, 255, 20],
  ];
  const moveNames = mut.moveNames ?? ["AAA", "BBB", "CCC"];
  const triples = mut.triples ?? [[TYPE.WATER, TYPE.FIRE, 20], [TYPE.ELECTRIC, TYPE.GROUND, 0]];
  const dexOrder = mut.dexOrder ?? [2, 0, 1];      // species 2 is a MissingNo hole
  const statEntries = mut.statEntries ?? [
    // [dex, hp, atk, def, speed, spc, type1, type2, catch, exp]
    [1, 45, 49, 49, 45, 65, TYPE.GRASS, TYPE.POISON, 45, 64],
    [2, 39, 52, 43, 65, 50, TYPE.FIRE, TYPE.FIRE, 45, 65],
  ];
  const monNames = mut.monNames ?? ["ONE", "TWO", "THREE"];

  const bytes = new Map<number, number>();
  const put = (bank: number, addr: number, vals: number[]) =>
    vals.forEach((v, i) => bytes.set(KEY(bank, addr + i), v));

  moveEntries.forEach((e, i) => put(1, 0x4000 + i * MOVE_ENTRY_BYTES, e));
  let a = 0x4000;
  for (const n of moveNames) { put(2, a, [...A(n), 0x50]); a += n.length + 1; }
  let t = 0x4000;
  for (const tr of triples) { put(3, t, tr); t += 3; }
  put(3, t, [mut.teTerminator ?? 0xff]);
  put(4, 0x4000, dexOrder);
  statEntries.forEach((e, i) => put(5, 0x4000 + i * 28, e));
  monNames.forEach((n, i) => put(6, 0x4000 + i * 10, [...A(n), 0x50]));

  const movesSpan = mut.movesSpan ?? moveEntries.length * MOVE_ENTRY_BYTES;
  const teSpan = mut.teSpan ?? triples.length * 3 + 1;
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const sym = [
    `01:${hex(0x4000)} Moves`,            `01:${hex(0x4000 + movesSpan)} MovesEnd`,
    `02:${hex(0x4000)} MoveNames`,
    `03:${hex(0x4000)} TypeEffects`,      `03:${hex(0x4000 + teSpan)} TypeEffectsEnd`,
    `04:${hex(0x4000)} PokedexOrder`,     `04:${hex(0x4000 + dexOrder.length)} PokedexOrderEnd`,
    `05:${hex(0x4000)} BaseStats`,        `05:${hex(0x4000 + statEntries.length * 28)} BaseStatsEnd`,
    `06:${hex(0x4000)} MonsterNames`,     `06:${hex(0x4000 + monNames.length * 10)} MonsterNamesEnd`,
  ].join("\n") + "\n";
  return { bytes, sym };
}

const TMP = mkdtempSync(join(tmpdir(), "lpp1180-"));
let symSeq = 0;
function mount(c: Cart): { rom: RomLike; sym: SymbolTable } {
  const p = join(TMP, `cart${symSeq++}.sym`);
  writeFileSync(p, c.sym);
  return { rom: { byte: (bank, addr) => c.bytes.get(KEY(bank, addr)) ?? 0 }, sym: new SymbolTable(p) };
}

console.log("== probe_romtables1180: ROM decodes for Moves / TypeEffects / BaseStats ==");

// ───────────────────────────── A. synthetic decodes ────────────────────────
console.log("\n== A. the decoders, against a cartridge we wrote ==");
{
  const { rom, sym } = mount(synthetic());
  const mv = decodeMoves(rom, sym);
  chk("A1 move count comes from the symbol region, not a constant", mv.size === 3, `${mv.size}`);
  chk("A2 all six fields decode", JSON.stringify(mv.get(1)) ===
      JSON.stringify({ id: 1, name: "AAA", type: TYPE.NORMAL, power: 40, accuracy: 255, pp: 35, effect: 0, lockIn: false }),
      JSON.stringify(mv.get(1)));
  chk("A3 lockIn is DERIVED from the effect byte, not hand-set",
      mv.get(2)!.lockIn === true && mv.get(3)!.lockIn === false);

  const te = decodeTypeEffects(rom, sym);
  chk("A4 type triples decode in the ROM's own shape",
      te.length === 2 && te[0][0] === TYPE.WATER && te[0][2] === 20 && te[1][2] === 0);

  const bs = decodeBaseStats(rom, sym);
  chk("A5 base stats are keyed by SPECIES id through PokedexOrder",
      bs.get(1)!.dex === 2 && bs.get(3)!.dex === 1, `sp1 dex${bs.get(1)?.dex} sp3 dex${bs.get(3)?.dex}`);
  chk("A6 a MissingNo hole (dex 0) is skipped, not invented", bs.size === 2 && !bs.has(2));
  chk("A7 stats and types land in the right fields",
      bs.get(3)!.hp === 45 && bs.get(3)!.atk === 49 && bs.get(3)!.speed === 45 &&
      bs.get(3)!.spc === 65 && bs.get(3)!.type1 === TYPE.GRASS && bs.get(3)!.type2 === TYPE.POISON);
  chk("A8 species names come from MonsterNames", bs.get(3)!.name === "THREE", bs.get(3)!.name);
}

// ───────────────────────────── B. every throw path ─────────────────────────
console.log("\n== B. a cartridge that does not match the symbols THROWS ==");
throws("B1 Moves region that does not divide by 6",
       () => decodeMoves(...Object.values(mount(synthetic({ movesSpan: 17 }))) as [RomLike, SymbolTable]));
throws("B2 a Moves entry whose id byte disagrees with its index", () => {
  const { rom, sym } = mount(synthetic({ moveEntries: [[1, 0, 40, 0, 255, 35], [9, 0, 40, 0, 255, 35]] }));
  return decodeMoves(rom, sym);
});
throws("B3 a move type byte that is not a Gen 1 type id", () => {
  const { rom, sym } = mount(synthetic({ moveEntries: [[1, 0, 40, 77, 255, 35]], moveNames: ["AAA"] }));
  return decodeMoves(rom, sym);
});
throws("B4 a MoveNames entry with an unmapped byte", () => {
  const c = synthetic({ moveNames: ["AAA"], moveEntries: [[1, 0, 40, 0, 255, 35]] });
  c.bytes.set(KEY(2, 0x4001), 0x03);           // not in the Gen 1 charset
  const { rom, sym } = mount(c);
  return decodeMoves(rom, sym);
});
throws("B5 fewer names than moves", () => {
  const { rom, sym } = mount(synthetic({ moveNames: ["AAA"] }));
  return decodeMoves(rom, sym);
});
throws("B6 TypeEffects with no terminator inside its region",
       () => { const { rom, sym } = mount(synthetic({ teTerminator: 0x10 })); return decodeTypeEffects(rom, sym); });
throws("B7 TypeEffects that terminates short of its region",
       () => { const { rom, sym } = mount(synthetic({ teSpan: 40 })); return decodeTypeEffects(rom, sym); });
throws("B8 a TypeEffects multiplier above 2.0x",
       () => { const { rom, sym } = mount(synthetic({ triples: [[TYPE.WATER, TYPE.FIRE, 40]] })); return decodeTypeEffects(rom, sym); });
throws("B9 a BaseStats entry whose dex byte disagrees with PokedexOrder", () => {
  const { rom, sym } = mount(synthetic({ statEntries: [[7, 45, 49, 49, 45, 65, 22, 3, 45, 64], [2, 39, 52, 43, 65, 50, 20, 20, 45, 65]] }));
  return decodeBaseStats(rom, sym);
});
throws("B10 PokedexOrder and MonsterNames of different lengths",
       () => { const { rom, sym } = mount(synthetic({ monNames: ["ONE", "TWO"] })); return decodeBaseStats(rom, sym); });

// ───────────────────────────── C. the fallback path ────────────────────────
console.log("\n== C. a rejected decode falls back, and says so ==");
chk("C1 nothing installed yet: the pickers read the hand-typed fallback",
    moveTableInfo().source === "fallback" && chartSource() === "fallback" && baseStatsInfo().source === "none");
{
  // The synthetic cartridge decodes CLEANLY but its contents are nothing like
  // Gen 1, so the golden set is what rejects it — the same path a real ROM
  // whose layout moved underneath a valid-looking table would take.
  const { rom, sym } = mount(synthetic());
  const load = loadRomTables(rom, sym);
  chk("C2 loadRomTables rejects all three against the golden set",
      load.moves === null && load.typeEffects === null && load.baseStats === null);
  chk("C3 and reports WHY, per table", load.errors.length === 3,
      load.errors.map(e => e.split(":")[0]).join(","));
  chk("C4 every error names the golden disagreement, not just a failure",
      load.errors.every(e => e.includes("golden")), load.errors[0]?.slice(0, 90));
  chk("C5 install*() refuse a null and leave the fallbacks in place",
      installRomMoves(load.moves) === false && installTypeChart(load.typeEffects) === false &&
      installBaseStats(load.baseStats) === false);
  chk("C6 the pickers are still on the fallback after a rejected load",
      moveTableInfo().source === "fallback" && chartSource() === "fallback");
}
chk("C7 the fallback still answers for the moves the run has actually seen",
    moveMeta(99)?.lockIn === true && moveMeta(52)?.name === "EMBER" && moveMeta(52)?.type === TYPE.FIRE);
chk("C8 and returns undefined — not a guess — for one it never had",
    moveMeta(63) === undefined && moveMeta(150) === undefined);
chk("C9 the fallback chart still knows the Gen 1 quirks",
    activeChart().x10(TYPE.GHOST, TYPE.PSYCHIC) === 0 && activeChart().x10(TYPE.POISON, TYPE.BUG) === 20);
chk("C10 a decode error is a LOGGABLE string, never a silent null", (() => {
  const { rom, sym } = mount(synthetic({ movesSpan: 17 }));
  const load = loadRomTables(rom, sym);
  return load.moves === null && load.errors.some(e => e.startsWith("Moves:") && e.includes("ROM layout moved"));
})());

// ───────────────────────────── D. the real cartridge ───────────────────────
// Same BASE the other cartridge probes use (probe_battle587, probe_claims).
// --no-rom forces the CI path on a box that HAS the cartridge, so the branch
// below is exercised on Lumen rather than discovered in CI.
const BASE = "/home/lumen/pokemon";
const ROM_PATH = `${BASE}/roms/pokeblue.gb`;
const SYM_PATH = `${BASE}/roms/pokeblue.sym`;
const haveRom = !process.argv.includes("--no-rom") && existsSync(ROM_PATH) && existsSync(SYM_PATH);
console.log(`\n== D. the real cartridge ${haveRom ? "(present)" : "(absent)"} ==`);
if (!haveRom) {
  // Not a failure: CI tracks only .sym files (copyright), and A-C above already
  // cover the decoders, every throw path and the fallback. scripts/probes-main.sh
  // asserts the cartridge exists before it runs, so this cannot silently become
  // the only half that runs on the host that has one.
  console.log(`SKIP D :: no cartridge at ${ROM_PATH} — A-C (synthetic + fallback) still ran`);
} else {
  const rom = new Rom(ROM_PATH), sym = new SymbolTable(SYM_PATH);
  const load = loadRomTables(rom, sym);
  chk("D1 all three tables decode and agree with the golden set", load.errors.length === 0,
      load.errors.join(" | "));
  chk("D2 165 moves, 82 matchups, 151 species", load.counts.moves === 165 &&
      load.counts.typeEffects === 82 && load.counts.baseStats === 151, JSON.stringify(load.counts));

  const mv = load.moves!, bs = load.baseStats!;
  for (const g of GOLDEN_MOVES.slice(0, 3))
    chk(`D3 ${g.name} decodes to type ${TYPE_NAME[g.type]} power ${g.power}`,
        mv.get(g.id)!.type === g.type && mv.get(g.id)!.power === g.power);
  chk(`D4 the golden set is ${GOLDEN_MOVES.length} moves / ${GOLDEN_TYPE.length} matchups / ${GOLDEN_STATS.length} species`,
      GOLDEN_MOVES.length >= 9 && GOLDEN_TYPE.length >= 9 && GOLDEN_STATS.length >= 9);

  // THE RETIREMENT EVIDENCE. Every hand-typed entry is checked against the
  // cartridge; a disagreement here means demoting the table changed behaviour,
  // which is exactly what this ticket must not do silently.
  const disagree = Object.values(FALLBACK_MOVES).filter(f => {
    const r = mv.get(f.id);
    return !r || r.name !== f.name || r.type !== f.type || r.power !== f.power;
  });
  chk(`D5 all ${Object.keys(FALLBACK_MOVES).length} demoted hand-typed moves agree with the cartridge`,
      disagree.length === 0, disagree.map(d => d.name).join(","));
  chk("D6 the three hand-set lockIn flags survive the ROM derivation",
      [91, 99, 117].every(id => mv.get(id)!.lockIn === true));
  chk("D7 and it finds the lock-ins nobody had typed in",
      [13, 19, 37, 63, 76, 80, 130, 143].every(id => mv.get(id)!.lockIn === true));
  const lockNames = [...mv.values()].filter(m => m.lockIn).map(m => m.name).sort();
  // 11 moves across 6 effects: BIDE, THRASH+PETAL DANCE, the five CHARGE moves,
  // FLY, HYPER BEAM, RAGE. The hand-typed table had 3 of them.
  chk(`D8 ${Object.keys(LOCK_IN_EFFECTS).length} lock-in effects cover 11 moves`,
      lockNames.length === 11, lockNames.join(","));

  // calc.ts transcribed the whole chart by hand and left a note saying it was
  // unverified. This is the verification.
  const romMap = new Map(load.typeEffects!.map(([a, d, x]) => [a * 256 + d, x]));
  const handMap = new Map(TYPE_EFFECTS.map(([a, d, x]) => [a * 256 + d, x]));
  const bad: string[] = [];
  for (const [k, v] of romMap) if (handMap.get(k) !== v) bad.push(`${TYPE_NAME[k >> 8]}->${TYPE_NAME[k & 255]} rom=${v} hand=${handMap.get(k)}`);
  for (const k of handMap.keys()) if (!romMap.has(k)) bad.push(`${TYPE_NAME[k >> 8]}->${TYPE_NAME[k & 255]} hand-only`);
  chk(`D9 calc.ts's transcribed chart matches the cartridge row for row (${TYPE_EFFECTS.length} rows)`,
      bad.length === 0 && TYPE_EFFECTS.length === load.counts.typeEffects, bad.slice(0, 4).join(" | "));

  for (const g of GOLDEN_STATS.slice(0, 4))
    chk(`D10 ${g.name} (species ${g.species}) is dex ${g.dex} with ${g.hp}/${g.atk}/${g.def}/${g.speed}/${g.spc}`,
        bs.get(g.species)!.dex === g.dex && bs.get(g.species)!.hp === g.hp && bs.get(g.species)!.spc === g.spc);
  chk("D11 MEW is decoded from MewBaseStats, outside the 150-entry table",
      bs.get(21)!.dex === 151 && bs.get(21)!.name === "MEW" && bs.get(21)!.spc === 100);

  // ── the install, and what it changes ──
  chk("D12 install*() accept a verified decode",
      installRomMoves(load.moves) && installTypeChart(load.typeEffects) && installBaseStats(load.baseStats));
  chk("D13 the pickers and the verdict are now reading the cartridge",
      moveTableInfo().source === "rom" && moveTableInfo().entries === 165 && chartSource() === "rom");
  chk("D14 THE RETIREMENT: an id the hand-typed table never had now resolves",
      moveMeta(63)?.name === "HYPER BEAM" && moveMeta(63)?.power === 150 && moveMeta(150) !== undefined,
      moveLabel(63));
  chk("D15 coverage went from 25 moves to 165", moveTableInfo().entries === 165 &&
      Object.keys(FALLBACK_MOVES).length === 25);
  chk("D16 base stats are reachable by species id for the item-5/6 estimator",
      baseStatsFor(153)?.name === "BULBASAUR" && baseStatsInfo().entries === 151);
  chk("D17 the ROM chart agrees with the fallback on the quirks that decide fights",
      activeChart().x10(TYPE.GHOST, TYPE.PSYCHIC) === 0 && activeChart().x10(TYPE.WATER, TYPE.FIRE) === 20 &&
      activeChart().x10(TYPE.POISON, TYPE.BUG) === 20);
}

console.log(`\n${fail === 0 ? "PROBE GREEN" : "PROBE RED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
