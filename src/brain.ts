// LiteLLM brain client: routing, escalation, budget governance, bounded retries.
// wq#722: fallback logging + Isis health alerting (no silent DeepSeek spend).
// wq#907: every brain call is bounded in wall-clock and walks a rung ladder that
// ends somewhere that cannot itself dead-end. Rationale + knobs: CFG.brain.
import { CFG, BrainProfile } from "./config";
import { EventBus } from "./events";
import { readFileSync, appendFileSync } from "fs";

function apiKey(): string {
  for (const f of ["/home/lumen/agent/.env"]) {
    try {
      const m = readFileSync(f, "utf8").match(/LITELLM_(?:MASTER_)?KEY=(\S+)/);
      if (m) return m[1];
    } catch {}
  }
  return "sk-local";
}

// wq#907: overridable so a probe's rung failures do not land in the production
// stats file that incident review reads.
const FALLBACK_LOG = process.env.LPP_FALLBACK_LOG ?? "/home/lumen/pokemon/fallback_stats.jsonl";
const PRIMARY_FAIL_WINDOW_MS = 10 * 60 * 1000;
const PRIMARY_FAIL_THRESHOLD = 3;

function logFallback(entry: {
  ts: string; profile: string; model: string; reason: string;
  primaryModel?: string; error?: string; ms?: number;
}) {
  try { appendFileSync(FALLBACK_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export interface TurnUsage { prompt: number; completion: number; model: string }

/** One attempt target. `terminal` rungs are never skipped by the breaker, so a
 *  turn always makes at least one real request. */
interface Rung { model: string; timeoutMs: number; attempts: number; terminal: boolean }

export class Brain {
  private stallTurns = 0;
  private escalatedLeft = 0;
  private primaryFailTimes: number[] = [];
  private isisAlerted = false;
  /** wq#907 breaker state, per model: consecutive failures, and the epoch ms
   *  until which the rung is presumed saturated and skipped. */
  private rungFails = new Map<string, number>();
  private rungOpenUntil = new Map<string, number>();
  totalPrompt = 0; totalCompletion = 0;
  constructor(private bus: EventBus) {}

  private trackPrimaryFail(err: string) {
    const now = Date.now();
    this.primaryFailTimes.push(now);
    this.primaryFailTimes = this.primaryFailTimes.filter(t => now - t < PRIMARY_FAIL_WINDOW_MS);
    if (this.primaryFailTimes.length >= PRIMARY_FAIL_THRESHOLD && !this.isisAlerted) {
      this.isisAlerted = true;
      const msg = `LPP primary brain (${CFG.profiles.primary.model}) failed ${this.primaryFailTimes.length}x in 10min`;
      this.bus.emit("tool_call", { tool: "isis_alert", level: "critical", source: "brain", msg });
      console.error(`[brain] CRITICAL: ${msg}`);
      logFallback({ ts: new Date().toISOString(), profile: "isis_health",
        model: CFG.profiles.primary.model, reason: "primary_fail_threshold", error: err });
    }
  }

  private trackPrimaryOk() { this.primaryFailTimes = []; this.isisAlerted = false; }

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
    if (!r.ok) throw new Error(`gateway ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
          } else if (isPrimary) {
            this.trackPrimaryOk();
          }
          return out;
        } catch (e: any) {
          lastErr = e;
          const ms = Date.now() - started;
          if (isPrimary && rung.model === model) this.trackPrimaryFail(String(e));
          this.noteRungFail(rung.model, Date.now(), profileName);
          logFallback({ ts: new Date().toISOString(), profile: profileName, model: rung.model,
            reason: "rung_failed", primaryModel: model, ms,
            error: String(e?.message ?? e).slice(0, 200) });
          if (a + 1 < rung.attempts) await sleep(1500 * (a + 1));
        }
      }
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
