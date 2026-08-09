// S3 recon part 3: battle ITEM/ball flows + mart BUY flow, all empirical.
import { Emulator, KEYS, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { Battle } from "./battle";
import { StateReader } from "./state";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");

function rig(save: string) {
  const e = new Emulator(ROM); loadSnapshotFile(e, save);
  const rom = new Rom(ROM);
  const bus = new EventBus("/tmp", "probe-s3b-" + Date.now());
  const map = new MapModel(e, sym, rom);
  const scr = new Screen(e, sym), sync = new Sync(e, sym);
  const nav = new Navigator(e, sym, map, bus, sync);
  const dlg = new Dialog(e, scr, sync, bus, sym);
  const act = new Actions(e, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(e, sym, scr, sync, dlg, bus);
  const rd = new StateReader(e, sym);
  return { e, map, scr, sync, nav, dlg, act, bat, rd };
}
const BCD = (v: number, d: number) => ((Math.floor(v / Math.pow(10, d * 2 + 1)) % 10) << 4) | (Math.floor(v / Math.pow(10, d * 2)) % 10);
const inject = (e: Emulator, money = 0) => {
  const m = e.mem(), nA = sym.addr("wNumBagItems"), bA = sym.addr("wBagItems");
  m[bA] = 20; m[bA + 1] = 2; m[bA + 2] = 4; m[bA + 3] = 3; m[bA + 4] = 0xff; m[nA] = 2;
  if (money) { const a = sym.addr("wPlayerMoney"); m[a] = BCD(money, 2); m[a + 1] = BCD(money, 1); m[a + 2] = BCD(money, 0); }
};
const showT = (scr: Screen, tag: string, e: Emulator) =>
  console.log(`--- ${tag} --- cur=${JSON.stringify(scr.cursor())} qty=${e.mem()[sym.addr("wItemQuantity")]}\n` +
    scr.text().split("\n").map(l => l.trim()).filter(Boolean).join(" / ").slice(0, 320));

(async () => {
  // ===== A. wild battle: potion + ball throw =====
  console.log("\n########## A: WILD BATTLE ITEM FLOWS ##########");
  const A = rig("/home/lumen/pokemon/saves/forest-reached.state.gz");
  await A.e.framesAsync(180); await A.sync.settle(600);
  inject(A.e);
  const p0 = A.nav.pos();
  console.log("pos:", JSON.stringify(p0), "map:", A.rd.read().map);
  // pace in place until a wild battle triggers
  let got = false;
  for (let i = 0; i < 120 && !got; i++) {
    await A.e.tapAsync(i % 2 ? KEYS.UP : KEYS.DOWN, 8, 20);
    await A.e.framesAsync(30);
    if (A.bat.active()) got = true;
  }
  console.log("wild battle:", got, "inBattle=", A.rd.read().inBattle);
  if (got) {
    const w = await A.bat.waitForMenu();
    console.log("menu:", w);
    // battle main menu: normalise to FIGHT corner (UP+LEFT) then DOWN = ITEM?
    await A.e.tapAsync(KEYS.UP, 8, 8); await A.e.tapAsync(KEYS.LEFT, 8, 8);
    await A.e.tapAsync(KEYS.DOWN, 8, 10);
    showT(A.scr, "cursor after DOWN from FIGHT", A.e);
    await A.e.tapAsync(KEYS.A, 8, 30); await A.sync.settle(500);
    showT(A.scr, "battle ITEM list", A.e);
    // select POTION (row 0) -> in battle should go straight to party select
    await A.e.tapAsync(KEYS.A, 8, 30); await A.sync.settle(700);
    showT(A.scr, "after A on POTION (battle)", A.e);
    await A.e.tapAsync(KEYS.A, 8, 30); await A.sync.settle(900);
    showT(A.scr, "after A on mon (battle heal)", A.e);
    await A.dlg.advance(60);
    const bagAfterHeal = [A.e.mem()[sym.addr("wBagItems") + 1]];
    console.log("POTION qty after battle heal attempt:", bagAfterHeal[0]);
    // now the foe turn ran; wait for menu, then throw a BALL
    const w2 = await A.bat.waitForMenu();
    console.log("menu again:", w2, "still in battle:", A.bat.active());
    if (w2 === "menu") {
      await A.e.tapAsync(KEYS.UP, 8, 8); await A.e.tapAsync(KEYS.LEFT, 8, 8);
      await A.e.tapAsync(KEYS.DOWN, 8, 10); await A.e.tapAsync(KEYS.A, 8, 30);
      await A.sync.settle(500);
      await A.e.tapAsync(KEYS.DOWN, 8, 10);   // cursor to POKe BALL row
      showT(A.scr, "cursor on POKe BALL", A.e);
      await A.e.tapAsync(KEYS.A, 8, 30); await A.sync.settle(900);
      showT(A.scr, "after A on POKe BALL (throw)", A.e);
      const d = await A.dlg.advance(80);
      console.log("throw outcome text:", d.lines.slice(-5).join(" / ").slice(0, 300));
      console.log("in battle now:", A.bat.active(), "party count:", A.rd.read().partyCount, "ball qty:", A.e.mem()[sym.addr("wBagItems") + 3]);
    }
  }

  // ===== B. trainer battle: ball must be blocked =====
  console.log("\n########## B: TRAINER BALL BLOCK ##########");
  const B = rig("/home/lumen/pokemon/saves/rival1-battle.state.gz");
  await B.e.framesAsync(180);
  inject(B.e);
  const wB = await B.bat.waitForMenu();
  console.log("menu:", wB, "inBattle=", B.rd.read().inBattle);
  if (wB === "menu") {
    await B.e.tapAsync(KEYS.UP, 8, 8); await B.e.tapAsync(KEYS.LEFT, 8, 8);
    await B.e.tapAsync(KEYS.DOWN, 8, 10); await B.e.tapAsync(KEYS.A, 8, 30);
    await B.sync.settle(500);
    await B.e.tapAsync(KEYS.DOWN, 8, 10); await B.e.tapAsync(KEYS.A, 8, 30);
    await B.sync.settle(900);
    const d = await B.dlg.advance(80);
    console.log("trainer ball text:", d.lines.slice(-4).join(" / ").slice(0, 240));
    console.log("ball qty after block:", B.e.mem()[sym.addr("wBagItems") + 3], "(3 = not consumed)");
  }

  // ===== C. mart BUY flow =====
  console.log("\n########## C: MART BUY ##########");
  const C = rig("/home/lumen/pokemon/saves/viridian.state.gz");
  await C.e.framesAsync(180); await C.sync.settle(600);
  inject(C.e, 999);
  console.log("money set:", C.rd.read().money, "map:", C.rd.read().map, "pos:", JSON.stringify(C.nav.pos()));
  C.map.build();
  console.log("warps:", C.map.warps.map((w, i) => `${i}:(${w.x},${w.y})->m${w.destMap}`).join(" "));
  const mart = C.map.warps.findIndex(w => w.destMap === 42);
  if (mart >= 0) {
    const r = await C.nav.enterWarp(C.map.warps[mart]);
    console.log("enter mart:", r, "map now:", C.rd.read().map);
    C.map.build();
    console.log("mart sprites:", JSON.stringify(C.map.sprites));
    // clerk = first sprite; interact
    const s = C.map.sprites[0];
    const d = await C.act.interactAt(s.x, s.y);
    console.log("clerk:", d ? d.lines.join(" / ").slice(0, 200) : "no_response", "| cursor:", JSON.stringify(C.scr.cursor()));
    showT(C.scr, "mart menu", C.e);
    await C.e.tapAsync(KEYS.A, 8, 30); await C.sync.settle(600);   // BUY
    showT(C.scr, "buy list", C.e);
    await C.e.tapAsync(KEYS.A, 8, 30); await C.sync.settle(600);   // pick first item
    showT(C.scr, "quantity widget", C.e);
    await C.e.tapAsync(KEYS.UP, 8, 12);
    showT(C.scr, "qty after UP", C.e);
    await C.e.tapAsync(KEYS.A, 8, 30); await C.sync.settle(600);
    showT(C.scr, "confirm prompt", C.e);
    await C.act.answerYesNo(true);
    const d2 = await C.dlg.advance(60);
    console.log("post-buy:", d2.lines.slice(-3).join(" / ").slice(0, 200));
    console.log("money now:", C.rd.read().money, "bag:", (() => { const m = C.e.mem(), a = sym.addr("wBagItems"), n = m[sym.addr("wNumBagItems")]; return Array.from({length: n}, (_, i) => `${m[a+2*i]}x${m[a+2*i+1]}`).join(","); })());
  }
  process.exit(0);
})();
