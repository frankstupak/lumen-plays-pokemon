// S4 research: Pokecenter heal flow. Unknowns: mem writability, center map id,
// nurse sprite pos, heal dialog cadence, HP/status/PP restore verification.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Battle } from "./battle";
import { StateReader } from "./state";

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, "/home/lumen/pokemon/checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-res4-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);

const m = () => emu.mem();
const r = (n: string) => m()[sym.addr(n)];
const tap = async (k: number, s = 250) => { await emu.tapAsync(k, 8, 16); await sync.settle(s); };
const party = () => reader.read().party.map(p => `${p.hp}/${p.maxHp} st=${p.status} pp=[${p.pp.join(",")}]`).join(" | ");
const st = (tag: string) =>
  console.log(`${tag}: cur=${r("wCurrentMenuItem")} dlg=${dlg.open()} cursor=${JSON.stringify(scr.cursor())} textUp=${sync.textUp()} :: ${scr.text().split("\n").filter(x=>x.trim()).slice(-2).map(x=>x.trim()).join(" / ")}`);

(async () => {
  await emu.framesAsync(90); await sync.settle();
  console.log("party before:", party());
  // 1) mem writability: damage mon1 HP to 7 and zap some PP
  const hpAddr = sym.addr("wPartyMon1HP");
  m()[hpAddr] = 0; m()[hpAddr + 1] = 7;
  const ppAddr = sym.addr("wPartyMon1PP");
  m()[ppAddr] = m()[ppAddr] & 0xc0;   // keep PP-Up bits, zero current PP of move 1
  await emu.framesAsync(5);
  console.log("MEMWRITE:", r("wPartyMon1HP") === 0 && m()[hpAddr + 1] === 7 ? "WRITABLE" : "NOT WRITABLE");
  console.log("party damaged:", party());
  // 2) find + enter the center from Viridian (expect destMap 41)
  map.build();
  console.log("warps:", JSON.stringify(map.warps));
  const c = map.warps.find(w => (w as any).destMap === 41);
  if (!c) { console.log("no destMap 41 warp - dumping and exiting"); process.exit(2); }
  console.log("enter ->", await nav.enterWarp(c).catch((e: any) => "ERR " + e));
  console.log("map now:", reader.read().map);
  // 3) inside: layout
  map.build();
  console.log("grid:\n" + map.ascii(nav.pos().x, nav.pos().y));
  console.log("sprites:", JSON.stringify(map.sprites), "pos:", JSON.stringify(nav.pos()));
  // 4) nurse = topmost sprite; approach below, face UP, A
  const nurse = map.sprites.slice().sort((a, b) => a.y - b.y)[0];
  console.log("nurse guess:", JSON.stringify(nurse));
  console.log("goto ->", await nav.goto(nurse.x, nurse.y + 2).catch((e: any) => "ERR " + e));
  await tap(KEYS.UP, 200);
  st("faced");
  // 5) drive dialog: A while no cursor; cursor => dump then YES (cur default) A; til HP full
  const full = () => reader.read().party.every(p => p.hp === p.maxHp);
  await tap(KEYS.A, 300);
  for (let i = 0; i < 45 && !full(); i++) {
    st(`heal[${i}]`);
    if (this === undefined && false) break;
    if (scr.cursor() !== null) { console.log("  CHOICE UP - pressing A (YES default)"); await tap(KEYS.A, 300); }
    else await tap(KEYS.A, 300);
  }
  st("post");
  console.log("party after:", party());
  console.log("FULL:", full(), "status:", reader.read().party.map(p => p.status).join(","));
  process.exit(0);
})().catch(e => { console.error("ERR", e); process.exit(2); });
