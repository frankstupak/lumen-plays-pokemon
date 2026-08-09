// S3 recon part 2: open START->ITEM with injected items, capture the flow.
import { Emulator, KEYS, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { EventBus } from "./events";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const e = new Emulator(ROM);
loadSnapshotFile(e, "/home/lumen/pokemon/saves/rival1-won.state.gz");
const scr = new Screen(e, sym), sync = new Sync(e, sym);
const bus = new EventBus("/tmp", "probe-s3-menu-" + Date.now());
const dlg = new Dialog(e, scr, sync, bus, sym);
const show = (tag: string) => {
  const t = scr.text().split("\n").map((l, i) => l.trim() ? `${String(i).padStart(2)}|${l}` : null).filter(Boolean).join("\n");
  console.log(`--- ${tag} --- cursor=${JSON.stringify(scr.cursor())} menuItem=${e.mem()[sym.addr("wCurrentMenuItem")]} max=${e.mem()[sym.addr("wMaxMenuItem")]}\n${t || "(blank)"}`);
};

(async () => {
  await e.framesAsync(180); await sync.settle(600);
  const m = e.mem(), nA = sym.addr("wNumBagItems"), bA = sym.addr("wBagItems");
  m[bA] = 20; m[bA + 1] = 2;      // POTION x2
  m[bA + 2] = 4; m[bA + 3] = 3;   // POKe BALL x3
  m[bA + 4] = 0xff; m[nA] = 2;
  console.log("injected POTIONx2 POKeBALLx3");
  await e.tapAsync(KEYS.START, 8, 40); await sync.settle(600);
  show("after START");
  // move cursor onto the ITEM row
  for (let i = 0; i < 7; i++) {
    const cur = scr.cursor();
    const line = cur ? (scr.text().split("\n")[cur.y] ?? "") : "";
    if (/ITEM/.test(line)) break;
    await e.tapAsync(KEYS.DOWN, 8, 14);
  }
  show("cursor on ITEM");
  await e.tapAsync(KEYS.A, 8, 40); await sync.settle(600);
  show("ITEM list open");
  // select POTION (first row) -> expect USE/TOSS submenu
  await e.tapAsync(KEYS.A, 8, 40); await sync.settle(600);
  show("after A on POTION");
  // choose USE -> party select expected (overworld heal path)
  await e.tapAsync(KEYS.A, 8, 40); await sync.settle(800);
  show("after A on USE");
  // press A on first mon
  await e.tapAsync(KEYS.A, 8, 40); await sync.settle(800);
  show("after A on mon");
  await dlg.advance(40);
  show("after dialog advance");
  console.log("BAG NOW:", m[nA], "items; first:", m[bA], "x", m[bA + 1]);
})();
