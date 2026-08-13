// S4 acceptance: heal_at_center macro + shopping-policy observability.
// From Viridian street: refuse outside a center -> enter center -> heal damaged
// party (HP+PP+status via RAM writes) -> verify full restore + overworld control
// -> already-full short-circuit -> exit center -> mart TIP renders in observe().
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
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
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, "/home/lumen/pokemon/checkpoints/archive-pre-s2/auto-msbuxqpm-map1.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-s4-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const brain = new Brain(bus);   // never called by this probe
// wq#540: THIS PROBE COULD DELETE THE LIVE CHECKPOINT CORPUS, and that is not a
// theoretical reading of the code. The last constructor argument is the Agent's
// checkpointDir, and it was the CWD-relative string "checkpoints". Agent's
// checkpoint pruning calls unlinkSync() inside that directory. Run from a
// worktree it quietly littered a stray checkpoints/ folder; run from
// /home/lumen/pokemon — which is where anyone spot-checking a probe runs it —
// "checkpoints" IS the live corpus, and a probe that writes and prunes was one
// invocation away from deleting real saves. A private temp directory removes
// both the CWD dependence and the blast radius.
const CKPT_TMP = mkdtempSync(join(tmpdir(), "probe-s4-ckpt-"));
const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, brain, bus, CKPT_TMP);

const m = () => emu.mem();

(async () => {
  await emu.framesAsync(90); await sync.settle();
  let st = reader.read();
  chk("base state Viridian", st.map === 1, `map=${st.map}`);

  // 1) refusal outside a center
  let r = await agent.heal.atCenter();
  console.log("  outside ->", r);
  chk("refused outside center", /not inside a Pokemon Center/.test(r), r);

  // 2) enter the center FIRST (poison ticks HP on overworld steps - damaging
  //    before the walk fainted the mon and wedged the warp in probe run a)
  map.build();
  const c = map.warps.find(w => w.destMap === 41)!;
  await nav.enterWarp(c);
  chk("entered center", reader.read().map === 41, `map=${reader.read().map}`);

  // 3) damage the party inside: HP -> 10, zero PP of move 1, poison (0x08)
  const hp = sym.addr("wPartyMon1HP");
  m()[hp] = 0; m()[hp + 1] = 10;
  m()[sym.addr("wPartyMon1PP")] &= 0xc0;
  const status = sym.addr("wPartyMon1Status");
  m()[status] = 0x08;
  await emu.framesAsync(5);
  st = reader.read();
  chk("party damaged for test", st.party[0].hp === 10 && st.party[0].status === 0x08, `hp=${st.party[0].hp} st=${st.party[0].status}`);

  r = await agent.heal.atCenter();
  console.log("  heal ->", r);
  st = reader.read();
  const full = st.party.every(p => p.hp === p.maxHp && p.status === 0);
  chk("healed: HP full + status cleared", /healed/.test(r) && full, `hp=${st.party[0].hp}/${st.party[0].maxHp} st=${st.party[0].status}`);
  chk("PP restored", st.party[0].pp[0] > 0, `pp=${st.party[0].pp.join(",")}`);
  chk("overworld control returned", !dlg.open() && !sync.textUp() && scr.cursor() === null);

  // 4) already-full short-circuit
  r = await agent.heal.atCenter();
  console.log("  again ->", r);
  chk("already-full short-circuit", /already at full/.test(r), r);

  // 5) exit the center back to Viridian
  map.build();
  const out = map.warps.find(w => w.destMap === 255 || w.destMap === 1);
  if (out) await nav.enterWarp(out).catch(() => {});
  chk("back in Viridian", reader.read().map === 1, `map=${reader.read().map}`);

  // 6) shopping TIP renders when standing in the mart with low supplies
  map.build();
  const mart = map.warps.find(w => w.destMap === 42)!;
  await nav.enterWarp(mart);
  chk("entered mart", reader.read().map === 42, `map=${reader.read().map}`);
  const obs = agent.observe();
  const hasTip = /TIP: in a Mart/.test(obs) && /poke_ball/.test(obs);
  chk("mart shopping TIP rendered", hasTip, hasTip ? obs.split("\n").find(l => l.startsWith("TIP:"))! : "no TIP line");
  chk("center TIP absent when full", !/heal_at_center\(\) restores/.test(obs));

  console.log(`${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e); process.exit(2); });
