// Stage 5c: text+RAM-driven mart buy; robust exit; START->ITEM->ANTIDOTE->party.
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
const bus = new EventBus("/tmp", "probe-sm3-" + Date.now());
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
async function waitFor(pred: () => boolean, label: string, maxFrames = 900) {
  for (let i = 0; i < maxFrames / 10; i++) { if (pred()) return true; await emu.framesAsync(10); }
  console.log(`TIMEOUT: ${label}\n${txt()}`); return false;
}
async function tap(k: number, settle = 200) { await emu.tapAsync(k, 8, 16); await sync.settle(settle); }
/** advance-with-A until predicate; the universal Gen1 "text mid-print" driver */
async function aUntil(pred: () => boolean, label: string, maxTaps = 8) {
  for (let i = 0; i < maxTaps; i++) { if (pred()) return true; await tap(KEYS.A, 300); }
  const ok = pred(); if (!ok) console.log(`A-UNTIL FAIL: ${label}\n${txt()}`); return ok;
}

(async () => {
  await emu.framesAsync(60); await sync.settle();
  while (txt().includes("BUY")) await tap(KEYS.B, 300);   // ensure clean overworld
  await nav.goto(2, 5); await tap(KEYS.LEFT); await tap(KEYS.A);
  await waitFor(() => txt().includes("BUY"), "mart menu");
  await tap(KEYS.A);
  await waitFor(() => txt().includes("BALL"), "list");
  await tap(KEYS.DOWN, 120); await waitFor(() => cur() === 1, "cur1");
  await tap(KEYS.A); await waitFor(() => /x0\d/.test(txt()), "qty");
  const money0 = reader.read().money;
  await tap(KEYS.A, 300);
  await aUntil(() => /OK\?/.test(txt()) && /YES/.test(txt()), "price+yesno");
  await tap(KEYS.A, 400);   // YES
  const ok = await waitFor(() => reader.read().money < money0, "money debited", 1200);
  console.log("ANTIDOTE bought:", ok, "bag", JSON.stringify(bag()), "money", reader.read().money);
  // robust exit: B until mart UI text gone
  for (let i = 0; i < 14 && (txt().includes("BUY") || sync.textUp() || dlg.open()); i++) await tap(KEYS.B, 300);
  console.log("clean overworld?", txt().trim() === "");

  // ---- START menu ----
  await tap(KEYS.START, 400);
  await waitFor(() => /ITEM/.test(txt()), "start menu");
  const labels0 = txt().split("\n").map(r => r.trim()).filter(Boolean);
  console.log("START labels:", JSON.stringify(labels0), "cur=", cur());
  const itemIdx = labels0.indexOf("ITEM");
  while (cur() !== itemIdx) await tap(KEYS.DOWN, 120);
  await tap(KEYS.A, 300);
  await waitFor(() => txt().includes("CANCEL"), "bag list");
  console.log("BAG:\n" + txt(), "cur=", cur(), "scroll=", M()[sym.addr("wListScrollOffset")]);
  await tap(KEYS.DOWN, 120);   // ANTIDOTE = bag index 1
  await tap(KEYS.A, 300);
  console.log("after select:\n" + txt());
  // party menu expected (medicine): choose mon 0
  await waitFor(() => /Use item on\?|Choose/i.test(txt()) || txt().includes("CHARMELEON") || txt().includes(":L"), "party menu", 600);
  console.log("party screen:\n" + txt(), "wWhichPokemon=", M()[sym.addr("wWhichPokemon")]);
  await tap(KEYS.A, 400);
  await aUntil(() => bag().every(([id, q]) => id !== 11 || true) && /effect|won.t have any/i.test(txt()), "no-effect text", 5);
  console.log("outcome:\n" + txt(), "\nbag now", JSON.stringify(bag()));
  // close everything
  for (let i = 0; i < 10 && (sync.textUp() || dlg.open() || /CANCEL|ITEM/.test(txt())); i++) await tap(KEYS.B, 300);
  console.log("final overworld clean?", txt().trim() === "");
  saveSnapshotFile(emu, "/tmp/have-ball-antidote.state.gz");
})();
