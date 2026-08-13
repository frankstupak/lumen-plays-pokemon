// End-to-end proven flow -> save a items-in-bag state -> probe USE fully.
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
loadSnapshotFile(emu, "/home/lumen/pokemon/checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-buyuse-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const cur = () => M()[sym.addr("wCurrentMenuItem")];
const scroll = () => M()[sym.addr("wListScrollOffset")];
const bag = () => { const n = M()[sym.addr("wNumBagItems")], a = sym.addr("wBagItems");
  return Array.from({ length: n }, (_, i) => [M()[a+i*2], M()[a+i*2+1]]); };
const txt = () => scr.text();
async function tap(k: number, s = 200) { await emu.tapAsync(k, 8, 16); await sync.settle(s); }
async function waitFor(p: () => boolean, l: string, mf = 900) {
  for (let i = 0; i < mf / 10; i++) { if (p()) return true; await emu.framesAsync(10); }
  console.log(`TIMEOUT: ${l}\n${txt()}`); return false;
}
// verified move: current menu item OR (list scrolled). retries a swallowed tap.
async function stepCur(dir: number, s = 160) {
  const before = cur() * 1000 + scroll();
  await tap(dir, s);
  if (cur() * 1000 + scroll() === before) await tap(dir, s + 120);  // retry
}
async function aUntil(p: () => boolean, l: string, max = 8) {
  for (let i = 0; i < max; i++) { if (p()) return true; await tap(KEYS.A, 300); }
  if (!p()) console.log(`A-UNTIL FAIL: ${l}\n${txt()}`); return p();
}

(async () => {
  await emu.framesAsync(90); await sync.settle();
  map.build();
  await nav.enterWarp(map.warps[map.warps.findIndex(w => w.destMap === 42)]);
  await sync.settle(300);
  // --- BUY 2x ANTIDOTE (id 11, list idx 1, price 100 each) ---
  await nav.goto(2, 5); await tap(KEYS.LEFT); await tap(KEYS.A);
  await waitFor(() => txt().includes("BUY"), "menu");
  while (cur() !== 0) await stepCur(KEYS.UP);
  await tap(KEYS.A, 400);
  await waitFor(() => txt().includes("BALL"), "list");
  while (cur() !== 1) await stepCur(KEYS.DOWN);        // -> ANTIDOTE
  await tap(KEYS.A); await waitFor(() => /x0\d/.test(txt()), "qty");
  await stepCur(KEYS.UP);                              // x2
  await tap(KEYS.A, 300);
  await aUntil(() => /OK\?/.test(txt()), "confirm");
  const p200 = /200\. OK/.test(txt());                 // 2 antidotes = 200
  console.log("antidote x2 confirm=200:", p200);
  await tap(KEYS.A, 400);
  await waitFor(() => bag().some(([id, q]) => id === 11 && q === 2), "2 antidotes", 1500);
  console.log("bag", JSON.stringify(bag()), "money", reader.read().money);
  // exit: B to menu, QUIT
  await tap(KEYS.B, 400); await waitFor(() => txt().includes("QUIT"), "menu2");
  while (cur() !== 2) await stepCur(KEYS.DOWN);
  await tap(KEYS.A, 400);
  for (let i = 0; i < 8 && txt().trim() !== ""; i++) await tap(KEYS.A, 300);
  console.log("overworld clean:", txt().trim() === "");
  await nav.goto(3, 7);
  saveSnapshotFile(emu, "/tmp/items-in-bag.state.gz");

  // --- USE ANTIDOTE on party mon 0 ---
  await tap(KEYS.START, 500);
  await waitFor(() => /ITEM/.test(txt()), "field menu", 700);
  let labels = txt().split("\n").map(r => r.trim()).filter(Boolean);
  const itemIdx = labels.indexOf("ITEM");
  console.log("field menu:", JSON.stringify(labels));
  while (cur() !== itemIdx) await stepCur(KEYS.DOWN);
  await tap(KEYS.A, 400);
  await waitFor(() => txt().includes("ANTIDOTE") && txt().includes("CANCEL"), "bag list", 900);
  console.log("BAG:\n" + txt(), "cur=", cur());
  // antidote at list position 0 (only item type besides... balls? we have only antidotes here)
  const order = bag().map(([id]) => id); const antPos = order.indexOf(11);
  while (cur() !== antPos) await stepCur(KEYS.DOWN);
  await tap(KEYS.A, 400);
  console.log("after select antidote:\n" + txt());
  // USE/TOSS submenu likely
  const submenu = /USE/.test(txt()) && /TOSS/.test(txt());
  console.log("USE/TOSS submenu:", submenu);
  if (submenu) { while (!/USE/.test(txt().split("\n").find(l => scr.cursor() && l) || "USE")) break; await tap(KEYS.A, 400); }
  // party select
  await waitFor(() => /:L\d/.test(txt()) || /Use item on/i.test(txt()) || M()[sym.addr("wWhichPokemon")] !== 255, "party", 900);
  console.log("PARTY:\n" + txt(), "wWhichPokemon=", M()[sym.addr("wWhichPokemon")]);
  await tap(KEYS.A, 500);
  await aUntil(() => /health|no effect|won.t have any|CURED|POISON/i.test(txt()), "effect msg", 6);
  console.log("EFFECT:\n" + txt(), "\nbag after use:", JSON.stringify(bag()));
  for (let i = 0; i < 10 && (sync.textUp() || dlg.open() || /CANCEL|ITEM|USE|TOSS/.test(txt())); i++) await tap(KEYS.B, 300);
  console.log("final clean:", txt().trim() === "", "\nBUYUSE DONE");
})();
