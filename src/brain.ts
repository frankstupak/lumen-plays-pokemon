// LiteLLM brain client: routing, escalation, budget governance, bounded retries.
// wq#722: fallback logging + Isis health alerting (no silent DeepSeek spend).
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

const FALLBACK_LOG = "/home/lumen/pokemon/fallback_stats.jsonl";
const PRIMARY_FAIL_WINDOW_MS = 10 * 60 * 1000;
const PRIMARY_FAIL_THRESHOLD = 3;

function logFallback(entry: {
  ts: string; profile: string; model: string; reason: string;
  primaryModel?: string; error?: string;
}) {
  try { appendFileSync(FALLBACK_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

export interface TurnUsage { prompt: number; completion: number; model: string }

export class Brain {
  private stallTurns = 0;
  private escalatedLeft = 0;
  private primaryFailTimes: number[] = [];
  private isisAlerted = false;
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

  async complete(messages: object[], profileOverride?: BrainProfile): Promise<{ text: string; usage: TurnUsage }> {
    if (this.overBudget()) throw new Error("run token budget exhausted");
    const prof = profileOverride ?? this.pickProfile();
    const model = prof.model;
    const isPrimary = !profileOverride && model === CFG.profiles.primary.model;
    if (profileOverride && model !== CFG.profiles.primary.model) {
      const pn = profileOverride === CFG.profiles.actRetry ? "actRetry"
        : profileOverride === CFG.profiles.escalate ? "escalate"
        : profileOverride === CFG.profiles.summarize ? "summarize"
        : profileOverride === CFG.profiles.vision ? "vision" : "unknown";
      logFallback({ ts: new Date().toISOString(), profile: pn, model,
        reason: "profile_invoked", primaryModel: CFG.profiles.primary.model });
    }
    let lastErr: any = null;
    for (let i = 0; i < CFG.retries; i++) {
      try {
        const body: any = { model, messages, max_tokens: prof.maxTokensOut, temperature: 0.6 };
        if (prof.reasoningEffort) body.reasoning_effort = prof.reasoningEffort;
        if (prof.thinking) body.thinking = { type: prof.thinking };
        const r = await fetch(CFG.gateway, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`gateway ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const d: any = await r.json();
        const msg = d.choices?.[0]?.message ?? {};
        const text = (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning_content ?? "");
        if (msg.reasoning_content) this.bus.emit("think_chunk", { model, reasoning: msg.reasoning_content });
        if (d.choices?.[0]?.finish_reason === "length" && !(msg.content && msg.content.trim()))
          this.bus.emit("think_chunk", { model, truncated: true });
        const usage: TurnUsage = {
          prompt: d.usage?.prompt_tokens ?? 0,
          completion: d.usage?.completion_tokens ?? 0, model,
        };
        this.totalPrompt += usage.prompt; this.totalCompletion += usage.completion;
        this.bus.emit("think_chunk", { model, tokens: usage });
        if (isPrimary) this.trackPrimaryOk();
        return { text, usage };
      } catch (e) {
        lastErr = e;
        if (isPrimary) this.trackPrimaryFail(String(e));
        await new Promise(res => setTimeout(res, 1500 * (i + 1)));
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
