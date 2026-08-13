// Stage 3: counter-talk -> BUY -> list nav -> quantity -> confirm. Full flow.
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

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, "/tmp/in-mart.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-mart3-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const md = (tag: string) => console.log(`[${tag}] cur=${M()[sym.addr("wCurrentMenuItem")]} max=${M()[sym.addr("wMaxMenuItem")]} scroll=${M()[sym.addr("wListScrollOffset")]} qty=${M()[sym.addr("wItemQuantity")]} textUp=${sync.textUp()} cursor=${JSON.stringify(scr.cursor())}\n${scr.text()}\n---`);

(async () => {
  await emu.framesAsync(60); await sync.settle();
  await nav.goto(2, 5);
  await emu.tapAsync(KEYS.LEFT, 8, 20); await sync.settle(200);  // face counter
  await emu.tapAsync(KEYS.A, 8, 30); await sync.settle(400);
  // clerk greeting text scrolls; advance until menu cursor appears
  for (let i = 0; i < 10 && !scr.cursor(); i++) { await emu.tapAsync(KEYS.A, 8, 20); await sync.settle(300); }
  md("mart-menu");
  // BUY = entry 0: ensure cursor at 0 then A
  await emu.tapAsync(KEYS.A, 8, 30); await sync.settle(500);
  md("buy-list");
  // walk the list down twice to observe cursor/scroll behavior
  await emu.tapAsync(KEYS.DOWN, 8, 12); await sync.settle(150); md("down1");
  await emu.tapAsync(KEYS.DOWN, 8, 12); await sync.settle(150); md("down2");
  // select current entry -> quantity selector
  await emu.tapAsync(KEYS.A, 8, 24); await sync.settle(300); md("qty-open");
  await emu.tapAsync(KEYS.UP, 8, 12); await sync.settle(150); md("qty-up");
  await emu.tapAsync(KEYS.A, 8, 24); await sync.settle(400); md("confirm?");
  // confirm yes if asked
  await emu.tapAsync(KEYS.A, 8, 24); await sync.settle(500); md("after-confirm");
  const st = reader.read();
  const n = M()[sym.addr("wNumBagItems")]; const a = sym.addr("wBagItems");
  const bag = Array.from({ length: n }, (_, i) => `id=${M()[a+i*2]}x${M()[a+i*2+1]}`).join(" ");
  console.log("RESULT money=", st.money, "bag:", bag);
  saveSnapshotFile(emu, "/tmp/mart-postbuy.state.gz");
})();
