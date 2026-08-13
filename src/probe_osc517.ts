// wq#517 acceptance: the loop guard measures REAL warp arrivals, fires on the
// wide loop the old rule missed, survives restarts, and never claims a direction.
//
// TEST ISOLATION IS LOAD-BEARING HERE. oscillation.ts persists to
// runtime/warp_history.json under process.cwd(), which in production is the live
// deployment. A probe that did not redirect LPP_OSC_HISTORY would inject fake map
// ids into the running agent's cross-run history and could make the live guard
// fire on maps the agent never visited. The env override is set before any import
// of oscillation.ts is used.
process.env.LPP_OSC_HISTORY = `/tmp/osc517-${process.pid}-${Date.now()}.json`;

import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { assess, historyFile, loadHistory, saveHistory,
         WITHIN_WINDOW, WITHIN_COUNT, CROSS_WINDOW, CROSS_COUNT } from "./oscillation";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

/** Replay a warp sequence through the pure rule, within-run only. */
function replayWithin(seq: number[]) {
  const hist: number[] = [];
  const trips: number[] = [];
  for (const m of seq) {
    hist.push(m);
    const v = assess(m, hist, []);
    if (v.trip) trips.push(m);
  }
  return trips;
}

// -------------------------------------------------- A. the rule itself
console.log("=== A. the widened within-run rule ===");
{
  // The old rule, reimplemented here so the difference is asserted rather than
  // remembered.
  const oldRule = (hist: number[], m: number) => {
    const recent = hist.slice(-6);
    if (recent.length < 5) return false;
    const counts = new Map<number, number>();
    for (const x of recent) counts.set(x, (counts.get(x) ?? 0) + 1);
    return counts.size <= 2 && (counts.get(m) ?? 0) >= 3;
  };
  const replayOld = (seq: number[]) => {
    const h: number[] = []; const trips: number[] = [];
    for (const m of seq) { h.push(m); if (oldRule(h, m)) trips.push(m); }
    return trips;
  };

  // CORRECTION, wq#517 (rabbit15). An earlier draft of THIS probe asserted that
  // the old rule "provably did not fire" on the ticket's cited loop
  // 15->59->60->61->60->61. THE ASSERTION FAILED WHEN RUN, and the assertion was
  // wrong rather than the code: extend that loop by one more bounce and the
  // 6-window fills with just {60,61}, distinct drops to 2, and the old rule DOES
  // fire. The cited six-element prefix is simply too short to discriminate the
  // two rules -- NEITHER fires on it. Left in as a test so nobody re-derives the
  // ticket's framing from the example.
  const cited = [15, 59, 60, 61, 60, 61];
  chk("A1 on the ticket's cited 6-warp prefix NEITHER rule fires (the example does not discriminate)",
    replayOld(cited).length === 0 && replayWithin(cited).length === 0);

  // THE ACTUAL DISCRIMINATOR: a third map anywhere in the window blinds the old
  // rule completely, because `distinct <= 2` is a property of the WINDOW while
  // the thing being asked about is a property of ONE MAP.
  const interleaved = [60, 61, 60, 59, 61, 60, 61];
  chk("A2 with a third map in the window the OLD rule is blind",
    replayOld(interleaved).length === 0, `old trips ${replayOld(interleaved)}`);
  chk("A3 ...and the new rule still sees the loop",
    replayWithin(interleaved).length > 0, `new trips ${replayWithin(interleaved)}`);

  // And on a pure two-map loop the old rule is not dead -- it fires, just later.
  // That is consistent with production: all 8 trips on 2026-08-13 were on the
  // degenerate shape, 7 of them manufactured by the unguarded call site.
  const extended = [15, 59, 60, 61, 60, 61, 60, 61];
  chk("A4 on a pure loop the OLD rule does fire (it was never dead code)",
    replayOld(extended).length > 0, `old trips ${replayOld(extended)}`);
  chk("A5 ...and the new rule fires EARLIER on the same sequence",
    replayWithin(extended).length > replayOld(extended).length,
    `new ${replayWithin(extended)} vs old ${replayOld(extended)}`);

  chk("A6 healthy linear progress does not trip", replayWithin([51, 50, 13, 46, 47, 48]).length === 0);
  chk("A7 thresholds are the documented ones",
    WITHIN_WINDOW === 6 && WITHIN_COUNT === 3 && CROSS_WINDOW === 12 && CROSS_COUNT === 5,
    `${WITHIN_WINDOW}/${WITHIN_COUNT}/${CROSS_WINDOW}/${CROSS_COUNT}`);
}

// -------------------------------------------------- B. the message
console.log("\n=== B. the message never claims a direction ===");
{
  const trips = [60, 61, 60, 61, 60, 61];
  const hist: number[] = []; let msg = "";
  for (const m of trips) { hist.push(m); const v = assess(m, hist, []); if (v.trip) msg = v.message; }
  console.log(`  message: ${msg.trim().slice(0, 150)}...`);
  chk("B1 a trip produces a message", msg.length > 0);
  // wq#535: the only exit from Mt Moon runs 61->60. Any text calling that
  // backward argues against the single move that leaves the cave.
  chk("B2 it never says BACKWARD", !/BACKWARD/i.test(msg));
  chk("B3 it never orders a different warp index as if it knew better",
    !/Pick a DIFFERENT warp index/i.test(msg));
  chk("B4 it says explicitly that the warp may have been correct",
    /not a claim that the warp was wrong|only way out/i.test(msg));
  chk("B5 it names the map and the recent path", /map6[01]/.test(msg) && /->/.test(msg));
}

// -------------------------------------------------- C. cross-run persistence
console.log("\n=== C. history survives a restart ===");
{
  const f = historyFile();
  chk("C1 the history file is redirected away from runtime/", f.startsWith("/tmp/"), f);
  if (existsSync(f)) unlinkSync(f);
  chk("C2 a missing history file loads as empty, never throws", loadHistory(f).length === 0);

  saveHistory(f, [60, 61, 60, 61, 60]);
  chk("C3 what was saved is what loads back", loadHistory(f).join(",") === "60,61,60,61,60");

  // The restart case: within-run history is empty (new Agent), cross-run is not.
  const cross = [60, 61, 60, 61, 60, 61, 60, 61, 60, 61];
  const v = assess(61, [61], [...cross, 61]);
  chk("C4 a loop spanning restarts trips on the CROSS rule with an empty within-run window",
    v.trip && v.rule === "cross", `rule=${v.rule} crossCount=${v.crossCount}`);
  chk("C5 the cross message says it is counting previous runs",
    /previous runs/i.test(v.message));

  saveHistory(f, "not-an-array" as any);
  chk("C6 a corrupt history file does not throw and loads empty", loadHistory(f).length === 0);
  // NOTE ON THE PATH CHOSEN HERE, because the obvious one is a trap: an earlier
  // draft used "/proc/nope/warp_history.json", and mkdirSync on /proc does not
  // throw in this container -- it BLOCKS, and the probe hung at exactly this
  // check (exit 124) with no error to catch. saveHistory's try/catch makes it
  // fail-soft against ERRORS, not against blocking I/O. That is fine in
  // production, where the path is runtime/ under cwd, but it is worth knowing
  // that a stalled mount under runtime/ would hang a turn rather than skip a
  // save. "/dev/null/sub/..." fails fast with ENOTDIR and tests what was meant.
  chk("C7 an unwritable path does not throw", (() => {
    try { saveHistory("/dev/null/sub/warp_history.json", [1, 2, 3]); return true; } catch { return false; }
  })());
  if (existsSync(f)) unlinkSync(f);
}

// -------------------------------------------------- D. the call-site fix
console.log("\n=== D. only REAL arrivals are recorded (the 7-of-8 defect) ===");
{
  // Source-text check: importing agent.ts to reach the private method needs a
  // live Emulator + ROM, and the .gb is gitignored so a --worktree checkout does
  // not have one. The property that matters is exactly textual: the brain-facing
  // enter_warp must not record unless the warp happened.
  // __dirname, never a fixed /home/lumen/pokemon path (wq#520).
  const src = readFileSync(join(__dirname, "agent.ts"), "utf8");
  const block = src.slice(src.indexOf('case "enter_warp"'), src.indexOf('case "leave_edge"'));
  chk("D1 the enter_warp block guards the record on r === \"warped\"",
    /r === "warped"[\s\S]{0,120}notePotentialOscillation/.test(block));
  chk("D2 the unconditional call is gone",
    !/const osc = this\.notePotentialOscillation\(landed\);/.test(block));
  chk("D3 the auto path still records only on a real warp",
    /if \(r === "warped"\) \{ this\.notePotentialOscillation/.test(src));
  chk("D4 the guard is wired to the extracted module", /from "\.\/oscillation"/.test(src));
  // Matches the CODE, not the words: the phrase "distinct <= 2" now legitimately
  // appears in the comments explaining why the conjunct was removed, and an
  // earlier draft of this check failed on its own documentation.
  chk("D5 the dead `distinct <= 2` conjunct is gone from agent.ts's code",
    !/const distinct = counts\.size/.test(src) && !/distinct <= 2 &&/.test(src));
  chk("D6 a structured oscillation event is emitted", /emit\("oscillation"/.test(src));
}

console.log(`\nprobe_osc517: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
