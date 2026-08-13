// wq#535 acceptance: prove from RAM+ROM that the Mt Moon exit is real, that the
// two fossil objects are what block it, and that the corridor pack tells the
// brain the route that actually exists.
//
// WHY THIS DOES NOT IMPORT live_agent.ts: that module binds port 8871, opens an
// EventBus that writes a new run log, and ends in an IIFE that starts the agent
// loop. Importing it to reach mtMoonTransitPack would launch a SECOND live
// agent against the same save. The pack is therefore checked as source text,
// which is also the property that matters here -- the prompt must not drift
// away from the ROM. Section A proves the geometry; section B proves the
// prompt still describes that geometry.
//
// Usage: npx tsx src/probe_fossil535.ts
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CKPTS = "/home/lumen/pokemon/checkpoints";
// Resolve the file under test relative to THIS probe, never to a fixed
// /home/lumen/pokemon path. wq#520 found verify_489.py hardcoded the primary
// tree, so running it from a `lumen-pr start --worktree` checkout verified the
// unmodified file and went green without ever reading the diff under review.
// __dirname rather than import.meta.url: this project's tsc target is CommonJS
// and import.meta is a hard TS1470 error there, even though tsx runs it fine.
const SRC = join(__dirname, "live_agent.ts");

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

/** Load the newest checkpoint sitting on `wantMap`, or null. */
function loadOn(wantMap: number): { emu: Emulator; x: number; y: number; file: string } | null {
  const files = readdirSync(CKPTS).filter(f => f.endsWith(".state.gz"))
    .map(f => `${CKPTS}/${f}`);
  for (const f of files) {
    const emu = new Emulator(ROM);
    try { loadSnapshotFile(emu, f); } catch { continue; }
    const st = new StateReader(emu, sym).read();
    if (st.map === wantMap) return { emu, x: st.x, y: st.y, file: f.split("/").pop()! };
  }
  return null;
}

function bfs(mm: MapModel, sx: number, sy: number): Set<string> {
  const seen = new Set<string>([`${sx},${sy}`]);
  const q: [number, number][] = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && mm.passable(nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

console.log("=== A. map61 (Mt Moon B2F): the blockers and the exit, from RAM ===");
const b2 = loadOn(61);
if (!b2) {
  chk("a map61 checkpoint exists to test against", false, "none found");
} else {
  const mm = new MapModel(b2.emu, sym, rom); mm.build();
  console.log(`  using ${b2.file} @(${b2.x},${b2.y})`);

  const exitWarp = mm.warps.find(w => w.x === 5 && w.y === 7);
  chk("map61 has the (5,7) warp to map60", !!exitWarp && exitWarp.destMap === 60,
      JSON.stringify(exitWarp));

  const dome = mm.sprites.some(s => s.x === 12 && s.y === 6);
  const helix = mm.sprites.some(s => s.x === 13 && s.y === 6);
  chk("both fossil objects are present at (12,6) and (13,6)", dome && helix,
      `dome=${dome} helix=${helix}`);
  chk("both fossil tiles are impassable", !mm.passable(12, 6) && !mm.passable(13, 6));
  chk("the interaction tile (12,7) IS passable", mm.passable(12, 7));

  const before = bfs(mm, b2.x, b2.y);
  chk("with both fossils present, (5,7) is UNREACHABLE", !before.has("5,7"),
      `${before.size} tiles reachable`);

  // Remove ONLY the dome fossil, exactly as taking it would.
  const saved = mm.sprites.slice();
  mm.sprites = saved.filter(s => !(s.x === 12 && s.y === 6));
  const after = bfs(mm, b2.x, b2.y);
  chk("removing the DOME fossil alone makes (5,7) REACHABLE", after.has("5,7"),
      `${after.size} tiles reachable`);

  mm.sprites = saved.filter(s => !(s.x === 13 && s.y === 6));
  chk("removing the HELIX fossil alone also makes (5,7) REACHABLE",
      bfs(mm, b2.x, b2.y).has("5,7"));

  // The alternative the ticket floated: is the Super Nerd the blocker?
  mm.sprites = saved.filter(s => !(s.x === 12 && s.y === 8));
  chk("removing the SUPER NERD does NOT open it (he is not the cut)",
      !bfs(mm, b2.x, b2.y).has("5,7"));
  mm.sprites = saved;
}

console.log("\n=== B. map60 (B1F): only the (23,3) pocket touches the outside ===");
const b1 = loadOn(60);
if (!b1) {
  chk("a map60 checkpoint exists to test against", false, "none found");
} else {
  const mm = new MapModel(b1.emu, sym, rom); mm.build();
  console.log(`  using ${b1.file} @(${b1.x},${b1.y})`);
  const up = mm.warps.find(w => w.x === 23 && w.y === 3);
  const out = mm.warps.find(w => w.x === 27 && w.y === 3);
  chk("map60 (23,3) warps to map61", !!up && up.destMap === 61, JSON.stringify(up));
  chk("map60 (27,3) is the OUTSIDE warp (destMap 255)", !!out && out.destMap === 255,
      JSON.stringify(out));
  // (23,3) and (27,3) must be in the SAME pocket, or the route is wrong.
  const fromLadder = bfs(mm, 23, 3);
  chk("(27,3) is reachable from (23,3) - same pocket", fromLadder.has("27,3"),
      `${fromLadder.size} tiles in that pocket`);
}

console.log("\n=== C. the corridor pack still describes the route the ROM has ===");
{
  const src = readFileSync(SRC, "utf8");
  const start = src.indexOf("function mtMoonTransitPack");
  const pack = start >= 0 ? src.slice(start, src.indexOf("\nfunction ", start + 10)) : "";
  chk("mtMoonTransitPack found in source", pack.length > 0);
  chk("pack names the forced exit route B2F(5,7) -> B1F(23,3) -> (27,3)",
      pack.includes("(5,7) -> B1F(map60) (23,3)") && pack.includes("(27,3)"));
  chk("pack names both fossil coordinates as blockers",
      pack.includes("(12,6)") && pack.includes("(13,6)"));
  chk("pack gives the exact clearing interaction",
      pack.includes("goto(12,7)") && pack.includes("interact(12,6)") && pack.includes("choose(yes)"));
  chk("pack warns B1F is disconnected pockets, not one floor",
      /FOUR DISCONNECTED POCKETS/.test(pack));
  chk("pack no longer says B1F is a small connector floor",
      !pack.includes("small connector floor"));
  chk("the fossil-door block is suppressed once a fossil is held",
      /haveFossil \? \[\] :/.test(pack));
  // wq#488: guidance must never carry the notepad's own markers.
  chk("pack contains no [[ ]] guidance markers", !pack.includes("[[") && !pack.includes("]]"));
  // wq#535 second pass: "go back up" was advice, not an action. The agent sat
  // on (17,11) -- the ladder out -- issuing goto(27,3) at a tile four pockets
  // away, eight turns running. The pack must name enter_warp explicitly.
  chk("pack has an actionable dead-pocket recovery (enter_warp, not 'go back up')",
      /DEAD-POCKET RECOVERY/.test(pack) && pack.includes("enter_warp the warp at your OWN coordinates"));
  chk("pack states goto cannot cross a warp",
      /goto can never cross a warp/.test(pack));
  chk("pack orders the fossil BEFORE any ladder down",
      /BEFORE TAKING ANY LADDER DOWN/.test(pack));
}

console.log("\n=== D. the dead-pocket claim is TRUE, not just asserted (RAM) ===");
if (!b1) {
  chk("map60 checkpoint available for pocket analysis", false, "none found");
} else {
  const mm = new MapModel(b1.emu, sym, rom); mm.build();
  const outside = mm.warps.find(w => w.destMap === 255);
  chk("map60 has exactly one OUTSIDE warp", !!outside && `${outside.x},${outside.y}` === "27,3");
  // Each B2F ladder lands somewhere on B1F. The pack claims (25,9)/(21,17)/
  // (15,27) all land in pockets with no route to (27,3). Verify per landing
  // tile: map60's warps back UP to map61 are the landing points.
  for (const land of [[17, 11], [21, 17], [13, 27]] as const) {
    const reach = bfs(mm, land[0], land[1]);
    chk(`B1F pocket at (${land[0]},${land[1]}) CANNOT reach the exit (27,3)`,
        !reach.has("27,3"), `${reach.size} tiles`);
    // ...and the ladder back up is standing right there, which is the recovery.
    const here = mm.warps.find(w => w.x === land[0] && w.y === land[1]);
    chk(`  and (${land[0]},${land[1]}) is itself a warp back up (the recovery)`,
        !!here && here.destMap === 61, JSON.stringify(here));
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
