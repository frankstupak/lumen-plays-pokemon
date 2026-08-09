// S3 exploration: walk into Viridian Mart, dump sprites/menus at each step.
import { Emulator, loadSnapshotFile, saveSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { StateReader } from "./state";

const sym = new SymbolTable("roms/pokeblue.sym");
const emu = new Emulator("roms/pokeblue.gb");
loadSnapshotFile(emu, "checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-mart-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const menuDump = (tag: string) => console.log(`[${tag}] cur=${M()[sym.addr("wCurrentMenuItem")]} max=${M()[sym.addr("wMaxMenuItem")]} scroll=${M()[sym.addr("wListScrollOffset")]} qty=${M()[sym.addr("wItemQuantity")]} textbox=${M()[sym.addr("wTextBoxID")]}`);

(async () => {
  await emu.framesAsync(120); await sync.settle();
  let st = reader.read();
  console.log("START", JSON.stringify({ map: st.map, x: st.x, y: st.y, money: st.money }));
  map.build();
  console.log("WARPS", map.warps.map((w, i) => `${i}:(${w.x},${w.y})->m${w.destMap}`).join(" "));
  if (st.map === 1) {
    const wi = map.warps.findIndex(w => w.destMap === 42);
    console.log("entering mart warp", wi);
    const r = await nav.enterWarp(map.warps[wi]);
    console.log("enterWarp ->", r);
  }
  await sync.settle(); st = reader.read();
  console.log("NOW", JSON.stringify({ map: st.map, x: st.x, y: st.y }));
  map.build();
  console.log("SPRITES", JSON.stringify(map.sprites));
  console.log("GRID\n" + map.ascii(st.x, st.y));
  console.log("SCREEN:\n" + scr.text());
  saveSnapshotFile(emu, "/tmp/in-mart.state.gz");
  menuDump("pre-interact");
})();
