// S3 recon part 4: post-parcel world - wild-battle item flows on Route 1 + real mart BUY.
import { Emulator, KEYS, loadSnapshotFile, saveSnapshotFile } from "./emulator";
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
const e = new Emulator(ROM);
loadSnapshotFile(e, "/home/lumen/pokemon/saves/parcel-delivered.state.gz");
const rom = new Rom(ROM);
const bus = new EventBus("/tmp", "probe-s3c-" + Date.now());
const map = new MapModel(e, sym, rom);
const scr = new Screen(e, sym), sync = new Sync(e, sym);
const nav = new Navigator(e, sym, map, bus, sync);
const dlg = new Dialog(e, scr, sync, bus, sym);
const act = new Actions(e, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(e, sym, scr, sync, dlg, bus);
const rd = new StateReader(e, sym);
const BCD = (v: number, d: number) => ((Math.floor(v / Math.pow(10, d * 2 + 1)) % 10) << 4) | (Math.floor(v / Math.pow(10, d * 2)) % 10);
const showT = (tag: string) =>
  console.log(`--- ${tag} --- cur=${JSON.stringify(scr.cursor())} qty=${e.mem()[sym.addr("wItemQuantity")]} :: ` +
    scr.text().split("\n").map(l => l.trim()).filter(Boolean).join(" / ").slice(0, 300));
const bag = () => { const m = e.mem(), a = sym.addr("wBagItems"), n = m[sym.addr("wNumBagItems")];
  return Array.from({ length: n }, (_, i) => `${m[a + 2 * i]}x${m[a + 2 * i + 1]}`).join(","); };

(async () => {
  await e.framesAsync(180); await sync.settle(600);
  // inject POTIONx2 BALLx3 + $999
  const m = e.mem(), nA = sym.addr("wNumBagItems"), bA = sym.addr("wBagItems");
  m[bA] = 20; m[bA + 1] = 2; m[bA + 2] = 4; m[bA + 3] = 3; m[bA + 4] = 0xff; m[nA] = 2;
  const mo = sym.addr("wPlayerMoney"); m[mo] = BCD(999, 2); m[mo + 1] = BCD(999, 1); m[mo + 2] = BCD(999, 0);
  let st = rd.read();
  console.log("start map:", st.map, "pos:", st.x, st.y, "money:", st.money, "bag:", bag());

  // ---- get out of the lab to Pallet, then north to Route 1 ----
  if (st.map === 40) { map.build(); await nav.enterWarp(map.warps[0]); }
  st = rd.read(); console.log("map now:", st.map);
  if (st.map === 0) { const r = await nav.leaveMapEdge("N"); console.log("leave N:", r); }
  st = rd.read(); console.log("map now:", st.map, rd.read().x, rd.read().y);

  // ---- Route 1: walk north via goto until a wild battle interrupts ----
  let battled = false;
  for (let hop = 0; hop < 24 && rd.read().map === 12; hop++) {
    const p = nav.pos();
    const r = await nav.goto(p.x, Math.max(0, p.y - 8));
    if (r === "battle") { battled = true; break; }
    if (p.y <= 1 || r === "stuck") {
      const r2 = await nav.leaveMapEdge("N");
      if (r2 === "battle") { battled = true; break; }
      if (r2 === "warped") break;
    }
  }
  console.log("battled on Route 1:", battled, "inBattle:", rd.read().inBattle, "map:", rd.read().map);

  if (battled) {
    saveSnapshotFile(e, "/home/lumen/pokemon/saves/wild-battle-items.state.gz");   // reusable acceptance fixture
    console.log("SAVED FIXTURE saves/wild-battle-items.state.gz");
    await bat.waitForMenu();
    console.log("foe:", JSON.stringify(bat.state()).slice(0, 200));
    // --- potion in battle ---
    await e.tapAsync(KEYS.UP, 8, 8); await e.tapAsync(KEYS.LEFT, 8, 8);
    await e.tapAsync(KEYS.DOWN, 8, 10);
    await e.tapAsync(KEYS.A, 8, 30); await sync.settle(500);
    showT("battle ITEM list");
    await e.tapAsync(KEYS.A, 8, 30); await sync.settle(700);
    showT("after A on POTION");
    await e.tapAsync(KEYS.A, 8, 30); await sync.settle(900);
    showT("after A on mon");
    await dlg.advance(60);
    console.log("bag after battle-potion:", bag(), "(full HP likely=no effect)");
    // --- ball throw ---
    const w2 = await bat.waitForMenu();
    if (w2 === "menu") {
      await e.tapAsync(KEYS.UP, 8, 8); await e.tapAsync(KEYS.LEFT, 8, 8);
      await e.tapAsync(KEYS.DOWN, 8, 10); await e.tapAsync(KEYS.A, 8, 30); await sync.settle(500);
      await e.tapAsync(KEYS.DOWN, 8, 10);
      showT("cursor on POKe BALL");
      await e.tapAsync(KEYS.A, 8, 30); await sync.settle(1200);
      const d = await dlg.advance(100);
      console.log("throw text:", d.lines.slice(-6).join(" / ").slice(0, 300));
      console.log("in battle:", bat.active(), "party:", rd.read().partyCount, "bag:", bag());
      if (bat.active()) {   // escaped ball - finish the fight
        await bat.run(() => 0);
        console.log("battle finished; party:", rd.read().partyCount, "bag:", bag());
      }
    }
  }

  // ---- continue to Viridian, enter mart (destMap 42), BUY ----
  for (let hop = 0; hop < 30 && rd.read().map === 12; hop++) {
    const p = nav.pos();
    const r = await nav.goto(p.x, Math.max(0, p.y - 8));
    if (r === "battle") { await bat.run(() => 0); }
    if (p.y <= 1) { const r2 = await nav.leaveMapEdge("N"); if (r2 === "battle") await bat.run(() => 0); if (r2 === "warped") break; }
  }
  console.log("map now:", rd.read().map);
  if (rd.read().map === 1) {
    map.build();
    const w = map.warps.find(w => w.destMap === 42)!;
    const r = await nav.enterWarp(w);
    console.log("enter mart:", r, "map:", rd.read().map);
    map.build();
    console.log("sprites:", JSON.stringify(map.sprites));
    const d = await act.interactAt(map.sprites[0].x, map.sprites[0].y);
    console.log("clerk says:", d ? d.lines.join(" / ").slice(0, 160) : "no_response");
    showT("mart top menu");
    await e.tapAsync(KEYS.A, 8, 30); await sync.settle(700);   // BUY
    showT("buy list");
    await e.tapAsync(KEYS.A, 8, 30); await sync.settle(700);   // first item
    showT("qty widget");
    await e.tapAsync(KEYS.UP, 8, 14);
    showT("qty after UP");
    console.log("wItemQuantity:", e.mem()[sym.addr("wItemQuantity")]);
    await e.tapAsync(KEYS.A, 8, 30); await sync.settle(700);
    showT("confirm");
    await act.answerYesNo(true);
    await dlg.advance(60);
    console.log("money:", rd.read().money, "bag:", bag());
    showT("post-buy state");
  }
  process.exit(0);
})();
