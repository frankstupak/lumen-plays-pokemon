// S5 metrics: observe-only run instrumentation. Subscribes to the event bus and
// derives per-run counters, then writes events/run-summary-<runTag>.json on badge
// gain or shutdown. Zero gameplay-logic coupling - pure listener.
import { writeFileSync } from "fs";
import { EventBus } from "./events";
import { BlackoutDetector } from "./blackout";

// Canonical brain-facing tool names (the SYSTEM_PREFIX tool list, exactly).
const BRAIN_TOOLS = new Set([
  "goto", "enter_warp", "leave_edge", "interact", "talk", "choose",
  "battle_move", "flee", "press", "use_item", "buy_item", "sell_item", "heal_at_center", "note",
]);

// wq#612: rolling window size for the kiosk tok/turn + tok/call tile. Same
// number for both windows so the tile's "(50t)" label is unambiguous.
const TOKEN_WINDOW = 50;

export interface TokenStats {
  perCall: { avgPrompt: number; avgCompletion: number; window: number } | null;
  perTurn: { avg: number; window: number } | null;
  perModel: Record<string, { avgPrompt: number; avgCompletion: number; calls: number }>;
  campaign: { promptTotal: number; completionTotal: number; calls: number; turns: number };
}

interface RunMetrics {
  runTag: string; startedAt: string; resumedFrom: string;
  turns: number; wallMs: number;
  tokensPrompt: number; tokensCompletion: number;
  whiteouts: number; reboots: number;
  battlesEntered: number; battlesWild: number; battlesTrainer: number;
  toolCalls: Record<string, number>;   // brain-chosen only (src:"brain"); parse junk -> _invalid
  autoCalls: Record<string, number>;   // harness/internal-layer emissions (nav, battle, unwedge...)
  autoTurns: number;                   // turns recovered by unwedge/soft-lock (no usable brain ACT)
  plannedAutoTurns: number;            // wq#472: intentional harness turns (DET:) - NOT the failure mode above
  brainTruncations: number;            // completions that hit the token cap with empty content
  itemsBought: number; itemsUsed: number;
  catchesAttempted: number; catchesSucceeded: number;
  healsAtCenter: number;
  badges: number; maxEventCount: number;
  mapsSeen: number[];
}

export class Metrics {
  private m: RunMetrics;
  private t0 = Date.now();
  private lastInBattle = 0;
  private lastBadges = 0;
  private blackout = new BlackoutDetector();
  private maps = new Set<number>();
  private dir: string;
  // wq#612: token-economics windows, ridden off the same think_chunk/turn_summary
  // events consumed below. calls = tokens-bearing think_chunks only (reasoning
  // and truncated shapes carry no usage and are not counted as calls).
  private callWindow: { prompt: number; completion: number; model: string }[] = [];
  private turnWindow: number[] = [];
  private turnPromptAcc = 0;
  private turnCompletionAcc = 0;
  private perModel: Record<string, { prompt: number; completion: number; calls: number }> = {};
  private calls = 0;

  constructor(private bus: EventBus, runTag: string, eventsDir: string) {
    this.dir = eventsDir;
    this.m = {
      runTag, startedAt: new Date().toISOString(), resumedFrom: "",
      turns: 0, wallMs: 0, tokensPrompt: 0, tokensCompletion: 0,
      whiteouts: 0, reboots: 0,
      battlesEntered: 0, battlesWild: 0, battlesTrainer: 0,
      toolCalls: {}, autoCalls: {}, autoTurns: 0, plannedAutoTurns: 0, brainTruncations: 0, itemsBought: 0, itemsUsed: 0,
      catchesAttempted: 0, catchesSucceeded: 0, healsAtCenter: 0,
      badges: 0, maxEventCount: 0, mapsSeen: [],
    };
    this.bus.on((e: any) => this.consume(e));
  }

  private consume(e: any): void {
    switch (e.kind) {
      case "boot":
        if (e.resumedFrom) this.m.resumedFrom = e.resumedFrom;
        break;
      case "state_read": {
        const ib = e.inBattle ?? 0;
        // count a new battle on any transition into a battle type that differs
        // from the last battle state (0->1, 0->2, and 1->2/2->1 back-to-back).
        if (ib > 0 && ib !== this.lastInBattle) {
          this.m.battlesEntered++;
          if (ib === 1) this.m.battlesWild++; else if (ib === 2) this.m.battlesTrainer++;
        }
        this.lastInBattle = ib;
        // wq#547: blackouts are counted from their DURABLE CONSEQUENCES, not
        // from the all-fainted edge. That edge required a state_read inside a
        // window Red closes in well under one poll interval, and it caught
        // NOTHING in 1285 sampled reads. See blackout.ts.
        if (this.blackout.observe(e)) this.m.whiteouts++;
        if (typeof e.badgeCount === "number") {
          const gained = e.badgeCount > this.lastBadges;
          this.lastBadges = e.badgeCount;
          this.m.badges = e.badgeCount;   // set first so flush() sees the new count
          if (gained) this.onBadge(e.badgeCount);
        }
        if (typeof e.map === "number") this.maps.add(e.map);
        break;
      }
      case "think_chunk":
        if (typeof e.turn === "number") this.m.turns = Math.max(this.m.turns, e.turn);
        if (e.truncated === true) this.m.brainTruncations++;
        if (e.tokens) {
          const p = e.tokens.prompt ?? 0, c = e.tokens.completion ?? 0, model = e.tokens.model ?? "unknown";
          this.m.tokensPrompt += p;
          this.m.tokensCompletion += c;
          // wq#612: per-call window + per-turn accumulator (a turn can carry more
          // than one tokens-bearing think_chunk, e.g. the actRetry profile).
          this.turnPromptAcc += p; this.turnCompletionAcc += c;
          this.callWindow.push({ prompt: p, completion: c, model });
          if (this.callWindow.length > TOKEN_WINDOW) this.callWindow.shift();
          this.calls++;
          const pm = this.perModel[model] ?? (this.perModel[model] = { prompt: 0, completion: 0, calls: 0 });
          pm.prompt += p; pm.completion += c; pm.calls++;
        }
        break;
      case "tool_call": {
        const t = e.tool ?? "unknown";
        if (e.src === "brain") {
          // Only what the brain actually chose; the ACT-line parse can yield
          // junk names (prose fragments like "at"/"map68") - bucket, don't litter.
          const name = BRAIN_TOOLS.has(t) ? t : "_invalid";
          this.m.toolCalls[name] = (this.m.toolCalls[name] ?? 0) + 1;
        } else {
          this.m.autoCalls[t] = (this.m.autoCalls[t] ?? 0) + 1;
        }
        if (t === "buy_item" && e.args?.spent) this.m.itemsBought += e.args.qty ?? 1;
        if (t === "use_item" && e.args?.used) this.m.itemsUsed++;
        if (t === "catch") { this.m.catchesAttempted++; if (e.args?.caught) this.m.catchesSucceeded++; }
        if (t === "heal_at_center" && e.args?.ok) this.m.healsAtCenter++;
        break;
      }
      case "turn_summary":
        if (typeof e.line === "string" && e.line.includes("rebooting")) this.m.reboots++;
        if (typeof e.line === "string" && e.line.includes("AUTO:")) this.m.autoTurns++;
        if (typeof e.line === "string" && e.line.includes("DET:")) this.m.plannedAutoTurns++;
        // wq#612: close the turn's token accumulator on its boundary. A turn
        // with zero tokens-bearing think_chunks (deterministic/auto turn) still
        // closes as a 0 entry — that is a real data point, not a gap.
        this.turnWindow.push(this.turnPromptAcc + this.turnCompletionAcc);
        if (this.turnWindow.length > TOKEN_WINDOW) this.turnWindow.shift();
        this.turnPromptAcc = 0; this.turnCompletionAcc = 0;
        break;
      case "checkpoint":
        if (typeof e.events === "number") this.m.maxEventCount = Math.max(this.m.maxEventCount, e.events);
        break;
    }
  }

  private onBadge(n: number): void { this.flush(`badge${n}`); }

  flush(reason = "shutdown"): void {
    this.m.wallMs = Date.now() - this.t0;
    this.m.mapsSeen = [...this.maps].sort((a, b) => a - b);
    const tot = this.m.tokensPrompt + this.m.tokensCompletion;
    const derived = {
      reason,
      tokensTotal: tot,
      tokensPerBadge: this.m.badges > 0 ? Math.round(tot / this.m.badges) : null,
      whiteoutsPerBadge: this.m.badges > 0 ? +(this.m.whiteouts / this.m.badges).toFixed(2) : null,
      catchRate: this.m.catchesAttempted > 0 ? +(this.m.catchesSucceeded / this.m.catchesAttempted).toFixed(2) : null,
      autoRate: this.m.turns > 0 ? +(this.m.autoTurns / this.m.turns).toFixed(2) : null,
      // wq#472: share of turns carried deterministically on purpose; brain-call
      // saving per run = plannedAutoTurns brain round-trips avoided.
      plannedAutoRate: this.m.turns > 0 ? +(this.m.plannedAutoTurns / this.m.turns).toFixed(2) : null,
    };
    try {
      writeFileSync(`${this.dir}/run-summary-${this.m.runTag}.json`,
        JSON.stringify({ ...this.m, derived }, null, 2));
    } catch {}
  }

  snapshot(): RunMetrics { return { ...this.m }; }

  /** wq#612: rolling tok/turn + tok/call windows, per-model split, campaign
   *  totals. Windows return null (never a divide-by-zero) until at least one
   *  entry has landed — the "--" convention the panel already follows. */
  tokenSnapshot(): TokenStats {
    const perCall = this.callWindow.length ? {
      avgPrompt: +(this.callWindow.reduce((s, c) => s + c.prompt, 0) / this.callWindow.length).toFixed(1),
      avgCompletion: +(this.callWindow.reduce((s, c) => s + c.completion, 0) / this.callWindow.length).toFixed(1),
      window: this.callWindow.length,
    } : null;
    const perTurn = this.turnWindow.length ? {
      avg: +(this.turnWindow.reduce((s, t) => s + t, 0) / this.turnWindow.length).toFixed(1),
      window: this.turnWindow.length,
    } : null;
    const perModel: Record<string, { avgPrompt: number; avgCompletion: number; calls: number }> = {};
    for (const [model, v] of Object.entries(this.perModel)) {
      perModel[model] = { avgPrompt: +(v.prompt / v.calls).toFixed(1), avgCompletion: +(v.completion / v.calls).toFixed(1), calls: v.calls };
    }
    return {
      perCall, perTurn, perModel,
      campaign: { promptTotal: this.m.tokensPrompt, completionTotal: this.m.tokensCompletion, calls: this.calls, turns: this.m.turns },
    };
  }
}
