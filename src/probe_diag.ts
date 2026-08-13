// Diagnose post-use_item movement lock: dump input-gate RAM, try one step.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { Battle } from "./battle";
import { StateReader } from "./state";
import { Items, ITEM } from "./items";

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, "/tmp/in-mart.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-diag-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const items = new Items(emu, sym, scr, sync, dlg, nav, map, bat);
const M = () => emu.mem();
const dump = (tag: string) => {
  const st = reader.read();
  console.log(`[${tag}] pos=(${st.x},${st.y}) joyIgnore=${M()[sym.addr("wJoyIgnore")].toString(16)} ` +
    `simIdx=${M()[sym.addr("wSimulatedJoypadStatesIndex")]} textUp=${sync.textUp()} dlg=${dlg.open()} txtLen=${scr.text().trim().length}`);
};

(async () => {
  await emu.framesAsync(60); await sync.settle();
  dump("baseline");
  // fresh buy so bag has antidote, then use it
  console.log(await items.buy(ITEM.ANTIDOTE, 1));
  dump("post-buy");
  console.log(await items.useOverworld(ITEM.ANTIDOTE));
  dump("post-use");
  // try one raw step
  const p0 = reader.read();
  await emu.tapAsync(KEYS.UP, 8, 24); await sync.settle(300);
  const p1 = reader.read();
  console.log("raw UP step:", `(${p0.x},${p0.y}) -> (${p1.x},${p1.y})`, p0.y !== p1.y || p0.x !== p1.x ? "MOVED" : "BLOCKED");
  dump("after-step");
  console.log("screen now:\n" + scr.text());
})();
