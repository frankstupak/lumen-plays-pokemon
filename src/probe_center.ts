// S4 exploration: Viridian Pokemon Center - layout, nurse talk, heal flow.
import { Emulator, loadSnapshotFile, saveSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { StateReader } from "./state";

const sym = new SymbolTable("roms/pokeblue.sym");
const emu = new Emulator("roms/pokeblue.gb");
loadSnapshotFile(emu, "checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-center-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const txt = () => scr.text();
const hp = () => { const p = reader.read().party[0]; return p ? `${p.hp}/${p.maxHp}` : "-"; };
async function tap(k: number, settle = 200) { await emu.tapAsync(k, 8, 16); await sync.settle(settle); }
async function waitFor(p: () => boolean, l: string, mf = 900) {
  for (let i = 0; i < mf / 10; i++) { if (p()) return true; await emu.framesAsync(10); }
  console.log(`TIMEOUT: ${l}\n${txt()}`); return false;
}
const twoOpt = () => M()[sym.addr("wTwoOptionMenuID")] !== 0 || (/YES/.test(txt()) && scr.cursor() !== null);

(async () => {
  await emu.framesAsync(60); await sync.settle();
  console.log("start hp:", hp(), "map:", reader.read().map);
  map.build();
  const wi = map.warps.findIndex(w => w.destMap === 41);
  console.log("center warp idx", wi);
  await nav.enterWarp(map.warps[wi]); await sync.settle(400);
  const st = reader.read();
  console.log("IN CENTER map:", st.map, "pos:", st.x, st.y);
  map.build();
  console.log("SPRITES", JSON.stringify(map.sprites));
  console.log("GRID\n" + map.ascii(st.x, st.y));
  // nurse in Gen1 centers: behind counter, top area. Try counter-talk from below.
  // Dump attempts at likely tiles: stand at (x=3,y=4?) facing UP etc. Learn from grid first run.
  saveSnapshotFile(emu, "/tmp/in-center.state.gz");
})();
