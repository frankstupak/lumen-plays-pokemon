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

// ---- wq#1178 (roadmap item 7): directed warp-edge ledger + cooldown --------
//
// THE BLIND SPOT assess() ABOVE CANNOT SEE. The live stall this fixes
// (lpp-pstack: Route 25, 407h / 8110 turns, 60% of turns reading
// `enter_warp: refused - this is the door you just arrived through`) never
// once reaches assess(). agent.ts's existing "just arrived through" refusal
// (wq#674/wq#1086) is a HARD refusal — the attempt never returns "warped",
// so it never gets pushed into mapHistory/crossRunWarps above. The
// supervisor's WARP_OSC classifier reads warp ARRIVALS; a stall made
// entirely of refusals produces zero arrivals, so it looks like nothing is
// happening at all, and the ban list never populates while the brain keeps
// retrying the identical refused call forever.
//
// A directed edge ledger answers a narrower, cheaper question than assess()
// does: "did I just arrive through THIS EXACT DOOR" — recorded from actual
// traversals only (never refusals), keyed on warp IDENTITY (map + index) per
// the wq#1086 lesson (a coordinate can land you adjacent to the door, not on
// it). Persisted the same fail-soft way as warp_history.json above, so the
// cooldown survives both a `continue` (new Agent instance) and a full
// restart — the zero-step-only check in agent.ts does not, which is exactly
// the gap this closes: take one step away and back, and the old check goes
// silent while the door is still the one you just came through.
//
// TIME-BOXED, BECAUSE THIS FILE ALREADY LEARNED THE ALTERNATIVE ONCE. A ban
// that cannot expire wedges the campaign inside whichever side it left
// unbanned (ISSUE-LOG #339, Bills House<->Route25 rev). WARP_COOLDOWN_TURNS
// is a TURN count, not a wall-clock one, for the same reason WITHIN_WINDOW
// and CROSS_WINDOW are above: turn rate swings by an order of magnitude
// between a combat-heavy stretch and an exploration-heavy one.
export interface WarpEdge {
  fromMap: number; fromIdx: number; fromX: number; fromY: number;
  toMap: number; toIdx: number; toX: number; toY: number;
  turn: number;
}

export const WARP_COOLDOWN_TURNS = 8;
const EDGE_KEEP = 64;

/** Append + cap, same ring-buffer shape as the history list above. */
export function recordEdge(edges: WarpEdge[], edge: WarpEdge): WarpEdge[] {
  const next = edges.concat([edge]);
  return next.length > EDGE_KEEP ? next.slice(-EDGE_KEEP) : next;
}

export interface WarpCooldownVerdict { onCooldown: boolean; turnsLeft: number; via: WarpEdge | null }

/** Is (map, idx) the door the agent most recently arrived through, and is
 *  that arrival still inside its cooldown window? Only the MOST RECENT
 *  arrival through this exact door counts — an older one that already
 *  expired must not resurrect a ban (that would be the wq#517 permanent-ban
 *  wedge again, just with extra steps to get there). Pure and turn-indexed,
 *  so it is trivially unit-testable without a clock. */
export function warpCooldown(edges: WarpEdge[], map: number, idx: number,
                             currentTurn: number,
                             cooldownTurns = WARP_COOLDOWN_TURNS): WarpCooldownVerdict {
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i];
    if (e.toMap === map && e.toIdx === idx) {
      const age = currentTurn - e.turn;
      return age < cooldownTurns
        ? { onCooldown: true, turnsLeft: cooldownTurns - age, via: e }
        : { onCooldown: false, turnsLeft: 0, via: null };
    }
  }
  return { onCooldown: false, turnsLeft: 0, via: null };
}

// Persistence: a SEPARATE file from warp_history.json above. That one is an
// undirected arrival list assess() already relies on; this one is keyed on
// warp identity and must not be reshaped to fit the other's schema.
interface EdgeStore { v: number; edges: WarpEdge[] }

export function edgeHistoryFile(): string {
  return process.env.LPP_WARP_EDGE_HISTORY ?? `${process.cwd()}/runtime/warp_edges.json`;
}

export function loadEdges(file: string): WarpEdge[] {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as EdgeStore;
    if (s && Array.isArray(s.edges)) {
      return s.edges.filter(e => e && typeof e.toMap === "number" && typeof e.toIdx === "number"
        && typeof e.fromMap === "number" && typeof e.fromIdx === "number"
        && typeof e.turn === "number").slice(-EDGE_KEEP);
    }
  } catch {}
  return [];
}

export function saveEdges(file: string, edges: WarpEdge[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, edges: edges.slice(-EDGE_KEEP) }));
  } catch {}
}
