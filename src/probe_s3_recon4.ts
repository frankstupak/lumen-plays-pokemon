// S3 recon final: ball throw/catch from fixture, then mart BUY. paceMs=0.
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
const e = new Emulator(ROM);
(e as any).paceMs = 0;
loadSnapshotFile(e, "/home/lumen/pokemon/saves/wild-battle-items.state.gz");
const rom = new Rom(ROM);
const bus = new EventBus("/tmp", "probe-s3d-" + Date.now());
const map = new MapModel(e, sym, rom);
const scr = new Screen(e, sym), sync = new Sync(e, sym);
const nav = new Navigator(e, sym, map, bus, sync);
const dlg = new Dialog(e, scr, sync, bus, sym);
const act = new Actions(e, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(e, sym, scr, sync, dlg, bus);
const rd = new StateReader(e, sym);
const showT = (tag: string) =>
  console.log(`--- ${tag} --- cur=${JSON.stringify(scr.cursor())} qty=${e.mem()[sym.addr("wItemQuantity")]} :: ` +
    scr.text().split("\n").map(l => l.trim()).filter(Boolean).join(" / ").slice(0, 300));
const bag = () => { const m = e.mem(), a = sym.addr("wBagItems"), n = m[sym.addr("wNumBagItems")];
  return Array.from({ length: n }, (_, i) => `${m[a + 2 * i]}x${m[a + 2 * i + 1]}`).join(","); };

(async () => {
  await e.framesAsync(60);
  console.log("fixture: inBattle=", rd.read().inBattle, "bag:", bag(), "money:", rd.read().money);
  const w = await bat.waitForMenu();
  console.log("menu:", w);
  // ---- ball throw ----
  await e.tapAsync(KEYS.UP, 8, 8); await e.tapAsync(KEYS.LEFT, 8, 8);
  await e.tapAsync(KEYS.DOWN, 8, 10); await e.tapAsync(KEYS.A, 8, 30); await sync.settle(400);
  showT("battle ITEM list");
  await e.tapAsync(KEYS.DOWN, 8, 12);
  showT("cursor on BALL row");
  await e.tapAsync(KEYS.A, 8, 30); await sync.settle(600);
  showT("right after A on BALL");
  const d = await dlg.advance(120);
  console.log("throw text:", d.lines.slice(-8).join(" / ").slice(0, 340));
  console.log("in battle:", bat.active(), "party:", rd.read().partyCount, "bag:", bag());
  if (bat.active()) {
    const r = await bat.run(() => 0);
    console.log("finished remaining battle:", r);
  }
  console.log("post-battle: party=", rd.read().partyCount, "bag:", bag(), "map:", rd.read().map);

  // ---- to Viridian mart ----
  for (let hop = 0; hop < 40 && rd.read().map === 12; hop++) {
    const p = nav.pos();
    let r = p.y <= 4 ? await nav.leaveMapEdge("N") : await nav.goto(p.x, Math.max(0, p.y - 8));
    if (r === "battle") { await bat.run(() => 0); }
    if (r === "warped") break;
    if (r === "stuck") { const alt = await nav.goto(Math.max(2, p.x - 4), Math.max(0, p.y - 4)); if (alt === "battle") await bat.run(() => 0); }
  }
  console.log("map now:", rd.read().map, JSON.stringify(nav.pos()));
  if (rd.read().map !== 1) { console.log("did not reach Viridian - stop"); process.exit(0); }
  map.build();
  const wMart = map.warps.find(x => x.destMap === 42)!;
  console.log("mart warp:", JSON.stringify(wMart), "->", await nav.enterWarp(wMart), "map:", rd.read().map);
  map.build();
  console.log("sprites:", JSON.stringify(map.sprites));
  const dd = await act.interactAt(map.sprites[0].x, map.sprites[0].y);
  console.log("clerk:", dd ? dd.lines.join(" / ").slice(0, 160) : "no_response");
  showT("mart top menu");
  await e.tapAsync(KEYS.A, 8, 30); await sync.settle(500);
  showT("buy list");
  await e.tapAsync(KEYS.A, 8, 30); await sync.settle(500);
  showT("qty widget");
  await e.tapAsync(KEYS.UP, 8, 14);
  showT("qty after UP");
  await e.tapAsync(KEYS.A, 8, 30); await sync.settle(500);
  showT("confirm");
  await act.answerYesNo(true);
  await dlg.advance(80);
  console.log("money:", rd.read().money, "bag:", bag());
  showT("post-buy");
  process.exit(0);
})();
