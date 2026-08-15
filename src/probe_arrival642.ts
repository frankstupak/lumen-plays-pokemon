// wq#642 probe: stale "heading to X (mapN)" pins get RAM-verified and
// retired, the same way wq#519/531 verify possession pins.
//
// THE FIXTURE IS NOT INVENTED. PINS_LIVE is the exact pinned region captured
// from runtime/notepad.txt at 2026-08-15 ~14:04-14:10Z, live during this
// session's wq#638 deploy verification — the two "heading to Cerulean City
// (map3)" lines are what the brain's THINK text cited on turn 1
// (events/live-agent-1786803038916.jsonl) instead of the already-fixed
// CORRIDOR guidance, while standing at map3 (13,16). Same style as
// probe_claims.ts's PINS_LIVE: a captured transcript, not a synthetic guess.
import { Notepad, parseArrivalClaim, ArrivalClaim } from "./notepad";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

console.log("\n== A. the fixture is the real, captured pinned region ==");
const PINS_LIVE: string[] = [
  "Mt Moon B2F - need Dome Fossil from Super Nerd at (13,6",
  "Goal: Exit Mt Moon via Dome Fossil puzzle",
  "Dome Fossil acquired. Goal: Exit Mt Moon B2F west pocket via exit ladder at (5,7",
  "Goal is Cerulean City (map3",
  "Current Goal is Cerulean City (map3",
  "Cerulean City reached,map 3 pos 25,26. Goal: Route 24/25 grind for Misty badge prep. Party of 1,catch target priority.",
  "Dome Fossil is in bag,verify with inventory check",
  "Cerulean City reached,map 3 pos 31,26. Goal: Route 24/25 grind for Misty badge prep. Party of 1,catch target priority.",
  "Dome Fossil acquisition claim was false; current location is Route 4 East (map15) heading to Cerulean City (map3); priority is catching a Pokemon to expand party before gym",
  "Current location is Route 4 East (map15) heading to Cerulean City (map3); priority is catching a Pokemon to expand party before gym",
];
chk("fixture carries exactly two 'heading to ... (map3)' pins -- the observed live defect",
    PINS_LIVE.filter(p => /heading to .*\(map3\)/i.test(p)).length === 2, JSON.stringify(PINS_LIVE));
chk("fixture also carries pins that must NOT be misread as stale (no explicit mapN, or already-accurate snapshots)",
    PINS_LIVE.filter(p => parseArrivalClaim(p)).length === 2,
    `arrival-matched=${PINS_LIVE.filter(p => parseArrivalClaim(p)).length}`);

console.log("\n== B. parseArrivalClaim: extraction ==");
chk("extracts the target map id from a live pin",
    parseArrivalClaim("Current location is Route 4 East (map15) heading to Cerulean City (map3); priority is catching a Pokemon")?.targetMap === 3);
chk("extracts the target name too",
    parseArrivalClaim("heading to Cerulean City (map3)")?.targetName === "Cerulean City");
chk("matches the 'via EAST edge to X (mapN)' phrasing too",
    parseArrivalClaim("Goal: Exit Route 4 East via EAST edge to Cerulean City (map3); catch new Pokemon")?.targetMap === 3);
chk("a pin with no explicit (mapN) does not match -- cannot invent a target",
    parseArrivalClaim("Goal: Leave Route 4 East via EAST edge to Cerulean City") === null);
chk("a possession pin does not accidentally match",
    parseArrivalClaim("Dome Fossil is in bag, verify with inventory check") === null);
chk("non-arrival prose does not match",
    parseArrivalClaim("Cerulean City reached, map 3 pos 25,26. Goal: Route 24/25 grind for Misty badge prep.") === null);

console.log("\n== C. verifyClaims: drops only when RAM says arrived ==");
{
  const mk = () => { const p = new Notepad(); p.pinned = [...PINS_LIVE, "east exit ladder at (21,25)"]; return p; };

  const arrived = mk();
  const EXPECT_DROP = 2;   // exactly the two "heading to ... (map3)" lines
  arrived.arrivalChecker = (c: ArrivalClaim) =>
    ({ arrived: c.targetMap === 3, evidence: "current position is map3 (13,16)" });
  const rArr = arrived.verifyClaims();
  chk("stale 'heading to map3' pins dropped once RAM confirms arrival, nothing else touched",
      rArr.dropped.length === EXPECT_DROP, `dropped=${rArr.dropped.length} :: ${JSON.stringify(rArr.dropped)}`);
  chk("the rest of the pinned region -- including OTHER Cerulean-mentioning but non-'heading' lines -- survives",
      arrived.pinned.length === PINS_LIVE.length + 1 - EXPECT_DROP &&
      arrived.pinned.includes("east exit ladder at (21,25)"),
      JSON.stringify(arrived.pinned));
  chk("correction explains WHY and forbids the same confusion going forward",
      arrived.rolling.some(r => r.includes("already reached") && r.includes("map3") && r.includes("CURRENT position")),
      JSON.stringify(arrived.rolling).slice(0, 200));

  const notArrived = mk();
  notArrived.arrivalChecker = () => ({ arrived: false, evidence: "current position is map15 (30,10), still on Route 4" });
  const rNot = notArrived.verifyClaims();
  chk("pins kept while genuinely still en route", rNot.dropped.length === 0 && notArrived.pinned.length === PINS_LIVE.length + 1,
      `dropped=${rNot.dropped.length}`);

  const throwing = mk();
  throwing.arrivalChecker = () => { throw new Error("RAM read exploded"); };
  const rThrow = throwing.verifyClaims();
  chk("a throwing arrivalChecker drops nothing", rThrow.dropped.length === 0, `dropped=${rThrow.dropped.length}`);

  const none = mk();
  const rNone = none.verifyClaims();
  chk("no arrivalChecker installed = no-op for arrival pins", rNone.checked === 0 && none.pinned.length === PINS_LIVE.length + 1,
      `checked=${rNone.checked}`);
}

console.log("\n== D. possession and arrival checkers coexist without cross-talk ==");
{
  const pad = new Notepad();
  pad.pinned = ["Dome Fossil confirmed in inventory", "heading to Cerulean City (map3)"];
  pad.claimChecker = (c) => c.subject === "dome fossil" ? { holds: false, evidence: "bag empty" } : null;
  pad.arrivalChecker = (c) => ({ arrived: c.targetMap === 3, evidence: "map3" });
  const r = pad.verifyClaims();
  chk("both the false possession pin and the stale arrival pin are dropped, nothing double-counted",
      r.dropped.length === 2 && r.checked === 2 && pad.pinned.length === 0,
      `dropped=${r.dropped.length} checked=${r.checked}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
