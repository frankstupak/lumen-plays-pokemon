// Stage 5: buy ANTIDOTE, exit mart, START menu -> ITEM -> use flows.
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
loadSnapshotFile(emu, "/tmp/mart-haveballs.state.gz");
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-sm-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const cur = () => M()[sym.addr("wCurrentMenuItem")];
const bag = () => { const n = M()[sym.addr("wNumBagItems")], a = sym.addr("wBagItems");
  return Array.from({ length: n }, (_, i) => [M()[a+i*2], M()[a+i*2+1]]); };
async function waitFor(pred: () => boolean, label: string, maxFrames = 900) {
  for (let i = 0; i < maxFrames / 10; i++) { if (pred()) return true; await emu.framesAsync(10); }
  console.log(`TIMEOUT: ${label}\n${scr.text()}`); return false;
}
async function tap(k: number, settle = 200) { await emu.tapAsync(k, 8, 16); await sync.settle(settle); }

(async () => {
  await emu.framesAsync(60); await sync.settle();
  // still at mart menu remnants? clear
  for (let i = 0; i < 6 && (sync.textUp() || dlg.open() || scr.cursor()); i++) await tap(KEYS.B);
  // Re-open clerk, buy 1 ANTIDOTE (list index 1)
  await nav.goto(2, 5); await tap(KEYS.LEFT); await tap(KEYS.A);
  await waitFor(() => scr.text().includes("BUY"), "mart menu");
  await tap(KEYS.A);
  await waitFor(() => scr.text().includes("BALL") && scr.cursor() !== null, "list");
  await tap(KEYS.DOWN, 120); await waitFor(() => cur() === 1, "cur1");
  await tap(KEYS.A); await waitFor(() => /x0\d/.test(scr.text()), "qty");
  await tap(KEYS.A); await waitFor(() => /OK\?/.test(scr.text()), "ok?");
  await tap(KEYS.A);                       // YES
  await waitFor(() => bag().some(([id]) => id === 11), "antidote in bag");
  for (let i = 0; i < 8 && (sync.textUp() || dlg.open() || scr.cursor()); i++) await tap(KEYS.B);
  console.log("bag now", JSON.stringify(bag()), "money", reader.read().money);

  // ---- START menu exploration ----
  await tap(KEYS.START, 300);
  await waitFor(() => scr.cursor() !== null, "start menu");
  console.log("START MENU cur=", cur(), "screen:\n" + scr.text());
  // find ITEM row from screen text, navigate cursor there
  const rows = scr.text().split("\n");
  console.log("menu rows:", JSON.stringify(rows.filter(r => r.trim())));
  // press DOWN until the cursor sits on ITEM: cheap check = cur increments; ITEM label position known from dump
  await tap(KEYS.DOWN, 120); console.log("cur after down1 =", cur());
  await tap(KEYS.DOWN, 120); console.log("cur after down2 =", cur());
  console.log("screen now:\n" + scr.text());
  saveSnapshotFile(emu, "/tmp/startmenu-open.state.gz");
})();
