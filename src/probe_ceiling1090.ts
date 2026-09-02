// wq#1090 acceptance: the retry ceiling counts nav GUARD REFUSALS, not just
// failed verifies.
//
// THE GAP, measured live (events/live-agent-1787956303157.jsonl, turns 17-45,
// right after wq#1086 deployed): the brain issued enter_warp on the door it had
// just arrived through across FOUR maps in ~8 minutes. wq#1086's widened guard
// correctly refused every one — zero actual bounces — but the refusals were
// REFUSED, not FAILED-VERIFY, so ActionCeiling.record() never incremented and
// the ceiling could not have tripped no matter how long the pattern ran. That
// run happened to land somewhere NEW each time (a position change re-arms the
// ceiling anyway), so nothing wedged; a route where the just-arrived door is
// the only legal move from that tile would have repeated forever.
//
// RED IS IN-PROBE: OLD_navVerifyFailed below is the pre-wq#1090 nav clause of
// verifyFailed(), copied byte-for-byte from ceiling.ts. Section A drives BOTH
// predicates over the same live strings, so "the old path could not see this"
// is demonstrated here rather than remembered.
//
// PURE: no emulator, no ROM, no I/O — ceiling.ts is pure, so this probe runs in
// the CI-safe subset (scripts/probes-pure.sh).
import { verifyFailed, ActionCeiling, CEILING } from "./ceiling";
import { GATE_MAX_FIRES } from "./ledger";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

/** The nav clause of verifyFailed() exactly as it stood before wq#1090. */
const OLD_navVerifyFailed = (result: string): boolean =>
  / -> stuck\b/.test(result) || result.includes("bad index") ||
  result.includes("bad direction");

// The strings agent.ts::dispatchInner actually returns, copied from their call
// sites so a reworded guard fails this probe instead of silently un-counting.
const DOOR_BOUNCE =                                                   // agent.ts wq#1086
  "enter_warp: refused - this is the door you just arrived through and you have not " +
  "moved since. Firing it again replays your OWN arrival and sends you right back out. " +
  "goto() a DIFFERENT tile first to actually go somewhere (wq#674, wq#1086).";
const SUPERVISOR_BAN =                                                // agent.ts wq#724
  "enter_warp: refused — Route25 (map36) is BANNED by the stuck supervisor (navigation " +
  "loop detected). Pick a different destination or pursue a different objective. The ban " +
  "lifts when story progress advances.";
const CROSS_MAP = "goto: target (4,7) is on map67, you are on map3";   // agent.ts wq#606
const INTERIOR_EDGE =                                                 // agent.ts wq#606
  "leave_edge: map67 is an INTERIOR — no edge connections exist";
const BAD_ARGS = "goto: bad args — use goto(x,y) for a tile on YOUR CURRENT map, " +
  "or goto(map,x,y) to name the map explicitly";
const BAD_INDEX = "enter_warp: bad index";
const BAD_DIR = "leave_edge: bad direction (N|S|E|W)";
const NPC_ON_TILE =                                                   // agent.ts wq#583
  'goto: (4,7) is occupied by an NPC standing on it, so you cannot stand there.' +
  ' You are now ADJACENT at {"map":3,"x":4,"y":8} - talk() or interact if you meant' +
  ' that NPC, or pick a different destination tile.';
const THROWN = "tool error: Cannot read properties of undefined";     // dispatchInner catch
// guidance.ts::engagementGateLine, pasted rather than called: guidance.ts
// imports items.ts -> emulator.ts, and CI has no emulator binding. Keeping this
// probe import-pure is what lets it run in scripts/probes-pure.sh; the wording
// is re-asserted against the live builder by probe_ledger1181.
const LOSS_GATE = "enter_warp: refused - LOSS GATE on CeruleanGym (map65): lost to Misty. " +
  "Re-entry opens when party levelSum reaches 42 (+6 from the loss), or automatically in " +
  "20 min, or after 7 more refusals. Losing the same fight again costs half your money and " +
  "respawns you at the centre - GRIND first (route grass and trainers near here), heal, " +
  "then come back.";

const STUCK = 'goto -> stuck now {"map":3,"x":25,"y":26} — the tiles north are ledges';
const ARRIVED = 'goto -> arrived now {"map":3,"x":25,"y":26}';
const MOVED = 'leave_edge -> moved now {"map":15,"x":9,"y":1}';
const WARPED = 'enter_warp -> warped now {"map":88,"x":5,"y":6}';
const BATTLE = "enter_warp interrupted by a wild battle - the harness will flee it " +
  "and resume this warp automatically";
const DIALOG = "goto blocked: a dialog or sign text is open - use talk() to clear it first";

// ── A. RED: the old predicate is blind to every refusal ────────────────────
{
  const refusals: [string, string][] = [
    ["wq#1086 door bounce", DOOR_BOUNCE], ["wq#724 supervisor ban", SUPERVISOR_BAN],
    ["wq#606 cross-map", CROSS_MAP], ["wq#606 interior edge", INTERIOR_EDGE],
    ["bad args", BAD_ARGS], ["NPC on target tile", NPC_ON_TILE], ["thrown error", THROWN],
  ];
  for (const [name, s] of refusals) {
    chk(`A RED old predicate misses ${name}`, !OLD_navVerifyFailed(s));
    chk(`A GREEN ${name} counts`, verifyFailed("enter_warp", s) && verifyFailed("goto", s));
  }
  chk("A RED old predicate misses wq#1181 loss gate", !OLD_navVerifyFailed(LOSS_GATE));
  chk("A GREEN wq#1181 loss gate counts", verifyFailed("enter_warp", LOSS_GATE));
}

// ── B. What must still NOT count ───────────────────────────────────────────
for (const [name, s] of [["arrived", ARRIVED], ["moved", MOVED], ["warped", WARPED],
                         ["battle interrupt", BATTLE], ["open dialog", DIALOG]] as const) {
  chk(`B ${name} does not count`, !verifyFailed("goto", s) &&
      !verifyFailed("enter_warp", s) && !verifyFailed("leave_edge", s));
}
chk("B stuck still counts", verifyFailed("goto", STUCK) && OLD_navVerifyFailed(STUCK));
chk("B bad index still counts", verifyFailed("enter_warp", BAD_INDEX));
chk("B bad direction still counts", verifyFailed("leave_edge", BAD_DIR));
chk("B dialog/battle tools still exempt wholesale",
    !verifyFailed("talk", DOOR_BOUNCE) && !verifyFailed("battle_move", STUCK));
// A refusal is only a refusal for the tool that emitted it; the switch is keyed
// by tool, so a nav string handed to a non-nav tool must not leak through.
chk("B non-nav tools unaffected by the widening", !verifyFailed("press", DOOR_BOUNCE));

// ── C. The live loop, now ceilinged ────────────────────────────────────────
{
  const door = { map: 88, x: 5, y: 6 };
  const c = new ActionCeiling();
  chk("C no trip at 1", !c.record("enter_warp", "0", door, DOOR_BOUNCE));
  chk("C no trip at 2", !c.record("enter_warp", "0", door, DOOR_BOUNCE));
  chk(`C TRIP at ${CEILING}`, c.record("enter_warp", "0", door, DOOR_BOUNCE));
  const ref = c.check("enter_warp", "0", door);
  chk("C refused verbatim after the trip", !!ref && ref.startsWith("retry_ceiling:"), ref ?? "null");
  chk("C a different door is not refused", c.check("enter_warp", "1", door) === null);
  chk("C one tile of movement re-arms", c.check("enter_warp", "0", { ...door, x: 6 }) === null);
}
{
  // The live run itself: four refusals, each from a NEW tile. Position re-arms,
  // so this correctly does NOT trip — the gap was never that this run wedged.
  const c = new ActionCeiling();
  const tripped = [88, 64, 3, 36].map((map, i) =>
    c.record("enter_warp", "0", { map, x: 5 + i, y: 6 }, DOOR_BOUNCE));
  chk("C the live four-map run still does not trip (position re-arms)",
      tripped.every(t => !t));
}
{
  // Interleaving a note does not refill the budget, same as wq#606's buy burn.
  const c = new ActionCeiling();
  const p = { map: 88, x: 5, y: 6 };
  c.record("enter_warp", "0", p, DOOR_BOUNCE);
  c.record("note", "trying the door again", p, "note saved");
  c.record("enter_warp", "0", p, DOOR_BOUNCE);
  chk("C interleaved note does not refill the budget",
      c.record("enter_warp", "0", p, DOOR_BOUNCE));
}
{
  // A refusal that gives way to a real warp clears the count — the guard is
  // transient (it lifts the moment the brain takes a step), so a brain that
  // takes the hint must not carry a grudge into its next attempt.
  const c = new ActionCeiling();
  const p = { map: 88, x: 5, y: 6 };
  c.record("enter_warp", "0", p, DOOR_BOUNCE);
  c.record("enter_warp", "0", p, DOOR_BOUNCE);
  c.record("enter_warp", "0", p, WARPED);
  chk("C a success resets the refusal count", !c.record("enter_warp", "0", p, DOOR_BOUNCE));
}

// ── D. The deliberate interaction with the wq#1181 gate's anti-wedge cap ───
// The gate lifts on its own after GATE_MAX_FIRES refusals, and the ceiling now
// front-runs that for a STATIONARY brain: check() refuses before dispatch, so
// noteFire() stops accruing at CEILING. Documented in ceiling.ts's header as
// the trade we want (3 wasted turns beats 10); asserted here so nobody has to
// rediscover it from a live wedge.
{
  chk("D ceiling trips before the gate's own cap", CEILING < GATE_MAX_FIRES,
      `CEILING=${CEILING} GATE_MAX_FIRES=${GATE_MAX_FIRES}`);
  const c = new ActionCeiling();
  const p = { map: 3, x: 30, y: 19 };
  let fires = 0;
  for (let i = 0; i < GATE_MAX_FIRES; i++) {
    if (c.check("enter_warp", "3", p)) break;      // refused before dispatch: no fire
    fires++;
    c.record("enter_warp", "3", p, LOSS_GATE);
  }
  chk("D a stationary brain stops feeding the gate at the ceiling",
      fires === CEILING, `fires=${fires}`);
  // ...and moving re-arms, so the gate's fire path still gets there for a brain
  // that does what the refusal told it to do.
  chk("D moving re-arms, so the fire path still accrues",
      c.check("enter_warp", "3", { ...p, x: 31 }) === null);
}

console.log(`\nprobe_ceiling1090: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
