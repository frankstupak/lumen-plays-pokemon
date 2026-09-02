// S6 battle soft-lock detector (wq#423): pure decision logic.
// Gen 1 engine loops are real (plan doc): Normal-type Struggle whiffs forever
// vs Ghost (PP burns, HP never moves - hence the HP-ONLY stall signature),
// Transform-vs-Transform PP resets, 1/256 universal miss streaks. The agent
// also self-locks by repeating an ineffective move. Tiers:
//   advisory -> a "!" directive the brain must obey (change move / flee)
//   force    -> harness takes a deterministic action, no brain call (saves
//               tokens: a locked battle at ~20k tok/turn is the expensive kind
//               of stuck)
//   terminal -> battle_softlock event; live_agent flushes metrics and exits 3;
//               systemd Restart=on-failure resumes from checkpoint (this is
//               the designed CONTINUES path, not an incident).
export interface LockAssessment {
  directive: string | null;
  force: "flee" | "rotate" | null;   // flee for wild, rotate slots for trainer
  terminal: boolean;
}

export const LOCK = {
  ADVISE_STALL: 8, ADVISE_TURNS: 35,
  FORCE_STALL: 15, FORCE_TURNS: 55,
  TERMINAL_TURNS: 90,
} as const;

/** wq#1181: the winnability half of the same escalation. The stall counters
 *  above answer "this fight is going nowhere" after 15 wasted turns; the
 *  verdict answers it on turn 1, from the damage calc. */
export interface WinnabilityAction {
  directive: string | null;
  force: "flee" | null;
  /** Why the force was withheld, when it was — rendered on the bus so a soak
   *  week's logs show what WOULD have happened. */
  withheld: string | null;
}

/**
 * Escalation for a winnability verdict.
 *
 * ADVISORY BY DEFAULT, and that is a shipping decision, not an oversight: the
 * verdict must run a soak week emitting what it would have done before it is
 * allowed to spend a real action (`forcing` comes from CFG.winnability.force,
 * env LPP_WINNABILITY_FORCE, default 0). Forcing additionally requires HIGH
 * confidence — a verdict that had to guess at move metadata never moves the
 * controller (see calc.ts's fail-closed note).
 *
 * A trainer battle is never fled (Gen 1 forbids it); the verdict there is prose
 * for the brain and a record for the loss ledger, which is what gates the
 * RE-ENTRY half of the loop (ledger.ts).
 */
export function assessWinnability(
  v: { verdict: string; confidence: string; reason: string } | null,
  wild: boolean, forcing: boolean): WinnabilityAction {
  if (!v || v.verdict === "UNKNOWN") return { directive: null, force: null, withheld: null };
  if (v.verdict !== "UNWINNABLE") {
    // WINNABLE/CLOSE are informational only. Rendering CLOSE matters: it is the
    // honest answer in the matchups where a level number would have said "go".
    return {
      directive: v.verdict === "CLOSE"
        ? `WINNABILITY CLOSE: ${v.reason}. Heal or switch if HP drops below half.`
        : null,
      force: null, withheld: null,
    };
  }
  const lowConf = v.confidence !== "high";
  const directive = wild
    ? `! UNWINNABLE WILD BATTLE: ${v.reason}. flee() NOW - fighting this out costs the party.`
    : `! UNWINNABLE TRAINER BATTLE: ${v.reason}. You cannot flee; use your strongest move and expect to lose. This fight is being recorded - the harness will refuse re-entry until you out-level it.`;
  if (!wild) return { directive, force: null, withheld: "trainer battles cannot be fled" };
  if (lowConf) return { directive, force: null, withheld: "low confidence (move metadata missing)" };
  if (!forcing) return { directive, force: null, withheld: "advisory mode (LPP_WINNABILITY_FORCE=0)" };
  return { directive, force: "flee", withheld: null };
}

export function assessBattleLock(turns: number, stall: number, wild: boolean): LockAssessment {
  const terminal = turns >= LOCK.TERMINAL_TURNS;
  const force = (stall >= LOCK.FORCE_STALL || turns >= LOCK.FORCE_TURNS)
    ? (wild ? "flee" as const : "rotate" as const) : null;
  let directive: string | null = null;
  if (stall >= LOCK.ADVISE_STALL)
    directive = `! BATTLE STALLED: ${stall} turns with no HP change on either side - your current move is NOT working. Pick a DIFFERENT move slot${wild ? " or flee()" : ""}.`;
  else if (turns >= LOCK.ADVISE_TURNS)
    directive = `! BATTLE TURN BUDGET: ${turns} turns in this single battle - end it NOW with your strongest move${wild ? ", or flee()" : ""}.`;
  return { directive, force, terminal };
}
