// wq#698 — notepad pin hygiene: refuse/downgrade position-stamped nav goals.
//
// Pure unit probe: Notepad is emulator-free, unbound pad never touches disk.
// GREEN asserts: (1) durable fact pins go through, (2) position-stamped nav
// goals are downgraded to rolling notes, (3) sweepStalePositionPins demotes
// existing stale pins, (4) the detector fires on the exact live exhibit
// strings from 2026-08-19 T4/T7.
import { Notepad, isPositionStampedNavGoal } from "./notepad";

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

console.log("== probe_notepad698 (GREEN) ==");

// ── detector unit tests ──────────────────────────────────────────────────
// Live exhibit strings from 2026-08-19 T4/T7 (the exact pollution)
const NAV_GOALS = [
  "Cerulean reached,map3 pos 19,8. Goal: Exit North to Route 24/25 to catch Grass/Rock type and grind trainers before fighting Misty.",
  "Cerulean City reached,map 3 pos 25,26. Goal: Route 24/25 grind for Misty badge prep. Party of 1,catch target priority.",
  "Cerulean reached,map3 pos 25,26. Goal: Route 24/25 grind for Misty badge prep. Party of 1,catch target priority. MART stock verified,no buy needed yet.",
  "Route 25 Map36 POS 19,3. Goal: Catch Grass/Rock type on R24/25 to counter Misty. TM19 at (22,2 on map36) unreachable.",
  "Goal: Exit Mt Moon B2F west pocket via exit ladder at (5,7",
  "Goal: Head EAST on Route 4 to Cerulean City",
  "Goal: Leave Route 4 East via EAST edge to Cerulean City",
  "Goal: Navigate north to Route 24 from Cerulean",
  "Goal: Go to Cerulean Mart (warp 5",
  "Goal: Exit Route 4 East via EAST edge to Cerulean City (map3); catch new Pokemon for party diversity",
  "Goal: Return to Cerulean City center",
  "Goal: Walk east along Route 25",
  "Goal: Move to Route 24 grass patch",
  "Goal: Enter Cerulean Gym after prep",
];

// Durable facts that must NOT be detected as nav goals
const DURABLE_FACTS = [
  "Brock defeated, Boulder Badge earned",
  "TM19 at (22,2 on map36) on Route 25 is unreachable currently; ignore until later",
  "Mt Moon B2F - need Dome Fossil from Super Nerd at (13,6",
  "Dome Fossil is in bag,verify with inventory check",
  "Current party is 1 Pokemon (Pidgeot L31). Priority: Catch a Grass/Rock type on Route 24/25 to counter Misty's Water types.",
  "Current Goal is Cerulean City (map3",
  "Cerulean Gym requires Water counter before entry",
];

// S1: detector fires on every nav-goal string
for (const s of NAV_GOALS) {
  chk(`detect nav-goal: "${s.slice(0, 50)}..."`, isPositionStampedNavGoal(s), s);
}

// S2: detector does NOT fire on durable facts
for (const s of DURABLE_FACTS) {
  chk(`pass durable fact: "${s.slice(0, 50)}..."`, !isPositionStampedNavGoal(s), s);
}

// ── pinRaw downgrade ─────────────────────────────────────────────────────

// S3: a nav-goal pin is downgraded to rolling, not pinned
{
  const pad = new Notepad();
  const result = pad.note("PIN: Cerulean reached,map3 pos 19,8. Goal: Exit North to Route 24/25");
  chk("S3a nav-goal pin returns DOWNGRADED", /DOWNGRADED/i.test(result), result);
  chk("S3b nav-goal not in pinned", pad.pinned.length === 0, `pinned=${pad.pinned.length}`);
  chk("S3c nav-goal landed in rolling", pad.rolling.length === 1, `rolling=${pad.rolling.length}`);
}

// S4: a durable fact pin goes through normally
{
  const pad = new Notepad();
  const result = pad.note("PIN: Brock defeated, Boulder Badge earned");
  chk("S4a fact pin returns PINNED", /PINNED/i.test(result), result);
  chk("S4b fact in pinned", pad.pinned.length === 1);
  chk("S4c rolling stays empty", pad.rolling.length === 0);
}

// ── sweep ────────────────────────────────────────────────────────────────

// S5: sweep demotes stale position pins, keeps durable facts
{
  const pad = new Notepad();
  pad.pinned = [
    "Brock defeated, Boulder Badge earned",
    "Cerulean reached,map3 pos 19,8. Goal: Exit North to Route 24/25 to catch Grass/Rock",
    "TM19 at (22,2 on map36) on Route 25 is unreachable currently; ignore until later",
    "Goal: Head EAST on Route 4 to Cerulean City; heal at Center",
    "Current Goal is Cerulean City (map3",
    "Route 25 Map36 POS 19,3. Goal: Catch Grass/Rock type",
  ];
  const demoted = pad.sweepStalePositionPins();
  chk("S5a sweep demoted 3 nav-goal pins", demoted.length === 3, `demoted=${demoted.length}`);
  chk("S5b Brock pin survived", pad.pinned.some(p => /Brock/.test(p)));
  chk("S5c TM19 pin survived", pad.pinned.some(p => /TM19/.test(p)));
  chk("S5d Current Goal pin survived", pad.pinned.some(p => /Current Goal/.test(p)));
  chk("S5e rolling has DEMOTED corrections", pad.rolling.some(r => /DEMOTED/.test(r)));
  // idempotent
  const second = pad.sweepStalePositionPins();
  chk("S5f second sweep is no-op", second.length === 0);
}

// S6: pin() path also downgrades (not just note("PIN:..."))
{
  const pad = new Notepad();
  const result = pad.pin("Goal: Exit Mt Moon B2F west pocket via exit ladder at (5,7");
  chk("S6a pin() downgrades nav-goal", /DOWNGRADED/i.test(result), result);
  chk("S6b not pinned", pad.pinned.length === 0);
}

// ── summary ──────────────────────────────────────────────────────────────
console.log(`\n== ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} pass, ${fail} fail ==`);
process.exit(fail > 0 ? 1 : 0);
