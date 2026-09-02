// wq#1177 — the write gate and the v4 sidecar against a LIVE emulator.
//
// probe_ckptgate1177 proves the policy; this proves the wiring: that the gate
// reads real RAM, that a settled overworld state still checkpoints (the whole
// risk of adding refusals is starving the pool), and that the sidecar the
// writer produces carries the stateKey resume.ts now selects on.
//
// Needs the ROM and saves/ — SKIPs cleanly without them, so it is a main-suite
// probe, not a CI one.
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "fs";
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
import { readProgress, stateKeyOf, Sidecar } from "./resume";
import { CKPT_WARP_STARVE_TURNS } from "./checkpoint_gate";

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

console.log("== probe_ckptwrite1177 (write gate + v4 sidecar, live) ==");

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const SYM = `${BASE}/roms/pokeblue.sym`;
const OVERWORLD = `${BASE}/saves/rival1-won.state.gz`;
const INBATTLE = `${BASE}/saves/rival1-battle.state.gz`;

if (!existsSync(ROM) || !existsSync(OVERWORLD)) {
  skipped("A-D live write path", "no ROM/saves on this host");
  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(0);
}

const sym = new SymbolTable(SYM);
const ck = mkdtempSync(`${tmpdir()}/ck1177-`);
const emu = new Emulator(ROM);
const rom = new Rom(ROM);
const bus = new EventBus("/tmp", "probe-ckptwrite1177");
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, new Brain(bus), bus, ck);

const states = () => readdirSync(ck).filter(f => f.endsWith(".state.gz"));
const sidecars = () => readdirSync(ck).filter(f => f.endsWith(".json"));

(async () => {
  // ── A. the settled overworld state still writes ─────────────────────
  loadSnapshotFile(emu, OVERWORLD);
  await emu.framesAsync(120);
  const ow = reader.read();
  agent.turn = 20;
  agent.maybeCheckpoint(ow, ow);
  chk("A1 a settled overworld state still checkpoints (the gate did not starve it)",
      states().length === 1 && sidecars().length === 1, readdirSync(ck).join(","));

  // ── B. the sidecar is v4 and carries the identity resume selects on ──
  const scFile = sidecars()[0];
  const sc: Sidecar = JSON.parse(readFileSync(`${ck}/${scFile}`, "utf8"));
  chk("B1 sidecar is v4", sc.v === 4, String(sc.v));
  const expect = stateKeyOf({
    map: ow.map, x: ow.x, y: ow.y, story: reader.storyScore(),
    badges: ow.badgeCount, levelSum: ow.party.reduce((n, m) => n + m.level, 0),
  });
  chk("B2 stateKey describes the state actually saved", sc.stateKey === expect,
      `${sc.stateKey} vs ${expect}`);
  chk("B3 the party is really in the key (a level rise is a new state)",
      !!sc.stateKey && sc.stateKey !== stateKeyOf({
        map: ow.map, x: ow.x, y: ow.y, story: reader.storyScore(),
        badges: ow.badgeCount, levelSum: ow.party.reduce((n, m) => n + m.level, 0) + 1,
      }));
  chk("B4 readProgress lifts that key back out with no emulator boot",
      readProgress(`${ck}/${states()[0]}`, sym, ROM).key === expect);
  chk("B5 the wq#586 stamps survived the refactor",
      typeof (sc as any).onWarp === "boolean" && sc.map === ow.map &&
      sc.badges === ow.badgeCount, JSON.stringify({ onWarp: sc.onWarp, map: sc.map }));

  // ── C. in battle: RAM truth, not a harness flag ─────────────────────
  if (!existsSync(INBATTLE)) skipped("C1 in-battle refusal", "no rival1-battle save");
  else {
    loadSnapshotFile(emu, INBATTLE);
    await emu.framesAsync(120);
    const inBat = reader.read();
    const n = states().length;
    agent.turn = 30;
    agent.maybeCheckpoint(inBat, inBat);
    chk("C1 no checkpoint while wIsInBattle != 0", states().length === n,
        `${n} -> ${states().length}`);
  }

  // ── D. starvation cannot come from the warp gate alone ──────────────
  // Not a behavioural assertion about this save (whether it stands on a warp
  // tile is the map's business) — an assertion that the escape EXISTS and is
  // bounded, which is the wq#517 property the gate must keep.
  chk("D1 the warp refusal expires within a bounded number of turns",
      CKPT_WARP_STARVE_TURNS > 0 && CKPT_WARP_STARVE_TURNS <= 100,
      String(CKPT_WARP_STARVE_TURNS));

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
