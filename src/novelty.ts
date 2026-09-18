// wq#1179: tile-novelty tracker + composite progress scalar (the PWhiddy borrow).
//
// WHY THIS EXISTS
//   Every stall axis in this repo answers "has storyScore/badges/eventFlags
//   moved" on a WALL-CLOCK window (lpp_stuck_mode.py: 2h; lpp_frontier.py: 12h).
//   That axis cannot tell productive grinding (levels rising, new ground being
//   covered) from a gym<->center shuffle (nothing rising) until the clock runs
//   out, and it says nothing at all about exploration: grep confirmed there was
//   no visited-tile tracking anywhere in src/ before this file. The live 60%-
//   refused-warp stall that motivated this ticket ran with stuck_mode=None and
//   the sentinels silent for twelve days — the detector was blind, not wrong.
//
//   PWhiddy's reward is `levels + badges + event flags + exploration novelty`.
//   The first three already exist here (state.ts storyScore, badgeCount, party
//   levels). This adds the fourth and composes all of them into ONE scalar P,
//   sampled once per turn, so a stall can be stated as "dP == 0 over N TURNS"
//   instead of "nothing moved for H hours". Turn rate varies by an order of
//   magnitude between brain-driven and deterministic turns, which is why the
//   window is counted in samples and not in hours.
//
// OBSERVE-ONLY. Nothing in this file feeds a gameplay decision. agent.ts calls
// observe() once per turn and the result goes to the event bus and two files
// under runtime/; the consumer is tools/lpp_stuck_mode.py, and even there the
// dP axis only drives `stalled` behind an explicit flag. Same shipping order
// metrics.ts followed (wq#503): measure first, act later, with the measurement
// on disk to argue from.
//
// wq#1731 is the "act later": src/explore.ts reads the sample window back
// through recent() to trigger the exploration override. It never writes here,
// so this module's contract (and lpp_stuck_mode.py's view of it) is unchanged.
//
// WHAT A "TILE" IS HERE, PRECISELY. One sample per turn, taken at the turn's
// END position (the same `after` read that writes the turn summary), keyed
// (map,x,y). Steps taken INSIDE a nav.goto are not counted — nav_trace (wq#542)
// carries them and a future refinement could fold them in. The consequence is
// worth stating plainly: `newTiles` is 0 or 1 per turn, never 20, so novelty
// here measures "did this turn end somewhere new", not "how much ground did
// this turn cover". That is the weaker signal, and it is still sufficient for
// both cases the detector has to separate — a re-entry loop ends every turn on
// a tile it has already stood on (novelty 0), ordinary exploration does not.
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/** Composite weights. Tiers only need to be NON-FUNGIBLE PER SAMPLE: because a
 *  sample can add at most MAX_NEW_TILES_PER_SAMPLE tile, no single turn of
 *  wandering can fake the point value of a level, a dex entry, a badge or a
 *  story flag. They are deliberately NOT non-fungible in absolute terms (1000
 *  tiles do sum to one story flag) and they do not need to be: the detector
 *  tests dP != 0, never P against a threshold. */
export const WEIGHTS = { story: 1000, badge: 500, level: 10, dex: 5, tile: 1 };

/** End-of-turn sampling means a sample can discover at most one new tile. */
export const MAX_NEW_TILES_PER_SAMPLE = 1;

/** Default stall window, in SAMPLES (== turns). At the live agent's cadence a
 *  turn is ~20-60s, so 40 turns is roughly 15-40 minutes — materially faster
 *  than lpp_stuck_mode.py's 2h clock, and long enough that a legitimately slow
 *  stretch (a long dialog chain, a menu sequence, a cave crossing that ends
 *  each turn on ground already walked) does not trip it. tools/lpp_stuck_mode.py
 *  PARSES this constant rather than retyping it; see dp_window_turns() there. */
export const DP_WINDOW_TURNS = 40;

/** Samples retained in runtime/progress.json. Bounded like every other runtime
 *  file in this repo (oscillation.ts KEEP=64, events.ts rotation): a multi-day
 *  run must not grow an unbounded log. 512 samples is >10x the widest window
 *  any consumer asks for. */
export const KEEP_SAMPLES = 512;

/** Hard cap on the visited-tile set. Kanto is tens of thousands of walkable
 *  tiles, so this is not expected to bind; it exists so a corrupt map read
 *  (garbage coordinates during a map load) cannot grow the file without limit.
 *  Past the cap the set stops accepting tiles and says so (`saturated`), which
 *  matters because novelty collapsing to 0 would otherwise be indistinguishable
 *  from a real stall. */
export const MAX_TILES = 100000;

export interface ProgressParts {
  storyScore: number;
  badges: number;
  levelSum: number;
  pokedexOwned: number;
  uniqueTiles: number;
}

export interface ProgressSample extends ProgressParts {
  seq: number;      // monotonic across runs — turn numbers reset on every reboot
  turn: number;     // this run's turn counter, for reading logs next to it
  ts: number;       // epoch ms
  map: number; x: number; y: number;
  newTiles: number; // 0 or 1 (see MAX_NEW_TILES_PER_SAMPLE)
  P: number;
  saturated?: true; // tile set hit MAX_TILES: novelty is capped, not absent
}

export interface DeltaP {
  ok: boolean;
  samples: number;      // samples actually in the window
  windowTurns: number;  // window asked for
  complete: boolean;    // window full — a partial window never claims a stall
  spanTurns: number;    // seq span covered by the window
  dP: number;
  newTiles: number;     // tiles discovered inside the window
  flat: boolean;        // complete && dP <= 0
  first: number; last: number;   // P at both ends
}

/** The state fields P is computed from. Structurally satisfied by GameState
 *  (state.ts) — declared as its own shape so this module stays importable by
 *  probes and tools without dragging the emulator in. */
export interface StateLike {
  map: number; x: number; y: number;
  partyCount: number;
  party: { level: number }[];
  badgeCount: number;
  pokedexOwned: number;
  storyScore: number;
}

export function tileKey(map: number, x: number, y: number): string {
  return `${map},${x},${y}`;
}

export function levelSum(st: StateLike): number {
  return st.party.slice(0, Math.max(0, Math.min(st.partyCount, 6)))
    .reduce((s, p) => s + (p?.level ?? 0), 0);
}

/** P = 1000*storyScore + 500*badges + 10*levelSum + 5*pokedexOwned + 1*tiles. */
export function composite(p: ProgressParts): number {
  return WEIGHTS.story * p.storyScore + WEIGHTS.badge * p.badges +
         WEIGHTS.level * p.levelSum + WEIGHTS.dex * p.pokedexOwned +
         WEIGHTS.tile * p.uniqueTiles;
}

/** dP over the last `windowTurns` SAMPLES (not hours, not turn ids — turn ids
 *  restart at 1 on every reboot and the loop this detects outlives reboots).
 *
 *  `flat` is deliberately `dP <= 0` and not `dP === 0`: levelSum is the one
 *  component that can fall (a mon deposited at a PC), and a run that went
 *  BACKWARDS on the composite is not making progress either. It also requires
 *  a COMPLETE window — a fresh boot with three samples has not yet earned the
 *  right to call anything stalled. */
export function deltaP(samples: ProgressSample[], windowTurns = DP_WINDOW_TURNS): DeltaP {
  const w = Math.max(2, Math.floor(windowTurns));
  const win = (samples ?? []).slice(-w);
  if (win.length < 2) {
    return { ok: false, samples: win.length, windowTurns: w, complete: false,
             spanTurns: 0, dP: 0, newTiles: 0, flat: false, first: 0, last: 0 };
  }
  const first = win[0], last = win[win.length - 1];
  const dP = last.P - first.P;
  const complete = win.length >= w;
  return {
    ok: true, samples: win.length, windowTurns: w, complete,
    spanTurns: last.seq - first.seq,
    dP, newTiles: win.reduce((s, x) => s + (x.newTiles ?? 0), 0),
    flat: complete && dP <= 0,
    first: first.P, last: last.P,
  };
}

// ---- persistence: runtime/, bounded, fail-soft ----------------------------
// Same contract as oscillation.ts's warp history (wq#517): runtime/ is already
// gitignored and already holds per-deployment state, and every file operation
// is wrapped, because a bookkeeping failure must never be able to break a turn.
// Both paths take an env override so probes cannot write into a live
// deployment's history (the wq#517 probe-isolation lesson, in this file's
// probe: probe_novelty1179.ts).

interface TileStore { v: number; tiles: string[]; saturated?: boolean }
interface ProgStore { v: number; seq: number; samples: ProgressSample[] }

export function tilesFile(dir?: string): string {
  return process.env.LPP_VISITED_TILES ?? `${dir ?? `${process.cwd()}/runtime`}/visited_tiles.json`;
}

export function progressFile(dir?: string): string {
  return process.env.LPP_PROGRESS_LOG ?? `${dir ?? `${process.cwd()}/runtime`}/progress.json`;
}

export function loadTiles(file: string): { tiles: Set<string>; saturated: boolean } {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as TileStore;
    if (s && Array.isArray(s.tiles)) {
      return {
        tiles: new Set(s.tiles.filter(t => typeof t === "string").slice(0, MAX_TILES)),
        saturated: !!s.saturated,
      };
    }
  } catch {}
  return { tiles: new Set<string>(), saturated: false };
}

export function loadSamples(file: string): { seq: number; samples: ProgressSample[] } {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as ProgStore;
    if (s && Array.isArray(s.samples)) {
      const samples = s.samples.filter(x => x && typeof x.P === "number").slice(-KEEP_SAMPLES);
      const seq = typeof s.seq === "number" ? s.seq
        : (samples.length ? samples[samples.length - 1].seq ?? samples.length : 0);
      return { seq, samples };
    }
  } catch {}
  return { seq: 0, samples: [] };
}

function writeJson(file: string, data: object): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch {}
}

export interface TrackerOpts {
  dir?: string;                      // <base>/runtime; env overrides win
  bus?: { emit(kind: any, data: object): void };
  windowTurns?: number;
}

/** Per-run holder of the cross-run visited-tile set and the P sample log.
 *  Construct once per Agent; both files carry state forward across reboots,
 *  which is the whole point — the loops this is meant to see span restarts. */
export class NoveltyTracker {
  private tiles: Set<string>;
  private saturated: boolean;
  private samples: ProgressSample[];
  private seq: number;
  private tilesPath: string;
  private progPath: string;
  private window: number;

  constructor(private opts: TrackerOpts = {}) {
    this.tilesPath = tilesFile(opts.dir);
    this.progPath = progressFile(opts.dir);
    this.window = opts.windowTurns ?? DP_WINDOW_TURNS;
    const t = loadTiles(this.tilesPath);
    this.tiles = t.tiles;
    this.saturated = t.saturated || t.tiles.size >= MAX_TILES;
    const p = loadSamples(this.progPath);
    this.samples = p.samples;
    this.seq = p.seq;
  }

  uniqueTiles(): number { return this.tiles.size; }
  recent(): ProgressSample[] { return this.samples.slice(); }
  /** The newest sample's seq — monotonic across restarts, unlike Agent.turn, so
   *  it is what any budget that must survive one counts in (wq#1839). */
  lastSeq(): number { return this.seq; }
  delta(windowTurns = this.window): DeltaP { return deltaP(this.samples, windowTurns); }

  /** Record one turn. Returns the sample; emits a `progress` event carrying the
   *  sample plus the current dP window, which is what tools/kiosk read. */
  observe(turn: number, st: StateLike): ProgressSample {
    const key = tileKey(st.map, st.x, st.y);
    let newTiles = 0;
    if (!this.tiles.has(key)) {
      if (this.tiles.size < MAX_TILES) { this.tiles.add(key); newTiles = 1; }
      else this.saturated = true;
    }
    const parts: ProgressParts = {
      storyScore: st.storyScore, badges: st.badgeCount, levelSum: levelSum(st),
      pokedexOwned: st.pokedexOwned, uniqueTiles: this.tiles.size,
    };
    const sample: ProgressSample = {
      seq: ++this.seq, turn, ts: Date.now(),
      map: st.map, x: st.x, y: st.y, newTiles,
      ...parts, P: composite(parts),
      ...(this.saturated ? { saturated: true as const } : {}),
    };
    this.samples.push(sample);
    if (this.samples.length > KEEP_SAMPLES) this.samples = this.samples.slice(-KEEP_SAMPLES);
    // The tile file is only rewritten when it changed; the sample log every
    // turn (it is bounded at KEEP_SAMPLES entries, so the write stays small).
    if (newTiles) writeJson(this.tilesPath, { v: 1, tiles: [...this.tiles], saturated: this.saturated });
    writeJson(this.progPath, { v: 1, seq: this.seq, samples: this.samples });
    const d = this.delta();
    this.opts.bus?.emit("progress", {
      turn, seq: sample.seq, P: sample.P, newTiles, uniqueTiles: this.tiles.size,
      storyScore: parts.storyScore, badges: parts.badges, levelSum: parts.levelSum,
      pokedexOwned: parts.pokedexOwned,
      dP: d.dP, dPWindow: d.windowTurns, dPSamples: d.samples,
      dPComplete: d.complete, dPFlat: d.flat, dPNewTiles: d.newTiles,
      saturated: this.saturated || undefined,
    });
    return sample;
  }
}
