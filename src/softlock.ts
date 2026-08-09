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
