// Isolate the USE path from the clean post-antidote state. Buy is already proven.
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
loadSnapshotFile(emu, "/tmp/mart-clean.state.gz");   // in mart, clean, $1587, 2 balls in bag
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-use-" + Date.now());
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
const txt = () => scr.text();
async function tap(k: number, s = 200) { await emu.tapAsync(k, 8, 16); await sync.settle(s); }
async function waitFor(p: () => boolean, l: string, mf = 900) {
  for (let i = 0; i < mf / 10; i++) { if (p()) return true; await emu.framesAsync(10); }
  console.log(`TIMEOUT: ${l}\n${txt()}`); return false;
}
async function moveCur(t: number, max = 14) {
  for (let i = 0; i < max && cur() !== t; i++) { const c0 = cur(); await tap(cur() < t ? KEYS.DOWN : KEYS.UP, 150);
    if (cur() === c0) await tap(cur() < t ? KEYS.DOWN : KEYS.UP, 200); }   // retry swallowed tap
  return cur() === t;
}

(async () => {
  await emu.framesAsync(90); await sync.settle();
  console.log("start state map", reader.read().map, "bag", JSON.stringify(bag()));
  // step to a floor tile away from counter so START opens the field menu
  await nav.goto(3, 7); await sync.settle(200);
  console.log("at", JSON.stringify(nav.pos()), "screen empty?", txt().trim() === "");

  await tap(KEYS.START, 500);
  await waitFor(() => /ITEM/.test(txt()), "field menu", 700);
  const labels = txt().split("\n").map(r => r.trim()).filter(Boolean);
  console.log("FIELD MENU:", JSON.stringify(labels), "cur=", cur());
  const itemIdx = labels.indexOf("ITEM");
  console.log("ITEM idx", itemIdx, "-> move:", await moveCur(itemIdx));
  await tap(KEYS.A, 400);
  await waitFor(() => txt().includes("CANCEL"), "bag list");
  console.log("BAG LIST:\n" + txt(), "cur=", cur(), "scroll=", M()[sym.addr("wListScrollOffset")]);
  // pick POKe BALL (id 4) at bag order 0 -> should be UNUSABLE in field ("OAK: this isnt the time")
  const order = bag().map(([id]) => id);
  console.log("bag order ids:", order);
  await moveCur(0); await tap(KEYS.A, 400);
  console.log("after selecting BALL in field:\n" + txt());
  // dump the submenu: is it USE/TOSS, or a direct message?
  await waitFor(() => /USE|TOSS|OAK|time|Choose|:L\d/.test(txt()), "submenu/msg", 700);
  console.log("SUBMENU/MSG:\n" + txt(), "cur=", cur());
  saveSnapshotFile(emu, "/tmp/bag-open.state.gz");
  console.log("USE-PROBE DONE");
})();
