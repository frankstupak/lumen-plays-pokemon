// wq#564 acceptance: the Mt Moon guidance names a tile the agent can REACH.
//
// THE DEFECT: wq#535's pack stated one global forced route starting at B2F
// (5,7). From the east pocket the agent has occupied for 123 hours, (5,7) is
// unreachable -- and so are the fossils. The pack named a destination no goto
// could ever path to, and 31 of 54 real goto failures in the wq#560 window were
// that pack being replayed on the wrong floor.
//
// HOW THIS PROBE DISCRIMINATES, which is the property this lane keeps finding
// missing. Section B runs the SAME assertion set twice: once over the NEW
// per-pocket resolver and once over OLD_PACK, a verbatim fixture of the retired
// wq#535 text. NEW must pass every assertion and OLD must FAIL the route ones.
// An assertion that both satisfy is not evidence, and this run prints which
// ones caught OLD so a future reader can see the red rather than trust a claim
// that it was once observed.
//
// Usage: npx tsx src/probe_route564.ts
import { readFileSync } from "fs";
import { join } from "path";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { mtMoonLeg, reachableWarps, MT_MOON_MAPS, ROUTE_OVERVIEW } from "./mtmoon_route";
import { findFixture, requireFixture, instructionBody, haveSamples, romPath } from "./fixtures";

const ROM = romPath("pokeblue.gb");
const sym = new SymbolTable(romPath("pokeblue.sym"));
const rom = new Rom(ROM);
// R2: resolve the file under test relative to THIS probe, never to the primary
// tree, or a --worktree run verifies code that is not under review (wq#520).
const SRC = join(__dirname, "live_agent.ts");

let PASS = 0, FAIL = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { PASS++; console.log(`PASS  ${label}`); }
  else { FAIL++; console.log(`FAIL  ${label}${detail ? "  :: " + detail : ""}`); }
};

/** Pair-aware component, so the probe measures reachability the same way the
 *  resolver and nav do rather than by a looser rule of its own. */
function component(mm: MapModel, sx: number, sy: number): Set<string> {
  const seen = new Set([`${sx},${sy}`]);
  const q: [number, number][] = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && mm.passableFrom(x, y, nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

/** Load a fixture standing on `map`, resolved BY PROPERTY (wq#540 R1/R4). */
function on(map: number, extra: (sc: any) => boolean = () => true) {
  const p = requireFixture(`a checkpoint on map ${map}`,
                           findFixture(sc => sc.map === map && extra(sc)));
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, p);
  const st = new StateReader(emu, sym).read();
  const mm = new MapModel(emu, sym, rom);
  mm.build();
  return { mm, st, file: p.split("/").pop()! };
}

console.log("=== A. THE DEFECT, from RAM: the old route's first tile is unreachable ===");
const b2 = on(61);
console.log(`  using ${b2.file} @(${b2.st.x},${b2.st.y})`);
{
  const { mm, st } = b2;
  const comp = (sx: number, sy: number) => {
    const seen = new Set([`${sx},${sy}`]);
    const q: [number, number][] = [[sx, sy]];
    while (q.length) {
      const [x, y] = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
        if (!seen.has(k) && mm.passableFrom(x, y, nx, ny)) { seen.add(k); q.push([nx, ny]); }
      }
    }
    return seen;
  };
  const mine = comp(st.x, st.y);
  const warps = reachableWarps(mm, st.x, st.y);
  console.log(`  player component ${mine.size} tiles; reachable warps: ` +
              warps.map(w => `(${w.x},${w.y})->m${w.destMap}`).join(" ") || "NONE");
  // The east pocket is the one the campaign is stuck in. If the fixture happens
  // to be in the west pocket instead, say so rather than asserting nonsense.
  const east = warps.length === 1 && warps[0].x === 25 && warps[0].y === 9;
  if (east) {
    ok("east pocket: the OLD route's first tile (5,7) is UNREACHABLE", !mine.has("5,7"),
       "this is the whole ticket: the pack named it as the forced first step");
    ok("east pocket: the fossils at (12,7) are UNREACHABLE too", !mine.has("12,7"),
       "so 'take the fossil BEFORE any ladder down' was anti-guidance here");
    ok("east pocket: exactly ONE warp is reachable, the (25,9) ladder", true,
       `${warps.length} warp(s)`);
  } else {
    console.log("  NOTE: fixture is not in the east pocket; A's east assertions are skipped");
    ok("fixture pocket has at least one reachable warp", warps.length > 0);
  }
}

console.log("\n=== B. RED/GREEN: same assertions over NEW resolver vs the OLD pack ===");
// Verbatim fixture of the retired wq#535 text, so the defect stays pinned and a
// restoration of it goes red here rather than silently shipping.
const OLD_PACK = [
  "THE EXIT IS ONE FORCED ROUTE - trust this over exploring:",
  "    B2F(map61) (5,7) -> B1F(map60) (23,3) -> walk to (27,3) -> Route 4 EAST.",
  "  No other ladder anywhere in the mountain reaches the outside.",
  "DEAD-POCKET RECOVERY (read this the FIRST time a goto answers 'stuck'):",
  "  THE WAY OUT IS THE LADDER YOU ARRIVED BY, AND YOU ARE USUALLY STANDING ON",
  "  IT: enter_warp the warp at your OWN coordinates to go back up to B2F,",
  "  then take B2F (5,7). goto can never cross a warp - only enter_warp can.",
  "  DO THIS WHILE YOU ARE STILL ON B2F, BEFORE TAKING ANY LADDER DOWN.",
].join("\n");

/** The assertions any east-pocket guidance must satisfy. Returns failures. */
function eastPocketFailures(text: string): string[] {
  const bad: string[] = [];
  if (!/\(25,9\)/.test(text)) bad.push("does not name the (25,9) ladder, the only way out");
  if (!/enter_warp/.test(text)) bad.push("does not tell the agent to enter_warp");
  if (/goto\(5,7\)|take B2F \(5,7\)|-> B1F\(map60\)/.test(text))
    bad.push("directs the agent to (5,7), which it cannot reach from here");
  if (/BEFORE TAKING ANY LADDER DOWN/.test(text))
    bad.push("orders the fossil before a ladder down, which is anti-guidance here");
  return bad;
}

{
  const leg = mtMoonLeg(b2.mm, 61, b2.st.x, b2.st.y);
  ok("NEW: a leg resolves for the live B2F position", leg !== null);
  const newText = leg ? [leg.leg, leg.pocket, ...leg.lines].join("\n") : "";
  if (leg) console.log(`  leg ${leg.leg} - ${leg.pocket}`);

  const warps = reachableWarps(b2.mm, b2.st.x, b2.st.y);
  const isEast = warps.length === 1 && warps[0].x === 25 && warps[0].y === 9;
  if (isEast) {
    const newBad = eastPocketFailures(newText);
    ok("NEW pack passes every east-pocket assertion", newBad.length === 0, newBad.join("; "));
    const oldBad = eastPocketFailures(OLD_PACK);
    // The discriminating half. If OLD ever passes these, they have stopped
    // testing anything and this probe is decoration.
    ok("OLD pack FAILS them (the assertions discriminate)", oldBad.length > 0,
       "an assertion both versions satisfy is not evidence");
    console.log(`  OLD caught by: ${oldBad.length ? oldBad.join(" | ") : "NOTHING - assertions are vacuous"}`);
  } else {
    console.log("  NOTE: live fixture is not east-pocket; running the OLD/NEW contrast anyway");
    ok("OLD pack still fails the east-pocket assertions", eastPocketFailures(OLD_PACK).length > 0);
  }
}

console.log("\n=== C. every pocket on every Mt Moon floor gets a leg (no silent gaps) ===");
// A pocket with no rule is an agent with no instruction, which is the state
// this ticket found. Enumerate pockets by their warps and demand a leg for each.
for (const mapId of MT_MOON_MAPS) {
  const f = on(mapId);
  const { mm } = f;
  const seen = new Set<string>();
  let pockets = 0, legged = 0;
  for (const w of mm.warps) {
    if (seen.has(`${w.x},${w.y}`)) continue;
    if (!mm.passable(w.x, w.y)) continue;
    const group = reachableWarps(mm, w.x, w.y);
    group.forEach(g => seen.add(`${g.x},${g.y}`));
    pockets++;
    const leg = mtMoonLeg(mm, mapId, w.x, w.y);
    if (leg) legged++;
    console.log(`  map${mapId} pocket{${group.map(g => `(${g.x},${g.y})`).join(" ")}} -> ` +
                (leg ? `${leg.leg} (${leg.pocket})` : "*** NO LEG ***"));
  }
  ok(`map${mapId}: every reachable-warp pocket resolves to a leg`,
     haveSamples(`map${mapId} pockets`, pockets) && legged === pockets,
     `${legged}/${pockets}`);
}

console.log("\n=== D. a leg can only ever name a warp the player can reach ===");
// The structural claim behind the whole fix. For every pocket on every floor,
// every coordinate the leg text mentions must be either a warp in THAT pocket
// or a tile reachable within it. This is what makes "guidance names a tile the
// agent cannot reach" unavailable rather than merely fixed.
for (const mapId of MT_MOON_MAPS) {
  const { mm } = on(mapId);
  const seen = new Set<string>();
  for (const w of mm.warps) {
    if (seen.has(`${w.x},${w.y}`) || !mm.passable(w.x, w.y)) continue;
    const group = reachableWarps(mm, w.x, w.y);
    group.forEach(g => seen.add(`${g.x},${g.y}`));
    const leg = mtMoonLeg(mm, mapId, w.x, w.y);
    if (!leg) continue;
    // Coordinates the leg tells the agent to enter_warp must be in this pocket.
    const text = leg.lines.join("\n");
    const warpTargets = [...text.matchAll(/enter_warp\s*\(?(\d+),(\d+)\)?/g)]
      .map(m => [Number(m[1]), Number(m[2])] as const);
    const bad = warpTargets.filter(t => !group.some(g => g.x === t[0] && g.y === t[1]));
    ok(`map${mapId} ${leg.leg}: every enter_warp target is in the player's own pocket`,
       bad.length === 0, bad.map(b => `(${b})`).join(" "));
    // ...and every goto target must be WALKABLE from here. This is the assertion
    // that would have caught the original defect directly: the old pack's
    // goto(5,7) from the east pocket is exactly a goto to another component.
    const cells = component(mm, w.x, w.y);
    const gotoTargets = [...text.matchAll(/goto\s*\((\d+),(\d+)\)/g)]
      .map(m => [Number(m[1]), Number(m[2])] as const);
    const unreachable = gotoTargets.filter(t => !cells.has(`${t[0]},${t[1]}`));
    ok(`map${mapId} ${leg.leg}: every goto target is walkable from this pocket`,
       unreachable.length === 0,
       unreachable.map(b => `(${b})`).join(" ") + ` [${gotoTargets.length} goto target(s)]`);
  }
}

console.log("\n=== E. the wiring: live_agent actually consumes the resolver ===");
{
  const src = readFileSync(SRC, "utf8");
  const pack = instructionBody(src, "mtMoonTransitPack");
  ok("mtMoonTransitPack takes a routeLeg", /routeLeg/.test(pack));
  ok("the pack no longer states one global forced route",
     !/THE EXIT IS ONE FORCED ROUTE/.test(pack));
  ok("the pack no longer orders the fossil before any ladder down",
     !/BEFORE TAKING ANY LADDER DOWN/.test(pack),
     "asserted on the INSTRUCTION body: a comment citing the retired rule must not satisfy this");
  // R5 regression guard: prove the strip is doing the work. The raw source DOES
  // still contain the phrase, inside the comment that explains the retirement.
  ok("R5: the retired phrase survives in a comment, and stripping is what catches it",
     /BEFORE TAKING ANY LADDER DOWN/.test(src),
     "if this fails the citation was removed - the assertion above then proves less than it claims");
  ok("the leg is resolved inside the turn-loop refresh, not pinned at boot",
     /mtMoonLeg\(map, st\.map, st\.x, st\.y\)/.test(src));
  ok("leg resolution is guarded to the cave maps and out of battle",
     /MT_MOON_MAPS\.includes\(st\.map\) && st\.inBattle === 0/.test(src));
  ok("a geometry failure cannot kill the turn loop", /route leg unresolved/.test(src));
  ok("the route overview is non-empty and names no per-turn target",
     ROUTE_OVERVIEW.length > 0 && !/goto\(/.test(ROUTE_OVERVIEW.join("\n")));
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
