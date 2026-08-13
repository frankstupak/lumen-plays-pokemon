// wq#478 probe: ceruleanGuidance against real checkpoints.
// Expect: ACTIVE (with live money/potion numbers) on post-Brock Route 4
// states; EMPTY on pre-Misty states outside the region (Mt Moon interiors)
// and on pre-Brock archive states.
// Usage: npx tsx src/probe_cerulean.ts
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";
import { ceruleanGuidance, ceruleanBuyPlan } from "./guidance";
// wq#540: TWO OF THIS PROBE'S THREE CASES NAMED CHECKPOINTS THAT HAVE ROTATED
// OFF DISK, so it died with an ENOENT stack trace on the FIRST case and never
// reached the third — which does still exist. What each case needs is a map,
// not a filename: "a Route 4 state", "a Mt Moon 1F state", "a pre-Brock
// museum state". Resolved by property, and a case whose map is no longer
// represented is reported and skipped rather than killing the run.
import { findFixture } from "./fixtures";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const WANTED: [string, number, string][] = [
  ["Route4 live", 15, "guidance ACTIVE: post-Brock, inside the Cerulean approach"],
  ["MtMoon 1F", 59, "guidance EMPTY: pre-Misty, inside the cave"],
  ["preBrock museum", 52, "guidance EMPTY: pre-Brock archive state"],
];
const CASES: [string, string][] = [];
for (const [label, map, why] of WANTED) {
  const f = findFixture(sc => sc.map === map,
    [`${"/home/lumen/pokemon"}/checkpoints`, `${"/home/lumen/pokemon"}/saves`,
     `${"/home/lumen/pokemon"}/checkpoints/archive-regressed-20260812`,
     `${"/home/lumen/pokemon"}/checkpoints/archive-pre-s2`]);
  if (f) CASES.push([label, f]);
  else console.log(`SKIP ${label} (map ${map}) — no such state on disk. ` +
                   `Expected ${why}. This is corpus rot, not a code defect.`);
}
if (!CASES.length) {
  console.log("FAIL FIXTURE MISSING: not one of this probe's map cases is represented on disk.");
  process.exit(1);
}
for (const [label, file] of CASES) {
  const e = new Emulator(ROM);
  loadSnapshotFile(e, file);
  const rd = new StateReader(e, sym);
  const s = rd.read();
  const g = ceruleanGuidance(e, sym, rd);
  console.log(`\n--- ${label} (map ${s.map}, $${s.money}, lead L${s.party[0]?.level}) ---`);
  console.log(g ? g : "(empty - guidance inactive here)");
}
console.log("\n--- buy-plan table (potions=0) ---");
for (const money of [0, 250, 600, 1200, 3000])
  console.log(`$${money}: ${ceruleanBuyPlan(money, 0)}`);
console.log("--- buy-plan (money 3000, potions 5) ---");
console.log(ceruleanBuyPlan(3000, 5));
