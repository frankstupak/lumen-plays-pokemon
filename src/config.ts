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
// ...and the fractional one, for a share (wq#1828 LPP_EXPLORE_PATCH_SHARE): 0 is off
const envF0 = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
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

// wq#1664: the escalation ladder is [primary, ...fallbackModels] (Brain.ladder),
// so these two are hoisted out of CFG to derive the rescue roles' DEFAULTS from
// it. NEXT_RUNG is the first ladder rung that is not primary — the cheapest
// model that is genuinely a second opinion. Only a default: an explicit
// LPP_BRAIN_ESCALATE/ACTRETRY still wins, and brainConfigErrors() below is what
// refuses the pin-everything-to-one-model shape.
const PRIMARY_MODEL = envS("LPP_BRAIN_PRIMARY", "cerebras-oss-120b");
const FALLBACK_MODELS = envList("LPP_BRAIN_FALLBACK_MODELS", ["cerebras-oss-120b", "mistral-small"]);

/** First fallback rung that differs from `primary`, or `primary` itself when the
 *  ladder offers no second model — in which case brainConfigErrors() reports it
 *  rather than this silently returning a same-model "escalation". */
export function nextLadderRung(primary: string, fallbacks: string[]): string {
  return fallbacks.find(m => m && m !== primary) ?? primary;
}

const NEXT_RUNG = nextLadderRung(PRIMARY_MODEL, FALLBACK_MODELS);

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
      model: PRIMARY_MODEL,
      maxTokensOut: envN("LPP_BRAIN_MAXTOK", 3200),
      reasoningEffort: envEffort("LPP_BRAIN_EFFORT", "low"),
    } as BrainProfile,
    // hard spots (stalls, gyms, puzzles). wq#1664: defaults to the next ladder
    // rung, never to primary — re-asking the model that just stalled 12 turns is
    // not an escalation (it fired 337x in one day that way; M7 in
    // foreman/research/LPP_BEHAVIORAL_ANALYSIS.md). full effort wanted here by default,
    // but wq#1616: on glm-5.3-flash-zai reasoning is MANDATORY (no "none") and
    // bills as output at $0.50/M, so this must be env-overridable per rung
    // rather than hardcoded "full effort" — lpp-glm.env pins it to "low".
    escalate: {
      model: envS("LPP_BRAIN_ESCALATE", NEXT_RUNG),
      maxTokensOut: envN("LPP_BRAIN_ESCALATE_MAXTOK", 3200),
      reasoningEffort: envEffort("LPP_BRAIN_ESCALATE_EFFORT"),
    } as BrainProfile,
    // no-ACT rescue: a DIFFERENT (cheap, content-reliable) model retries the
    // turn instead of the same model failing the same way — hence the next-rung
    // default and the brainConfigErrors() check, wq#1664. deepseek-v4-flash
    // reasons ~2-4k tokens before its content, so the budget leaves headroom
    // (1600 truncated in vivo 2026-08-08); a rescued turn costs ~$0.002 vs a
    // wasted AUTO turn. thinking:"disabled" is set for the day the gateway
    // passes it (see BrainProfile note).
    actRetry: {
      model: envS("LPP_BRAIN_ACTRETRY", NEXT_RUNG),
      maxTokensOut: envN("LPP_BRAIN_ACTRETRY_MAXTOK", 6000),
      thinking: "disabled",
      reasoningEffort: envEffort("LPP_BRAIN_ACTRETRY_EFFORT"),
    } as BrainProfile,
    // compaction helper, off the main loop
    summarize: {
      model: envS("LPP_BRAIN_SUMMARIZE", "cerebras-oss-120b"),
      maxTokensOut: 3200,
      reasoningEffort: envEffort("LPP_BRAIN_SUMMARIZE_EFFORT"),
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
  // wq#1181 WINNABILITY VERDICT (roadmap item 5). The damage calc runs every
  // battle turn and renders its verdict to the brain; `force` is what lets it
  // spend a real action (a wild UNWINNABLE flee) instead of only advising.
  //
  // force DEFAULTS OFF ON PURPOSE. The roadmap rates this Medium risk and asks
  // for a soak week of advisory-only first: with force=0 every turn still emits
  // a `winnability` event carrying the verdict AND the action it withheld, so
  // the soak produces exactly the log needed to decide whether flipping
  // LPP_WINNABILITY_FORCE=1 is safe. Flipping it is an env change in the
  // systemd unit — no redeploy, and no code change to revert.
  winnability: {
    advisory: envN0("LPP_WINNABILITY", 1) > 0,
    force: envN0("LPP_WINNABILITY_FORCE", 0) > 0,
  },
  // wq#1731 EXPLORATION OVERRIDE (src/explore.ts). ON by default: this is the
  // hard rung the stuck detectors never had. It fires only on a COMPLETE
  // novelty window with zero new tiles that is either a tight pace (< minTiles
  // tiles) or never left one map, then drives K directional steps with no
  // brain call. LPP_EXPLORE_OVERRIDE=0 reverts the rung, LPP_EXPLORE_PROMPT=0
  // drops the PROGRESS/GOAL lines, both without a redeploy.
  //
  // wq#1828 added the two knob groups at the end. patch* is the third trigger:
  // the first two fired ZERO times in 6.7h of live play because the agent
  // shuttles off the stalled strip every ~50 turns, and one sample anywhere in
  // the window clears a whole-window AND. patchShare is the share of a window
  // one Chebyshev-patchRadius patch must hold; radius 5 is the measured live
  // stall (map35 x=4..5, y=19..29). Below radius 4 the trigger stops firing on
  // that run at all (6/363 windows at r=3, 0/363 at r=2), at 5 it fires on
  // 260/363. excludeTurns is how long goto refuses the escaped patch after a
  // fire. LPP_EXPLORE_PATCH_SHARE=0 reverts the trigger,
  // LPP_EXPLORE_EXCLUDE_TURNS=0 reverts the exclusion, both independently.
  explore: {
    enabled: envN0("LPP_EXPLORE_OVERRIDE", 1) > 0,
    prompt: envN0("LPP_EXPLORE_PROMPT", 1) > 0,
    windowTurns: envN("LPP_EXPLORE_WINDOW", 150),
    minTiles: envN("LPP_EXPLORE_MIN_TILES", 5),
    stepsK: envN("LPP_EXPLORE_K", 30),
    clearance: envN("LPP_EXPLORE_CLEARANCE", 3),
    expireFactor: envN("LPP_EXPLORE_EXPIRE_FACTOR", 3),
    urgencyTurns: envN("LPP_EXPLORE_URGENCY_TURNS", 60),
    catchParty: envN("LPP_EXPLORE_CATCH_PARTY", 3),
    patchShare: envF0("LPP_EXPLORE_PATCH_SHARE", 0.5),
    patchRadius: envN0("LPP_EXPLORE_PATCH_RADIUS", 5),
    patchNew: envN0("LPP_EXPLORE_PATCH_NEW", 0),
    excludeTurns: envN0("LPP_EXPLORE_EXCLUDE_TURNS", 60),
    // wq#1746: novelty samples an escape is watched for before its `verdict`
    // record settles `escaped`. One stall window, so the answer covers the
    // exclusion's 60 turns AND the 90 after it lifts — the interval in which
    // all nine historical fires were undone. LPP_EXPLORE_VERDICT_TURNS=0 drops
    // the measurement; nothing else reads it, so nothing else changes.
    verdictTurns: envN0("LPP_EXPLORE_VERDICT_TURNS", 150),
  },
  // wq#1840 SUPERVISOR PIN EXPIRY (src/pin.ts). The stuck supervisor's
  // notepadPin used to lift on story advance ALONE, so the FIGHT_LOSS_LOOP@3
  // pin whose own remedy was the blocked story advance sat in the prompt for
  // fourteen days. maxHours retires the whole directive (pin AND gotoBan) on
  // the wall clock: the supervisor re-affirms a live stall by rewriting the
  // file every ~30 minutes (runtime/intervention_log.json), so 6h is twelve
  // missed re-affirmations and four times the span of a whole K=3 ladder — it
  // cannot cut an escalation short, because a new attempt rewrites generatedAt
  // and resets this clock. maxTurns is the fallback for a file with no
  // parseable timestamp (~300 turns = 6h at the measured 47 turns/h);
  // it cannot be the primary, because live_agent builds a fresh Agent on every
  // continue and the turn counter restarts with it. LPP_PIN_MAX_HOURS=0 /
  // LPP_PIN_MAX_TURNS=0 / LPP_PIN_CONTRADICTION=0 revert each rule
  // independently, no redeploy.
  pin: {
    maxHours: envN0("LPP_PIN_MAX_HOURS", 6),
    maxTurns: envN0("LPP_PIN_MAX_TURNS", 300),
    contradiction: envN0("LPP_PIN_CONTRADICTION", 1) > 0,
  },
  // wq#1181 LOSS LEDGER + engagement gates (roadmap item 6). ON by default:
  // unlike the verdict above it cannot act on its own, it can only refuse a
  // re-entry the agent has already proven it loses, and every gate carries
  // three expiries plus a fire cap (ledger.ts). LPP_FIGHT_GATE=0 reverts to
  // record-only, which still feeds the ledger file for analysis.
  fightGate: envN0("LPP_FIGHT_GATE", 1) > 0,
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
    fallbackModels: FALLBACK_MODELS,
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
    // DEAD RUNG (wq#1660): a gateway 4xx that is not 429/408 is deterministic —
    // budget exceeded, invalid model, key not allowed — and re-asking cannot
    // change the answer. The rung is marked dead (skipped outright, terminal
    // included) for this window, unlike the breaker above, whose whole contract
    // is that the terminal rung ignores it. Long on purpose: this is "wait for
    // an operator or a budget reset", not "wait out a busy decode slot".
    deadRungRecheckMs: envN("LPP_BRAIN_DEAD_RUNG_RECHECK_MS", 900_000),
    // wq#1660 boot pre-flight (GET /v1/models + /key/info). 0 skips it —
    // probes and stub-gateway runs have no /v1/models to answer.
    preflight: envN0("LPP_BRAIN_PREFLIGHT", 1) > 0,
  },
  // wq#1176 STREAMER CHAT (one-way: Lumen -> audience; there is no inbound
  // path, see chat.ts). This block is the TRANSPORT only — the ring the overlay
  // reads, the append-only log, and a rate-limit backstop. Who speaks and when
  // is CFG.streamer.
  //
  // minIntervalMs is deliberately BELOW the streamer's own floor
  // (streamer.eventMinGapMs). Cadence is a policy the generator owns; this
  // limiter exists to catch a bug that would otherwise put a wall of text on a
  // live stream, not to shape the pacing. Set it above the streamer floor and
  // it silently starts eating event-triggered lines.
  chat: {
    enabled: envN0("LPP_CHAT_ENABLE", 1) > 0,           // master kill-switch for anything spoken
    ring: envN("LPP_CHAT_RING", 60),                    // messages kept for the overlay
    minIntervalMs: envN("LPP_CHAT_MIN_INTERVAL_MS", 20_000),
    log: envS("LPP_CHAT_LOG", ""),                      // append-only chat.jsonl; "" = derive from RUNTIME
  },
  // wq#1192 STREAMER — the chat generator, independent of gameplay.
  //
  // THREE CONSTRAINTS SHAPE EVERY VALUE HERE, and all three are why the
  // previous attempt (a SAY: line on the gameplay completion) was reworked:
  //
  // 1. CADENCE IS WALL-CLOCK, NOT TURNS. Deterministic turns (nav, dialog,
  //    battle scripts) can run for minutes without one LLM call. Chat driven by
  //    the gameplay brain goes silent for exactly those stretches, which are the
  //    stretches a viewer is most likely to be watching. A timer cannot go
  //    silent, so the timer is the source of truth and game events only pull the
  //    next line EARLIER.
  // 2. THE MODEL IS THE CHEAP RUNG, ALWAYS. Chat is a nice-to-have riding on a
  //    budget that exists to finish the game. It gets its own single-shot call
  //    on a fast cheap model with no fallback ladder — a chat line is never
  //    worth escalating, and a failed one is worth exactly nothing. There is no
  //    path from here to CFG.profiles.
  // 3. FAILURE IS DECOUPLED. Nothing in this path can cost a game turn: the
  //    generator holds no lock the agent wants, and its errors are swallowed
  //    into the next tick.
  streamer: {
    enabled: envN0("LPP_STREAMER_ENABLE", 1) > 0,
    model: envS("LPP_STREAMER_MODEL", "deepseek-v4-flash"),
    timeoutMs: envN("LPP_STREAMER_TIMEOUT_MS", 20_000),
    maxTokensOut: envN("LPP_STREAMER_MAX_TOKENS", 160),
    temperature: Number(envS("LPP_STREAMER_TEMP", "0.9")),
    // Jittered so the stream does not tick like a metronome. Spec: 60-120s.
    minIntervalMs: envN("LPP_STREAMER_MIN_MS", 60_000),
    maxIntervalMs: envN("LPP_STREAMER_MAX_MS", 120_000),
    // Floor for an EVENT-triggered line. Badges, white-outs and battle
    // transitions cluster (a gym fight ends, a badge lands, the map changes,
    // all inside 10s), so without a floor one interesting moment becomes four
    // lines nobody can read.
    eventMinGapMs: envN("LPP_STREAMER_EVENT_GAP_MS", 25_000),
    // Share of lines that are NOT about the game. Frank's brief: a real
    // streamer with a life, roughly 60/40.
    offTopicRate: Number(envS("LPP_STREAMER_OFFTOPIC", "0.4")),
    recentLines: envN("LPP_STREAMER_RECENT", 10),       // shown to the model so it does not repeat itself
    // Extra strings the guardrail refuses on top of the structural patterns
    // (IPs, tokens, paths, hostnames). Env-only: a deny list checked into the
    // repo is itself a disclosure of the thing it is protecting.
    denyTerms: envList("LPP_STREAMER_DENY", []),
    // Touch this file to silence chat on a LIVE stream without restarting the
    // agent. Checked every tick, so it takes effect within a second.
    killFile: envS("LPP_STREAMER_KILLFILE", "/home/lumen/pokemon/runtime/chat.off"),
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

/** wq#1664: the two rescue roles must be a SECOND OPINION, not the model that
 *  just failed. When a unit drop-in pins every role to one model (as lpp-glm did
 *  on 09-10), `escalate` on stall_12_turns and `actRetry` on a missing ACT line
 *  both re-ask the model that produced the stall: same prompt, same weights,
 *  same answer, one extra billed call. That is silent — the escalation is logged
 *  and looks like it worked — so it is caught at boot instead.
 *  Returns one message per broken role; empty array = config is sane. */
export interface BrainRoleConfig {
  profiles: { primary: BrainProfile; escalate: BrainProfile; actRetry: BrainProfile };
  brain: { fallbackModels: string[] };
}

export function brainConfigErrors(cfg: BrainRoleConfig = CFG): string[] {
  const primary = cfg.profiles.primary.model;
  const ladder = [primary, ...cfg.brain.fallbackModels].filter((m, i, a) => m && a.indexOf(m) === i);
  const errs: string[] = [];
  for (const [role, env] of [["escalate", "LPP_BRAIN_ESCALATE"], ["actRetry", "LPP_BRAIN_ACTRETRY"]] as const) {
    const model = cfg.profiles[role].model;
    if (!model) { errs.push(`${role} profile has no model (${env} is set to an empty string).`); continue; }
    if (model !== primary) continue;
    const alts = ladder.filter(m => m !== primary);
    errs.push(`${role} profile model "${model}" is the primary model, so ${role} re-asks the model that just failed. `
      + `Set ${env} to a different model`
      + (alts.length ? ` (ladder rungs available: ${alts.join(", ")}).`
                     : `; no rung of LPP_BRAIN_FALLBACK_MODELS differs from primary either, so there is nothing to escalate to.`));
  }
  return errs;
}
