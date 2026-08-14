// wq#584 — notepad corrector: direction-aware, deduped, staleness-swept.
//
// The live exhibit (runtime/notepad.txt at 04:27Z, wq#581 audit): NINE
// near-identical fossil CORRECTION lines flooding rolling, the 9th of which
// removed the TRUE pin "Dome Fossil is NOT in inventory; current bag has only
// item234" — the direction-blind checker pattern-matched fossil+inventory and
// asserted FALSE whenever the flags read 0. Meanwhile the stale pre-wq#564
// pin "stuck loop detected - stop trying to move on map 60" contradicted the
// live route guidance every turn.
//
// Pure unit probe: Notepad is deliberately emulator-free, and an UNBOUND pad
// (no bind()) never touches disk. GREEN asserts the four-quadrant truth table,
// the flood collapse (including the exact nine live lines), and the stale
// purge. RED (LPP584_RED=1 on origin/main) asserts the OLD behaviour: the
// true negative dies, the flood stands, the stale pin survives.
import { Notepad, parsePossessionClaim, PossessionClaim } from "./notepad";

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

const RED = process.env.LPP584_RED === "1";
console.log(`== probe_notepad584 (${RED ? "RED: expecting the OLD broken behaviour" : "GREEN"}) ==`);

// The exact strings from the live pad tonight.
const TRUE_NEGATIVE = "Dome Fossil is NOT in inventory; current bag has only item234";
const STALE_PIN = "Mt Moon B1F stuck loop detected - stop trying to move on map 60";
const GOOD_PIN = "Mt Moon B2F - need Dome Fossil from Super Nerd at (13,6";
const FALSE_POSITIVES = [
  "Dome Fossil acquired - verify in inventory",
  "Dome Fossil confirmed in inventory",
  "Dome Fossil verified in inventory",
];
const LIVE_FLOOD: string[] = [
  ...["Dome Fossil acquired - verify in inventory", "Dome Fossil confirmed in inventory",
      "Dome Fossil acquired and verified in inventory", "Dome Fossil confirmed in inventory",
      "Dome Fossil verified in inventory", "Dome Fossil in inventory",
      "Dome Fossil acquired and verified in inventory", "Dome Fossil acquired and verified in inventory",
      "Dome Fossil is NOT in inventory; current bag has only item234"]
    .map(c => `CORRECTION (state check): the pinned claim "${c}" is FALSE. RAM read of wEventFlags: EVENT_GOT_DOME_FOSSIL=0, EVENT_GOT_HELIX_FOSSIL=0. The pin has been removed. Do not re-pin it; verify with a state read before asserting possession again.`),
];

// A checker that mirrors tonight's reality: the fossil flags read 0.
const fossilNotHeld = (c: PossessionClaim) =>
  /fossil/.test(c.subject)
    ? { holds: false, evidence: "RAM read of wEventFlags: EVENT_GOT_DOME_FOSSIL=0, EVENT_GOT_HELIX_FOSSIL=0." }
    : null;
const fossilHeld = (c: PossessionClaim) =>
  /fossil/.test(c.subject)
    ? { holds: true, evidence: "RAM read of wEventFlags: EVENT_GOT_DOME_FOSSIL=1." }
    : null;

// ── parse layer ──────────────────────────────────────────────────────────
const neg = parsePossessionClaim(TRUE_NEGATIVE);
const pos = parsePossessionClaim("Dome Fossil confirmed in inventory");
if (RED) {
  // Old interface has no `negated`; the negation leaks into the subject.
  chk("R-P1 old parse has no direction field", neg !== null && (neg as any).negated === undefined,
      JSON.stringify(neg));
} else {
  chk("P1 negative claim parses with negated=true", neg !== null && neg.negated === true,
      JSON.stringify(neg));
  chk("P2 negation stripped from the subject key", neg !== null && !/\bnot?\b/.test(neg.subject),
      neg?.subject ?? "");
  chk("P3 positive claim parses with negated=false", pos !== null && pos.negated === false);
  chk("P4 both directions share one subject key", neg !== null && pos !== null && neg.subject === pos.subject,
      `${neg?.subject} vs ${pos?.subject}`);
}

// ── four-quadrant verify ────────────────────────────────────────────────
function pad(pins: string[], checker: (c: PossessionClaim) => any): Notepad {
  const n = new Notepad();
  n.pinned = pins.slice();
  n.claimChecker = checker as any;
  return n;
}

// Q1: TRUE NEGATIVE must survive (tonight's casualty).
{
  const n = pad([TRUE_NEGATIVE], fossilNotHeld);
  const r = n.verifyClaims();
  if (RED) {
    chk("R-Q1 old corrector KILLS the true negative", r.dropped.includes(TRUE_NEGATIVE),
        `dropped=${r.dropped.length}`);
  } else {
    chk("Q1 TRUE negative pin survives", r.dropped.length === 0 && n.pinned.includes(TRUE_NEGATIVE),
        `kept=${r.kept}`);
  }
}
if (!RED) {
  // Q2: FALSE positive still removed (what worked keeps working).
  {
    const n = pad(FALSE_POSITIVES.slice(0, 1), fossilNotHeld);
    const r = n.verifyClaims();
    chk("Q2 FALSE positive pin still removed", r.dropped.length === 1 &&
        n.rolling.some(x => x.startsWith("CORRECTION")), `dropped=${r.dropped.length}`);
  }
  // Q3: FALSE negative removed with a direction-appropriate correction.
  {
    const n = pad([TRUE_NEGATIVE], fossilHeld);
    const r = n.verifyClaims();
    chk("Q3 FALSE negative removed, correction says you DO possess",
        r.dropped.length === 1 && n.rolling.some(x => x.includes("you DO possess")),
        n.rolling[0]?.slice(0, 90) ?? "");
  }
  // Q4: TRUE positive survives.
  {
    const n = pad(["Dome Fossil confirmed in inventory"], fossilHeld);
    const r = n.verifyClaims();
    chk("Q4 TRUE positive pin survives", r.dropped.length === 0 && r.kept === 1);
  }
  // Null checker still keeps everything possession-flavoured.
  {
    const n = pad([TRUE_NEGATIVE, "Dome Fossil confirmed in inventory"], () => null);
    const r = n.verifyClaims();
    chk("Q5 cannot-check keeps both directions untouched", r.dropped.length === 0 && n.pinned.length === 2);
  }
}

// ── dedup ────────────────────────────────────────────────────────────────
{
  const n = pad(FALSE_POSITIVES, fossilNotHeld);
  const r = n.verifyClaims();
  const corrections = n.rolling.filter(x => x.startsWith("CORRECTION"));
  if (RED) {
    chk("R-D1 old corrector floods one line per pin", corrections.length === FALSE_POSITIVES.length,
        `corrections=${corrections.length}`);
  } else {
    chk("D1 three false pins -> ONE deduped correction", r.dropped.length === 3 && corrections.length === 1,
        `corrections=${corrections.length}`);
    chk("D2 collapsed line carries the count", corrections[0]?.includes("(x3 similar)"),
        corrections[0]?.slice(-30) ?? "");
  }
}
// The nine EXACT live lines collapse on the next verify pass.
if (!RED) {
  const n = new Notepad();
  n.rolling = LIVE_FLOOD.slice();
  n.claimChecker = fossilNotHeld as any;
  n.verifyClaims();
  const corrections = n.rolling.filter(x => x.startsWith("CORRECTION"));
  chk("D3 tonight's nine-line flood collapses to one", corrections.length === 1,
      `now ${corrections.length} line(s): ${corrections[0]?.slice(-30)}`);
}

// ── staleness ────────────────────────────────────────────────────────────
{
  const n = pad([STALE_PIN, GOOD_PIN], fossilNotHeld);
  const r = n.verifyClaims();
  if (RED) {
    chk("R-S1 old pass leaves the stale movement ban standing", n.pinned.includes(STALE_PIN),
        `pinned=${n.pinned.length}`);
  } else {
    chk("S1 stale movement-ban pin retired", !n.pinned.includes(STALE_PIN) &&
        r.dropped.includes(STALE_PIN), `pinned=${n.pinned.length}`);
    chk("S2 retirement note points at the route system",
        n.rolling.some(x => x.startsWith("RETIRED") && x.includes("route")),
        n.rolling.find(x => x.startsWith("RETIRED"))?.slice(0, 80) ?? "");
    chk("S3 the good current pin survives the sweep", n.pinned.includes(GOOD_PIN));
  }
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
