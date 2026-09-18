// wq#1090 probe — the retry ceiling counts nav GUARD REFUSALS, and still lets
// the two self-limiting gates spend their own budgets.
//
// THE DEFECT: ceiling.ts's verifyFailed() only ever looked for " -> stuck",
// "bad index" and "bad direction" on goto/enter_warp/leave_edge, on the stated
// grounds that "a guard refusal is NOT a verify failure and never counts".
// That was written when wq#674's just-arrived-door guard needed EXACT-tile
// re-entry to fire. wq#1086 widened it to match the warp's identity, so it now
// catches the doors that land you adjacent too — and a confused brain trips it
// constantly. Live (events/live-agent-1787956303157.jsonl, turns 17-45, on the
// mistral-small fallback): enter_warp on the door it had just arrived through,
// at map88, map64, map3 and one more inside ~8 minutes. Every one correctly
// refused, ZERO bounces — and ActionCeiling.record() never incremented once,
// so no number of repeats could ever trip the ceiling. That run kept landing
// somewhere new, which re-arms the ceiling anyway, so nothing wedged; a tile
// whose only legal move IS the door back has no such luck.
//
// GREEN CONTRACT (this branch):
//   1. the wq#1086 refusal, replayed verbatim from one tile, TRIPS at CEILING
//      and is then refused verbatim by check() — the loop the ticket describes;
//   2. so do the other unbudgeted nav guards, including scope.ts's two, which
//      now open with "refused - " like the rest;
//   3. the exploration exclusion and the loss gate do NOT count: they lift BY
//      being refused, and their lines say so (REFUSAL_BUDGET_PHRASE);
//   4. nothing that used to count stopped counting, and no success counts.
// PURE: ceiling.ts, scope.ts and exclusion.ts only — no emulator (probes-pure).
import { verifyFailed, ActionCeiling, CEILING, REFUSAL_BUDGET_PHRASE } from "./ceiling";
import { crossMapRefusal, edgeRefusal } from "./scope";
import { exclusionRefusal, Exclusion, EXCLUSION_MAX_FIRES } from "./exclusion";
import { assess } from "./oscillation";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// The live result strings, verbatim from the executors that build them.
// agent.ts:1015 — the wq#674/wq#1086 just-arrived-door guard, the one the
// ticket's eight live minutes are made of.
const DOOR = "enter_warp: refused - this is the door you just arrived through and you " +
  "have not moved since. Firing it again replays your OWN arrival and sends you " +
  "right back out. goto() a DIFFERENT tile first to actually go somewhere (wq#674, wq#1086).";
// agent.ts:68 mtMoonReentryRefusal, prefixed by its dispatch site.
const MTMOON = "goto: refused - (24,5) warps back into Mt Moon (map59) and you are PAST the cave.";
// agent.ts:971, the wq#724 supervisor map ban.
const BAN = "enter_warp: refused — CeruleanGym (map65) is BANNED by the stuck supervisor " +
  "(navigation loop detected).";
// guidance.ts:255 mistyGymEntryRefusal.
const MISTY = "enter_warp: refused - not ready for MISTY (party of 1 < 2). A Fire-type party has no winning line";

// ---- A. the ticket's loop: the wq#1086 refusal now reaches the counter ----
ok("A1 the just-arrived-door refusal counts as a verify failure",
   verifyFailed("enter_warp", DOOR));
{
  const c = new ActionCeiling();
  const p = { map: 88, x: 4, y: 7 };
  const tripped: boolean[] = [];
  for (let i = 0; i < CEILING; i++) tripped.push(c.record("enter_warp", "0", p, DOOR));
  ok(`A2 no trip before ${CEILING} identical refusals`,
     tripped.slice(0, CEILING - 1).every(t => !t), JSON.stringify(tripped));
  ok(`A3 TRIPS on refusal #${CEILING}`, tripped[CEILING - 1] === true);
  const ref = c.check("enter_warp", "0", p);
  ok("A4 the 4th attempt is refused verbatim by the ceiling",
     !!ref && ref.startsWith("retry_ceiling:"), ref ?? "null");
  ok("A5 one step away re-arms it — the live run's only reprieve",
     c.check("enter_warp", "0", { map: 88, x: 4, y: 8 }) === null);
}

// ---- B. the other unbudgeted nav guards count too ----
ok("B1 Mt Moon re-entry refusal counts", verifyFailed("goto", MTMOON));
ok("B2 supervisor map ban counts (em dash form)", verifyFailed("enter_warp", BAN));
ok("B3 Misty gate refusal counts", verifyFailed("enter_warp", MISTY));
{
  // scope.ts's two, built live rather than pasted: wq#1090 gave them the same
  // "refused - " opening as every other guard, which is what makes them visible
  // here without ceiling.ts having to match their prose.
  const xmap = crossMapRefusal({ m: 67, x: 4, y: 7 }, 3, id => (id === 67 ? "CeruleanMart" : null));
  ok("B4 cross-map goto refusal counts", !!xmap && verifyFailed("goto", `goto: ${xmap}`), xmap ?? "null");
  const interior = edgeRefusal(0, "E", [{ x: 3, y: 7, destMap: 3 }], 67, "CeruleanMart");
  ok("B5 interior leave_edge refusal counts",
     !!interior && verifyFailed("leave_edge", `leave_edge: ${interior}`), interior ?? "null");
  const noConn = edgeRefusal(1 /* E only */, "N", [], 15, null);
  ok("B6 missing-connection leave_edge refusal counts",
     !!noConn && verifyFailed("leave_edge", `leave_edge: ${noConn}`), noConn ?? "null");
}

// ---- C. the budgeted gates are exempt: they lift BY being refused ----
{
  const e: Exclusion = {
    v: 2, tiles: ["3:5:5", "3:5:6"], map: 3, fromSeq: 10, untilSeq: 40,
    fromFire: 3, fires: 2, iso: "2026-09-18T00:00:00.000Z",
  };
  const line = exclusionRefusal(e, 20, 5, 5, "CeruleanCity");
  ok("C1 the exclusion line still says 'refused' and still shows its budget",
     line.includes("refused") && line.includes(REFUSAL_BUDGET_PHRASE) &&
     line.includes(String(EXCLUSION_MAX_FIRES - e.fires)), line.slice(0, 90));
  ok("C2 ...and so does NOT count — ceiling-ing it would starve that budget",
     !verifyFailed("goto", `goto: ${line}`));
}
{
  // guidance.ts:274 engagementGateLine. Pasted, not imported: guidance.ts pulls
  // in items.ts -> emulator.ts, and probes-pure has no native binding (wq#1090
  // ISSUE-LOG 56). probe_ledger1181 is the probe that asserts the builder; what
  // matters here is only that its budget phrase exempts it, and C1 proves the
  // phrase is the shared constant rather than a coincidence.
  const gate = "enter_warp: refused - LOSS GATE on CeruleanGym (map65): lost here 12 min ago. " +
    `Re-entry opens when party levelSum reaches 48 (+6 from the loss), or automatically in ` +
    `41 min, or after 7 ${REFUSAL_BUDGET_PHRASE}. GRIND first, heal, then come back.`;
  ok("C3 the loss gate does not count either", !verifyFailed("enter_warp", gate));
  const c = new ActionCeiling();
  const p = { map: 3, x: 30, y: 19 };
  ok("C4 ...and never trips, however many times it fires",
     [...Array(12)].every(() => !c.record("enter_warp", "1", p, gate)) &&
     c.check("enter_warp", "1", p) === null);
}

// ---- D. nothing that used to count stopped, and no success counts ----
ok("D1 goto stuck still counts", verifyFailed("goto", 'goto -> stuck now {"map":3,"x":25,"y":26}'));
ok("D2 bad index still counts", verifyFailed("enter_warp", "enter_warp: bad index"));
ok("D3 bad direction still counts", verifyFailed("leave_edge", "leave_edge: bad direction (N|S|E|W)"));
ok("D4 a warp that happened is not a failure",
   !verifyFailed("enter_warp", 'enter_warp -> warped now {"map":64,"x":3,"y":7}'));
ok("D5 an arrival is not a failure",
   !verifyFailed("goto", 'goto -> arrived now {"map":3,"x":20,"y":30}'));
ok("D6 an edge crossing is not a failure",
   !verifyFailed("leave_edge", 'leave_edge -> moved now {"map":36,"x":10,"y":2}'));
ok("D7 a goto the harness will resume is not a failure",
   !verifyFailed("goto", "goto interrupted by a wild battle - the harness will flee it and resume this goto automatically"));
ok("D8 dialog-blocked is not a failure",
   !verifyFailed("goto", "goto blocked: a dialog or sign text is open - use talk() to clear it first"));
ok("D9 arrival-adjacent to an NPC is not a failure",
   !verifyFailed("goto", "goto: (4,7) is occupied by an NPC standing on it, so you cannot stand there."));
ok("D10 dialog tools still repeat freely",
   !verifyFailed("talk", "talk: refused - anything at all"));
{
  // The one long string wq#1090's new "refused" match could have collided with:
  // a SUCCESSFUL warp carries the oscillation LOOP NOTICE appended to it
  // (agent.ts:1044). Built from the real assess(), not paraphrased, so a
  // reworded notice that ever grows the word "refused" fails here first.
  const v = assess(88, [88, 36, 88, 36, 88, 36, 88, 36, 88, 36, 88, 36], []);
  const warped = `enter_warp -> warped now {"map":88,"x":4,"y":7}${v.message}`;
  ok("D11 a LOOP NOTICE on a successful warp is still not a failure",
     v.trip && !verifyFailed("enter_warp", warped), `trip=${v.trip} rule=${v.rule}`);
}

// ---- E. a refusal followed by a success clears the key ----
{
  const c = new ActionCeiling();
  const p = { map: 88, x: 4, y: 7 };
  c.record("enter_warp", "0", p, DOOR);
  c.record("enter_warp", "0", p, DOOR);
  ok("E1 a success resets the count",
     !c.record("enter_warp", "0", p, 'enter_warp -> warped now {"map":36,"x":1,"y":1}'));
  ok("E2 ...so the next two refusals do not trip",
     !c.record("enter_warp", "0", p, DOOR) && !c.record("enter_warp", "0", p, DOOR));
}

console.log(`\nprobe_ceiling1090: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
