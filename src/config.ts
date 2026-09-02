// Efficiency + routing knobs, one place.
import { join } from "path";

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
// comma-separated list; empty string is a meaningful value (no rungs) so it is
// honoured rather than falling back to the default, same rule as envN0.
const envList = (k: string, d: string[]) => {
  const v = process.env[k];
  if (v === undefined) return d;
  return v.split(",").map(s => s.trim()).filter(Boolean);
};

export const CFG = {
  // wq#907: env-overridable so a test can point the brain at a stub gateway
  // without touching the running proxy.
  gateway: envS("LPP_GATEWAY", "http://localhost:4000/v1/chat/completions"),
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
      model: envS("LPP_BRAIN_ESCALATE", "cerebras-oss-120b"),
      maxTokensOut: envN("LPP_BRAIN_ESCALATE_MAXTOK", 3200),
    } as BrainProfile,
    // no-ACT rescue: a DIFFERENT (cheap, content-reliable) model retries the
    // turn instead of the same model failing the same way. deepseek-v4-flash
    // reasons ~2-4k tokens before its content, so the budget leaves headroom
    // (1600 truncated in vivo 2026-08-08); a rescued turn costs ~$0.002 vs a
    // wasted AUTO turn. thinking:"disabled" is set for the day the gateway
    // passes it (see BrainProfile note).
    actRetry: {
      model: envS("LPP_BRAIN_ACTRETRY", "cerebras-oss-120b"),
      maxTokensOut: envN("LPP_BRAIN_ACTRETRY_MAXTOK", 6000),
      thinking: "disabled",
    } as BrainProfile,
    // compaction helper, off the main loop
    summarize: {
      model: envS("LPP_BRAIN_SUMMARIZE", "cerebras-oss-120b"),
      maxTokensOut: 3200,
    } as BrainProfile,
    // wq#621: escalation-only valve, not the text loop's per-turn brain.
    vision: { model: "lumen-vision", maxTokensOut: 3200 } as BrainProfile,
    // wq#1191 persona extraction: "did he just state a durable fact about
    // himself?" over one sentence. Deliberately pinned to the CHEAPEST rung and
    // deliberately NOT run through Brain's fallback ladder (persona_llm.ts) —
    // this fires after every line Lumen speaks, and a question that small
    // climbing to an expensive model would cost more than the feature.
    persona: {
      model: envS("LPP_BRAIN_PERSONA", "deepseek-v4-flash"),
      maxTokensOut: envN("LPP_BRAIN_PERSONA_MAXTOK", 400),
      thinking: "disabled",
    } as BrainProfile,
  },
  // wq#621 VISION VERDICT VALVE: escalation-ONLY VLM consult (research
  // reports/vision_research_brief.md — every harness that beat the game used
  // RAM/text to correct vision, never the reverse; the symbolic ceiling is
  // ~100% for Gen1, so vision is a rare safety-valve hint, not a channel the
  // brain gets every turn). Fires only after `stuckN` CONSECUTIVE stuck_dumps
  // at the same (map,x,y); hard-capped at `maxPerHour` calls, sliding window.
  visionValve: {
    enabled: envN0("LPP_VISION_ENABLE", 1) > 0,
    stuckN: envN("LPP_VISION_STUCK_N", 3),
    maxPerHour: envN("LPP_VISION_MAX_PER_HOUR", 4),
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
    retryMax: envN("LPP_RDV_RETRY_MAX", 3),                  // wq#510: max rendezvous retry attempts on stranded-slave
    retryBackoffMs: envN("LPP_RDV_RETRY_BACKOFF", 2_000),    // wq#510: base delay between retry attempts
  },
  historyKeepVerbatim: 30,    // recent turn summaries kept verbatim
  historyCompactAt: 80,       // fold-forward compaction threshold
  escalateAfterStallTurns: 12,
  escalateForTurns: 6,
  // wq#907 BRAIN LIVENESS. The 12h stand-still of 2026-08-23 was not a crash:
  // every rung of the chain was individually "reasonable" and the product was
  // unbounded. Primary is qwen36-local (Isis, ONE decode slot — wq#898); the
  // gateway gives that model `timeout: 600` and, since wq#589, NO fallback
  // group, so an exhausted call is a terminal dead end. LiteLLM retried 3x600s,
  // the harness retried that 3x, and `fetch` had no deadline at all, so the
  // process sat at 0.0% CPU on an open socket to 127.0.0.1:4000.
  //
  // The fix is here rather than only in the gateway config because this is the
  // one layer that cannot itself dead-end: whatever the proxy does, a turn
  // returns text or throws inside a known bound, and live_agent.ts already
  // survives a throw (failStreak -> checkpoint -> reboot).
  brain: {
    // Hard client deadline for the profile's own model (the "primary" path).
    // A healthy qwen36-local turn is ~10 tok/s; anything past this is the
    // single slot being held by someone else, not a turn worth waiting for.
    timeoutMs: envN("LPP_BRAIN_TIMEOUT_MS", 120_000),
    // Fallback rungs are cloud and fast. Seconds, per the ticket: a fallback
    // that can take minutes is just the original bug one rung down.
    fallbackTimeoutMs: envN("LPP_BRAIN_FALLBACK_TIMEOUT_MS", 30_000),
    // TERMINAL FALLBACK: ordered rungs tried after the profile's own model,
    // deliberately on two DIFFERENT cloud providers so the ladder cannot end
    // on a single failure domain. The last rung is never skipped (see the
    // breaker below), so every turn makes at least one real attempt.
    fallbackModels: envList("LPP_BRAIN_FALLBACK_MODELS", ["cerebras-oss-120b", "mistral-small"]),
    // Attempts on the terminal rung only. Non-terminal rungs get one shot —
    // the ladder IS the retry, and retrying a hung rung is what cost 12h.
    terminalAttempts: envN("LPP_BRAIN_TERMINAL_ATTEMPTS", 2),
    // SINGLE-SLOT SATURATION (wq#898): LPP cannot see Isis's decode slot, and
    // an aborted request does not free it — the gateway keeps generating for
    // the rest of its own 600s timeout. So a rung that just cost us a deadline
    // is presumed busy and is skipped outright for a cooldown, which turns a
    // saturated Isis from "120s wasted every turn" into "120s wasted twice per
    // cooldown window". Cheapest-first resumes by itself when it expires.
    breakerFails: envN("LPP_BRAIN_BREAKER_FAILS", 2),
    breakerCooldownMs: envN("LPP_BRAIN_BREAKER_COOLDOWN_MS", 600_000),
  },
  // wq#1176 STREAMER CHAT (one-way: Lumen -> audience; there is no inbound
  // path, see chat.ts). The brain speaks by appending an optional SAY: line to
  // its reply, so a chat line costs NO game turn — turns are the scarce
  // resource here and an audience feature must not compete with gameplay for
  // them. minIntervalMs is what keeps a 25x-realtime emulator from producing a
  // wall of text: it spaces the lines the viewer actually sees.
  chat: {
    enabled: envN0("LPP_CHAT_ENABLE", 1) > 0,
    ring: envN("LPP_CHAT_RING", 60),                    // messages kept for the overlay
    minIntervalMs: envN("LPP_CHAT_MIN_INTERVAL_MS", 45_000),
  },
  // wq#1176/wq#1191 PERSONA MEMORY. The cross-platform contract is `subject` in
  // lumen_state (the FLEET's bi-temporal store), not a file in this repo: a
  // Messenger bridge, an operator running `lumen_state.py current lumen-persona`
  // and any other fleet agent all read the rows the streamer wrote. `path` is
  // now only the wq#1176 JSON store's location, migrated into lumen_state once
  // on first bind and then left alone.
  persona: {
    enabled: envN0("LPP_PERSONA_ENABLE", 1) > 0,
    path: envS("LPP_PERSONA_PATH", "/home/lumen/pokemon/runtime/persona.json"),
    platform: envS("LPP_PERSONA_PLATFORM", "stream"),
    recallBudget: envN("LPP_PERSONA_RECALL_BUDGET", 900),   // chars injected per prompt
    subject: envS("LPP_PERSONA_SUBJECT", "lumen-persona"),
    python: envS("LPP_PYTHON", "python3"),
    adapter: envS("LPP_PERSONA_ADAPTER", join(__dirname, "..", "tools", "lumen_state_json.py")),
    stateRegen: envS("LPP_STATE_REGEN", "/home/lumen/bin/state-regen"),
    // Tests only: point the adapter at a throwaway sqlite file. Empty = the
    // real minerva.db, which is the only correct production value.
    stateDb: envS("LPP_LUMEN_STATE_DB", ""),
    stateTimeoutMs: envN("LPP_PERSONA_STATE_TIMEOUT_MS", 15_000),
    regenMinIntervalMs: envN("LPP_PERSONA_REGEN_MIN_INTERVAL_MS", 60_000),
    // The store is the source of truth; this is how long a turn may reuse the
    // last read of it before paying for another subprocess.
    cacheTtlMs: envN0("LPP_PERSONA_CACHE_TTL_MS", 60_000),   // 0 = read every time
    // LLM extraction (wq#1191). Off = the regex fast path only, which is what
    // wq#1176 shipped and is still the zero-cost first pass when this is on.
    llmExtract: envN0("LPP_PERSONA_LLM_EXTRACT", 1) > 0,
    extractTimeoutMs: envN("LPP_PERSONA_EXTRACT_TIMEOUT_MS", 20_000),
    maxLlmFacts: envN("LPP_PERSONA_MAX_LLM_FACTS", 4),      // per generated line
  },
  runTokenBudget: 3_000_000,  // hard stop per run
};
