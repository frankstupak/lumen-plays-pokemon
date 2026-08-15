// wq#638 — Cerulean nav pathology: red/green.
//
// THE DEFECT THIS FIXES. Sentinel evidence 2026-08-15 08:25-13:17Z: the agent
// bounced map3<->map63 (Cerulean Trade House) for 5 hours, retry-ceiling on
// leave_edge(E) at map3 (13,16) and on goto() to outdoor-scale coordinates
// while standing inside the Trade House. Traced live in
// events/live-agent-1786799071200.jsonl: leave_edge(E) enumerated all 26
// walkable tiles on map3's east edge (x=39) and every one of them returned
// goto->no_path. ceruleanApproachPack() (src/live_agent.ts) was still telling
// the brain "Keep heading EAST until the map id becomes 3" while the map id
// WAS ALREADY 3 -- corridorPhase (phase.ts) deliberately HOLDS at
// CERULEAN_APPROACH while the player wanders Cerulean's buildings (they rank
// -1, off the critical path), so the stale instruction never got replaced.
//
// SECTION A proves the root cause from the REAL checkpoint that was live-stuck
// (auto-msu34rfn-map3.state.gz, player at (13,16)): the east edge really is
// unreachable via A* (leave_edge('E') was doomed, not buggy), while the
// buildings the fixed guidance now points at (Pokecenter/Mart/Gym/Trade
// House) are ALL reachable via the same WARPS line the brain reads every
// turn (reach.ts, wq#538) -- so the fix's advice ("trust your WARPS line")
// is not just plausible text, it is RAM-verified against the exact stuck
// position.
//
// SECTION B is RED IN-PROBE for the guidance text: it re-derives what
// ceruleanApproachPack's arrival branch must and must not say by reading the
// live source, the same technique probe_phase514 already uses for this file
// (importing live_agent.ts would run its top-level IIFE).
//
// Usage: npx tsx src/probe_cerulean638.ts   (sandbox emulator + fixture only)
import * as fs from "fs";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { warpViews } from "./reach";
import { findFixture } from "./fixtures";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

console.log("-- A: the real live-stuck position, map3 (13,16) --");
const fixture = findFixture(sc => sc.map === 3 && sc.x === 13 && sc.y === 16,
  [`${BASE}/checkpoints`, `${BASE}/saves`]);
if (!fixture) {
  console.log("SKIP section A -- no map3 (13,16) checkpoint on disk (corpus rotated). " +
              "This is corpus rot, not a code defect; section B still runs.");
} else {
  const e = new Emulator(ROM);
  loadSnapshotFile(e, fixture);
  const rom = new Rom(ROM);
  const rd = new StateReader(e, sym);
  const st = rd.read();
  chk("fixture is really the stuck position", st.map === 3 && st.x === 13 && st.y === 16,
      `map${st.map} (${st.x},${st.y})`);

  const mm = new MapModel(e, sym, rom);
  mm.build();
  chk("map3 connection byte has EAST set (leave_edge was never structurally refused)",
      (mm.connections & 0x01) !== 0, `0x${mm.connections.toString(16)}`);

  // Full flood-fill from the stuck tile, same passability MapModel.grid uses.
  const seen = new Set<string>();
  const start: [number, number] = [st.x, st.y];
  seen.add(start.join(","));
  const q: [number, number][] = [start];
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= mm.gw || ny >= mm.gh) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      if (mm.grid[ny][nx]) { seen.add(k); q.push([nx, ny]); }
    }
  }
  const eastEdgeWalkable = Array.from({ length: mm.gh }, (_, y) => y).filter(y => mm.grid[y][mm.gw - 1]);
  const eastEdgeReachable = eastEdgeWalkable.filter(y => seen.has(`${mm.gw - 1},${y}`));
  chk("east edge (x=gw-1) has walkable tiles per the collision grid",
      eastEdgeWalkable.length > 0, `${eastEdgeWalkable.length} candidates`);
  chk("NONE of them are reachable from (13,16) -- leave_edge(E) was always going to fail here",
      eastEdgeReachable.length === 0,
      `${eastEdgeReachable.length}/${eastEdgeWalkable.length} reachable`);

  const views = warpViews(mm, st.x, st.y, 0xff, id => null);
  const byDest = (destMap: number) => views.find(v => v.destMap === destMap);
  const wantReachable: [string, number][] = [
    ["Trade House", 63], ["Pokecenter", 64], ["Gym", 65], ["Mart", 67],
  ];
  for (const [name, destMap] of wantReachable) {
    const v = byDest(destMap);
    chk(`${name} (map${destMap}) warp is reachable via WARPS (what the fixed guidance now points at)`,
        !!v && v.state !== "unreachable", v ? `${v.state}, ${v.steps} steps` : "no such warp");
  }
}

console.log("\n-- B: guidance text, source-verified (same technique as probe_phase514) --");
const src = fs.readFileSync("src/live_agent.ts", "utf8");

const mapsMatch = src.match(/const CERULEAN_TOWN_MAPS = \[([^\]]+)\]/);
const mapsList = mapsMatch ? mapsMatch[1].split(",").map(s => Number(s.trim())) : [];
chk("CERULEAN_TOWN_MAPS carries map3 plus every warp destination read off its own table",
    [3, 62, 63, 64, 65, 66, 67, 228, 230].every(m => mapsList.includes(m)) && mapsList.length === 9,
    mapsList.join(","));

chk("ceruleanApproachPack takes the current map (arrival is no longer boot-static)",
    /function ceruleanApproachPack\(map: number\)/.test(src));
chk("corridorNotepad threads map through to ceruleanApproachPack",
    /ceruleanApproachPack\(map\)/.test(src));
chk("the live call site passes st.map, not a constant",
    /corridorNotepad\(st\.badgeCount, next, st\.map,/.test(src));

const packSrc = src.slice(src.indexOf("function ceruleanApproachPack"), src.indexOf("(async () => {"));
const arrivedBranch = packSrc.slice(packSrc.indexOf("const whereYouAre = arrived ? ["),
                                    packSrc.indexOf("] : ["));
const approachBranch = packSrc.slice(packSrc.indexOf("] : ["), packSrc.indexOf("];\n  return ["));
chk("arrived branch does NOT tell the brain to keep heading east",
    !/keep heading east/i.test(arrivedBranch), arrivedBranch.slice(0, 80));
chk("arrived branch tells the brain to use enter_warp / its WARPS line instead of chasing east",
    /enter_warp/i.test(arrivedBranch) && /WARPS/.test(arrivedBranch));
chk("approach (not-yet-arrived) branch is UNCHANGED: still says keep heading east",
    /keep heading east/i.test(approachBranch));
chk("east pack still never mentions the mountain, not even as a negation (wq#514 deliverable 4 holds)",
    !/mt\s*moon|mtmoon|mount moon/i.test(packSrc));

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
