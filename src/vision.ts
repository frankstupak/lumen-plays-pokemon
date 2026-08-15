// wq#621 — VISION VERDICT VALVE (Option B, research reports/vision_research_brief.md).
// An escalation-ONLY VLM consult, not a per-turn channel and not a brain swap.
//
// WHY escalation-only: the research brief's symbolic ceiling finding — every
// harness that actually beat Gen1 (CPP, GPP, PokeAgent winners) got its
// reliability from RAM/text, and Google's own Gemini 2.5 report says the
// pixel channel was "roughly as well as without the vision information" at
// this model class. Vision earns its keep only where symbolic perception has
// DEMONSTRABLY failed: repeated stuck navigation at the same tile.
//
// THE VALVE, precise:
//  * TRIGGER: VisionValve.recordStuck() fires true exactly once per stuck
//    streak, the instant the streak reaches `stuckN` consecutive stuck_dumps
//    at an unchanged (map,x,y) — not before, and not again for the same
//    streak. Moving to a different tile resets the streak (a fresh N is
//    required to re-trigger there or anywhere else).
//  * BUDGET: tryConsumeBudget() is a sliding 1-hour window capped at
//    `maxPerHour`; call N+1 within the hour is refused and the caller must
//    log the refusal (agent.ts emits a board-visible tool_call event).
//  * OUTPUT: consultVision() returns a hint string only. It is written to the
//    notepad's GUIDANCE channel (harness-derived, regenerated, never
//    persisted as a brain memory) under its own "VISION" key — never spliced
//    into RAM-derived state, never allowed to overrule the ASCII grid.
//  * COST: routes through Brain.complete(), which already emits a
//    think_chunk carrying `tokens: {model, prompt, completion}` — the kiosk
//    token metric (wq#612) picks up model="lumen-vision" for free, no
//    separate accounting needed here.
import { Brain } from "./brain";
import { CFG } from "./config";

export interface StuckPos { map: number; x: number; y: number }

/** Pure trigger + budget bookkeeping — no I/O, unit-testable without an
 *  emulator or network (see probe_vision621.ts). */
export class VisionValve {
  private lastPos: StuckPos | null = null;
  private streak = 0;
  private trippedThisStreak = false;
  private callTimestamps: number[] = [];   // ms epoch, sliding 1h window

  constructor(
    private stuckN = CFG.visionValve.stuckN,
    private maxPerHour = CFG.visionValve.maxPerHour,
    private now: () => number = () => Date.now(),
  ) {}

  private static samePos(a: StuckPos, b: StuckPos): boolean {
    return a.map === b.map && a.x === b.x && a.y === b.y;
  }

  /** Feed one stuck_dump. Returns true exactly once per streak, the moment
   *  the streak first reaches `stuckN`. */
  recordStuck(pos: StuckPos): boolean {
    if (this.lastPos && VisionValve.samePos(this.lastPos, pos)) this.streak++;
    else { this.streak = 1; this.trippedThisStreak = false; }
    this.lastPos = pos;
    if (this.streak >= this.stuckN && !this.trippedThisStreak) {
      this.trippedThisStreak = true;
      return true;
    }
    return false;
  }

  /** true + records the call if the hourly budget has room; false = refused
   *  (caller does NOT get to call vision this time — no side effect either way
   *  beyond the timestamp bookkeeping). */
  tryConsumeBudget(): boolean {
    const t = this.now();
    const cutoff = t - 3_600_000;
    this.callTimestamps = this.callTimestamps.filter(ts => ts > cutoff);
    if (this.callTimestamps.length >= this.maxPerHour) return false;
    this.callTimestamps.push(t);
    return true;
  }
}

/** One escalation call: frame + ASCII grid + a fixed question. The grid is
 *  framed as ground truth on purpose — the model is asked what the IMAGE
 *  adds, not to re-derive tile layout it can get wrong (research §2: vision
 *  is the weak channel in every published harness). */
export async function consultVision(brain: Brain, frame: Buffer, grid: string): Promise<string> {
  const question =
    "The agent is stuck: repeated navigation attempts have failed at this exact position. " +
    "The ASCII grid below is ground truth for tile layout - do not contradict it. " +
    "Looking at the screenshot, what do you see that the grid does not show " +
    "(e.g. a dialog/menu open, an NPC or object blocking the path, a ledge, a sign, a cutscene)? " +
    "One or two short sentences, no preamble.";
  const messages = [{
    role: "user",
    content: [
      { type: "text", text: `${question}\n\nASCII grid:\n${grid}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${frame.toString("base64")}` } },
    ],
  }];
  const { text } = await brain.complete(messages, CFG.profiles.vision);
  return text.trim();
}
