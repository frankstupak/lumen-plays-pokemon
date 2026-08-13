// wq#538 acceptance: the WARPS list and the failed-goto reply must carry
// reachability, and destMap 255 must resolve to a real map.
//
// Sections A-D are properties of the GAME and hold on any tree; they exist so a
// future ROM, tileset change or MapModel edit that moves the Mt Moon geometry
// fails a test instead of silently changing what the brain is told. Section E
// exercises THIS DIFF and is what fails on pristine origin/main.
//
// Usage: npx tsx src/probe_reach538.ts
import { readdirSync } from "fs";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { GameNames } from "./names";
import { astar } from "./nav";
import { warpViews, renderWarps, stuckHint, resolveDest, WarpView } from "./reach";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CK = "/home/lumen/pokemon/checkpoints";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);
const names = new GameNames(rom, sym);
const label = (id: number) => names.mapName(id);

interface Loaded { file: string; emu: Emulator; x: number; y: number; mm: MapModel; lastMap: number }
function loadAllOn(wantMap: number): Loaded[] {
  const out: Loaded[] = [];
  for (const f of readdirSync(CK).filter(n => n.endsWith(".state.gz"))) {
    const emu = new Emulator(ROM);
    try { loadSnapshotFile(emu, `${CK}/${f}`); } catch { continue; }
    const st = new StateReader(emu, sym).read();
    if (st.map !== wantMap) continue;
    const mm = new MapModel(emu, sym, rom); mm.build();
    out.push({ file: f, emu, x: st.x, y: st.y, mm, lastMap: emu.mem()[sym.addr("wLastMap")] });
  }
  return out;
}

/** Component decomposition under astar's traversal rule (warps are terminal). */
function components(mm: MapModel): { size: number; warps: number[] }[] {
  const seen = new Set<string>();
  const comps: { size: number; warps: number[] }[] = [];
  for (let y = 0; y < mm.gh; y++) for (let x = 0; x < mm.gw; x++) {
    const k = `${x},${y}`;
    if (seen.has(k) || !mm.passable(x, y) || mm.isWarp(x, y)) continue;
    const set = new Set([k]); const q: [number, number][] = [[x, y]];
    while (q.length) {
      const [cx, cy] = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy, nk = `${nx},${ny}`;
        if (set.has(nk) || !mm.passable(nx, ny) || mm.isWarp(nx, ny)) continue;
        set.add(nk); q.push([nx, ny]);
      }
    }
    for (const kk of set) seen.add(kk);
    const ws = mm.warps.map((w, i) => i).filter(i => {
      const w = mm.warps[i];
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => set.has(`${w.x + dx},${w.y + dy}`));
    });
    comps.push({ size: set.size, warps: ws });
  }
  return comps.sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------- A: map60 topology
console.log("\n=== A. Mt Moon B1F (map60) is four disconnected pockets ===");
const b1f = loadAllOn(60);
chk("A0 at least one map60 checkpoint on disk", b1f.length > 0, `${b1f.length} found`);
for (const s of b1f) {
  const comps = components(s.mm);
  chk(`A1 ${s.file} has exactly 4 components`, comps.length === 4,
    comps.map(c => c.size).join("/"));
  const exitComp = comps.find(c => c.warps.includes(7));
  chk(`A2 ${s.file} the pocket holding warp7 (27,3) also holds warp6 (23,3) and NOTHING else`,
    !!exitComp && exitComp.warps.length === 2 && exitComp.warps.includes(6),
    exitComp ? `warps=[${exitComp.warps}] size=${exitComp.size}` : "no comp owns warp7");
  // THE load-bearing claim: the exit pocket is entered only from B2F.
  const w6 = s.mm.warps[6];
  chk(`A3 ${s.file} warp6 (23,3) leads to map61 (B2F) - so B2F is MANDATORY, not a dead end`,
    w6.x === 23 && w6.y === 3 && w6.destMap === 61, `warp6=(${w6.x},${w6.y})->map${w6.destMap}`);
}

// ---------------------------------------------------------------- B: reachability from the landing tile
console.log("\n=== B. from the B1F landing tile, the exit is NOT reachable and the ladder underfoot IS ===");
for (const s of b1f) {
  const views = warpViews(s.mm, s.x, s.y, s.lastMap, label);
  const here = views.filter(v => v.state === "here").map(v => v.i);
  const reach = views.filter(v => v.state === "reachable").map(v => v.i);
  const un = views.filter(v => v.state === "unreachable").map(v => v.i);
  chk(`B1 ${s.file} (${s.x},${s.y}) stands ON exactly one warp`, here.length === 1, `here=[${here}]`);
  chk(`B2 ${s.file} warp7 (27,3), the Route 4 exit, is UNREACHABLE from here`,
    un.includes(7), `unreachable=[${un}]`);
  chk(`B3 ${s.file} at least one warp is usable (never a total dead end)`,
    here.length + reach.length > 0, `here=[${here}] reachable=[${reach}]`);
  chk(`B4 ${s.file} astar agrees: no path to (27,3)`,
    astar(s.mm, s.x, s.y, 27, 3, new Set()) === null);
}

// ---------------------------------------------------------------- C: destMap 255
console.log("\n=== C. destMap 255 is LAST_MAP and resolves to a real place ===");
for (const s of b1f) {
  chk(`C1 ${s.file} wLastMap is a labelled map, not garbage`, label(s.lastMap) !== null,
    `wLastMap=${s.lastMap} -> ${label(s.lastMap)}`);
  const w7 = s.mm.warps[7];
  const d = resolveDest(w7.destMap, s.lastMap, label);
  chk(`C2 ${s.file} warp7 renders as a place, never as "255"`,
    w7.destMap === 255 && !d.includes("255") && d.length > 3, `-> "${d}"`);
  chk(`C3 ${s.file} and that place is Route 4`, d.toLowerCase().includes("route 4"), d);
}

// ---------------------------------------------------------------- D: map61 fossil approach
console.log("\n=== D. Mt Moon B2F (map61): the fossils are far, and (5,7) is shut ===");
const b2f = loadAllOn(61);
chk("D0 at least one map61 checkpoint on disk", b2f.length > 0, `${b2f.length} found`);
for (const s of b2f) {
  const toFossil = astar(s.mm, s.x, s.y, 12, 7, new Set());
  chk(`D1 ${s.file} the Dome approach tile (12,7) IS reachable`, toFossil !== null);
  // The five-day illusion: 12 tiles away in a straight line, ~85 by the only
  // legal route. Any change that makes this SHORT means the model broke.
  chk(`D2 ${s.file} and it is a long walk (>=60 steps), not the 12-tile straight line`,
    !!toFossil && toFossil.length >= 60, toFossil ? `${toFossil.length} steps` : "no path");
  chk(`D3 ${s.file} (5,7), the warp into the exit pocket, is NOT reachable while the fossils stand`,
    astar(s.mm, s.x, s.y, 5, 7, new Set()) === null);
}

// ---------------------------------------------------------------- E: what the brain is TOLD
console.log("\n=== E. the rendered strings (this section is what the diff changes) ===");
{
  const s = b1f[0];
  const views = warpViews(s.mm, s.x, s.y, s.lastMap, label);
  const line = renderWarps(views);
  console.log(`  WARPS line:\n    ${line.replace(/\n/g, "\n    ")}`);
  chk("E1 the WARPS line marks unreachable warps", line.includes("NO PATH"), "");
  chk("E2 the WARPS line marks the warp underfoot", line.includes("STANDING-ON-IT"));
  chk("E3 the WARPS line never shows a raw map255", !line.includes("map255") && !line.includes("->255"));
  chk("E4 the WARPS line names Route 4 as the exit", /route 4/i.test(line));
  chk("E5 standing on a warp produces the enter_warp hint", line.includes("enter_warp("));
  chk("E6 reachable warps carry a step count", /\[\d+ steps\]/.test(line));

  const hint = stuckHint(s.mm, s.x, s.y, 27, 3, views);
  console.log(`  stuck hint (unreachable target):\n    ${hint.trim()}`);
  chk("E7 a failed goto to an unreachable tile says it is unreachable", /no path to \(27,3\)/.test(hint));
  chk("E8 ...and names a warp that IS usable", /Reachable warps: /.test(hint));
  chk("E9 ...and points at enter_warp rather than another goto", /enter_warp/.test(hint));

  // The other half: a target that IS reachable but the walk did not finish.
  // Distinguishing these two is the whole point - the responses are opposite.
  const s2 = b2f[0];
  const v2 = warpViews(s2.mm, s2.x, s2.y, s2.lastMap, label);
  const hint2 = stuckHint(s2.mm, s2.x, s2.y, 12, 7, v2);
  console.log(`  stuck hint (reachable target):\n    ${hint2.trim()}`);
  chk("E10 a failed goto to a REACHABLE tile says the target is not the problem",
    /IS reachable/.test(hint2) && /not the problem/.test(hint2));
  chk("E11 ...and quotes the real distance", /\d\d steps/.test(hint2));
  chk("E12 the two hints are different advice", hint !== hint2);

  // Regression guard on the old behaviour we replaced.
  chk("E13 the WARPS line is no longer the bare undifferentiated list",
    !/^WARPS \d+:\(\d+,\d+\)->map\d+ \d+:/.test(line));
}

// ---------------------------------------------------------------- F: the wiring
// Sections A-E prove reach.ts is correct. NONE of them prove agent.ts actually
// CALLS it - they would all pass with reach.ts present and the state block still
// rendering the old bare list. That is the "green but wrong" shape this lane has
// caught repeatedly, so it gets its own section. Checked as source text because
// importing agent.ts to reach observe() would need a live Emulator, ROM, Screen
// and EventBus, and the property that matters here is exactly textual: the old
// renderer must be GONE, not merely shadowed.
// __dirname, never a fixed /home/lumen/pokemon path (wq#520): a probe that reads
// the primary tree from inside a --worktree checkout verifies the wrong file and
// goes green without ever executing the diff.
console.log("\n=== F. agent.ts is actually wired to it ===");
{
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const src = readFileSync(join(__dirname, "agent.ts"), "utf8");
  chk("F1 the state block renders via renderWarps()", src.includes("renderWarps("));
  chk("F2 the failed-goto reply calls stuckHint()", src.includes("stuckHint("));
  chk("F3 the OLD bare warp renderer is gone, not just bypassed",
    !src.includes("->map${w.destMap}"));
  chk("F4 reachability is imported from reach.ts", /from "\.\/reach"/.test(src));
}

console.log(`\nprobe_reach538: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
