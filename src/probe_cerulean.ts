// wq#478 probe: ceruleanGuidance against real checkpoints.
// Expect: ACTIVE (with live money/potion numbers) on post-Brock Route 4
// states; EMPTY on pre-Misty states outside the region (Mt Moon interiors)
// and on pre-Brock archive states.
// Usage: npx tsx src/probe_cerulean.ts
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";
import { ceruleanGuidance, ceruleanBuyPlan } from "./guidance";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const CASES = [
  ["Route4 live", "/home/lumen/pokemon/checkpoints/auto-msqhs94q-map15.state.gz"],
  ["MtMoon 1F", "/home/lumen/pokemon/checkpoints/auto-msqhs94q-map59.state.gz"],
  ["preBrock museum", "/home/lumen/pokemon/checkpoints/archive-regressed-20260812/auto-mspxdhzz-map52.state.gz"],
];
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
