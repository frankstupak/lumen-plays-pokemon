// wq#542 / rabbit17b — INDEPENDENT verification of the load-bearing claim in
// probe_steptrace542 sections G1/G2: that MapModel believes the y=12 boundary
// is walkable while the EMULATOR refuses to step onto it.
//
// I did not take that on trust. probe_steptrace542 is inherited work whose D
// summary line reported "largest learnedBlocked set: 0 cells" while the traces
// directly above it showed sets of four — and the last two probes I audited in
// this lane (rabbit15's probe_evt522 section B, wq#540's three GREEN probes)
// were each green while exercising nothing. So this drives the emulator
// DIRECTLY, with raw button presses, and never goes through Navigator.step().
//
// It also maps the FULL EXTENT of the disagreement across the strip, which the
// inherited probe sampled at a single column (34,12). Extent is what a
// follow-up ticket needs.
//
// ISOLATION: read-only. Loads checkpoints, presses buttons in memory, writes
// nothing anywhere.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { readdirSync } from "fs";
import { join } from "path";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const rom = new Rom(ROM);
const CK = "/home/lumen/pokemon/checkpoints";
const MAP = 61;

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

/** Press a direction repeatedly, raw, settling between presses. Returns
 *  "battle" if an encounter interrupts — the CALLER must treat that as an
 *  inconclusive trial, not as a pass. (The inherited G2 counts a battle as a
 *  PASS, so an unlucky encounter can green it without testing the wall.) */
async function pressDir(emu: Emulator, sy: Sync, key: number, n: number): Promise<string> {
  for (let i = 0; i < n; i++) {
    await emu.tapAsync(key, 8, 2); await emu.framesAsync(22); await sy.settle(300);
    if (emu.mem()[sym.addr("wIsInBattle")] !== 0) return "battle";
  }
  return "ok";
}
const posOf = (emu: Emulator) => { const s = new StateReader(emu, sym).read(); return { x: s.x, y: s.y }; };

// Find a map61 checkpoint standing in the strip, BY PROPERTY not by name.
let picked: string | null = null;
for (const f of readdirSync(CK).filter(f => f.endsWith(".state.gz"))) {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, join(CK, f)); } catch { continue; }
  const s = new StateReader(emu, sym).read();
  if (s.map === MAP && (s.y === 10 || s.y === 11)) { picked = join(CK, f); break; }
}
if (!picked) { console.log("SKIP: no map61 strip checkpoint available"); process.exit(0); }
console.log(`fixture (resolved by property): ${picked}\n`);

async function main() {
const emu0 = new Emulator(ROM);
loadSnapshotFile(emu0, picked!);
const mm = new MapModel(emu0, sym, rom); mm.build();
const start = posOf(emu0);
console.log(`start (${start.x},${start.y})\n`);

// ---- A. what does the MAP MODEL believe about the boundary row? ----------
console.log("=== A. MapModel's view of y=11 (strip floor) and y=12 (boundary) ===");
const cols: number[] = [];
for (let x = 24; x <= 35; x++) cols.push(x);
const modelWalkable12 = cols.filter(x => mm.passable(x, 12));
const modelWalkable11 = cols.filter(x => mm.passable(x, 11));
console.log(`  y=11 passable per MapModel: ${modelWalkable11.join(",") || "(none)"}`);
console.log(`  y=12 passable per MapModel: ${modelWalkable12.join(",") || "(none)"}`);
chk("A1 MapModel believes at least part of the y=12 boundary is walkable",
  modelWalkable12.length > 0, `${modelWalkable12.length}/${cols.length} columns`);

// ---- B. what does the EMULATOR do, per column, with RAW presses? ---------
console.log("\n=== B. raw DOWN presses from y=11, column by column (no Navigator) ===");
const emuMoved: number[] = [], emuRefused: number[] = [], inconclusive: number[] = [];
for (const x of modelWalkable12) {
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, picked!);
  const sy = new Sync(emu, sym);
  let p = posOf(emu); let guard = 0; let interrupted = "";
  while (p.x !== x && guard++ < 20) {
    const r = await pressDir(emu, sy, p.x < x ? KEYS.RIGHT : KEYS.LEFT, 1);
    if (r === "battle") { interrupted = "battle-while-approaching"; break; }
    p = posOf(emu);
  }
  if (interrupted) { console.log(`  x=${x}: INCONCLUSIVE (${interrupted})`); inconclusive.push(x); continue; }
  if (p.x !== x) { console.log(`  x=${x}: could not reach column (stopped at ${p.x}) — skipped`); inconclusive.push(x); continue; }
  if (p.y !== 11) { await pressDir(emu, sy, KEYS.DOWN, 1); p = posOf(emu); }
  const before = posOf(emu);
  const dr = await pressDir(emu, sy, KEYS.DOWN, 6);
  const after = posOf(emu);
  if (dr === "battle") { console.log(`  x=${x}: INCONCLUSIVE (battle during DOWN)`); inconclusive.push(x); continue; }
  const moved = after.y > before.y;
  (moved ? emuMoved : emuRefused).push(x);
  console.log(`  x=${x}: MapModel says WALKABLE, 6 raw DOWN -> y ${before.y} -> ${after.y}  ${moved ? "MOVED" : "REFUSED"}`);
}
chk("B1 the emulator REFUSES every column the model calls walkable",
  emuMoved.length === 0 && emuRefused.length > 0,
  `refused=[${emuRefused.join(",")}] moved=[${emuMoved.join(",")}]`);

// ---- C. control: the same machinery moves fine in another direction -----
console.log("\n=== C. control — this is not a wedged emulator ===");
{
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, picked!);
  const sy = new Sync(emu, sym);
  const b = posOf(emu);
  await pressDir(emu, sy, KEYS.UP, 3);
  const a = posOf(emu);
  chk("C1 NORTH moves from the same fixture with the same press routine",
    a.y < b.y, `y ${b.y} -> ${a.y}`);
}

console.log(`\n*** DISAGREEMENT: MapModel calls ${modelWalkable12.length} boundary columns `
  + `walkable; the emulator refused ${emuRefused.length} of the ${emuRefused.length + emuMoved.length} tested. ***`);
console.log(`  inconclusive (battle interrupted): [${inconclusive.join(",")}]`);
console.log(`probe_wall542: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
main();
