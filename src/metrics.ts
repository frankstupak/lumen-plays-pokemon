// S5 metrics: observe-only run instrumentation. Subscribes to the event bus and
// derives per-run counters, then writes events/run-summary-<runTag>.json on badge
// gain or shutdown. Zero gameplay-logic coupling - pure listener.
import { writeFileSync } from "fs";
import { EventBus } from "./events";
import { BlackoutDetector } from "./blackout";

// Canonical brain-facing tool names (the SYSTEM_PREFIX tool list, exactly).
const BRAIN_TOOLS = new Set([
  "goto", "enter_warp", "leave_edge", "interact", "talk", "choose",
  "battle_move", "flee", "press", "use_item", "buy_item", "heal_at_center", "note",
]);

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
          this.m.tokensPrompt += e.tokens.prompt ?? 0;
          this.m.tokensCompletion += e.tokens.completion ?? 0;
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
}
