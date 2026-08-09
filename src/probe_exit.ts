import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { StateReader } from "./state";
const sym = new SymbolTable("roms/pokeblue.sym");
const emu = new Emulator("roms/pokeblue.gb");
loadSnapshotFile(emu, "/tmp/s3-final.state.gz");
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-exit-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const reader = new StateReader(emu, sym);
(async () => {
  await emu.framesAsync(90); await sync.settle();
  const st = reader.read();
  console.log("pos", JSON.stringify({ map: st.map, x: st.x, y: st.y }), "screen empty:", scr.text().trim() === "");
  map.build();
  console.log("warps:", map.warps.map((w, i) => `${i}:(${w.x},${w.y})->m${w.destMap}`).join(" "));
  console.log("grid:\n" + map.ascii(st.x, st.y));
  for (let i = 0; i < map.warps.length; i++) {
    const r = await nav.enterWarp(map.warps[i]);
    const s2 = reader.read();
    console.log(`enterWarp(${i}) -> ${r} now map=${s2.map} (${s2.x},${s2.y})`);
    if (s2.map !== 42) break;
  }
})();
