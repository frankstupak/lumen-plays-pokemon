// wq#1840 probe (pure: no ROM, no emulator, no filesystem, no clock). Every
// branch of the supervisor-pin expiry, driven off the LIVE directive text that
// caused the bug — the FIGHT_LOSS_LOOP prescription copied verbatim out of
// tools/lpp_stuck_intervene.py with its {attempt}/{k}/{location} filled in, and
// the WARP_OSC@36 pin that was on disk on 2026-09-12.
//
// A1/A2 are load-bearing: A1 is the fourteen-day pin the ticket is about
// (generatedAt 2026-08-29T16:44:34Z, read on 2026-09-12) and A2 is the same
// directive an hour old, which must survive. A probe that only tested "old
// expires" would pass with maxHours=0 and ship nothing.
import {
  PIN_CATCH_RE, PIN_GRASS_RE, pinAgeHours, pinContradiction, pinExpiry, pinQualifier, renderPin,
  type PinCfg, type PinnedDirective,
} from "./pin";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const CFG: PinCfg = { maxHours: 6, maxTurns: 300, contradiction: true };

// tools/lpp_stuck_intervene.py PRESCRIPTIONS["FIGHT_LOSS_LOOP"]["notepadPin"],
// rendered as runtime/supervisor_directive.json held it on 2026-08-29.
const FIGHT_PIN =
  "PIN: SUPERVISOR (3/3): stuck losing the gym fight at Cerulean Gym (map65). " +
  "STOP re-entering the gym — the harness REFUSES entry until all four hold: " +
  "lead level >= 30, >= 3 potions, >= 2 party members, and at least one Grass or Rock " +
  "party member (the gym is Water; a Fire lead is resisted, so more levels on the same " +
  "mon will never win it — the type counter is what unblocks the badge). Go to Route 24/25 " +
  "and CATCH an Oddish/Bellsprout/Paras/Geodude, then level it. Once you are ON a route, " +
  "use goto() to WALK into the tall grass to trigger wild battles. Do NOT enter_warp into " +
  "a house or building to look for grass, do not walk back into the doorway you just came " +
  "out of, and do not warp to the Pokecenter to heal when already at full HP.";

// runtime/supervisor_directive.json, 2026-09-12T10:55:35Z. Neither a catch nor
// a grass pin: it must pass through renderPin untouched.
const WARP_PIN =
  "PIN: SUPERVISOR (2/3): warp oscillation at Route 25 (map36). Your last several warps " +
  "alternate between Route 25 (map36) <-> Bills House (map88). Bills House (map88) is BANNED " +
  "by the harness until story advances — do not enter_warp back into it.";

const GENERATED = "2026-08-29T16:44:34Z";       // the live FIGHT_LOSS_LOOP@3 stamp
const READ_AT = Date.parse("2026-09-12T09:00:00Z");   // when the ticket was cut
const HOUR = 3_600_000;

const directive = (o: Partial<PinnedDirective> = {}): PinnedDirective => ({
  pin: FIGHT_PIN, mode: "FIGHT_LOSS_LOOP", generatedAt: GENERATED,
  loadedTurn: 0, loadedMs: READ_AT, ...o,
});

// --- A. age ---------------------------------------------------------------
{
  const d = directive();
  const age = pinAgeHours(d, READ_AT)!;
  chk("A1 the live 14-day FIGHT_LOSS_LOOP@3 pin expires on age alone",
    age > 300 && !!pinExpiry(d, { turn: 12, ms: READ_AT }, CFG),
    `${age.toFixed(0)}h`);
  chk("A1b the expiry reason names the age and the stamp, not just 'expired'",
    /\d+\.\dh old \(generated 2026-08-29T16:44:34Z, cap 6h\)/
      .test(pinExpiry(d, { turn: 12, ms: READ_AT }, CFG) ?? ""),
    pinExpiry(d, { turn: 12, ms: READ_AT }, CFG) ?? "null");

  const fresh = directive({ generatedAt: new Date(READ_AT - HOUR).toISOString() });
  chk("A2 an hour-old directive is still live (an in-flight ladder is not cut short)",
    pinExpiry(fresh, { turn: 5000, ms: READ_AT }, CFG) === null);

  // The K=3 ladder spans ~90 minutes (intervention_log.json: attempts 1837s
  // apart), so the whole of one must fit inside the cap with room to spare.
  const ladderEnd = directive({ generatedAt: new Date(READ_AT - 1.5 * HOUR).toISOString() });
  chk("A3 a directive rewritten at the end of a full K=3 ladder survives",
    pinExpiry(ladderEnd, { turn: 400, ms: READ_AT }, CFG) === null);

  chk("A4 exactly at the cap it retires (>= , not >)",
    !!pinExpiry(directive({ generatedAt: new Date(READ_AT - 6 * HOUR).toISOString() }),
                { turn: 1, ms: READ_AT }, CFG));

  chk("A5 LPP_PIN_MAX_HOURS=0 reverts the age rule entirely",
    pinExpiry(d, { turn: 12, ms: READ_AT }, { ...CFG, maxHours: 0 }) === null);

  chk("A6 a future generatedAt reads as age 0, never as a negative age",
    pinAgeHours(directive({ generatedAt: new Date(READ_AT + 99 * HOUR).toISOString() }), READ_AT) === 0);
}

// --- B. the turn fallback -------------------------------------------------
{
  const noStamp = directive({ generatedAt: undefined });
  chk("B1 no generatedAt: fresh directives still pass",
    pinAgeHours(noStamp, READ_AT) === null &&
    pinExpiry(noStamp, { turn: 299, ms: READ_AT }, CFG) === null);
  chk("B2 no generatedAt: retires at the turn cap",
    !!pinExpiry(noStamp, { turn: 300, ms: READ_AT }, CFG));
  chk("B3 an unparseable stamp falls back to turns, it does not make the pin immortal",
    !!pinExpiry(directive({ generatedAt: "not a date" }), { turn: 300, ms: READ_AT }, CFG));
  // The turn counter resets on every gameplay continue (four
  // supervisor_directive_loaded events in one 2026-09-12 run), so a STAMPED
  // directive must never be judged on turns — that is how 14 days went unnoticed.
  chk("B4 a stamped directive is judged on the clock, never on the reset-prone turn counter",
    pinExpiry(directive({ generatedAt: new Date(READ_AT - HOUR).toISOString(), loadedTurn: 0 }),
              { turn: 99_999, ms: READ_AT }, CFG) === null);
  chk("B5 LPP_PIN_MAX_TURNS=0 reverts the fallback",
    pinExpiry(noStamp, { turn: 99_999, ms: READ_AT }, { ...CFG, maxTurns: 0 }) === null);
}

// --- C. contradiction (wq#1829's measured state: $96, zero balls) ---------
{
  const broke = { balls: 0, money: 96, ballPrice: 200 };
  chk("C0 the catch regex matches the live prescription's own wording",
    PIN_CATCH_RE.test(FIGHT_PIN) && !PIN_CATCH_RE.test(WARP_PIN));

  const c = pinContradiction(FIGHT_PIN, broke, CFG);
  chk("C1 a CATCH pin at $96 with zero balls is suppressed", !!c);
  chk("C1b the suppression names both numbers and the way out",
    /\$96/.test(c ?? "") && /\$200/.test(c ?? "") && /TRAINER/.test(c ?? ""), c ?? "null");

  chk("C2 one ball in the bag and the pin is executable again",
    pinContradiction(FIGHT_PIN, { ...broke, balls: 1 }, CFG) === null);
  chk("C3 enough money to buy one and the pin is executable again",
    pinContradiction(FIGHT_PIN, { ...broke, money: 200 }, CFG) === null);
  chk("C4 a pin that never mentions catching is never suppressed by the bag",
    pinContradiction(WARP_PIN, broke, CFG) === null);
  chk("C5 LPP_PIN_CONTRADICTION=0 reverts the rule",
    pinContradiction(FIGHT_PIN, broke, { ...CFG, contradiction: false }) === null);
}

// --- D. deference to wq#1828's exclusion ----------------------------------
{
  // The live stall: map35 x=4..5, y=19..29, escaped by fire #3, refused until turn 505.
  const ex = { tiles: 22, map: 35, untilTurn: 505 };
  chk("D0 the grass regex matches the live prescription, not the warp one",
    PIN_GRASS_RE.test(FIGHT_PIN) && !PIN_GRASS_RE.test(WARP_PIN));

  const q = pinQualifier(FIGHT_PIN, ex);
  chk("D1 a live exclusion qualifies the grass order", !!q);
  chk("D1b the qualifier names the patch, its map and its expiry",
    /22-tile/.test(q ?? "") && /map35/.test(q ?? "") && /turn 505/.test(q ?? ""), q ?? "null");
  chk("D2 no exclusion, no qualifier", pinQualifier(FIGHT_PIN, null) === null);
  chk("D3 a non-grass pin is never qualified", pinQualifier(WARP_PIN, ex) === null);

  const r = renderPin(FIGHT_PIN, { balls: 2, money: 500, ballPrice: 200 }, ex, CFG)!;
  chk("D4 qualification APPENDS — the gym gate and the four conditions survive",
    r.text.startsWith(FIGHT_PIN) && r.text.includes("lead level >= 30") &&
    r.text.includes("PIN QUALIFIED") && r.suppressed === null);
  chk("D5 the appended line carries its own '!!' so the block stays one directive per line",
    r.text.split("\n").length === 2 && r.text.split("\n")[1].startsWith("!! "));
}

// --- E. render composition ------------------------------------------------
{
  const broke = { balls: 0, money: 96, ballPrice: 200 };
  const ex = { tiles: 22, map: 35, untilTurn: 505 };
  const r = renderPin(FIGHT_PIN, broke, ex, CFG)!;
  chk("E1 suppression outranks qualification: an impossible remedy is not qualified, it is withheld",
    !!r.suppressed && !r.text.includes("PIN QUALIFIED") && !r.text.includes("lead level >= 30"));
  chk("E2 an empty pin renders nothing",
    renderPin("", broke, ex, CFG) === null);
  chk("E3 an untouched pin renders verbatim (wq#1081's contract: the brain sees the pin)",
    renderPin(WARP_PIN, broke, ex, CFG)!.text === WARP_PIN);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
