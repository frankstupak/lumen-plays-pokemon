// wq#517: the oscillation guard, made to actually fire, and made honest about
// what it is telling the agent.
//
// WHAT WAS WRONG -- TWO THINGS, AND THE SECOND IS WORSE THAN THE FIRST.
//
// (a) agent.ts required `distinct <= 2 && thisCount >= 3` over the last 6
// warps. The loop that ran for five days was 15->59->60->61->60->61 -- FOUR
// distinct maps -- so the distinct conjunct made the WIDE loop invisible. Its
// history also lived on the Agent instance, and live_agent builds a NEW Agent
// inside its outer `for (;;)` loop, so the window reset on every continue and
// every restart while the real loop spanned 34 runs.
//
// (b) CORRECTION (rabbit15, wq#517) TO THIS FILE'S OWN FIRST DRAFT, which said
// "the distinct conjunct alone killed every trip / the guard has been dead code
// against the only pathology it was written for". THAT IS FALSE AND THE FIX
// DEPENDS ON KNOWING IT. The guard fired EIGHT times in production on
// 2026-08-13 between 03:36Z and 04:54Z (events/live-agent-1786589724686.jsonl).
// SEVEN of those eight fired on an enter_warp that returned "stuck" -- because
// agent.ts called notePotentialOscillation UNCONDITIONALLY on the brain-facing
// path, so a warp that never happened still pushed the CURRENT map into the
// arrival history. The agent sat at map60 (5,5) for three turns and the guard's
// own recent list read 59->60->60->60->60, four entries of which were non-events.
// The guard was a stuck-in-place detector wearing an oscillation label.
//
// THAT IS WHY REMOVING `distinct <= 2` IS ONLY SAFE ALONGSIDE THE CALL-SITE
// FIX. Against a history polluted by failed warps, a stationary agent trivially
// satisfies "same map >= 3 of the last 6" -- the conjunct was, by accident, the
// only thing holding the false-positive rate down. Widening the rule without
// cleaning the history would have made this guard fire MORE often on precisely
// the case it gets wrong. agent.ts now records an arrival only when
// r === "warped", matching what the auto path always did.
//
// WHAT THIS DOES NOT DO, DELIBERATELY. It does not tell the agent which way is
// forward. wq#535 established that the only exit from Mt Moon runs
// B2F(5,7) -> B1F(23,3) -> (27,3) -> Route 4 east, so the 61->60 warp is
// MANDATORY and looks backward to any rank-based test. The previous message
// said "This warp goes BACKWARD. Pick a DIFFERENT warp index", which on this
// corridor argues against the single move that leaves the cave. Repetition is
// evidence of repetition and nothing more; the message now says only that.
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/** Within a single run: this map seen this many times in this many warps. */
export const WITHIN_WINDOW = 6;
export const WITHIN_COUNT = 3;
/** Across runs, over persisted history: the slower, wider version of the same
 *  question. A loop that survives restarts is the one that cost five days. */
export const CROSS_WINDOW = 12;
export const CROSS_COUNT = 5;
const KEEP = 64;

export interface OscVerdict {
  trip: boolean;
  rule: "within" | "cross" | "none";
  map: number;
  withinCount: number; withinWindow: number;
  crossCount: number; crossWindow: number;
  recent: number[];
  message: string;
}

/** Pure assessment. `withinRun` and `crossRun` are both most-recent-last lists
 *  of map ids the agent has WARPED INTO, `crossRun` including earlier runs. */
export function assess(mapId: number, withinRun: number[], crossRun: number[]): OscVerdict {
  const recent = withinRun.slice(-WITHIN_WINDOW);
  const wide = crossRun.slice(-CROSS_WINDOW);
  const withinCount = recent.filter(m => m === mapId).length;
  const crossCount = wide.filter(m => m === mapId).length;
  // The old rule also demanded `distinct <= 2`. That conjunct is gone and is
  // not coming back: it is what made a four-map loop invisible.
  const within = recent.length >= WITHIN_WINDOW - 1 && withinCount >= WITHIN_COUNT;
  const cross = wide.length >= CROSS_WINDOW - 2 && crossCount >= CROSS_COUNT;
  const base: OscVerdict = {
    trip: within || cross, rule: within ? "within" : cross ? "cross" : "none",
    map: mapId, withinCount, withinWindow: recent.length,
    crossCount, crossWindow: wide.length, recent, message: "",
  };
  if (!base.trip) return base;
  const scope = within
    ? `${withinCount} of your last ${recent.length} warps`
    : `${crossCount} of the last ${wide.length} warps, counting previous runs`;
  base.message =
    `\n! LOOP NOTICE: map${mapId} has come up in ${scope} (recent: ${recent.join("->")}).` +
    ` This is an observation about your path, NOT a claim that the warp was wrong —` +
    ` on some maps the only way out genuinely runs back the way you came.` +
    ` If your recent goto/enter_warp attempts have been returning "stuck", the place you are aiming for` +
    ` is probably not reachable from where you are standing, and repeating it will not change that:` +
    ` try a warp index you have NOT used from this position.`;
  return base;
}

// ---- persistence: cross-run history, gitignored runtime/, fail-soft --------
// Follows the notepad (wq#486) and resume_history (wq#518) precedent: runtime/
// is already gitignored and already holds per-deployment state. Every file
// operation is wrapped, because a bookkeeping failure must never be able to
// break a turn.
interface Store { v: number; warps: number[] }

export function historyFile(): string {
  return process.env.LPP_OSC_HISTORY ?? `${process.cwd()}/runtime/warp_history.json`;
}

export function loadHistory(file: string): number[] {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Store;
    if (s && Array.isArray(s.warps)) return s.warps.filter(n => typeof n === "number").slice(-KEEP);
  } catch {}
  return [];
}

export function saveHistory(file: string, warps: number[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, warps: warps.slice(-KEEP) }));
  } catch {}
}
