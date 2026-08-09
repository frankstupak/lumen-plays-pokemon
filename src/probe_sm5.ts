// Stage 5e: CLEAN base regen + verified BUY-list entry + step-away-then-START.
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
loadSnapshotFile(emu, "checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz"); // clean overworld, $1587
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-sm5-" + Date.now());
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
async function tap(k: number, settle = 200) { await emu.tapAsync(k, 8, 16); await sync.settle(settle); }
async function waitFor(p: () => boolean, l: string, mf = 900) {
  for (let i = 0; i < mf / 10; i++) { if (p()) return true; await emu.framesAsync(10); }
  console.log(`TIMEOUT: ${l}\n${txt()}`); return false;
}
async function moveCur(t: number, max = 12) {
  for (let i = 0; i < max && cur() !== t; i++) await tap(cur() < t ? KEYS.DOWN : KEYS.UP, 150);
  return cur() === t;
}
async function aUntil(p: () => boolean, l: string, max = 8) {
  for (let i = 0; i < max; i++) { if (p()) return true; await tap(KEYS.A, 300); }
  if (!p()) { console.log(`A-UNTIL FAIL: ${l}\n${txt()}`); return false; } return true;
}
const inBuyList = () => txt().includes("BALL") && /\b(100|200|250)\b/.test(txt()) && !/sell\?/i.test(txt());

(async () => {
  await emu.framesAsync(90); await sync.settle();
  // enter mart from clean overworld
  map.build();
  const wi = map.warps.findIndex(w => w.destMap === 42);
  console.log("enterWarp:", await nav.enterWarp(map.warps[wi]));
  await sync.settle(300);
  saveSnapshotFile(emu, "/tmp/mart-clean.state.gz");   // reusable clean base

  // BUY: ANTIDOTE x1 with all guards
  await nav.goto(2, 5); await tap(KEYS.LEFT); await tap(KEYS.A);
  await waitFor(() => txt().includes("BUY"), "mart menu");
  await moveCur(0); await tap(KEYS.A, 400);
  const okList = await waitFor(inBuyList, "verified BUY list");
  console.log("in BUY list:", okList, "| cursor->ANTIDOTE:", await moveCur(1));
  console.log("pre-select cur:", cur(), "screen row check:\n" + txt().split("\n").slice(2,9).join("\n"));
  await tap(KEYS.A); await waitFor(() => /x0\d/.test(txt()), "qty");
  console.log("qty-stage cur:", cur(), "screen:\n" + txt());
  await tap(KEYS.A, 300);
  await aUntil(() => /OK\?/.test(txt()) && /YES/.test(txt()), "price+yesno");
  const priceOk = /\b100\.?\s*OK/.test(txt()) || /100\. OK/.test(txt());
  console.log("confirm price=100 (antidote):", priceOk, "| screen:\n" + txt().split("\n").slice(-3).join("\n"));
  if (!priceOk) { console.log("ABORT-WRONG-PRICE"); process.exit(1); }
  await tap(KEYS.A, 400);
  console.log("bought:", await waitFor(() => bag().some(([id]) => id === 11), "antidote", 1200),
    "bag", JSON.stringify(bag()), "money", reader.read().money);

  // also grab 2 POKe BALLs for the battle probe
  await tap(KEYS.B, 400); await waitFor(() => txt().includes("QUIT"), "menu again");
  await moveCur(0); await tap(KEYS.A, 400); await waitFor(inBuyList, "BUY list 2");
  await moveCur(0);
  await tap(KEYS.A); await waitFor(() => /x0\d/.test(txt()), "qty2");
  await tap(KEYS.UP, 150);   // x02
  await tap(KEYS.A, 300);
  await aUntil(() => /OK\?/.test(txt()) && /YES/.test(txt()), "yesno2");
  if (!/400\. OK/.test(txt())) { console.log("ABORT-WRONG-PRICE-2:\n" + txt()); process.exit(1); }
  await tap(KEYS.A, 400);
  await waitFor(() => bag().some(([id, q]) => id === 4 && q >= 2), "balls", 1200);
  console.log("bag", JSON.stringify(bag()), "money", reader.read().money);

  // EXIT via QUIT, verify clean, step away from counter
  await tap(KEYS.B, 400); await waitFor(() => txt().includes("QUIT"), "menu for quit");
  await moveCur(2); await tap(KEYS.A, 400);
  for (let i = 0; i < 8 && (sync.textUp() || dlg.open() || txt().trim() !== ""); i++) await tap(KEYS.A, 300);
  console.log("clean:", txt().trim() === "");
  await nav.goto(3, 7);                                  // away from clerk, near door

  // START -> ITEM -> ANTIDOTE -> party -> use
  await tap(KEYS.START, 500);
  await waitFor(() => /ITEM/.test(txt()), "start menu", 600);
  const labels = txt().split("\n").map(r => r.trim()).filter(Boolean);
  console.log("START labels:", JSON.stringify(labels), "cur=", cur());
  const itemIdx = labels.indexOf("ITEM");
  if (itemIdx < 0) { console.log("NO-ITEM-ENTRY"); process.exit(1); }
  await moveCur(itemIdx); await tap(KEYS.A, 400);
  await waitFor(() => txt().includes("CANCEL"), "bag list");
  console.log("BAG:\n" + txt());
  // find ANTIDOTE row in bag order
  const order = bag().map(([id]) => id);
  const antIdx = order.indexOf(11);
  console.log("antidote at bag idx", antIdx, "cursor:", await moveCur(antIdx));
  await tap(KEYS.A, 400);
  console.log("after select:\n" + txt());
  await waitFor(() => /:L\d/.test(txt()) || /Use item on/i.test(txt()), "party menu", 900);
  console.log("PARTY:\n" + txt());
  await tap(KEYS.A, 500);
  await aUntil(() => /effect/i.test(txt()), "no-effect", 5);
  console.log("OUTCOME:\n" + txt(), "\nbag:", JSON.stringify(bag()));
  for (let i = 0; i < 10 && (sync.textUp() || dlg.open() || /CANCEL|ITEM/.test(txt())); i++) await tap(KEYS.B, 300);
  console.log("final clean:", txt().trim() === "");
  saveSnapshotFile(emu, "/tmp/have-items-clean.state.gz");
  console.log("SM5 DONE");
})();
