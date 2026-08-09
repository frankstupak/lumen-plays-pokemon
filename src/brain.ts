// LiteLLM brain client: routing, escalation, budget governance, bounded retries.
import { CFG, BrainProfile } from "./config";
import { EventBus } from "./events";
import { readFileSync } from "fs";

function apiKey(): string {
  for (const f of ["/home/lumen/agent/.env"]) {
    try {
      const m = readFileSync(f, "utf8").match(/LITELLM_(?:MASTER_)?KEY=(\S+)/);
      if (m) return m[1];
    } catch {}
  }
  return "sk-local";
}

export interface TurnUsage { prompt: number; completion: number; model: string }

export class Brain {
  private stallTurns = 0;
  private escalatedLeft = 0;
  totalPrompt = 0; totalCompletion = 0;
  constructor(private bus: EventBus) {}

  reportProgress(progressed: boolean) {
    if (progressed) { this.stallTurns = 0; return; }
    this.stallTurns++;
    if (this.stallTurns >= CFG.escalateAfterStallTurns && this.escalatedLeft === 0) {
      this.escalatedLeft = CFG.escalateForTurns;
      this.stallTurns = 0;
      this.bus.emit("tool_call", { tool: "escalate", model: CFG.profiles.escalate.model });
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
        // Reasoning models can burn the whole budget narrating and emit no
        // content - flag it so metrics can count the failure mode we're fixing.
        if (d.choices?.[0]?.finish_reason === "length" && !(msg.content && msg.content.trim()))
          this.bus.emit("think_chunk", { model, truncated: true });
        const usage: TurnUsage = {
          prompt: d.usage?.prompt_tokens ?? 0,
          completion: d.usage?.completion_tokens ?? 0, model,
        };
        this.totalPrompt += usage.prompt; this.totalCompletion += usage.completion;
        this.bus.emit("think_chunk", { model, tokens: usage });
        return { text, usage };
      } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500 * (i + 1))); }
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
