// P1 acceptance: scripted Pallet bedroom -> Oak's lab, zero LLM.
import { existsSync } from "fs";
import { Emulator, KEYS, saveSnapshotFile, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const SNAP = "/home/lumen/pokemon/saves/boot-overworld.state.gz";
const ROUTE = [38, 37, 0, 40]; // bedroom -> house 1F -> Pallet -> Oak's lab

const bus = new EventBus("/home/lumen/pokemon/events", "p1-" + Date.now());
const sym = new SymbolTable(SYM);
const emu = new Emulator(ROM);
const reader = new StateReader(emu, sym);
const rom = new Rom(ROM);
const map = new MapModel(emu, sym, rom);
const nav = new Navigator(emu, sym, map, bus);

if (existsSync(SNAP)) {
  loadSnapshotFile(emu, SNAP);
  console.log("loaded boot snapshot");
} else {
  emu.frames(400);
  for (let i = 0; i < 8; i++) emu.tap(KEYS.START);
  for (let i = 0; i < 4; i++) emu.tap(KEYS.A);
  const ready = () => { const m = emu.mem();
    return m[sym.addr("wCurMap")] === 38 && m[sym.addr("wCurMapWidth")] !== 0
      && m[sym.addr("wNumberOfWarps")] !== 0; };
  for (let i = 0; i < 400 && !ready(); i++) emu.tap(KEYS.A, 8, 14);
  emu.frames(120);
  if (!ready()) { console.error("boot failed: map data never loaded"); process.exit(1); }
  saveSnapshotFile(emu, SNAP);
  console.log("booted + snapshot saved");
}

(async () => {
for (let leg = 0; leg < ROUTE.length - 1; leg++) {
  const cur = ROUTE[leg], next = ROUTE[leg + 1];
  let p = nav.pos();
  if (p.map !== cur) { console.error(`expected map ${cur}, at ${p.map}`); process.exit(2); }
  map.build();
  nav.clearLearned();
  const warp = map.warps.find(w => w.destMap === next || (next === 0 && w.destMap === 0xff));
  if (!warp) { console.error(`no warp ${cur}->${next}; warps: ${JSON.stringify(map.warps)}`); process.exit(3); }
  console.log(`leg ${cur}->${next}: pos(${p.x},${p.y}) warp(${warp.x},${warp.y})`);
  bus.emit("state_read", reader.read() as unknown as object);
  const r = await nav.goto(warp.x, warp.y);
  p = nav.pos();
  console.log(`  result=${r} now map=${p.map} pos(${p.x},${p.y})`);
  if (p.map !== next) {
    // arrived on warp tile without transition (edge warps need a step "into" it)
    console.error(`  transition missing after ${r}`); 
    console.log(map.ascii(p.x, p.y));
    process.exit(4);
  }
}

const fin = nav.pos();
emu.screenPng("/home/lumen/pokemon/events/p1_final.png");
if (fin.map === 40) { console.log(`P1 VERIFY: ALL PASS — in Oak's lab at (${fin.x},${fin.y})`); }
else { console.error("P1 FAIL"); process.exit(5); }
})();
