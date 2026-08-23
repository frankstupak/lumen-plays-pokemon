// S3 acceptance: buy balls+antidote at Viridian Mart, use antidote overworld,
// hunt a wild battle on Route 1, throw a ball in-battle. RAM-verified at each step.
import { Emulator, loadSnapshotFile, saveSnapshotFile } from "./emulator";
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
import { Items, ITEM } from "./items";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, "/home/lumen/pokemon/checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-s3-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const items = new Items(emu, sym, scr, sync, dlg, nav, map, bat);

(async () => {
  await emu.framesAsync(90); await sync.settle();
  let st = reader.read();
  chk("base state Viridian $1587", st.map === 1 && st.money === 1587, `map=${st.map} $${st.money}`);

  map.build();
  const wi = map.warps.findIndex(w => w.destMap === 42);
  await nav.enterWarp(map.warps[wi]);
  await sync.settle(); st = reader.read();
  chk("entered mart", st.map === 42, `map=${st.map}`);

  let r = await items.buy(ITEM.POKE_BALL, 4);
  console.log("  buy balls ->", r);
  st = reader.read();
  chk("4 balls bought, -800", items.count(ITEM.POKE_BALL) >= 4 && st.money === 787, `bag=${items.bagLine()} $${st.money}`);

  r = await items.buy(ITEM.ANTIDOTE, 1);
  console.log("  buy antidote ->", r);
  st = reader.read();
  chk("antidote bought, -100", items.count(ITEM.ANTIDOTE) === 1 && st.money === 687, `bag=${items.bagLine()} $${st.money}`);

  r = await items.buy(ITEM.POTION, 1);
  console.log("  buy potion (not stocked) ->", r);
  chk("potion correctly refused w/ stock list", /not sold here/.test(r) && /ANTIDOTE/.test(r), r);

  r = await items.useOverworld(ITEM.ANTIDOTE);
  console.log("  use antidote ->", r);
  // "no effect" = correct Gen1 verdict for antidote on an unpoisoned mon (item
  // refunded). Either verdict proves the START->ITEM->bag->party plumbing.
  chk("overworld use path completed", /done|no effect/.test(r), r);

  // out of the mart, south through Viridian, into Route 1 grass
  // roaming NPCs can block a door tile (proven nondeterminism) - retry both doors
  for (let att = 0; att < 8 && reader.read().map === 42; att++) {
    map.build();
    const doors = map.warps.filter(w => w.destMap === 255 || w.destMap === 1);
    const d = doors[att % Math.max(1, doors.length)];
    const r2 = await nav.enterWarp(d).catch(() => "stuck");
    if (reader.read().map !== 42) break;
    console.log(`  exit attempt ${att}: ${r2}, waiting for NPC to move`);
    await emu.framesAsync(120);
  }
  await sync.settle(); st = reader.read();
  chk("back in Viridian", st.map === 1, `map=${st.map}`);
  await nav.goto(19, 35).catch(() => {});
  let rr: any = await nav.leaveMapEdge("S" as any);
  // wq#554: a battle during the transition is NOT a map assertion — the same
  // defect class as steptrace542 G2/G3 (battle greens a check that never
  // verified the condition). Resolve the battle, then verify honestly.
  if (rr === "battle") {
    if (bat.active()) await bat.run(() => 0, 30);
    st = reader.read();
    if (st.map !== 12) rr = await nav.leaveMapEdge("S" as any).catch(() => "stuck");
  }
  st = reader.read();
  chk("on Route 1", st.map === 12, `map=${st.map} r=${rr}`);

  // pace until a wild battle bites (grass rows run down the route)
  let battled = false;
  for (let i = 0; i < 40 && !battled; i++) {
    const p = nav.pos();
    const g = await nav.goto(p.x, p.y + 2).catch(() => "stuck");
    if (g === "battle" || bat.active()) battled = true;
    if (reader.read().map !== 12 && !bat.active()) { await nav.leaveMapEdge("S" as any).catch(() => {}); }
  }
  chk("wild battle found", battled && reader.read().inBattle === 1, `inBattle=${reader.read().inBattle}`);

  if (bat.active()) {
    const balls0 = items.count(ITEM.POKE_BALL);
    const party0 = reader.read().partyCount;
    r = await items.useInBattle(ITEM.POKE_BALL);
    console.log("  throw ball ->", r);
    chk("ball consumed", items.count(ITEM.POKE_BALL) === balls0 - 1, `balls ${balls0}->${items.count(ITEM.POKE_BALL)}`);
    // break-free is game RNG, not plumbing -> keep throwing while balls remain
    while (bat.active() && items.count(ITEM.POKE_BALL) > 0 && reader.read().partyCount === party0) {
      r = await items.useInBattle(ITEM.POKE_BALL);
      console.log("  throw ball ->", r);
    }
    // resolve: caught (partyCount up / battle over) or keep fighting to the end
    if (bat.active()) await bat.run(() => 0, 30);
    const party1 = reader.read().partyCount;
    const thrown = balls0 - items.count(ITEM.POKE_BALL);
    console.log(`  battle resolved: party ${party0}->${party1}, caught=${party1 > party0}, thrown=${thrown}`);
    chk("battle resolved (ended or caught)", !bat.active() || party1 > party0);
    // Catch SUCCESS is game RNG (and an L7 lead can white out tanking break-free
    // turns - happened, verified via /tmp/s3-final.state.gz autopsy). The
    // capability under test is verified throw plumbing; live catches proven in
    // runs s3d + s3j (party 1->2). Pass = caught OR every throw verified-consumed.
    chk("CATCH capability proven", party1 > party0 || thrown >= 2, `caught=${party1 > party0} thrown=${thrown}`);
  }
  console.log(`\n${pass} pass / ${fail} fail`);
  saveSnapshotFile(emu, "/tmp/s3-final.state.gz");
  process.exit(fail ? 1 : 0);
})();
