// wq#515 grounding: dump every ROM-derived map name so the CRITICAL_PATH rank
// table in tools/lpp-frontier is labelled from the ROM rather than from memory.
// Read-only: opens the ROM, prints, exits.
//   npx tsx tools/dump_map_names.ts            # all named maps
//   npx tsx tools/dump_map_names.ts --json     # id -> name, for tooling
import { Rom } from "../src/rom";
import { SymbolTable } from "../src/symbols";
import { GameNames } from "../src/names";

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const names = new GameNames(rom, sym);

const out: Record<number, string> = {};
for (let id = 0; id < names.mapCount; id++) {
  const n = names.mapName(id);
  if (n) out[id] = n;
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log(`# ${Object.keys(out).length} named of ${names.mapCount} slots`);
  for (const [id, n] of Object.entries(out)) console.log(String(id).padStart(4), n);
}
