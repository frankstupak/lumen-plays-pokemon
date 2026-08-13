// Efficiency + routing knobs, one place.
// wq#426: models are now BrainProfiles (model + output budget + reasoning
// effort), each env-overridable so future model/effort swaps are config-only —
// no code edits, just Environment= lines in the systemd unit.
export interface BrainProfile {
  model: string;
  maxTokensOut: number;
  reasoningEffort?: "low" | "medium" | "high";   // omitted = provider default
  thinking?: "disabled" | "enabled";             // DeepSeek v4 thinking switch. NOTE: the
  // gateway's global drop_params currently strips it (verified 2026-08-08); it is plumbed
  // so a dedicated LiteLLM alias with thinking baked in becomes a pure env swap later.
}

const envS = (k: string, d: string) => process.env[k] ?? d;
const envN = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
// zero-permitted variant: 0 is a meaningful value (off), unlike envN where 0 falls to default
const envN0 = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : d; };
const envEffort = (k: string, d?: "low" | "medium" | "high") => {
  const v = process.env[k];
  if (v === "none") return undefined;            // explicit provider-default
  return (v === "low" || v === "medium" || v === "high") ? v : d;
};

export const CFG = {
  gateway: "http://localhost:4000/v1/chat/completions",
  profiles: {
    // default turn brain. reasoning_effort=low caps the hidden-reasoning burn
    // that was eating the whole completion budget before the ACT line
    // (~50% of turns were AUTO; Cerebras docs: standard OpenAI param, verified
    // through our LiteLLM gateway 2026-08-08).
    primary: {
      model: envS("LPP_BRAIN_PRIMARY", "cerebras-oss-120b"),
      maxTokensOut: envN("LPP_BRAIN_MAXTOK", 3200),
      reasoningEffort: envEffort("LPP_BRAIN_EFFORT", "low"),
    } as BrainProfile,
    // hard spots (stalls, gyms, puzzles) - full effort wanted here
    escalate: {
      model: envS("LPP_BRAIN_ESCALATE", "deepseek-v4-pro"),
      maxTokensOut: envN("LPP_BRAIN_ESCALATE_MAXTOK", 3200),
    } as BrainProfile,
    // no-ACT rescue: a DIFFERENT (cheap, content-reliable) model retries the
    // turn instead of the same model failing the same way. deepseek-v4-flash
    // reasons ~2-4k tokens before its content, so the budget leaves headroom
    // (1600 truncated in vivo 2026-08-08); a rescued turn costs ~$0.002 vs a
    // wasted AUTO turn. thinking:"disabled" is set for the day the gateway
    // passes it (see BrainProfile note).
    actRetry: {
      model: envS("LPP_BRAIN_ACTRETRY", "deepseek-v4-flash"),
      maxTokensOut: envN("LPP_BRAIN_ACTRETRY_MAXTOK", 6000),
      thinking: "disabled",
    } as BrainProfile,
    // compaction helper, off the main loop
    summarize: {
      model: envS("LPP_BRAIN_SUMMARIZE", "deepseek-v4-flash"),
      maxTokensOut: 3200,
    } as BrainProfile,
    // screenshot turns only (unused by the text loop)
    vision: { model: "lumen-vision", maxTokensOut: 3200 } as BrainProfile,
  },
  // wq#472 AUTO-turn rate lever: max PLANNED deterministic turns the harness
  // may run between brain calls (trainer-battle strongest-move, choice-free
  // dialog advance — see Agent.plannedAuto for the exact safety gates).
  // 0 = OFF = brain every turn (current behavior; policy default is Frank's
  // call — see wq decision ticket). N>0 = up to N harness turns per brain turn.
  autoTurnRatio: envN0("LPP_AUTO_TURN_RATIO", 0),
  // wq#487 TRANSIT policy: while a goto goal is in flight, wild encounters are
  // fled deterministically and the interrupted goto is resumed without a brain
  // call (see src/transit.ts). Deliberately INDEPENDENT of autoTurnRatio: this
  // is a targeted loop-breaker, not a rate lever, so it works at ratio=0.
  // ON by default; LPP_TRANSIT=0 is a full revert with no redeploy.
  transitPolicy: envN0("LPP_TRANSIT", 1) > 0,
  transitResumeCap: envN("LPP_TRANSIT_RESUME_CAP", 5),
  // wq#487: when an XP grind is the point (pre-gym levelling), transit must NOT
  // flee. Off by default; LPP_XP_GRIND=1 turns encounters back into content.
  xpGrind: envN0("LPP_XP_GRIND", 0) > 0,
  // wq#476: per-map good-run STEP estimates (manhattan-delta proxy summed over
  // state_reads; see watchdog in live_agent.ts). Soft alarm at 2x = notepad
  // warning + turn_summary; hard at 3x = designed continue (exit(3) -> resume
  // from best checkpoint, milestone-aware via wq#471 storyScore ranking).
  // Calibration: RESEARCH-P2P4 §2 — Mt Moon good run ~1k steps total.
  mapStepBudgets: {
    59: envN("LPP_BUDGET_MAP59", 500),   // Mt Moon 1F (main maze)
    60: envN("LPP_BUDGET_MAP60", 150),   // Mt Moon B1F (connector)
    61: envN("LPP_BUDGET_MAP61", 450),   // Mt Moon B2F (fossil floor)
  } as Record<number, number>,
  // wq#483 (M5c): distributed rendezvous timeouts. All env-tunable so a slow
  // or cross-continent link can be accommodated without a code change.
  rendezvous: {
    partnerTimeoutMs: envN("LPP_RDV_PARTNER_MS", 120_000),   // wait for the peer socket (late join)
    handshakeTimeoutMs: envN("LPP_RDV_HANDSHAKE_MS", 90_000),// ROM connection loop + attendant dialog
    roomTimeoutMs: envN("LPP_RDV_ROOM_MS", 60_000),          // room-select agreement
  },
  historyKeepVerbatim: 30,    // recent turn summaries kept verbatim
  historyCompactAt: 80,       // fold-forward compaction threshold
  escalateAfterStallTurns: 12,
  escalateForTurns: 6,
  retries: 3,
  runTokenBudget: 3_000_000,  // hard stop per run
};
