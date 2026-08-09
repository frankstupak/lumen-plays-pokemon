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
  historyKeepVerbatim: 30,    // recent turn summaries kept verbatim
  historyCompactAt: 80,       // fold-forward compaction threshold
  escalateAfterStallTurns: 12,
  escalateForTurns: 6,
  retries: 3,
  runTokenBudget: 3_000_000,  // hard stop per run
};
