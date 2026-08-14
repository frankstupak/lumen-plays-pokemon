// wq#583 — goto onto a sprite-occupied target: adjacent-arrival, honestly.
//
// The audit's live evidence (wq#581 A2.2, run live-agent-1786678999032):
// T12/T19/T21 all issued goto(27,17) from 61(26,17) — the beaten Rocket
// sprite stands at (27,17) — and each burned 25 replans of plan(len=1) /
// step(blocked) before "stuck", while reach.ts told the brain the tile
// "IS reachable (1 steps)". Three identical retries, three lost turns.
//
// GREEN CONTRACT (this branch):
//   goto(spriteX, spriteY) returns "adjacent_npc", the player ends at
//   manhattan-1 from the sprite, the journey costs FEW plans (not 25), a
//   re-issued goto returns immediately, and stuckHint names the occupant
//   instead of lying about reachability.
// RED (origin/main): same call returns "stuck" and stuckHint says
//   "IS reachable" — run this file there to watch it fail (R-mode below).
//
// Fixture by property: any checkpoint whose map has an NPC sprite with at
// least one passable non-warp neighbour AND a pathTo() route from the player
// to that neighbour, player 2+ tiles away (so a real walk happens first) and
// out of battle. The wandering-grace regression (a MOVING sprite in a gap)
// stays covered by probe_steptrace542 / probe_transit — swept alongside.
//
// ISOLATION: EventBus into mkdtemp (never events/), loads checkpoints,
// saves nothing, touches no live service.
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { EventBus } from "./events";
import { Navigator } from "./nav";
import { stuckHint, pathTo } from "./reach";
import { readdirSync } from "fs";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(ROM);
const CK = `${BASE}/checkpoints`;

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

interface Rig {
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader;
  events: any[];
  pos: () => { map: number; x: number; y: number };
}

function rig(statePath: string): Rig | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, statePath); } catch { return null; }
  const map = new MapModel(emu, sym, rom); map.build();
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp583-")), "probe583");
  const events: any[] = [];
  bus.on((e: any) => events.push(e));
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const rd = new StateReader(emu, sym);
  const pos = () => {
    const m = emu.mem();
    return { map: m[sym.addr("wCurMap")], x: m[sym.addr("wXCoord")], y: m[sym.addr("wYCoord")] };
  };
  return { emu, map, nav, rd, events, pos };
}

/** A neighbour of (x,y) that is passable terrain and not a warp. */
function freeNeighbour(map: MapModel, x: number, y: number) {
  return ([[0, 1], [0, -1], [1, 0], [-1, 0]] as const)
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .find(c => map.passable(c.x, c.y) &&
               !map.warps.some((w: Warp) => w.x === c.x && w.y === c.y));
}

/** Fixture + the sprite target it offers: player out of battle, some NPC
 *  sprite 2..12 tiles away with a reachable free neighbour. */
function findCase(): { file: string; r: Rig; s: { x: number; y: number } } | null {
  for (const f of readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort()) {
    const r = rig(`${CK}/${f}`);
    if (!r) continue;
    if (r.rd.read().inBattle !== 0) continue;
    const p = r.pos();
    for (const s of r.map.sprites) {
      const d = Math.abs(s.x - p.x) + Math.abs(s.y - p.y);
      if (d < 2 || d > 12) continue;
      const nb = freeNeighbour(r.map, s.x, s.y);
      if (!nb) continue;
      if (!pathTo(r.map, p.x, p.y, nb.x, nb.y)) continue;
      return { file: f, r, s };
    }
  }
  return null;
}

(async () => {
  const RED = process.env.LPP583_RED === "1";
  console.log(`== probe_goto583 (${RED ? "RED: expecting the OLD broken behaviour" : "GREEN"}) ==`);

  const c = findCase();
  if (!c) {
    chk("A1 fixture with a distant sprite target resolves", false, "none on disk");
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(1);
  }
  const { file, r, s } = c;
  const p0 = r.pos();
  chk("A1 fixture with a distant sprite target resolves", true,
      `${file}: map${p0.map} player(${p0.x},${p0.y}) sprite(${s.x},${s.y})`);

  const t0 = Date.now();
  const res = await r.nav.goto(s.x, s.y);
  const ms = Date.now() - t0;
  const p1 = r.pos();
  const plans = r.events.filter(e => e.kind === "nav_trace" && e.ev === "plan").length;
  const dist = Math.abs(p1.x - s.x) + Math.abs(p1.y - s.y);

  if (RED) {
    // The old code's shape: stuck after the full replan grind, never adjacent_npc.
    chk("R1 old goto returns 'stuck' on a sprite target", res === "stuck", `got ${res} in ${ms}ms`);
    chk("R2 old stuckHint claims the tile IS reachable",
        stuckHint(r.map, p1.x, p1.y, s.x, s.y, []).includes("IS reachable"),
        stuckHint(r.map, p1.x, p1.y, s.x, s.y, []).slice(0, 80));
  } else {
    chk("G1 goto returns 'adjacent_npc'", res === "adjacent_npc", `got ${res} in ${ms}ms`);
    chk("G2 player ends adjacent to the sprite", dist === 1, `pos(${p1.x},${p1.y}) d=${dist}`);
    chk("G3 journey cost few plans, not 25", plans <= 3, `plans=${plans}`);
    const res2 = await r.nav.goto(s.x, s.y);
    const plans2 = r.events.filter(e => e.kind === "nav_trace" && e.ev === "plan").length - plans;
    chk("G4 re-issued goto answers immediately", res2 === "adjacent_npc" && plans2 === 0,
        `got ${res2}, extra plans=${plans2}`);
    const hint = stuckHint(r.map, p1.x, p1.y, s.x, s.y, []);
    chk("G5 stuckHint names the NPC instead of lying", hint.includes("OCCUPIED BY AN NPC"),
        hint.slice(0, 80));
    chk("G6 no lying 'IS reachable' for the sprite tile", !hint.includes("IS reachable"));
  }

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
