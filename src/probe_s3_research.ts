// Research probe: nail 3 unknowns before the S3 fixes.
// A) START menu exact row text (for ITEM entry detection)
// B) cf91 wCurItem behavior in mart buy list (cursor moves + selection)
// C) post-exitMart input state (wJoyIgnore / textUp / dlg / scr.cursor)
import { Emulator, loadSnapshotFile } from "./emulator";
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
import { KEYS } from "./emulator";

const sym = new SymbolTable("roms/pokeblue.sym");
const emu = new Emulator("roms/pokeblue.gb");
loadSnapshotFile(emu, "checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-res-" + Date.now());
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
const dumpRows = (tag: string) => {
  const rows = scr.text().split("\n");
  rows.forEach((row, i) => { if (row.trim()) console.log(`${tag} row[${i}]: ${JSON.stringify(row)}`); });
};
const state = (tag: string) =>
  console.log(`${tag}: joyIgnore=${r("wJoyIgnore")} textUp=${sync.textUp()} dlg=${dlg.open()} cursor=${JSON.stringify(scr.cursor())} cur=${r("wCurrentMenuItem")} cf91=${r("wCurItem")}`);

(async () => {
  await emu.framesAsync(90); await sync.settle();
  console.log("=== A: START MENU ===");
  await tap(KEYS.START, 400);
  dumpRows("A0"); state("A0");
  for (let i = 0; i < 3; i++) { await tap(KEYS.DOWN, 200); state(`A-down${i + 1}`); }
  for (let i = 0; i < 8; i++) await tap(KEYS.B, 200);
  state("A-closed");

  console.log("=== B: MART BUY LIST ===");
  map.build();
  const mart = map.warps.find(w => w.destMap === 42);
  if (mart) await nav.enterWarp(mart).catch((e: any) => console.log("mart entry err", e));
  console.log("map now", reader.read().map);
  // reach clerk (reuse Items approach coords)
  await nav.goto(2, 5).catch(() => nav.goto(3, 6).catch(() => {}));
  await tap(KEYS.LEFT, 200); await tap(KEYS.A, 300);
  for (let i = 0; i < 6 && !scr.text().includes("BUY"); i++) await tap(KEYS.A, 300);
  dumpRows("B-menu"); state("B-menu");
  // select BUY
  await tap(KEYS.A, 300);
  for (let i = 0; i < 30 && !/BALL/.test(scr.text()); i++) await emu.framesAsync(10);
  await sync.settle(300);
  dumpRows("B-list0"); state("B-list0");
  await tap(KEYS.DOWN, 250); state("B-list-down1"); dumpRows("B-ld1");
  await tap(KEYS.A, 300);   // select row under cursor -> qty
  await sync.settle(200); state("B-after-select"); dumpRows("B-qty");
  await tap(KEYS.A, 300);   // confirm qty 1 -> YES/NO
  await sync.settle(300); state("B-confirm"); dumpRows("B-confirm");
  await tap(KEYS.B, 300);   // cancel purchase (NO path) - research only
  state("B-cancelled");
  console.log("=== C: EXIT STATE ===");
  // back out via QUIT like exitMart does
  for (let i = 0; i < 5 && !scr.text().includes("QUIT"); i++) await tap(KEYS.B, 250);
  dumpRows("C-quitmenu"); state("C-quitmenu");
  process.exit(0);
})().catch(e => { console.error("ERR", e); process.exit(2); });
