// S2 acceptance: eventCount, viability-gated sidecar ranking, legacy fallback,
// stability-guarded checkpoint writer + sidecars + milestones + prune.
import { mkdtempSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { Emulator, loadSnapshotFile } from "./emulator";
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
import { Brain } from "./brain";
import { Agent } from "./agent";
import { pickResume, readProgress } from "./resume";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};
const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");

// ---- 1. synthetic sidecar ranking ----
const dir = mkdtempSync(`${tmpdir()}/s2rank-`);
const mk = (stem: string, sc: object) => {
  writeFileSync(`${dir}/${stem}.state.gz`, "x");
  writeFileSync(`${dir}/${stem}.json`, JSON.stringify(sc));
};
mk("auto-far-dying",  { v:1, kind:"map", map:54, x:0, y:0, badges:0, events:40, hpPct:0.1, ppOk:true,  money:22, ts:4 });
mk("auto-mid-healthy",{ v:1, kind:"map", map:2,  x:0, y:0, badges:0, events:35, hpPct:1.0, ppOk:true,  money:44, ts:3 });
mk("auto-low-healthy",{ v:1, kind:"map", map:1,  x:0, y:0, badges:0, events:20, hpPct:0.9, ppOk:true,  money:44, ts:2 });
mk("auto-far-nopp",   { v:1, kind:"map", map:54, x:0, y:0, badges:0, events:41, hpPct:1.0, ppOk:false, money:22, ts:1 });
let best = pickResume([dir], sym, ROM);
chk("viable beats further-but-dying", best.endsWith("auto-mid-healthy.state.gz"), best.split("/").pop());
mk("milestone-badge", { v:1, kind:"badge", map:2, x:0, y:0, badges:1, events:36, hpPct:1.0, ppOk:true, money:99, ts:5 });
best = pickResume([dir], sym, ROM);
chk("badge outranks all", best.endsWith("milestone-badge.state.gz"), best.split("/").pop());
const dir2 = mkdtempSync(`${tmpdir()}/s2rank2-`);
writeFileSync(`${dir2}/auto-a.state.gz`, "x");
writeFileSync(`${dir2}/auto-a.json`, JSON.stringify({ v:1, kind:"map", map:54, x:0, y:0, badges:0, events:40, hpPct:0.1, ppOk:true, money:0, ts:1 }));
writeFileSync(`${dir2}/auto-b.state.gz`, "x");
writeFileSync(`${dir2}/auto-b.json`, JSON.stringify({ v:1, kind:"map", map:51, x:0, y:0, badges:0, events:30, hpPct:0.05, ppOk:false, money:0, ts:2 }));
best = pickResume([dir2], sym, ROM);
chk("no viable -> best non-viable", best.endsWith("auto-a.state.gz"), best.split("/").pop());

// ---- 2. legacy fallback (no sidecar) + eventCount monotonicity ----
const pr = readProgress("/home/lumen/pokemon/saves/rival1-battle.state.gz", sym, ROM);
chk("legacy fallback reads state", pr.rank >= -1 && pr.events >= 0 && pr.hpPct > 0, JSON.stringify(pr));
const e1 = new Emulator(ROM); loadSnapshotFile(e1, "/home/lumen/pokemon/saves/boot-overworld.state.gz");
const c1 = new StateReader(e1, sym).eventCount();
const e2 = new Emulator(ROM); loadSnapshotFile(e2, "/home/lumen/pokemon/saves/rival1-won.state.gz");
const c2 = new StateReader(e2, sym).eventCount();
chk("eventCount grows with story", c2 > c1, `boot=${c1} rival1-won=${c2}`);

// ---- 3. checkpoint writer: guard, sidecar, milestone, prune ----
const ck = mkdtempSync(`${tmpdir()}/s2ck-`);
const emu = new Emulator(ROM);
loadSnapshotFile(emu, "/home/lumen/pokemon/saves/rival1-battle.state.gz");
const rom = new Rom(ROM);
const bus = new EventBus("/tmp", "probe-s2-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, new Brain(bus), bus, ck);

(async () => {
  await emu.framesAsync(120);
  const inBat = reader.read();
  agent.turn = 10;
  agent.maybeCheckpoint(inBat, inBat);
  chk("guard: no checkpoint mid-battle", readdirSync(ck).length === 0, readdirSync(ck).join(","));

  loadSnapshotFile(emu, "/home/lumen/pokemon/saves/rival1-won.state.gz");
  await emu.framesAsync(120);
  const ow = reader.read();
  agent.turn = 20;
  agent.maybeCheckpoint(ow, ow);                       // periodic path
  let files = readdirSync(ck);
  chk("periodic checkpoint + sidecar written", files.some(f => f.endsWith(".state.gz")) && files.some(f => f.endsWith(".json")), files.join(","));
  const sc = JSON.parse(require("fs").readFileSync(`${ck}/${files.find(f => f.endsWith(".json"))}`, "utf8"));
  chk("sidecar fields sane", sc.v === 1 && sc.map === ow.map && sc.hpPct > 0 && typeof sc.ppOk === "boolean" && sc.events > 0, JSON.stringify(sc));

  // milestone on full heal (synthetic before with damaged lead)
  const beforeHurt = JSON.parse(JSON.stringify(ow));
  beforeHurt.party[0].hp = Math.max(1, beforeHurt.party[0].maxHp - 5);
  agent.turn = 21;
  agent.maybeCheckpoint(beforeHurt, ow);
  files = readdirSync(ck);
  chk("full-heal milestone written", files.some(f => f.startsWith("milestone-") && f.includes("-map")), files.filter(f => f.startsWith("milestone")).join(","));

  // prune: flood autos, trigger periodic
  for (let i = 0; i < 55; i++) writeFileSync(`${ck}/auto-flood-${String(i).padStart(2, "0")}.state.gz`, "x");
  agent.turn = 30;
  agent.maybeCheckpoint(ow, ow);
  const autos = readdirSync(ck).filter(f => f.startsWith("auto-") && f.endsWith(".state.gz"));
  chk("prune keeps 40 autos", autos.length === 40, `autos=${autos.length}`);
  chk("milestones survive prune", readdirSync(ck).some(f => f.startsWith("milestone-")));

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
