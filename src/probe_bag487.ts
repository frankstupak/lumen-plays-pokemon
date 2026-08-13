// wq#487 one-shot: what is actually in the bag + what the last wild foe was,
// read from the newest checkpoint. Answers "why did transit hand back?".
import { readdirSync, statSync } from "fs";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { ITEM_NAME } from "./items";
import { WANTED } from "./catch_policy";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const CK = "/home/lumen/pokemon/checkpoints";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator(ROM);

const newest = readdirSync(CK).filter(f => f.endsWith(".state.gz"))
  .map(f => ({ f, m: statSync(`${CK}/${f}`).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];
console.log("checkpoint:", newest.f, new Date(newest.m).toISOString());
loadSnapshotFile(emu, `${CK}/${newest.f}`);

const m = emu.mem();
const n = m[sym.addr("wNumBagItems")];
const a = sym.addr("wBagItems");
console.log("bag entries:", n);
for (let i = 0; i < Math.min(n, 20); i++) {
  const id = m[a + i * 2], qty = m[a + i * 2 + 1];
  console.log(`  ${ITEM_NAME[id] ?? "id" + id} x${qty}`);
}
const foe = m[sym.addr("wEnemyMonSpecies")];
console.log("last enemy species:", foe, WANTED[foe] ? `WANTED (${WANTED[foe].name}, urgent=${WANTED[foe].urgent})` : "not wanted");
console.log("repel steps left:", m[sym.addr("wRepelRemainingSteps")]);
