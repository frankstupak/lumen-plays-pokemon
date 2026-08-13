// Stage 2: clerk -> BUY -> item list. Learn menu RAM invariants live.
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

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, "/tmp/in-mart.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-mart2-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const md = (tag: string) => console.log(`[${tag}] cur=${M()[sym.addr("wCurrentMenuItem")]} max=${M()[sym.addr("wMaxMenuItem")]} scroll=${M()[sym.addr("wListScrollOffset")]} qty=${M()[sym.addr("wItemQuantity")]} textUp=${sync.textUp()} dlgOpen=${dlg.open()} cursor=${JSON.stringify(scr.cursor())}`);
const show = (tag: string) => { md(tag); console.log(`--- screen [${tag}] ---\n` + scr.text()); };

(async () => {
  await emu.framesAsync(60); await sync.settle();
  // clerk candidates: sprites (0,5) (5,5) (3,3). Counter clerk usually leftmost.
  const d = await act.interactAt(0, 5);
  console.log("interact(0,5) ->", d ? d.stoppedAt + " | " + d.lines.join(" / ") : "no_response");
  show("after-interact");
  // If a choice menu is up (BUY/SELL/QUIT), select entry 0 = BUY
  await emu.tapAsync(KEYS.A, 8, 30); await sync.settle(300);
  show("after-A(buy?)");
  saveSnapshotFile(emu, "/tmp/mart-buylist.state.gz");
})();
