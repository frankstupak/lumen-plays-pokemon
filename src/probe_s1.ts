// S1 acceptance: trainer-battle gate + type announcement + imperatives + party PP.
// Loads the rival trainer-battle checkpoint; no LLM calls (Brain never invoked).
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
import { renderState } from "./prompt";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, "/home/lumen/pokemon/saves/rival1-battle.state.gz");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/home/lumen/pokemon/events", "probe-s1-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader,
  new Brain(bus), bus, "/tmp/probe-s1-ckpts");

(async () => {
  await emu.framesAsync(120);           // let the loaded state settle
  const st = reader.read();
  chk("checkpoint is a trainer battle", st.inBattle === 2, `inBattle=${st.inBattle}`);

  // 1. movement gate
  for (const call of ["goto(10,10)", "enter_warp(0)", "leave_edge(N)"]) {
    const r = await agent.dispatch(call);
    chk(`gate ${call}`, /refused - TRAINER battle/.test(r), r);
  }
  // battle_move must NOT be gated (not executed here - just not refused by the gate path)

  // 2. battle block: type + imperatives structure
  const obs = agent.observe();
  chk("battle block announces TRAINER", obs.includes("BATTLE TRAINER (no escape"), obs.split("\n").find(l => l.startsWith("BATTLE")) ?? "");
  chk("battle block shows per-move PP", /\(pp\d+\)/.test(obs));

  // 3. imperative logic (pure checks against synthetic states via renderState + thresholds)
  const synth = { ...st, party: [{ species: 1, hp: 4, maxHp: 50, level: 10, status: 0, moves: [33, 45, 0, 0], pp: [0, 0, 0, 0] }] };
  const line = renderState(synth as any, null);
  chk("party line carries PP", /PP\[0\/0\]/.test(line), line.split("\n")[1]);

  // 4. overworld imperatives: load post-battle save (overworld), fake low HP path unavailable ->
  //    assert real save renders PP and no false-positive imperative at healthy HP
  loadSnapshotFile(emu, "/home/lumen/pokemon/saves/rival1-won.state.gz");
  await emu.framesAsync(120);
  const st2 = reader.read();
  const obs2 = agent.observe();
  const hpPct = st2.party[0] ? st2.party[0].hp / st2.party[0].maxHp : 1;
  chk("overworld observe built", obs2.includes("MAPGRID"));
  chk("imperative fires iff HP<=25%", obs2.includes("! HP CRITICAL") === (hpPct <= 0.25), `hp=${(hpPct * 100).toFixed(0)}%`);
  chk("party PP visible overworld", /PP\[[\d/]+\]/.test(obs2));

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
