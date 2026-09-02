// wq#1181 acceptance (roadmap item 6): the loss ledger records a fight, gates
// re-entry into the map it was lost on, and — the property this whole ticket
// hangs on — EVERY gate expires. wq#517 shipped a guard that could not lift and
// wedged the campaign on the map it had banned; this probe walks all four
// expiries plus the win-clears-it path, because "it expires" is the acceptance
// criterion, not a nice-to-have.
//
// TEST ISOLATION IS LOAD-BEARING (same lesson, same shape as probe_novelty1179).
// ledger.ts persists to runtime/fight_ledger.json under process.cwd(), which in
// production is the LIVE deployment. Writing synthetic losses there would gate
// the running agent out of real maps. ledgerFile() resolves the env override at
// CONSTRUCTION time, so setting it before the first FightLedger exists is
// enough — ESM hoists the imports above these assignments, which is fine
// because no ledger is constructed until the first statement below runs.
const TAG = `${process.pid}-${Date.now()}`;
process.env.LPP_FIGHT_LEDGER = `/tmp/ledger1181-${TAG}.json`;

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import {
  FightLedger, FightRecord, GateCtx, gateLift, grindJustified, fightKey, ledgerFile,
  loadLedger, GATE_LEVEL_RISE, GATE_TTL_MS, GATE_MAX_FIRES, KEEP_RECORDS,
  GRIND_WINDOW_TURNS, GRIND_MIN_LEVEL_GAIN, LIFT_RENDERS,
} from "./ledger";
import { engagementGateLine, grindPressure, gateLiftedLine } from "./guidance";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const T0 = 1_800_000_000_000;          // fixed epoch: no wall-clock flake
const MISTY = { opponent: 218, trainerNo: 1, map: 65 };   // gym leader class, Cerulean Gym

const loss = (o: Partial<FightRecord> = {}): FightRecord => ({
  ts: T0, turn: 100, outcome: "loss", ...MISTY, levelSum: 30, badges: 1, ...o,
});
const ctx = (o: Partial<GateCtx> = {}): GateCtx => ({ levelSum: 30, now: T0 + 1000, ...o });
const clean = () => { try { if (existsSync(ledgerFile())) unlinkSync(ledgerFile()); } catch {} };

// ------------------------------------------------- A. record and gate
console.log("=== A. a loss gates re-entry into the map it was lost on ===");
{
  clean();
  const l = new FightLedger({});
  chk("A1 an empty ledger blocks nothing", !l.gateForMap(65, ctx()).blocked);
  l.record(loss());
  const d = l.gateForMap(65, ctx());
  chk("A2 the map is gated after the loss", d.blocked, d.reason);
  chk("A3 the gate names its key", d.key === fightKey(218, 1, 65), String(d.key));
  chk("A4 an unrelated map is untouched", !l.gateForMap(3, ctx()).blocked);
  chk("A5 the exact fight is gated too", l.gateFor(218, 1, 65, ctx()).blocked);
  chk("A6 a different trainer on the same map is not gated by identity",
      !l.gateFor(218, 2, 65, ctx()).blocked);
  // The map gate is deliberately WIDER than the identity gate: enter_warp knows
  // a destination map, not which trainer stands behind the door.
  chk("A7 but the MAP gate still covers the door", l.gateForMap(65, ctx()).blocked);
  chk("A8 the decision states every exit it has",
      d.needLevelSum === 30 + GATE_LEVEL_RISE && (d.msLeft ?? 0) > 0 &&
      d.firesLeft === GATE_MAX_FIRES,
      JSON.stringify({ need: d.needLevelSum, ms: d.msLeft, fires: d.firesLeft }));
}

// ------------------------------------------------- B. every expiry
console.log("\n=== B. EVERY gate expires (the wq#517 lesson) ===");
{
  const g = { key: "k", map: 65, opponent: 218, trainerNo: 1,
              lossTs: T0, lossLevelSum: 30, losses: 1, fires: 0 };
  chk("B1 a fresh gate is live", gateLift(g, ctx()) === null);
  chk("B2 EXIT 1 - levelSum rose by the required amount",
      gateLift(g, ctx({ levelSum: 30 + GATE_LEVEL_RISE })) !== null);
  chk("B3 one level short does NOT lift it",
      gateLift(g, ctx({ levelSum: 30 + GATE_LEVEL_RISE - 1 })) === null);
  chk("B4 EXIT 2 - wall clock TTL",
      gateLift(g, ctx({ now: T0 + GATE_TTL_MS })) !== null);
  chk("B5 EXIT 3 - a pre-engagement estimate of WINNABLE",
      gateLift(g, ctx({ estimate: "WINNABLE" })) !== null);
  chk("B6 a worse estimate does not lift it",
      gateLift(g, ctx({ estimate: "UNWINNABLE" })) === null &&
      gateLift(g, ctx({ estimate: "CLOSE" })) === null &&
      gateLift(g, ctx({ estimate: "UNKNOWN" })) === null);
  chk("B7 EXIT 4 - the anti-wedge fire cap",
      gateLift({ ...g, fires: GATE_MAX_FIRES }, ctx()) !== null);
  chk("B8 no ctx produces a gate with no exit at all",
      [ctx({ levelSum: 999 }), ctx({ now: T0 + GATE_TTL_MS * 2 }),
       ctx({ estimate: "WINNABLE" })].every(c => gateLift(g, c) !== null));
}

// ------------------------------------------------- C. expiry through the ledger
console.log("\n=== C. the live ledger honours each expiry and says so ===");
{
  clean();
  const seen: any[] = [];
  const bus = { emit: (kind: any, d: object) => seen.push({ kind, ...d }) };
  const l = new FightLedger({ bus });
  l.record(loss());
  chk("C1 the loss is on the bus",
      seen.some(e => e.kind === "fight_ledger" && e.event === "loss" && e.gated === true));
  chk("C2 gated at the loss levelSum", l.gateForMap(65, ctx()).blocked);
  const lifted = l.gateForMap(65, ctx({ levelSum: 33 }));
  chk("C3 levelSum +3 lifts it", !lifted.blocked && !!lifted.lifted, JSON.stringify(lifted));
  chk("C4 the lift is on the bus",
      seen.some(e => e.event === "gate_lifted" && /levelSum rose/.test(String(e.reason))));
  chk("C5 the lift is durable - it does not come back at the old levelSum",
      !l.gateForMap(65, ctx()).blocked);

  clean();
  const l2 = new FightLedger({});
  l2.record(loss());
  chk("C6 TTL lifts it", !l2.gateForMap(65, ctx({ now: T0 + GATE_TTL_MS + 1 })).blocked);

  clean();
  const l3 = new FightLedger({});
  l3.record(loss());
  chk("C7 a WINNABLE estimate lifts it",
      !l3.gateForMap(65, ctx({ estimate: "WINNABLE" })).blocked);

  clean();
  const l4 = new FightLedger({ bus });
  l4.record(loss());
  // The fire cap is what stops a WRONG gate from wedging the run: the gate is
  // allowed to argue GATE_MAX_FIRES times and then it gives up on its own.
  for (let i = 0; i < GATE_MAX_FIRES; i++) {
    const d = l4.gateForMap(65, ctx());
    if (d.blocked && d.key) l4.noteFire(d.key);
  }
  const after = l4.gateForMap(65, ctx());
  chk("C8 the gate lifts itself after GATE_MAX_FIRES refusals", !after.blocked,
      JSON.stringify(after));
  chk("C9 and the run is not wedged: entry is allowed from here on",
      !l4.gateForMap(65, ctx()).blocked && !l4.gateForMap(65, ctx({ levelSum: 1 })).blocked);
  chk("C10 the anti-wedge lift is on the bus",
      seen.some(e => e.event === "gate_lifted" && /anti-wedge/.test(String(e.reason))));

  clean();
  const l5 = new FightLedger({});
  l5.record(loss());
  l5.record(loss({ outcome: "win", ts: T0 + 60_000 }));
  chk("C11 winning the fight clears its gate outright", !l5.gateForMap(65, ctx()).blocked);
}

// ------------------------------------------------- D. persistence
console.log("\n=== D. the gate survives the reboot the loop it catches spans ===");
{
  clean();
  const a = new FightLedger({});
  a.record(loss());
  a.record(loss({ ts: T0 + 1000, levelSum: 31 }));
  // A white-out exits the process (live_agent exit 3 -> systemd restart), so a
  // gate that only lived in memory would be gone exactly when it is needed.
  const b = new FightLedger({});
  chk("D1 gates survive a restart", b.gateForMap(65, ctx({ levelSum: 31 })).blocked);
  chk("D2 repeat losses are counted", /lost here 2x/.test(b.gateForMap(65, ctx({ levelSum: 31 })).reason));
  chk("D3 the newest loss sets the level target",
      b.gateForMap(65, ctx({ levelSum: 31 })).needLevelSum === 31 + GATE_LEVEL_RISE);
  chk("D4 a fresh loss restarts the fire budget",
      b.gateForMap(65, ctx({ levelSum: 31 })).firesLeft === GATE_MAX_FIRES);
  chk("D5 both records are on disk", b.records().length === 2);

  clean();
  const c = new FightLedger({});
  for (let i = 0; i < KEEP_RECORDS + 30; i++) c.record(loss({ ts: T0 + i, outcome: "win", trainerNo: i }));
  chk("D6 the record log stays bounded", c.records().length === KEEP_RECORDS,
      String(c.records().length));
}

// ------------------------------------------------- E. fail-closed
console.log("\n=== E. fail-closed: bookkeeping never breaks a turn ===");
{
  clean();
  writeFileSync(ledgerFile(), "{not json");
  let threw = "";
  let l: FightLedger | null = null;
  try { l = new FightLedger({}); l.record(loss()); } catch (e: any) { threw = String(e?.message ?? e); }
  chk("E1 a corrupt ledger loads as empty and still records", threw === "" && l!.records().length === 1, threw);
  chk("E2 a corrupt file blocks nothing on load", loadLedger("/tmp/does-not-exist-1181").records.length === 0);

  // An unwritable path must not stop a gate from being decided. Same blocker
  // trick as probe_novelty1179 (a FILE where a directory must be -> ENOTDIR),
  // and it stays inside /tmp so the probe never trips a permission gate.
  const blocker = `/tmp/ledger1181-blocker-${TAG}`;
  writeFileSync(blocker, "not a directory");
  process.env.LPP_FIGHT_LEDGER = `${blocker}/ledger.json`;
  let d: any = null;
  try {
    const u = new FightLedger({});
    u.record(loss());
    d = u.gateForMap(65, ctx());
  } catch (e: any) { threw = String(e?.message ?? e); }
  chk("E3 an unwritable ledger still gates in memory", threw === "" && d?.blocked === true, threw);
  process.env.LPP_FIGHT_LEDGER = `/tmp/ledger1181-${TAG}.json`;
  try { unlinkSync(blocker); } catch {}
  let fired = "";
  try { new FightLedger({}).noteFire("no-such-key"); } catch (e: any) { fired = String(e?.message ?? e); }
  chk("E4 noteFire on an unknown key is a no-op", fired === "", fired);
}

// ------------------------------------------------- F. grind governor
console.log("\n=== F. grind governor: grinding is a justified state, not a default ===");
{
  const flat = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, levelSum: 30 }));
  const rising = (n: number) => Array.from({ length: n }, (_, i) =>
    ({ seq: i + 1, levelSum: 30 + Math.floor(i / 10) }));

  const partial = grindJustified(flat(GRIND_WINDOW_TURNS - 1), { gated: true });
  chk("F1 a partial window is justified by construction", partial.justified, partial.reason);
  const stalled = grindJustified(flat(GRIND_WINDOW_TURNS), { gated: true });
  chk("F2 a full window with no levels is NOT justified", !stalled.justified, stalled.reason);
  chk("F3 and says the rate collapsed", /stopped paying/.test(stalled.reason));
  const paying = grindJustified(rising(GRIND_WINDOW_TURNS), { gated: true });
  chk("F4 a grind that is paying stays justified", paying.justified, paying.reason);
  chk("F5 the gain is reported", paying.gain >= GRIND_MIN_LEVEL_GAIN, String(paying.gain));
  const done = grindJustified(rising(GRIND_WINDOW_TURNS), { gated: false, estimate: "WINNABLE" });
  chk("F6 a WINNABLE estimate ends the grind even while it is paying",
      !done.justified && /no longer justified/.test(done.reason), done.reason);
  chk("F7 a WINNABLE estimate does NOT end a grind the gate still holds",
      grindJustified(rising(GRIND_WINDOW_TURNS), { gated: true, estimate: "WINNABLE" }).justified);
  chk("F8 an empty sample log is justified, not condemned",
      grindJustified([], { gated: true }).justified);
}

// ------------------------------------------------- G. the prose the brain reads
console.log("\n=== G. every refusal states its exits (a rule with no exit wedges) ===");
{
  clean();
  const l = new FightLedger({});
  l.record(loss());
  const d = l.gateForMap(65, ctx());
  const line = engagementGateLine(d, "CERULEAN GYM (map65)");
  chk("G1 the refusal names the place", /CERULEAN GYM \(map65\)/.test(line));
  chk("G2 it states the level exit", new RegExp(`levelSum reaches ${33}`).test(line), line);
  chk("G3 it states the clock exit", /automatically in \d+ min/.test(line));
  chk("G4 it states the give-up exit", /after \d+ more refusals/.test(line));
  chk("G5 it says what to do instead", /GRIND first/.test(line));

  const g = grindJustified(Array.from({ length: GRIND_WINDOW_TURNS }, (_, i) =>
    ({ seq: i + 1, levelSum: 30 })), { gated: true });
  chk("G6 no pressure while the grind is justified",
      grindPressure({ ...g, justified: true }, 30, "obj") === null);
  chk("G7 pressure escalates with how long it has been unjustified",
      !/^!/.test(grindPressure(g, 1, "obj")!) &&
      /^! /.test(grindPressure(g, 10, "obj")!) &&
      /^!! /.test(grindPressure(g, 20, "obj")!));
  chk("G8 the pressure line carries the objective",
      /obj/.test(grindPressure(g, 5, "obj")!));

  // The lift has to be ANNOUNCED: the failure this item exists for is an agent
  // that kept grinding long after the reason had gone.
  const l2 = new FightLedger({});
  chk("G9 no lift to report before one happens", l2.recentLift() === null);
  l2.record(loss());
  l2.gateForMap(65, ctx({ levelSum: 99 }));
  const lift = l2.recentLift();
  chk("G10 the lift is available to render", !!lift && lift.map === 65);
  chk("G11 the lifted line tells the agent to stop grinding",
      /Stop grinding/.test(gateLiftedLine("map65", lift!.reason)));
  let renders = 1;
  while (l2.recentLift()) renders++;
  chk("G12 the lift line is bounded, not wallpaper", renders === LIFT_RENDERS,
      `${renders} renders`);
  clean();
}

console.log(`\nprobe_ledger1181: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
