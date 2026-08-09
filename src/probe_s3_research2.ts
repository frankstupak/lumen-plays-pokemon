// Research probe 2: exact useOverworld sequence with state dumps, in-mart.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Battle } from "./battle";
import { StateReader } from "./state";
import { Items, ITEM } from "./items";

const sym = new SymbolTable("roms/pokeblue.sym");
const emu = new Emulator("roms/pokeblue.gb");
loadSnapshotFile(emu, "checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-res2-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const items = new Items(emu, sym, scr, sync, dlg, nav, map, bat);

const m = () => emu.mem();
const r = (n: string) => m()[sym.addr(n)];
const tap = async (k: number, s = 250) => { await emu.tapAsync(k, 8, 16); await sync.settle(s); };
const st = (tag: string) =>
  console.log(`${tag}: max=${r("wMaxMenuItem")} cur=${r("wCurrentMenuItem")} scroll=${r("wListScrollOffset")} cf91=${r("wCurItem")} dlg=${dlg.open()} cursor=${JSON.stringify(scr.cursor())} textUp=${sync.textUp()}`);
const rows = (tag: string) => scr.text().split("\n").forEach((row, i) => { if (row.trim()) console.log(`${tag} r[${i}]: ${JSON.stringify(row)}`); });

(async () => {
  await emu.framesAsync(90); await sync.settle();
  // buy an antidote first so the bag has [balls? no - fresh state: bag empty] -> buy antidote
  console.log("buy ->", await items.buy(ITEM.ANTIDOTE, 1));
  console.log("bag:", items.bagLine());
  st("post-buy");
  // now the exact useOverworld front half, instrumented
  await tap(KEYS.START, 350); st("start1");
  await emu.framesAsync(60); st("start1+60f");
  await tap(KEYS.DOWN, 200); st("start-down");   // wake the menu, observe cur
  await tap(KEYS.UP, 200); st("start-up");
  rows("startmenu");
  // move to presumed ITEM idx = max-4
  const idx = Math.max(0, r("wMaxMenuItem") - 4);
  console.log("computed ITEM idx =", idx);
  while (r("wCurrentMenuItem") !== idx) await tap(r("wCurrentMenuItem") < idx ? KEYS.DOWN : KEYS.UP, 150);
  st("on-item"); await tap(KEYS.A, 350); st("after-item-A");
  await emu.framesAsync(60); st("bag+60f"); rows("bag");
  // bag: antidote should be row 0; press A and watch cf91
  await tap(KEYS.A, 300); st("after-bag-A"); rows("after-bag-A");
  await emu.framesAsync(40); st("after-bag-A+40f");
  // USE/TOSS? press A on default
  await tap(KEYS.A, 350); st("after-useA"); rows("after-useA");
  await emu.framesAsync(60); st("+60f"); rows("final");
  process.exit(0);
})().catch(e => { console.error("ERR", e); process.exit(2); });
