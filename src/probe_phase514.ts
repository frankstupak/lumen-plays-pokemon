// probe_phase514 — offline proof for the wq#514 corridor PHASE machine.
//   npx tsx src/probe_phase514.ts
// No emulator, no service, no network. Pure functions + files on disk.
import * as fs from "fs";
import * as path from "path";
import { corridorPhase, phaseWarnings, ROUTE4_EAST_RANK, ROUTE4_WEST_RANK,
         F_SUPER_NERD, F_DOME, F_HELIX, type CorridorPhase } from "./phase";
import { SPLIT_MAPS, progressRank } from "./resume";
import type { GameState } from "./state";

let PASS = 0, FAIL = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { PASS++; console.log(`PASS  ${label}`); }
  else { FAIL++; console.log(`FAIL  ${label}${detail ? "  " + detail : ""}`); }
};
const st = (map: number, x: number, y: number, badgeCount = 1): GameState =>
  ({ map, x, y, badgeCount } as GameState);

console.log("\n-- flag table is intact (names resolved, not retyped) --");
ok("no phase warnings at import", phaseWarnings.length === 0, phaseWarnings.join("; "));
ok("EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD resolved", F_SUPER_NERD !== null);
ok("EVENT_GOT_DOME_FOSSIL resolved", F_DOME !== null);
ok("EVENT_GOT_HELIX_FOSSIL resolved", F_HELIX !== null);

console.log("\n-- the boundary is INHERITED from wq#518, not redefined here --");
ok("east rank is strictly above west rank", ROUTE4_EAST_RANK > ROUTE4_WEST_RANK,
   `${ROUTE4_WEST_RANK} -> ${ROUTE4_EAST_RANK}`);
ok("east rank sits above every Mt Moon floor",
   ROUTE4_EAST_RANK > progressRank(59) && ROUTE4_EAST_RANK > progressRank(60) &&
   ROUTE4_EAST_RANK > progressRank(61));
ok("west rank sits below every Mt Moon floor",
   ROUTE4_WEST_RANK < progressRank(59) && ROUTE4_WEST_RANK < progressRank(60) &&
   ROUTE4_WEST_RANK < progressRank(61));
ok("phase.ts declares no threshold of its own",
   !/beyond\s*[:=]\s*\d/.test(fs.readFileSync("src/phase.ts", "utf8")),
   "a literal boundary in phase.ts would duplicate wq#518");

console.log("\n-- WEST/EAST selection --");
const B = SPLIT_MAPS[15].beyond;
ok("Route 4 WEST -> MT_MOON_TRANSIT", corridorPhase(st(15, B - 1, 6)) === "MT_MOON_TRANSIT");
ok("Route 4 EAST -> CERULEAN_APPROACH", corridorPhase(st(15, B, 6)) === "CERULEAN_APPROACH");
ok("exactly at the wall column is EAST (boundary is inclusive, as wq#518 defines it)",
   corridorPhase(st(15, B, 6)) === "CERULEAN_APPROACH");
ok("one tile west of it is WEST", corridorPhase(st(15, B - 1, 6)) === "MT_MOON_TRANSIT");
for (const m of [14, 59, 60, 61, 68])
  ok(`map ${m} -> MT_MOON_TRANSIT`, corridorPhase(st(m, 5, 5)) === "MT_MOON_TRANSIT");
ok("Cerulean (map3) -> CERULEAN_APPROACH", corridorPhase(st(3, 10, 10)) === "CERULEAN_APPROACH");

console.log("\n-- badge gating: only the badges===1 branch splits --");
ok("badges 0 -> PEWTER_GYM", corridorPhase(st(15, B, 6, 0)) === "PEWTER_GYM");
ok("badges 2 -> OPEN_CAMPAIGN", corridorPhase(st(15, B - 1, 6, 2)) === "OPEN_CAMPAIGN");
ok("badges 3 -> OPEN_CAMPAIGN", corridorPhase(st(61, 5, 5, 3)) === "OPEN_CAMPAIGN");

console.log("\n-- off-path maps HOLD the phase (the Cerulean-building trap) --");
// progressRank returns -1 for anything off the critical path, and Cerulean's
// gym/mart/centre are all off it. Without the hold, walking indoors in
// Cerulean would rank -1 and hand the brain cave-crossing instructions.
ok("unranked map holds CERULEAN_APPROACH",
   corridorPhase(st(9999, 4, 4), "CERULEAN_APPROACH") === "CERULEAN_APPROACH");
ok("unranked map holds MT_MOON_TRANSIT",
   corridorPhase(st(9999, 4, 4), "MT_MOON_TRANSIT") === "MT_MOON_TRANSIT");
ok("unranked map with no prior phase defaults to the EARLIER half",
   corridorPhase(st(9999, 4, 4)) === "MT_MOON_TRANSIT");
ok("a ranked map still OVERRIDES a held phase (not a one-way latch)",
   corridorPhase(st(15, B - 1, 6), "CERULEAN_APPROACH") === "MT_MOON_TRANSIT",
   "a latch here would wedge the agent, which is what wq#517 was rewritten to avoid");

console.log("\n-- pack content rules --");
const src = fs.readFileSync("src/live_agent.ts", "utf8");
const eastPack = src.slice(src.indexOf("function ceruleanApproachPack"),
                           src.indexOf("(async () => {"));
ok("east pack never mentions the mountain, not even as a negation",
   !/mt\s*moon|mtmoon|mount moon/i.test(eastPack),
   "wq#488: a negated instruction still puts the action in context");
ok("east pack does not contain the map59/60/61 ids",
   !/\bmap(59|60|61)\b/.test(eastPack));
const westPack = src.slice(src.indexOf("function mtMoonTransitPack"),
                           src.indexOf("function ceruleanApproachPack"));
ok("west pack does own the crossing", /MT MOON 1F\(map59\)/.test(westPack));
ok("west pack does not issue Cerulean-side navigation",
   !/CERULEAN CITY \(map3\)|beat MISTY/i.test(westPack));
ok("the two packs are never both selectable for one position",
   ["MT_MOON_TRANSIT", "CERULEAN_APPROACH"].filter(
     p => p === corridorPhase(st(15, B, 6))).length === 1);
ok("guidance is no longer pinned once at boot",
   /refreshCorridorGuidance\(\);\s*\/\/ wq#514/.test(src),
   "must be called inside the turn loop");

console.log("\n-- the REAL checkpoint set (honest about what it can prove) --");
const dirs = ["checkpoints"];
const found: { file: string; x: number; y: number }[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith(".json")) {
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        if (j.map === 15 && typeof j.x === "number") found.push({ file: e.name, x: j.x, y: j.y });
      } catch { /* not a sidecar */ }
    }
  }
};
for (const d of dirs) if (fs.existsSync(d)) walk(d);
console.log(`   ${found.length} map15 checkpoints on disk; x values: ${[...new Set(found.map(f => f.x))].join(",")}`);
ok("every real map15 checkpoint classifies as MT_MOON_TRANSIT",
   found.length > 0 && found.every(f => corridorPhase(st(15, f.x, f.y)) === "MT_MOON_TRANSIT"),
   `${found.length} samples`);
// Stated plainly rather than dressed up as validation: every sample is west,
// so this set CANNOT discriminate the threshold's value. Any boundary from
// 12 to the map width classifies all of them identically. The boundary's
// evidence is ROM geometry (wq#518 probe section A) plus live confirmation
// once wq#527 deploys and the agent stands east for the first time.
ok("HONEST: the checkpoint set contains ZERO east samples, so it cannot validate the boundary VALUE",
   found.every(f => f.x < SPLIT_MAPS[15].beyond),
   "if this ever fails, a real east sample exists and the boundary can finally be tested from data");

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
