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

// ---- wq#1178: the DIRECTED warp-edge ledger -------------------------------
//
// WHY THE HISTORY ABOVE IS NOT ENOUGH. `warps` is a list of ARRIVAL MAP IDS.
// It can say "map59 keeps coming up" and nothing else — not which door fired,
// not what the door was left for, not whether the trip bought anything. The
// live stall this was written for (wq#1178: 60% of turns returning
// "enter_warp: refused - this is the door you just arrived through", frontier
// frozen at Route 25 for 407h / 8110 turns) is invisible on that axis twice
// over: a refused warp records no arrival at all, and a door-bounce pair
// A->B->A leaves the same two map ids as a legitimate there-and-back.
//
// An EDGE is (fromMap, warpIndex, toMap) plus the timestamp and the visited-
// tile count at the moment it fired. Two things follow that the map list
// cannot give:
//   * the WARPS line can be annotated per DOOR ("taken 4x in the last 10
//     warps, 0 new tiles since"), so the cost of a door is visible at the
//     moment the brain picks one, not two turns later in a LOOP NOTICE;
//   * an alternating pair can be detected as such, and the offending doors
//     put on a TIME-BOXED cooldown.
//
// TIME-BOXED, AND wq#517's LESSON IS WHY. A permanent ban wedges: the only
// exit from Mt Moon runs back the way you came, and a rule with no expiry
// would eventually forbid the one move that leaves. Every cooldown here dies
// two ways — a wall-clock deadline, and the FIRST NEW TILE the agent reaches
// (novelty.ts's visited set). The second matters more than the first: a
// cooldown that was wrong costs one step to lift, because any move that
// actually goes somewhere clears it immediately.

export interface WarpEdge {
  from: number;   // map the warp was fired FROM
  idx: number;    // warp index on that map (the door's identity, not its tile)
  to: number;     // map actually landed on (read after the warp, never predicted)
  ts: number;
  tiles: number;  // novelty.ts uniqueTiles() at the moment it fired
}

export interface WarpCooldown {
  key: string;
  from: number; idx: number; to: number;
  untilTs: number;   // wall-clock expiry
  tilesAt: number;   // lifts as soon as uniqueTiles() exceeds this
  reason: string;
  /** "bounce" — an alternating pair that bought nothing; the door WORKED and
   *  the trip was the waste. "refusal" — the door never fired at all, the same
   *  request was refused N times running, and the only thing being asked for is
   *  a move. A refusal cooldown is therefore satisfied BY that move and is
   *  dropped on it (dropRefusalCooldowns); a bounce cooldown is not, because a
   *  step does not make the round trip productive. Absent on records written
   *  before this field existed, which read as "bounce" — the conservative side. */
  kind?: "bounce" | "refusal";
}

/** Edges considered when annotating a door and when looking for a pair. Ten is
 *  the plan's own figure ("taken 4x in last 10 warps") and roughly two round
 *  trips' worth of slack past the trip threshold. */
export const EDGE_WINDOW = 10;
/** A door is annotated from the second time it appears in the window: once is
 *  a trip, twice is a pattern worth a token. */
export const EDGE_ANNOTATE_MIN = 2;
/** Round trips over the SAME map pair before its doors go on cooldown. Two
 *  means four warps spent to end up where you started. */
export const PAIR_TRIPS = 2;
/** Cooldown deadline. At the live agent's ~20-60s/turn cadence this is on the
 *  order of 10-30 turns — long enough to force a different plan, short enough
 *  that a false positive costs less than the loop it interrupts. */
export const COOLDOWN_MS = 10 * 60_000;
const KEEP_EDGES = 64;

export function edgeKey(from: number, idx: number, to: number): string {
  return `${from}:${idx}->${to}`;
}

export interface EdgeStore { edges: WarpEdge[]; cools: WarpCooldown[] }

export function edgesFile(dir?: string): string {
  return process.env.LPP_WARP_EDGES ?? `${dir ?? `${process.cwd()}/runtime`}/warp_edges.json`;
}

export function loadEdges(file: string): EdgeStore {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<EdgeStore>;
    const edges = Array.isArray(s?.edges)
      ? s!.edges!.filter(e => e && typeof e.from === "number" && typeof e.idx === "number" &&
                              typeof e.to === "number").slice(-KEEP_EDGES)
      : [];
    const cools = Array.isArray(s?.cools)
      ? s!.cools!.filter(c => c && typeof c.key === "string" && typeof c.untilTs === "number")
      : [];
    return { edges, cools };
  } catch {}
  return { edges: [], cools: [] };
}

export function saveEdges(file: string, s: EdgeStore): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      v: 1, edges: s.edges.slice(-KEEP_EDGES), cools: s.cools,
    }));
  } catch {}
}

/** How often this DOOR (from-map + index, direction included) fired in the
 *  window, and the visited-tile count when it first did. */
export function doorUsage(edges: WarpEdge[], from: number, idx: number,
                          window = EDGE_WINDOW): { count: number; window: number; tilesAt: number | null } {
  const win = edges.slice(-window);
  const hits = win.filter(e => e.from === from && e.idx === idx);
  return { count: hits.length, window: win.length, tilesAt: hits.length ? hits[0].tiles : null };
}

/** The per-door annotation for the WARPS line, or null when there is nothing
 *  worth spending tokens on. `tilesNow` is novelty.ts's uniqueTiles(). */
export function doorAnnotation(edges: WarpEdge[], from: number, idx: number,
                               tilesNow: number, window = EDGE_WINDOW): string | null {
  const u = doorUsage(edges, from, idx, window);
  if (u.count < EDGE_ANNOTATE_MIN) return null;
  const gained = u.tilesAt === null ? null : tilesNow - u.tilesAt;
  const novelty = gained === null ? "" : `, ${gained} new tiles since`;
  return `taken ${u.count}x in last ${u.window} warps${novelty}`;
}

/** Round trips per unordered map pair inside the window. A round trip is two
 *  ADJACENT edges that undo each other: A->B immediately followed by B->A.
 *  Adjacency is deliberate — A->B, a productive detour, then B->A is a route,
 *  not a bounce, and only the bounce is worth acting on.
 *
 *  Trips do not OVERLAP. In A->B->A->B->A a sliding window finds three
 *  reversals in four warps and would reach PAIR_TRIPS after three; consuming
 *  each pair keeps `trips` meaning what the word says, so the threshold below
 *  is stated in whole there-and-backs and PAIR_TRIPS=2 costs four warps. */
export function roundTrips(edges: WarpEdge[], window = EDGE_WINDOW):
    Map<string, { a: number; b: number; trips: number; tilesAt: number; doors: WarpEdge[] }> {
  const win = edges.slice(-window);
  const out = new Map<string, { a: number; b: number; trips: number; tilesAt: number; doors: WarpEdge[] }>();
  for (let i = 0; i + 1 < win.length; i++) {
    const e = win[i], f = win[i + 1];
    if (e.to !== f.from || f.to !== e.from || e.from === e.to) continue;
    const a = Math.min(e.from, e.to), b = Math.max(e.from, e.to);
    const k = `${a}<->${b}`;
    const prev = out.get(k);
    if (prev) { prev.trips++; prev.doors.push(e, f); }
    else out.set(k, { a, b, trips: 1, tilesAt: e.tiles, doors: [e, f] });
    i++;   // consume the pair: trips never overlap
  }
  return out;
}

/** Cooldowns the ledger justifies right now that are not already live. Trips
 *  alone are not enough: the pair must also have bought NOTHING (no new tile
 *  since the pattern started), which is what separates a bounce from a
 *  corridor that legitimately runs back and forth past new ground. */
export function assessCooldowns(edges: WarpEdge[], nowTs: number, tilesNow: number,
                                existing: WarpCooldown[]): WarpCooldown[] {
  const live = new Set(existing.filter(c => coolActive(c, nowTs, tilesNow)).map(c => c.key));
  const fresh: WarpCooldown[] = [];
  for (const [pair, t] of roundTrips(edges)) {
    if (t.trips < PAIR_TRIPS) continue;
    if (tilesNow > t.tilesAt) continue;   // the loop DID find new ground: not a bounce
    const seen = new Set<string>();
    for (const d of t.doors) {
      const key = edgeKey(d.from, d.idx, d.to);
      if (seen.has(key) || live.has(key)) continue;
      seen.add(key);
      fresh.push({
        key, from: d.from, idx: d.idx, to: d.to,
        untilTs: nowTs + COOLDOWN_MS, tilesAt: tilesNow, kind: "bounce",
        reason: `${pair} alternated ${t.trips}x with 0 new tiles`,
      });
    }
  }
  return fresh;
}

/** Live iff the deadline has not passed AND no new tile has been found since
 *  it was set. Either condition alone lifts it. */
export function coolActive(c: WarpCooldown, nowTs: number, tilesNow: number): boolean {
  return nowTs < c.untilTs && tilesNow <= c.tilesAt;
}

export function activeCooldown(cools: WarpCooldown[], key: string, nowTs: number,
                               tilesNow: number): WarpCooldown | null {
  return cools.find(c => c.key === key && coolActive(c, nowTs, tilesNow)) ?? null;
}

export function pruneCooldowns(cools: WarpCooldown[], nowTs: number, tilesNow: number): WarpCooldown[] {
  return cools.filter(c => coolActive(c, nowTs, tilesNow));
}

/** Called when the agent has actually MOVED. A refusal cooldown exists only to
 *  force that move, so the move retires it — otherwise a door refused three
 *  times would stay shut for ten minutes AFTER the brain complied, which is the
 *  wq#517 wedge in miniature. Bounce cooldowns survive: a single step does not
 *  make a round trip worth repeating. */
export function dropRefusalCooldowns(cools: WarpCooldown[]): WarpCooldown[] {
  return cools.filter(c => c.kind !== "refusal");
}

export function coolMinutesLeft(c: WarpCooldown, nowTs: number): number {
  return Math.max(0, Math.ceil((c.untilTs - nowTs) / 60_000));
}
