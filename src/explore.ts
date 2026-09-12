// wq#1731: hard exploration override. When the tile-novelty window says the
// agent has stopped finding ground, take the controller away from the brain
// for K steps and walk out.
//
// WHY THIS EXISTS
//   Every existing stuck path in this repo ends at the brain. The stuck_dump /
//   oscillation / noise_storm detectors feed the vision valve, and the valve
//   writes a hint the notepad labels "does not override RAM/grid". The brain
//   reads the hint and keeps doing what it was doing. LPP ran for weeks without
//   beating Gym #2 that way. This module is the missing rung: a deterministic
//   escape that does not ask the brain, because the brain is the stuck part.
//
//   LPP is an LLM agent, not an RL agent. Frank's PokemonAgentEvaluator seed
//   was a reward scalar; nothing here trains on one, so the scalar is dropped.
//   What survives is the coordinate window idea (driven off novelty.ts rather
//   than a second tracker) and the reward WEIGHTS, re-expressed as prompt
//   salience in progressBlock() below.
//
// THE TRIGGER, AND WHY IT IS NOT "uniqueTiles < 5"
//   The v2 design asked for uniqueTiles < 5 over ~150 steps. Measured on the
//   live runtime/progress.json (2026-09-10) the agent was pacing a two-wide
//   grass strip on Route 24 (map35, x=4..5, y=19..29): rolling 150-sample
//   windows held 16-24 distinct tiles, so a tile-count threshold never fires on
//   the stall it was written for. What IS true of that stall: zero new tiles
//   and one map for 500 straight samples. So a window stalls when it is
//   COMPLETE (novelty's own rule: a partial window never claims a stall), has
//   newTiles == 0, and either holds fewer than minTiles tiles (a tight pace,
//   possibly across a door) or never left the map.
//
// SHARED STATE IS READ, NEVER WRITTEN
//   novelty samples are persisted and read by tools/lpp_stuck_mode.py, so the
//   "flush coordHistory after breakout" step is a sequence floor instead: only
//   samples observed after the last override ended count toward the next one.
//   The floor is recovered from the override log on boot so a restart cannot
//   re-fire on the window the previous run already acted on.
//
//   Telemetry does NOT go into runtime/stuck_escalation.json. That file is
//   single-writer state for tools/lpp_stuck_feedback.py (load, modify,
//   os.replace, no lock); a second writer would lose updates in both
//   directions and could drop an incident's ticketId. Fires go to the sibling
//   runtime/stuck_escalation_overrides.jsonl, append-only, plus an
//   `exploration_override` bus event.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { dirname } from "path";
import { deltaP, tileKey, type ProgressSample } from "./novelty";
import { BADGE_NAMES } from "./names";
import { BALL_PRICE, ballMarts } from "./economy";   // wq#1829

export interface ExploreCfg {
  enabled: boolean;      // the override rung
  prompt: boolean;       // the PROGRESS/GOAL lines in observe()
  windowTurns: number;   // novelty samples a stall must span
  minTiles: number;      // below this many distinct tiles the window is a tight pace
  stepsK: number;        // directional steps the brain is suspended for
  clearance: number;     // preferred Chebyshev distance of a target from the stall footprint
  expireFactor: number;  // an override older than K*expireFactor turns ends (battles eat turns)
  urgencyTurns: number;  // turns without new ground before the prompt says leave
  catchParty: number;    // party smaller than this gets the catch line
}

/** The fixed escape the design falls back to when no target is reachable:
 *  Down x10, Right x10, Up x5. Blocked presses are skipped, not retried. */
export const FALLBACK_SEQUENCE: Dir[] = [
  ...Array(10).fill("D"), ...Array(10).fill("R"), ...Array(5).fill("U"),
] as Dir[];

export type Dir = "U" | "D" | "L" | "R";
export const DIR_DELTA: Record<Dir, { dx: number; dy: number }> = {
  U: { dx: 0, dy: -1 }, D: { dx: 0, dy: 1 }, L: { dx: -1, dy: 0 }, R: { dx: 1, dy: 0 },
};

export interface Tile { map: number; x: number; y: number }

export interface StallVerdict {
  stalled: boolean;
  trigger: "tight_pace" | "no_new_ground" | null;
  complete: boolean;
  samples: number;
  windowTurns: number;
  uniqueTiles: number;
  newTiles: number;
  maps: number[];
  fromSeq: number;
  toSeq: number;
  tiles: Tile[];
}

/** Is the last `windowTurns` of novelty samples (seq > sinceSeq) a stall? */
export function assessStall(samples: ProgressSample[], sinceSeq: number,
                            cfg: Pick<ExploreCfg, "windowTurns" | "minTiles">): StallVerdict {
  const eligible = (samples ?? []).filter(s => s && typeof s.seq === "number" && s.seq > sinceSeq);
  const d = deltaP(eligible, cfg.windowTurns);
  const win = eligible.slice(-d.windowTurns);
  const seen = new Map<string, Tile>();
  for (const s of win) seen.set(tileKey(s.map, s.x, s.y), { map: s.map, x: s.x, y: s.y });
  const maps = [...new Set(win.map(s => s.map))];
  let trigger: StallVerdict["trigger"] = null;
  if (d.complete && d.newTiles === 0) {
    if (seen.size < cfg.minTiles) trigger = "tight_pace";
    else if (maps.length === 1) trigger = "no_new_ground";
  }
  return {
    stalled: trigger !== null, trigger, complete: d.complete,
    samples: win.length, windowTurns: d.windowTurns,
    uniqueTiles: seen.size, newTiles: d.newTiles, maps,
    fromSeq: win.length ? win[0].seq : 0, toSeq: win.length ? win[win.length - 1].seq : 0,
    tiles: [...seen.values()],
  };
}

/** What the planner needs from MapModel. Declared structurally so the probe
 *  can hand it a synthetic grid without a ROM. */
export interface GridLike {
  gw: number; gh: number;
  passableFrom(fx: number, fy: number, tx: number, ty: number): boolean;
  isGrass(x: number, y: number): boolean;
  isWarp(x: number, y: number): boolean;
  hops(x: number, y: number): { x: number; y: number }[];
}

export interface EscapePlan {
  target: { x: number; y: number };
  path: { x: number; y: number }[];   // excludes the start cell; a hop is a 2-cell jump
  source: "clear_non_grass" | "non_grass";
}

/** Chebyshev distance from `p` to the nearest footprint tile (Infinity if none). */
export function footDistance(p: { x: number; y: number }, footprint: { x: number; y: number }[]): number {
  let best = Infinity;
  for (const f of footprint) best = Math.min(best, Math.max(Math.abs(f.x - p.x), Math.abs(f.y - p.y)));
  return best;
}

/** Nearest reachable tile (by steps, BFS) that is not grass and not in
 *  `avoid`, preferring one at least `clearance` tiles (Chebyshev) from every
 *  tile in `footprint` so the walk actually leaves the patch instead of
 *  stopping on its edge. Never routes through a warp: a door would hand the
 *  player to a building, which is a map change the brain did not choose.
 *
 *  `fromDist` is the walker's current distance from the footprint. A target is
 *  never closer than that, and a "clear" one is strictly farther. Without it a
 *  multi-leg escape is a nearest-unvisited walk, and the replay on the live
 *  Route 24 save showed what that does: 22 steps north out of the strip, then
 *  the next nearest unvisited column led it 8 steps straight back south.
 *  Only the TARGET is constrained; the path may dip closer to get around a wall.
 *  null = nothing within maxLen steps; the caller falls back. */
export function planEscape(g: GridLike, sx: number, sy: number, avoid: Set<string>,
                           footprint: { x: number; y: number }[], maxLen: number,
                           clearance: number, blocked: Set<string> = new Set(),
                           fromDist = 0): EscapePlan | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const parent = new Map<string, string | null>([[key(sx, sy), null]]);
  const depth = new Map<string, number>([[key(sx, sy), 0]]);
  const queue: { x: number; y: number }[] = [{ x: sx, y: sy }];
  let fallback: { x: number; y: number } | null = null;
  const dist = (x: number, y: number) => footDistance({ x, y }, footprint);
  const needClear = Math.max(clearance, fromDist + 1);
  const build = (x: number, y: number, source: EscapePlan["source"]): EscapePlan => {
    const path: { x: number; y: number }[] = [];
    let cur: string | null = key(x, y);
    while (cur && cur !== key(sx, sy)) {
      const [cx, cy] = cur.split(",").map(Number);
      path.unshift({ x: cx, y: cy });
      cur = parent.get(cur) ?? null;
    }
    return { target: { x, y }, path, source };
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    const dc = depth.get(key(c.x, c.y))!;
    if (dc > 0 && !g.isGrass(c.x, c.y) && !avoid.has(key(c.x, c.y))) {
      const dd = dist(c.x, c.y);
      if (dd >= needClear) return build(c.x, c.y, "clear_non_grass");
      if (!fallback && dd >= fromDist) fallback = c;
    }
    const next: { x: number; y: number; cost: number }[] = [];
    for (const d of Object.values(DIR_DELTA)) {
      const nx = c.x + d.dx, ny = c.y + d.dy;
      if (!g.passableFrom(c.x, c.y, nx, ny)) continue;
      next.push({ x: nx, y: ny, cost: 1 });
    }
    for (const h of g.hops(c.x, c.y)) next.push({ x: h.x, y: h.y, cost: 1 });
    for (const n of next) {
      const nk = key(n.x, n.y);
      if (parent.has(nk) || blocked.has(nk) || g.isWarp(n.x, n.y)) continue;
      if (dc + n.cost > maxLen) continue;
      parent.set(nk, key(c.x, c.y));
      depth.set(nk, dc + n.cost);
      queue.push({ x: n.x, y: n.y });
    }
  }
  return fallback ? build(fallback.x, fallback.y, "non_grass") : null;
}

/** Path cells -> presses. A 2-cell delta is a ledge hop (one press). */
export function pathToDirs(sx: number, sy: number, path: { x: number; y: number }[]): { dir: Dir; hop: boolean }[] {
  const out: { dir: Dir; hop: boolean }[] = [];
  let px = sx, py = sy;
  for (const c of path) {
    const dx = Math.sign(c.x - px), dy = Math.sign(c.y - py);
    const hop = Math.abs(c.x - px) + Math.abs(c.y - py) === 2;
    const dir = (Object.keys(DIR_DELTA) as Dir[]).find(k => DIR_DELTA[k].dx === dx && DIR_DELTA[k].dy === dy);
    if (!dir) break;
    out.push({ dir, hop });
    px = c.x; py = c.y;
  }
  return out;
}

// ---- telemetry: runtime/stuck_escalation_overrides.jsonl --------------------

/** Rotated (one .1 generation) past this many bytes. A fire is two lines. */
export const OVERRIDE_LOG_ROTATE_BYTES = 512 * 1024;

export function overrideLogFile(runtimeDir?: string): string {
  return process.env.LPP_OVERRIDE_LOG ??
    `${runtimeDir ?? `${process.cwd()}/runtime`}/stuck_escalation_overrides.jsonl`;
}

export function appendOverrideLog(file: string, rec: object): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > OVERRIDE_LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch { /* bookkeeping never breaks a turn */ }
}

/** Highest flushSeq recorded by an `end` line, newest generation first. */
export function recoverFlushSeq(file: string): number {
  for (const f of [file, `${file}.1`]) {
    try {
      const lines = readFileSync(f, "utf8").trim().split("\n").reverse();
      for (const l of lines) {
        try {
          const r = JSON.parse(l);
          if (r && r.ev === "end" && typeof r.flushSeq === "number") return r.flushSeq;
        } catch {}
      }
    } catch {}
  }
  return 0;
}

// ---- the controller ----------------------------------------------------------

export interface OverrideDeps {
  map: GridLike & { build(): void; loadPending(): boolean };
  pos(): Tile;
  step(dx: number, dy: number): Promise<string>;   // Navigator.step
  hop(dx: number, dy: number): Promise<string>;    // Navigator.hopStep
  samples(): ProgressSample[];                     // NoveltyTracker.recent()
  /** "battle" | "dialog" when the overworld is not ours to drive, else null. */
  blocked(): string | null;
  /** Called once per fire: drop harness goals that would walk straight back. */
  onFire?(): void;
  bus?: { emit(kind: any, data: object): void };
  logFile: string;
  cfg: ExploreCfg;
}

interface Run {
  fire: number;
  firedTurn: number;
  from: Tile;
  map: number;
  trigger: NonNullable<StallVerdict["trigger"]>;
  footprint: Set<string>;                 // tileKey over the stall window
  footprintHere: { x: number; y: number }[];
  stepsLeft: number;
  queue: { dir: Dir; hop: boolean }[];
  mode: "target" | "fallback";
  target: { x: number; y: number } | null;
  fallbackIdx: number;
  legs: number;                           // escape legs planned so far
  learnedBlocked: Set<string>;
  walked: Set<string>;
  executed: string[];
}

export class ExplorationOverride {
  private run: Run | null = null;
  private flushSeq: number;
  private fires = 0;

  constructor(private d: OverrideDeps) {
    this.flushSeq = recoverFlushSeq(d.logFile);
  }

  active(): boolean { return this.run !== null; }
  floor(): number { return this.flushSeq; }

  /** One ladder rung. A string = the harness acted this turn, skip the brain.
   *  null = not ours this turn (off, not stalled, battle, dialog, map loading). */
  async tick(turn: number): Promise<string | null> {
    const cfg = this.d.cfg;
    if (!cfg.enabled) return null;
    if (this.run && turn - this.run.firedTurn > cfg.stepsK * cfg.expireFactor) {
      this.finish("expired", null);   // logged; nothing pressed, so the ladder continues
      return null;
    }
    if (this.d.blocked() || this.d.map.loadPending()) return null;
    if (!this.run) {
      const v = assessStall(this.d.samples(), this.flushSeq, cfg);
      if (!v.stalled) return null;
      this.start(turn, v);
    }
    return this.advance();
  }

  private start(turn: number, v: StallVerdict): void {
    const cfg = this.d.cfg;
    this.d.map.build();
    const p = this.d.pos();
    const footprintHere = v.tiles.filter(t => t.map === p.map).map(t => ({ x: t.x, y: t.y }));
    this.fires++;
    const run: Run = {
      fire: this.fires, firedTurn: turn, from: p, map: p.map,
      trigger: v.trigger!,
      footprint: new Set(v.tiles.map(t => tileKey(t.map, t.x, t.y))),
      footprintHere, stepsLeft: cfg.stepsK, queue: [], mode: "target", target: null,
      fallbackIdx: 0, legs: 0, learnedBlocked: new Set(), walked: new Set(), executed: [],
    };
    this.run = run;
    const planned = this.replan();
    try { this.d.onFire?.(); } catch {}
    const rec = {
      v: 1, ev: "fire", fire: run.fire, turn, ts: Date.now(), iso: new Date().toISOString(),
      at: p, trigger: v.trigger,
      window: { turns: v.windowTurns, samples: v.samples, uniqueTiles: v.uniqueTiles,
                newTiles: v.newTiles, maps: v.maps, fromSeq: v.fromSeq, toSeq: v.toSeq },
      k: cfg.stepsK, mode: run.mode, source: planned?.source ?? "fallback",
      target: run.target, sequence: run.mode === "target"
        ? run.queue.map(q => q.hop ? `${q.dir}^` : q.dir)
        : FALLBACK_SEQUENCE.slice(),
    };
    appendOverrideLog(this.d.logFile, rec);
    this.d.bus?.emit("exploration_override", { stage: "fire", ...rec });
  }

  /** Plan the next leg toward non-grass ground outside the stall window and
   *  outside anywhere this run already walked. No leg -> fixed fallback. */
  private replan(): EscapePlan | null {
    const run = this.run!;
    if (run.mode === "fallback") return null;
    this.d.map.build();
    const p = this.d.pos();
    const avoid = new Set<string>();
    for (const t of run.footprintHere) avoid.add(`${t.x},${t.y}`);
    for (const k of run.walked) {
      const [m, x, y] = k.split(",").map(Number);
      if (m === p.map) avoid.add(`${x},${y}`);
    }
    const fromDist = run.footprintHere.length ? footDistance(p, run.footprintHere) : 0;
    const plan = planEscape(this.d.map, p.x, p.y, avoid, run.footprintHere,
      run.stepsLeft, this.d.cfg.clearance, run.learnedBlocked, fromDist);
    if (plan && plan.path.length) {
      run.legs++;
      run.target = plan.target;
      run.queue = pathToDirs(p.x, p.y, plan.path);
      return plan;
    }
    // Already out and nothing farther: stop here. The fixed fallback is only
    // for a run that never found a first leg; replayed from the far end of an
    // escape it would press Down x10 straight back into the patch.
    if (run.legs > 0) { run.target = null; run.queue = []; return null; }
    run.mode = "fallback";
    run.target = null;
    run.queue = [];
    return null;
  }

  /** Press one direction. Every call spends a step, including a blocked one,
   *  so a wall cannot hold the brain off forever. */
  private async advance(): Promise<string> {
    const run = this.run!;
    let move: { dir: Dir; hop: boolean } | null = null;
    if (run.mode === "target") {
      if (!run.queue.length && !this.replan() && run.legs > 0) return this.finish("no_farther_ground", null);
      if (run.mode === "target") move = run.queue.shift() ?? null;
    }
    if (!move && run.mode === "fallback") {
      if (run.fallbackIdx >= FALLBACK_SEQUENCE.length) return this.finish("fallback_exhausted", null);
      move = { dir: FALLBACK_SEQUENCE[run.fallbackIdx++], hop: false };
    }
    if (!move) return this.finish("no_route", null);

    const before = this.d.pos();
    const { dx, dy } = DIR_DELTA[move.dir];
    const r = move.hop ? await this.d.hop(dx, dy) : await this.d.step(dx, dy);
    run.stepsLeft--;
    const after = this.d.pos();
    run.walked.add(tileKey(after.map, after.x, after.y));
    run.executed.push(`${move.dir}${move.hop ? "^" : ""}:${r}`);
    const n = this.d.cfg.stepsK - run.stepsLeft;
    let line = `exploration_override #${run.fire} step ${n}/${this.d.cfg.stepsK} ` +
      `${move.dir}${move.hop ? "(hop)" : ""} -> ${r} now (${after.x},${after.y})` +
      (run.target ? ` target (${run.target.x},${run.target.y})` : ` fallback`);

    if (r === "blocked") {
      // The planner's grid disagreed with the engine (NPC stepped in, tile
      // pair). Learn the cell for this run and re-plan the leg next turn.
      run.learnedBlocked.add(`${before.x + dx * (move.hop ? 2 : 1)},${before.y + dy * (move.hop ? 2 : 1)}`);
      run.queue = [];
    }
    if (after.map !== run.map) return this.finish("map_changed", line);
    if (run.mode === "target" && run.target && after.x === run.target.x && after.y === run.target.y)
      run.queue = [];                       // leg done; next turn plans the next one
    if (run.stepsLeft <= 0) return this.finish("steps_exhausted", line);
    return line;
  }

  /** Close the run: log the outcome, raise the sample floor, hand back. */
  private finish(reason: string, lastLine: string | null): string {
    const run = this.run!;
    const cfg = this.d.cfg;
    const at = this.d.pos();
    const samples = this.d.samples();
    const lastSeq = samples.length ? samples[samples.length - 1].seq : this.flushSeq;
    const newGround = [...run.walked].filter(k => !run.footprint.has(k)).length;
    const mapChanged = at.map !== run.map;
    const escaped = mapChanged || newGround >= cfg.minTiles;
    this.flushSeq = Math.max(this.flushSeq, lastSeq);
    const rec = {
      v: 1, ev: "end", fire: run.fire, reason, ts: Date.now(), iso: new Date().toISOString(),
      from: run.from, at, stepsTaken: cfg.stepsK - run.stepsLeft, k: cfg.stepsK,
      mode: run.mode, target: run.target, executed: run.executed,
      distinctTiles: run.walked.size, newGround, mapChanged, escaped,
      flushSeq: this.flushSeq,
    };
    appendOverrideLog(this.d.logFile, rec);
    this.d.bus?.emit("exploration_override", { stage: "end", ...rec });
    this.run = null;
    const summary = `exploration_override #${run.fire} ended (${reason}): ` +
      `${rec.stepsTaken} steps, ${newGround} tiles outside the stalled patch` +
      `${mapChanged ? ", left the map" : ""}. You were pacing the same ground with no progress; ` +
      `do not walk back to it.`;
    return lastLine ? `${lastLine}\n${summary}` : summary;
  }
}

// ---- prompt salience: the reward weights, said out loud ----------------------

/** Gym order by wObtainedBadges bit (names.ts BADGE_NAMES order). */
export const GYMS = [
  { city: "Pewter", leader: "Brock" }, { city: "Cerulean", leader: "Misty" },
  { city: "Vermilion", leader: "Lt. Surge" }, { city: "Celadon", leader: "Erika" },
  { city: "Fuchsia", leader: "Koga" }, { city: "Saffron", leader: "Sabrina" },
  { city: "Cinnabar", leader: "Blaine" }, { city: "Viridian", leader: "Giovanni" },
];

export interface ProgressCtx {
  badges: number;          // wObtainedBadges bitmask
  partyCount: number;
  map: number;
  samples: ProgressSample[];
  // wq#1829: catching costs a ball, and a ball costs money. Both are REQUIRED,
  // not optional-with-a-default, because the bug this fixes was a catch
  // directive rendered by a function that had no idea whether catching was
  // possible — a default would have preserved exactly that.
  balls: number;           // POKE + GREAT + ULTRA, from the bag
  money: number;
}

/** Trailing samples on `map`, and trailing samples since a new tile. Both
 *  saturate at the retained sample count, reported with a "+". */
export function progressCounters(samples: ProgressSample[], map: number):
    { onMap: number; onMapCapped: boolean; sinceNew: number; sinceNewCapped: boolean } {
  let onMap = 0, sinceNew = 0, mapDone = false, newDone = false;
  for (let i = samples.length - 1; i >= 0 && !(mapDone && newDone); i--) {
    const s = samples[i];
    if (!mapDone) { if (s.map === map) onMap++; else mapDone = true; }
    if (!newDone) { if (s.newTiles) newDone = true; else sinceNew++; }
  }
  const any = samples.length > 0;
  return { onMap, onMapCapped: any && !mapDone, sinceNew, sinceNewCapped: any && !newDone };
}

/** The PROGRESS / GOAL lines for the brain's overworld state block.
 *  Deliberately not a score: the brain acts on stated goals, not scalars. */
export function progressBlock(c: ProgressCtx, cfg: Pick<ExploreCfg, "urgencyTurns" | "catchParty">): string {
  const next = [0, 1, 2, 3, 4, 5, 6, 7].find(i => !((c.badges >> i) & 1));
  const count = [0, 1, 2, 3, 4, 5, 6, 7].filter(i => (c.badges >> i) & 1).length;
  const k = progressCounters(c.samples, c.map);
  const n = (v: number, capped: boolean) => `${v}${capped ? "+" : ""}`;
  const lines = [
    `PROGRESS: badges ${count}/8, party ${c.partyCount}, ${n(k.onMap, k.onMapCapped)} turns on this map, ` +
    `${n(k.sinceNew, k.sinceNewCapped)} turns since you stood somewhere new`,
    next === undefined
      ? `GOAL: all 8 badges - Victory Road and the Pokemon League.`
      : `GOAL: Gym #${next + 1}, ${GYMS[next].city} (${GYMS[next].leader}, ${BADGE_NAMES[next]} Badge).`,
  ];
  if (k.sinceNew >= cfg.urgencyTurns && k.onMap >= cfg.urgencyTurns)
    lines.push(`!! NO NEW GROUND in ${n(k.sinceNew, k.sinceNewCapped)} turns: leaving this map is high value. ` +
      `Fights are only worth it when they block the path.`);
  // wq#1829: the small-party line used to say "catching another is valuable"
  // unconditionally. Measured on live-agent-1789183317445 (2026-09-12, 318
  // turns / 6.7h): bag held ZERO balls and the purse held $96 against a $200
  // ball for the entire run, and the brain burned think_chunks re-deriving "no
  // poke_ball. So catching is impossible right now" turn after turn. A
  // directive the agent cannot execute is worse than no directive: it competes
  // with the one action that DOES relieve the constraint. So the line now
  // names the binding resource instead of the wish.
  if (c.partyCount > 0 && c.partyCount < cfg.catchParty) {
    if (c.balls > 0)
      lines.push(`CATCH: you have ${c.partyCount} Pokemon and ${c.balls} ball(s); catching another is valuable.`);
    else if (c.money >= BALL_PRICE)
      lines.push(`BUY BALLS FIRST: ${c.partyCount} Pokemon, ZERO balls, $${c.money}. ` +
        `A Poke Ball is $${BALL_PRICE}; the marts that stock them are ${ballMarts().join(", ")}. ` +
        `Catching is impossible until you are carrying one, so buy before you hunt.`);
    else
      lines.push(`CATCHING IS IMPOSSIBLE: ${c.partyCount} Pokemon, ZERO balls, $${c.money}, ` +
        `and a Poke Ball costs $${BALL_PRICE}. Do NOT spend turns hunting or weakening wilds — ` +
        `you cannot throw anything at them. EARN MONEY FIRST: only TRAINER battles pay in this ` +
        `game, wild Pokemon pay nothing. Fight the trainers on your path until you clear ` +
        `$${BALL_PRICE}, then buy at ${ballMarts().join(", ")}.`);
  }
  return lines.join("\n");
}
