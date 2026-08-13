// wq#531 acceptance: claim verification must RE-ARM after every resume, and the
// checker must actually be WIRED in production.
//
// Two layers, because the ticket as written would have shipped a no-op:
//   A. RE-ARM SEMANTICS — the mechanism, against a fake checker whose verdict I
//      can flip mid-test. This is where "stale after rollback" is proven.
//   B. PRODUCTION WIRING — a source-level assertion that live_agent.ts assigns
//      pad.claimChecker at all. Layer A passes perfectly on a build where the
//      checker is never installed; that is exactly the state main was in for
//      the last two hours, with eight false pins live. A test that cannot fail
//      on the broken build is decoration.
// Usage: npx tsx src/probe_rearm531.ts
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Notepad, PossessionClaim } from "./notepad";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const dir = mkdtempSync(join(tmpdir(), "rearm531-"));
const padPath = join(dir, "notepad.txt");

// The nine real strings the live agent pinned, taken verbatim from
// runtime/notepad.txt at 2026-08-13T08:03Z, plus its own legitimate note.
const LIVE_PINS = [
  "Dome Fossil acquired - verify in inventory",
  "Dome Fossil confirmed in inventory",
  "Dome Fossil acquired and verified in inventory",
  "Dome Fossil confirmed in inventory",
  "Dome Fossil verified in inventory",
  "Dome Fossil in inventory",
  "Dome Fossil acquired and verified in inventory",
  "Dome Fossil acquired and verified in inventory",
  "Mt Moon B1F stuck loop detected - stop trying to move on map 60",
];

/** SEED THROUGH THE PERSISTED FILE, NOT THROUGH pinRaw(), AND THAT DISTINCTION
 *  IS THE WHOLE FIXTURE.
 *
 *  This probe originally pinned the nine strings one at a time. That does NOT
 *  reproduce the live pad: wq#519's own subject-dedup rejects eight of the nine
 *  as REDUNDANT ("already pins possession of dome fossil"), leaving 2 pins and 1
 *  checkable claim — measured, not assumed. Every count this probe asserted was
 *  therefore unreachable by construction, which is why it read 6 PASS / 6 FAIL
 *  against an implementation that turns out to be correct.
 *
 *  The live pad has eight because bind() loads the persisted array VERBATIM,
 *  with no dedup — the pins were written before that dedup existed and have
 *  outlived it. Seeding through the file reproduces the state the production
 *  agent is actually in: 9 pins, 8 checkable claims. */
function freshPad(): Notepad {
  writeFileSync(padPath, JSON.stringify({ v: 1, pinned: LIVE_PINS, summary: "", rolling: [] }));
  const pad = new Notepad();
  pad.bind(padPath);
  return pad;
}

console.log("=== A. re-arm semantics ===");
{
  // A "world" whose truth I control, standing in for the fossil event flag.
  let fossilHeld = true;
  const pad = freshPad();
  pad.claimChecker = (_c: PossessionClaim) => ({
    holds: fossilHeld,
    evidence: `fake RAM: fossil=${fossilHeld ? 1 : 0}.`,
  });

  pad.renderNotes();
  const first = pad.lastVerification!;
  chk("A1 verification runs on first render and keeps TRUE claims",
      first.checked === 8 && first.dropped.length === 0 && pad.pinned.length === 9,
      `checked=${first.checked} dropped=${first.dropped.length} pins=${pad.pinned.length}`);

  // The save rolls back: the fossil is no longer held. WITHOUT a re-arm the pad
  // never re-checks -- this is the wq#531 defect, asserted RED first.
  fossilHeld = false;
  pad.renderNotes();
  chk("A2 RED: without re-arm a stale pad keeps claims RAM now contradicts",
      pad.pinned.length === 9 && pad.lastVerification!.dropped.length === 0,
      `pins=${pad.pinned.length}`);

  // GREEN: re-arm, then render.
  pad.rearmClaimVerification();
  pad.renderNotes();
  const after = pad.lastVerification!;
  chk("A3 GREEN: after re-arm the eight false claims are dropped",
      after.dropped.length === 8 && pad.pinned.length === 1,
      `dropped=${after.dropped.length} pins=${pad.pinned.length}`);
  chk("A4 the agent's own non-possession note survives",
      pad.pinned[0] === "Mt Moon B1F stuck loop detected - stop trying to move on map 60",
      pad.pinned[0]);
  chk("A5 a CORRECTION carrying the evidence is left for the brain",
      pad.renderNotes().includes("CORRECTION (state check)") &&
      pad.renderNotes().includes("fake RAM: fossil=0"),
      "correction present with evidence");

  // Re-arm must be idempotent and must not re-drop or double-correct.
  const pinsBefore = pad.pinned.length;
  pad.rearmClaimVerification();
  pad.renderNotes();
  chk("A6 re-arm is safe to repeat (nothing left to drop)",
      pad.pinned.length === pinsBefore && pad.lastVerification!.dropped.length === 0,
      `pins=${pad.pinned.length}`);
}

console.log("\n=== A'. re-arm must never DROP on a checker that cannot read ===");
{
  const pad = freshPad();
  pad.claimChecker = () => null;                 // cannot check
  pad.renderNotes();
  pad.rearmClaimVerification();
  pad.renderNotes();
  chk("A7 null verdicts drop nothing, before or after re-arm",
      pad.pinned.length === 9 && pad.lastVerification!.dropped.length === 0,
      `pins=${pad.pinned.length}`);

  const padX = freshPad();
  padX.claimChecker = () => { throw new Error("checker exploded"); };
  padX.renderNotes();
  padX.rearmClaimVerification();
  padX.renderNotes();
  chk("A8 a throwing checker drops nothing across a re-arm",
      padX.pinned.length === 9, `pins=${padX.pinned.length}`);

  // A pad with NO checker must not blow up when re-armed.
  const padN = freshPad();
  padN.rearmClaimVerification();
  padN.renderNotes();
  chk("A9 re-arm on a pad with no checker is a safe no-op",
      padN.pinned.length === 9, `pins=${padN.pinned.length}`);
}

console.log("\n=== B. production wiring (the layer that fails on main) ===");
{
  const src = readFileSync(`${__dirname}/live_agent.ts`, "utf8");
  const assigns = /pad\.claimChecker\s*=/.test(src);
  chk("B1 live_agent.ts ASSIGNS pad.claimChecker", assigns,
      assigns ? "wired" : "NOT WIRED — verifyClaims() returns at its first guard");

  const rearms = /pad\.rearmClaimVerification\s*\(\s*\)/.test(src);
  chk("B2 live_agent.ts calls rearmClaimVerification()", rearms);

  // The re-arm has to sit with the resume, not somewhere incidental.
  const i = src.indexOf("loadSnapshotFile(emu, snap)");
  const j = src.indexOf("pad.rearmClaimVerification()");
  chk("B3 re-arm is called AFTER the snapshot is loaded, at the resume site",
      i >= 0 && j > i && j - i < 800, `loadIdx=${i} rearmIdx=${j}`);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
