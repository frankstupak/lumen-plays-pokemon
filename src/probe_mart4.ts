// Stage 4: condition-driven buy. Wait on screen/RAM predicates between steps.
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
loadSnapshotFile(emu, "/tmp/in-mart.state.gz");
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-mart4-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const bag = () => {
  const n = M()[sym.addr("wNumBagItems")]; const a = sym.addr("wBagItems");
  return Array.from({ length: n }, (_, i) => `${M()[a+i*2]}x${M()[a+i*2+1]}`).join(",");
};
async function waitFor(pred: () => boolean, label: string, maxFrames = 900): Promise<boolean> {
  for (let i = 0; i < maxFrames / 10; i++) { if (pred()) return true; await emu.framesAsync(10); }
  console.log(`TIMEOUT waiting: ${label}\n${scr.text()}`);
  return false;
}
const cur = () => M()[sym.addr("wCurrentMenuItem")];
const qty = () => M()[sym.addr("wItemQuantity")];

(async () => {
  await emu.framesAsync(60); await sync.settle();
  await nav.goto(2, 5);
  await emu.tapAsync(KEYS.LEFT, 8, 20); await sync.settle(200);
  await emu.tapAsync(KEYS.A, 8, 20);
  await waitFor(() => scr.text().includes("BUY"), "mart menu");
  console.log("MART MENU up, cur=", cur());
  await emu.tapAsync(KEYS.A, 8, 20);                       // BUY
  const listUp = await waitFor(() => scr.text().includes("BALL") && scr.cursor() !== null, "item list");
  console.log("LIST up:", listUp, "cur=", cur(), "cursor=", JSON.stringify(scr.cursor()));
  // cursor row tracking: DOWN once -> expect cur 0->1 (ANTIDOTE)
  await emu.tapAsync(KEYS.DOWN, 8, 10);
  await waitFor(() => cur() === 1, "cur=1");
  console.log("after DOWN cur=", cur());
  await emu.tapAsync(KEYS.UP, 8, 10);
  await waitFor(() => cur() === 0, "cur=0");
  console.log("back UP cur=", cur(), "-> selecting POKe BALL");
  await emu.tapAsync(KEYS.A, 8, 20);                       // select item -> qty ui
  await waitFor(() => /x0\d/.test(scr.text()), "qty ui");
  console.log("QTY ui, wItemQuantity=", qty());
  await emu.tapAsync(KEYS.UP, 8, 10);
  await waitFor(() => qty() === 2, "qty=2");
  console.log("qty now", qty(), "(expect 2) -> A to price it");
  await emu.tapAsync(KEYS.A, 8, 20);                       // -> "that will be 400. OK?" yes/no
  await waitFor(() => scr.cursor() !== null && /YES|NO|400/.test(scr.text()), "yes/no");
  console.log("CONFIRM screen:\n" + scr.text());
  await emu.tapAsync(KEYS.A, 8, 20);                       // YES (cursor defaults top=YES)
  await waitFor(() => bag().length > 0, "bag credit");
  await sync.settle(400);
  // clear trailing dialog
  for (let i = 0; i < 6 && (sync.textUp() || dlg.open()); i++) { await emu.tapAsync(KEYS.A, 8, 16); await sync.settle(200); }
  const st = reader.read();
  console.log("RESULT money=", st.money, "(expect 1187) bag:", bag());
  // exit mart menu cleanly: B out
  await emu.tapAsync(KEYS.B, 8, 20); await sync.settle(300);
  await emu.tapAsync(KEYS.B, 8, 20); await sync.settle(300);
  console.log("post-exit screen:\n" + scr.text());
  saveSnapshotFile(emu, "/tmp/mart-haveballs.state.gz");
})();
