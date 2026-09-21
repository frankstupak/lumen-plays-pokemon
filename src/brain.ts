// LiteLLM brain client: routing, escalation, budget governance, bounded retries.
// wq#722: fallback logging + Isis health alerting (no silent DeepSeek spend).
// wq#907: every brain call is bounded in wall-clock and walks a rung ladder that
// ends somewhere that cannot itself dead-end. Rationale + knobs: CFG.brain.
import { CFG, BrainProfile } from "./config";
import { EventBus } from "./events";
import { readFileSync, appendFileSync } from "fs";

// wq#1191: exported so persona extraction can reach the gateway on the cheap
// rung without going through the turn ladder. Same key resolution, one place.
export function apiKey(): string {
  // wq#903/wq#949: env first (scoped lpp key), then the lpp key file only.
  // Never /home/lumen/agent/.env — that silently misattributes spend to the
  // shared ops-emergency key. A missing key fails loudly (401 on sk-local).
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  try {
    return readFileSync("/home/lumen/.secrets/litellm-service-keys/lpp.key", "utf8").trim();
  } catch {}
  return "sk-local";
}

// wq#907: overridable so a probe's rung failures do not land in the production
// stats file that incident review reads.
const FALLBACK_LOG = process.env.LPP_FALLBACK_LOG ?? "/home/lumen/pokemon/fallback_stats.jsonl";

function logFallback(entry: {
  ts: string; profile: string; model: string; reason: string;
  primaryModel?: string; error?: string; ms?: number;
}) {
  try { appendFileSync(FALLBACK_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export interface TurnUsage { prompt: number; completion: number; model: string }

/** wq#1660: a non-2xx gateway response, with the status kept machine-readable
 *  so the ladder can tell a deterministic 4xx from a transient failure. */
export class GatewayError extends Error {
  constructor(msg: string, readonly status: number) { super(msg); this.name = "GatewayError"; }
}

/** wq#1660: every rung is dead (terminal 4xx) — the run has no brain at all.
 *  live_agent.ts catches this BY NAME and holds in place instead of walking
 *  the failStreak -> teardown -> resume path: a reboot exists to roll back to
 *  a better checkpoint, and a dead brain writes no checkpoints to roll to. */
export class BrainUnreachableError extends Error {
  constructor(msg: string, readonly rungs: { model: string; error: string }[]) {
    super(msg); this.name = "BrainUnreachableError";
  }
}

/** True for the 4xx family that re-asking cannot fix: budget exceeded (400),
 *  bad/disallowed key (401/403), invalid model (400/404)... 429 is a rate
 *  limit and 408 a gateway-side timeout — both transient, both left to the
 *  ordinary breaker. */
export function isTerminal4xx(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429 && status !== 408;
}

/** One attempt target. `terminal` rungs are never skipped by the breaker, so a
 *  turn always makes at least one real request. */
interface Rung { model: string; timeoutMs: number; attempts: number; terminal: boolean }

/** wq#1584: primary-fail history is MODULE state keyed by MODEL, not instance
 *  state. live_agent.ts builds a fresh Brain for every agent reboot cycle
 *  (live_agent.ts:667) — during an outage that is one every ~57s — so an
 *  instance counter was always wiped before "3 fails in 10min" could trip.
 *  The evidence that it never tripped: zero isis_alert rows across every
 *  events/*.jsonl on disk, and one primary_fail_threshold row in the whole of
 *  fallback_stats.jsonl, over a run that includes wq#1578's 14h of 401s.
 *  Keyed by model so swapping the primary starts a clean history instead of
 *  inheriting the retired model's. Process-scoped on purpose: a restart of the
 *  service is live_agent's dead-cycle alert to report, not this one's. */
interface PrimaryFailState { times: number[]; alerted: boolean }
const primaryFails = new Map<string, PrimaryFailState>();

/** Probes and tools build many Brains in one process, and the history above now
 *  outlives the instance — without this they would inherit each other's. */
export function resetPrimaryFailTracking() { primaryFails.clear(); }

export class Brain {
  private stallTurns = 0;
  private escalatedLeft = 0;
  /** wq#907 breaker state, per model: consecutive failures, and the epoch ms
   *  until which the rung is presumed saturated and skipped. */
  private rungFails = new Map<string, number>();
  private rungOpenUntil = new Map<string, number>();
  /** wq#1660 dead rungs: epoch ms until which a rung that answered a terminal
   *  4xx is skipped outright (terminal rung included — see isTerminal4xx), and
   *  the error text that killed it, kept for BrainUnreachableError. */
  private rungDeadUntil = new Map<string, number>();
  private rungDeadErr = new Map<string, string>();
  totalPrompt = 0; totalCompletion = 0;
  constructor(private bus: EventBus) {}

  /** One TURN the primary model did not serve — it failed, or it was skipped
   *  because the rung is dead or breaker-open. Counting the skips is the other
   *  half of wq#1584: deadRungRecheckMs (15min) and breakerCooldownMs (10min)
   *  are both >= the alert window, so while either holds the primary out of the
   *  ladder, a counter that only sees real requests cannot reach the threshold
   *  by arithmetic. A turn the fallback rescued is still a turn the primary
   *  lost, which is the silent-fallback-spend case wq#722 wanted paged. */
  private trackPrimaryFail(model: string, reason: string) {
    const now = Date.now();
    const st = primaryFails.get(model) ?? { times: [], alerted: false };
    primaryFails.set(model, st);
    st.times = st.times.filter(t => now - t < CFG.brain.primaryFailWindowMs);
    st.times.push(now);
    if (st.times.length < CFG.brain.primaryFailThreshold || st.alerted) return;
    // Latched until the primary serves again: one page per outage per process.
    // Duration reporting belongs to live_agent's brain_unreachable/dead-cycle
    // lines, which already run every 60s while the hold is in force.
    st.alerted = true;
    const mins = Math.round(CFG.brain.primaryFailWindowMs / 60_000);
    const msg = `LPP primary brain (${model}) failed ${st.times.length} turns in ${mins}min — last: ${reason}`;
    this.bus.emit("tool_call", { tool: "isis_alert", level: "critical", source: "brain", msg });
    console.error(`[brain] CRITICAL: ${msg}`);
    logFallback({ ts: new Date(now).toISOString(), profile: "isis_health",
      model, reason: "primary_fail_threshold", error: reason });
  }

  /** The primary served the turn: history and the alert latch both clear, so a
   *  second outage later in the same process pages again. */
  private trackPrimaryOk(model: string) { primaryFails.delete(model); }

  reportProgress(progressed: boolean) {
    if (progressed) { this.stallTurns = 0; return; }
    this.stallTurns++;
    if (this.stallTurns >= CFG.escalateAfterStallTurns && this.escalatedLeft === 0) {
      this.escalatedLeft = CFG.escalateForTurns;
      this.stallTurns = 0;
      this.bus.emit("tool_call", { tool: "escalate", model: CFG.profiles.escalate.model });
      logFallback({ ts: new Date().toISOString(), profile: "escalate",
        model: CFG.profiles.escalate.model, reason: `stall_${CFG.escalateAfterStallTurns}_turns`,
        primaryModel: CFG.profiles.primary.model });
    }
  }

  private pickProfile(): BrainProfile {
    if (this.escalatedLeft > 0) { this.escalatedLeft--; return CFG.profiles.escalate; }
    return CFG.profiles.primary;
  }

  overBudget(): boolean { return this.totalPrompt + this.totalCompletion > CFG.runTokenBudget; }

  /** The profile's own model first (generous deadline), then the configured
   *  cloud rungs (short deadline). Duplicates collapse, so a profile that is
   *  already pointed at a fallback model does not get tried twice. */
  ladder(prof: BrainProfile): Rung[] {
    const rungs: Rung[] = [];
    const seen = new Set<string>();
    const push = (model: string, timeoutMs: number) => {
      if (!model || seen.has(model)) return;
      seen.add(model);
      rungs.push({ model, timeoutMs, attempts: 1, terminal: false });
    };
    push(prof.model, CFG.brain.timeoutMs);
    for (const m of CFG.brain.fallbackModels) push(m, CFG.brain.fallbackTimeoutMs);
    const last = rungs[rungs.length - 1];
    if (last) { last.terminal = true; last.attempts = CFG.brain.terminalAttempts; }
    return rungs;
  }

  /** True while `model` is presumed to be holding a busy decode slot. */
  private breakerOpen(model: string, now: number): boolean {
    return (this.rungOpenUntil.get(model) ?? 0) > now;
  }

  private noteRungOk(model: string) {
    this.rungFails.delete(model);
    this.rungOpenUntil.delete(model);
    this.rungDeadUntil.delete(model);
    this.rungDeadErr.delete(model);
  }

  /** wq#1660: `model` answered a terminal 4xx. Unlike the breaker this skips
   *  the terminal rung too — the wq#907 "always make one real request"
   *  invariant is replaced by the explicit BrainUnreachableError below, never
   *  by a silent zero-request turn. */
  private noteRungDead(model: string, now: number, profileName: string, err: string) {
    this.rungDeadUntil.set(model, now + CFG.brain.deadRungRecheckMs);
    this.rungDeadErr.set(model, err.slice(0, 200));
    this.bus.emit("tool_call", { tool: "brain_rung_dead", model,
      recheckMs: CFG.brain.deadRungRecheckMs, error: err.slice(0, 200) });
    logFallback({ ts: new Date(now).toISOString(), profile: profileName, model,
      reason: `rung_dead_${Math.round(CFG.brain.deadRungRecheckMs / 1000)}s`, error: err.slice(0, 200) });
  }

  private rungDead(model: string, now: number): boolean {
    return (this.rungDeadUntil.get(model) ?? 0) > now;
  }

  private noteRungFail(model: string, now: number, profileName: string) {
    const n = (this.rungFails.get(model) ?? 0) + 1;
    this.rungFails.set(model, n);
    if (n < CFG.brain.breakerFails) return;
    this.rungFails.set(model, 0);
    this.rungOpenUntil.set(model, now + CFG.brain.breakerCooldownMs);
    this.bus.emit("tool_call", { tool: "brain_breaker", model,
      cooldownMs: CFG.brain.breakerCooldownMs, fails: n });
    logFallback({ ts: new Date(now).toISOString(), profile: profileName, model,
      reason: `breaker_open_${Math.round(CFG.brain.breakerCooldownMs / 1000)}s` });
  }

  /** One bounded request. The AbortSignal is the whole point: it covers connect,
   *  headers and body, so no gateway behaviour can make this outlive `timeoutMs`. */
  private async callRung(rung: Rung, prof: BrainProfile, messages: object[]): Promise<{ text: string; usage: TurnUsage }> {
    const body: any = { model: rung.model, messages, max_tokens: prof.maxTokensOut, temperature: 0.6 };
    if (prof.reasoningEffort) body.reasoning_effort = prof.reasoningEffort;
    if (prof.thinking) body.thinking = { type: prof.thinking };
    let r: Response;
    try {
      r = await fetch(CFG.gateway, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(rung.timeoutMs),
      });
    } catch (e: any) {
      // A deadline hit and a refused connection are both "this rung is not
      // answering", but only the first one means we may still be queued behind
      // someone on it, so name them apart in the log.
      if (e?.name === "TimeoutError" || e?.name === "AbortError")
        throw new Error(`deadline ${rung.timeoutMs}ms exceeded on ${rung.model}`);
      throw e;
    }
    if (!r.ok) throw new GatewayError(`gateway ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
    const d: any = await r.json();
    const msg = d.choices?.[0]?.message ?? {};
    const text = (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning_content ?? "");
    if (msg.reasoning_content) this.bus.emit("think_chunk", { model: rung.model, reasoning: msg.reasoning_content });
    if (d.choices?.[0]?.finish_reason === "length" && !(msg.content && msg.content.trim()))
      this.bus.emit("think_chunk", { model: rung.model, truncated: true });
    const usage: TurnUsage = {
      prompt: d.usage?.prompt_tokens ?? 0,
      completion: d.usage?.completion_tokens ?? 0, model: rung.model,
    };
    return { text, usage };
  }

  async complete(messages: object[], profileOverride?: BrainProfile): Promise<{ text: string; usage: TurnUsage }> {
    if (this.overBudget()) throw new Error("run token budget exhausted");
    const prof = profileOverride ?? this.pickProfile();
    const model = prof.model;
    const isPrimary = !profileOverride && model === CFG.profiles.primary.model;
    const profileName = !profileOverride ? "primary"
      : profileOverride === CFG.profiles.actRetry ? "actRetry"
      : profileOverride === CFG.profiles.escalate ? "escalate"
      : profileOverride === CFG.profiles.summarize ? "summarize"
      : profileOverride === CFG.profiles.vision ? "vision" : "unknown";
    if (profileOverride && model !== CFG.profiles.primary.model) {
      logFallback({ ts: new Date().toISOString(), profile: profileName, model,
        reason: "profile_invoked", primaryModel: CFG.profiles.primary.model });
    }
    const rungs = this.ladder(prof);
    let lastErr: any = new Error(`no brain rung configured for profile ${profileName}`);
    for (const rung of rungs) {
      const now = Date.now();
      // wq#1660: dead beats the breaker's terminal exemption. A rung the
      // gateway just answered with a deterministic 4xx cannot rescue anything;
      // re-asking it every turn IS the ~57s reboot loop of Sep 3-9 (M2).
      if (this.rungDead(rung.model, now)) {
        logFallback({ ts: new Date(now).toISOString(), profile: profileName, model: rung.model,
          reason: "rung_skipped_dead", primaryModel: model,
          error: this.rungDeadErr.get(rung.model) });
        continue;
      }
      if (!rung.terminal && this.breakerOpen(rung.model, now)) {
        logFallback({ ts: new Date(now).toISOString(), profile: profileName, model: rung.model,
          reason: "rung_skipped_breaker_open", primaryModel: model });
        continue;
      }
      for (let a = 0; a < rung.attempts; a++) {
        const started = Date.now();
        try {
          const out = await this.callRung(rung, prof, messages);
          this.totalPrompt += out.usage.prompt; this.totalCompletion += out.usage.completion;
          this.bus.emit("think_chunk", { model: rung.model, tokens: out.usage });
          this.noteRungOk(rung.model);
          if (rung.model !== model) {
            this.bus.emit("tool_call", { tool: "brain_fallback", from: model, to: rung.model });
            logFallback({ ts: new Date().toISOString(), profile: profileName, model: rung.model,
              reason: "rung_rescued_turn", primaryModel: model,
              error: String(lastErr?.message ?? lastErr).slice(0, 200) });
            if (isPrimary) this.trackPrimaryFail(model, `rescued by ${rung.model}`);
          } else if (isPrimary) {
            this.trackPrimaryOk(model);
          }
          return out;
        } catch (e: any) {
          lastErr = e;
          const ms = Date.now() - started;
          // wq#1584: the primary's outcome is booked once per TURN below, not
          // once per failed attempt — a single-model ladder retries the same
          // terminal rung twice and used to count that as two outages.
          // wq#1660: a terminal 4xx kills the rung outright — no breaker
          // bookkeeping (the slot is not busy, the request is impossible) and
          // no terminal-rung retries (the retry would get the same 4xx).
          if (e instanceof GatewayError && isTerminal4xx(e.status)) {
            this.noteRungDead(rung.model, Date.now(), profileName, String(e.message));
            break;
          }
          this.noteRungFail(rung.model, Date.now(), profileName);
          logFallback({ ts: new Date().toISOString(), profile: profileName, model: rung.model,
            reason: "rung_failed", primaryModel: model, ms,
            error: String(e?.message ?? e).slice(0, 200) });
          if (a + 1 < rung.attempts) await sleep(1500 * (a + 1));
        }
      }
    }
    // wq#1660: every rung is dead — say so by name. Distinct from an ordinary
    // all-rungs-failed throw (timeouts, 5xx), which stays retryable-by-reboot.
    const endNow = Date.now();
    // wq#1584: no rung served, so the primary did not either — including the
    // all-dead turn below, which makes zero requests and is exactly the shape
    // the 14h 401 outage took once wq#1660's dead-rung skip was in place. That
    // turn never touched `lastErr`, so report what killed the primary rung.
    if (isPrimary) {
      this.trackPrimaryFail(model, this.rungDead(model, endNow)
        ? `rung dead: ${this.rungDeadErr.get(model) ?? "?"}`
        : String(lastErr?.message ?? lastErr).slice(0, 120));
    }
    if (rungs.every(r => this.rungDead(r.model, endNow))) {
      const dead = rungs.map(r => ({ model: r.model, error: this.rungDeadErr.get(r.model) ?? "?" }));
      throw new BrainUnreachableError(
        `brain unreachable: every rung terminal — ${dead.map(d => `${d.model}: ${d.error}`).join(" | ").slice(0, 400)}`,
        dead);
    }
    throw lastErr;
  }

  async compact(oldLines: string[]): Promise<string> {
    const { text } = await this.complete([
      { role: "system", content: "Summarize this Pokemon gameplay log into 5 terse lines preserving: goals achieved, items/pokemon gained, places visited, unresolved problems. No preamble." },
      { role: "user", content: oldLines.join("\n") },
    ], CFG.profiles.summarize);
    return text;
  }
}

/** wq#1660 boot pre-flight. GET /v1/models with the service key and check every
 *  model on the TURN path (primary, escalate, actRetry, summarize + each
 *  fallback rung) is actually served to this key; GET /key/info and report the
 *  key's budget so a nearly-spent key is visible in the boot log.
 *
 *  `fatal` is only ever a DEFINITIVE negative — a 200 whose model list is
 *  missing a ladder model, or a 401/403 on the key itself. A refused
 *  connection or a 5xx is a `warn`: the gateway being down at boot is the
 *  transient the rung ladder already survives, and refusing to start on it
 *  would turn an outage into a crash loop. Off-turn-path models (vision,
 *  persona) also only warn — they degrade a feature, not the game. */
export async function preflightGateway(cfg = CFG): Promise<{ fatal: string[]; warn: string[]; budget?: { spend: number | null; maxBudget: number | null } }> {
  const fatal: string[] = [], warn: string[] = [];
  const base = cfg.gateway.replace(/\/chat\/completions\/?$/, "");   // .../v1
  const root = base.replace(/\/v1\/?$/, "");
  const headers = { Authorization: `Bearer ${apiKey()}` };
  let budget: { spend: number | null; maxBudget: number | null } | undefined;
  try {
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) {
      fatal.push(`/v1/models answered ${r.status}: the service key itself is refused — no rung can work.`);
    } else if (!r.ok) {
      warn.push(`/v1/models answered ${r.status} — cannot verify the ladder; booting on the rung ladder's own judgement.`);
    } else {
      const d: any = await r.json();
      const served = new Set<string>((d.data ?? []).map((m: any) => m.id));
      const turnPath: [string, string][] = [
        ["primary", cfg.profiles.primary.model],
        ["escalate", cfg.profiles.escalate.model],
        ["actRetry", cfg.profiles.actRetry.model],
        ["summarize", cfg.profiles.summarize.model],
        ...cfg.brain.fallbackModels.map((m, i) => [`fallback[${i}]`, m] as [string, string]),
      ];
      for (const [role, m] of turnPath)
        if (m && !served.has(m))
          fatal.push(`${role} model "${m}" is not in /v1/models for this key — every turn on it would be a 4xx (the E4 "Invalid model" shape, 1837x).`);
      for (const [role, m] of [["vision", cfg.profiles.vision.model], ["persona", cfg.profiles.persona.model]] as const)
        if (m && !served.has(m))
          warn.push(`${role} model "${m}" is not in /v1/models — that feature will fail until fixed.`);
    }
  } catch (e: any) {
    warn.push(`/v1/models unreachable (${String(e?.message ?? e).slice(0, 120)}) — cannot verify the ladder at boot.`);
  }
  try {
    const r = await fetch(`${root}/key/info`, { headers, signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      const d: any = await r.json();
      const info = d.info ?? d;
      budget = { spend: info.spend ?? null, maxBudget: info.max_budget ?? null };
    } else {
      warn.push(`/key/info answered ${r.status} — key budget unknown.`);
    }
  } catch (e: any) {
    warn.push(`/key/info unreachable (${String(e?.message ?? e).slice(0, 120)}) — key budget unknown.`);
  }
  return { fatal, warn, budget };
}
