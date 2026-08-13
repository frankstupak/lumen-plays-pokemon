// Stage 5b: correct yes/no discipline; then clean exit; then START->ITEM->use.
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
loadSnapshotFile(emu, "/tmp/mart-haveballs.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-sm2-" + Date.now());
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
const yesNoUp = () => scr.cursor() !== null && /YES/.test(scr.text()) && /NO/.test(scr.text());

(async () => {
  await emu.framesAsync(60); await sync.settle();
  for (let i = 0; i < 6 && (sync.textUp() || dlg.open() || scr.cursor()); i++) await tap(KEYS.B);
  await nav.goto(2, 5); await tap(KEYS.LEFT); await tap(KEYS.A);
  await waitFor(() => scr.text().includes("BUY"), "mart menu");
  await tap(KEYS.A);
  await waitFor(() => scr.text().includes("BALL") && scr.cursor() !== null, "list");
  await tap(KEYS.DOWN, 120); await waitFor(() => cur() === 1, "cur1");
  await tap(KEYS.A); await waitFor(() => /x0\d/.test(scr.text()), "qty");
  await tap(KEYS.A);
  await waitFor(yesNoUp, "yes/no MENU actually up");     // <- the fix
  await tap(KEYS.A);                                      // YES for real
  const ok = await waitFor(() => bag().some(([id]) => id === 11), "antidote in bag", 1500);
  console.log("antidote bought:", ok, "bag", JSON.stringify(bag()), "money", reader.read().money);
  // clean exit: B until no cursor/text AND map input restored
  for (let i = 0; i < 10 && (sync.textUp() || dlg.open() || scr.cursor()); i++) await tap(KEYS.B, 300);
  console.log("exited mart menu; screen:\n" + scr.text());

  // ---- START menu ----
  await tap(KEYS.START, 400);
  await waitFor(() => scr.cursor() !== null, "start menu");
  console.log("START MENU screen:\n" + scr.text(), "\ncur=", cur());
  // Navigate to ITEM by matching label rows: rows list in screen order
  const labels = scr.text().split("\n").map(r => r.trim()).filter(Boolean);
  console.log("labels:", JSON.stringify(labels));
  const itemIdx = labels.findIndex(l => l === "ITEM");
  console.log("ITEM at menu index", itemIdx, "(cursor now", cur(), ")");
  while (cur() < itemIdx) await tap(KEYS.DOWN, 120);
  await tap(KEYS.A, 300);
  await waitFor(() => scr.text().includes("CANCEL"), "bag list");
  console.log("BAG LIST:\n" + scr.text(), "\ncur=", cur(), "scroll=", M()[sym.addr("wListScrollOffset")]);
  // select ANTIDOTE (find its row order = bag order index 1)
  await tap(KEYS.DOWN, 120);
  await tap(KEYS.A, 300);
  console.log("after selecting ANTIDOTE:\n" + scr.text());
  // expect USE/TOSS submenu or direct party menu - dump to learn
  await waitFor(() => scr.text().includes("USE") || scr.text().includes("Choose") || M()[sym.addr("wWhichPokemon")] !== undefined, "use/toss or party", 600);
  console.log("state:", "wWhichPokemon=", M()[sym.addr("wWhichPokemon")], "screen:\n" + scr.text());
  await tap(KEYS.A, 400);   // USE (top) or confirm party slot 0
  await sync.settle(400);
  console.log("next:\n" + scr.text());
  await tap(KEYS.A, 400);
  await sync.settle(600);
  console.log("final:\n" + scr.text(), "\nbag now", JSON.stringify(bag()));
  saveSnapshotFile(emu, "/tmp/postuse.state.gz");
})();
