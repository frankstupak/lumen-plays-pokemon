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
//
// wq#1746: `escaped` WAS NOT A MEASUREMENT OF ESCAPING
//   All nine live fires (2026-09-10 21:00Z - 09-11 01:19Z) logged escaped=true
//   and the Route 24 cycle did not break, because `escaped` only ever saw the
//   run's own walk. The nav traces say what it missed: the FIRST brain action
//   after each end is a goto straight back into the patch — end at (15,4), then
//   steps (15,5),(15,6),(15,7)... inside 18 seconds; end at (4,4), then
//   (4,5),(4,6),(4,8)... The brain was not being perverse, it was following the
//   pinned supervisor directive (FIGHT_LOSS_LOOP@3, written 2026-08-29, lifted
//   only by story advance, still live 13 days later): "use goto() to WALK into
//   the tall grass to trigger wild battles".
//
//   So an end record now says `provisional`, and a `verdict` record settles it
//   `verdictTurns` novelty samples later from the only thing that decides it:
//   whether the player stood in that patch again. Seq, not turn, because the
//   agent's turn counter resets on every process restart (~2h live, shorter
//   than one verdict window) and seq does not — the watch is recovered from the
//   log on boot for the same reason the flush floor is.
//
//   This is the measurement half of wq#1828's exclusion (src/exclusion.ts): the
//   exclusion refuses the walk-back as a DESTINATION, by design leaving a walk
//   THROUGH the patch legal, so "did the escape hold" is a question only
//   position sampling can answer. The verdict counts the exclusion's refusals
//   beside its own answer, which is what makes the next live run decidable.
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
  patchShare: number;    // wq#1828: share of the window one patch must hold (0 = trigger off)
  patchRadius: number;   // Chebyshev radius of that patch, in tiles
  patchNew: number;      // new tiles INSIDE the patch the verdict tolerates
  excludeTurns: number;  // turns the escaped patch is refused as a goto target (0 = off)
  verdictTurns: number;  // wq#1746: novelty samples an escape is watched for (0 = off)
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
  trigger: "tight_pace" | "no_new_ground" | "dominant_patch" | null;
  complete: boolean;
  samples: number;
  windowTurns: number;
  uniqueTiles: number;
  newTiles: number;
  maps: number[];
  fromSeq: number;
  toSeq: number;
  tiles: Tile[];
  patch: Patch | null;
}

/** The window's densest region: the Chebyshev-`radius` disc, centred on a cell
 *  the agent actually stood on, that holds the most of the window's samples. */
export interface Patch {
  map: number; x: number; y: number;   // the centre cell
  radius: number;
  samples: number;                     // samples taken inside it
  share: number;                       // samples / window length
  newTiles: number;                    // tiles first discovered INSIDE it
  cells: Tile[];                       // its visited cells
}

/** Densest patch of a sample window, or null for an empty one. Ties go to the
 *  cell the agent reached first. Counted over distinct CELLS rather than
 *  samples, so the cost is quadratic in tiles (<= windowTurns), not in turns. */
export function dominantPatch(win: ProgressSample[], radius: number): Patch | null {
  const cells = new Map<string, { map: number; x: number; y: number; n: number; fresh: number }>();
  for (const s of win) {
    const k = tileKey(s.map, s.x, s.y);
    const c = cells.get(k) ?? { map: s.map, x: s.x, y: s.y, n: 0, fresh: 0 };
    c.n++; c.fresh += s.newTiles ?? 0;
    cells.set(k, c);
  }
  const all = [...cells.values()];
  const r = Math.max(0, Math.floor(radius));
  let best: Patch | null = null;
  for (const seed of all) {
    const inside = all.filter(c => c.map === seed.map &&
      Math.max(Math.abs(c.x - seed.x), Math.abs(c.y - seed.y)) <= r);
    const n = inside.reduce((sum, c) => sum + c.n, 0);
    if (best && n <= best.samples) continue;
    best = {
      map: seed.map, x: seed.x, y: seed.y, radius: r,
      samples: n, share: n / win.length,
      newTiles: inside.reduce((sum, c) => sum + c.fresh, 0),
      cells: inside.map(c => ({ map: c.map, x: c.x, y: c.y })),
    };
  }
  return best;
}

/** Is the last `windowTurns` of novelty samples (seq > sinceSeq) a stall?
 *
 *  wq#1828 added the third trigger. The first two AND over the WHOLE window, so
 *  one sample anywhere in it clears the verdict for the next `windowTurns`, and
 *  the live agent's shuttle — grind the map35 x=4..5 strip, pop to Route 25 or
 *  Bill's for a few turns, come back — trips both vetoes forever. Replaying the
 *  run's own samples (runtime/progress.json, 2026-09-12) through this function
 *  scored 363 of 363 windows not-stalled: 230 vetoed by a second map, 133 by a
 *  new tile found somewhere else entirely, while 60.9% of the samples sat in
 *  the strip the override exists to break. `dominant_patch` asks the question
 *  the shuttle cannot dodge — did most of this window happen inside one small
 *  patch that earned no new ground — and fires on 260 of those 363 windows. */
export function assessStall(samples: ProgressSample[], sinceSeq: number,
                            cfg: Pick<ExploreCfg, "windowTurns" | "minTiles" | "patchShare" |
                                       "patchRadius" | "patchNew">): StallVerdict {
  const eligible = (samples ?? []).filter(s => s && typeof s.seq === "number" && s.seq > sinceSeq);
  const d = deltaP(eligible, cfg.windowTurns);
  const win = eligible.slice(-d.windowTurns);
  const seen = new Map<string, Tile>();
  for (const s of win) seen.set(tileKey(s.map, s.x, s.y), { map: s.map, x: s.x, y: s.y });
  const maps = [...new Set(win.map(s => s.map))];
  const patch = d.complete ? dominantPatch(win, cfg.patchRadius) : null;
  let trigger: StallVerdict["trigger"] = null;
  if (d.complete) {
    if (d.newTiles === 0 && seen.size < cfg.minTiles) trigger = "tight_pace";
    else if (d.newTiles === 0 && maps.length === 1) trigger = "no_new_ground";
    else if (cfg.patchShare > 0 && patch && patch.share >= cfg.patchShare &&
             patch.newTiles <= cfg.patchNew) trigger = "dominant_patch";
  }
  return {
    stalled: trigger !== null, trigger, complete: d.complete,
    samples: win.length, windowTurns: d.windowTurns,
    uniqueTiles: seen.size, newTiles: d.newTiles, maps,
    fromSeq: win.length ? win[0].seq : 0, toSeq: win.length ? win[win.length - 1].seq : 0,
    tiles: [...seen.values()], patch,
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

/** wq#1746: an escape under watch — the patch it left, and until when. */
export interface Watch {
  fire: number;
  map: number;
  keys: Set<string>;        // "x,y" of the patch on `map`
  tiles: number;
  fromSeq: number;
  untilSeq: number;
  reenteredSeq: number;     // 0 until the player stands in the patch again
  offMapSamples: number;    // samples of the watch spent on another map
  exFires: number;          // most refusals wq#1828's exclusion had issued
  written: boolean;
}

/** The watch in flight when the process died, or null.
 *
 *  Newest-first, the first record that is either a `verdict` or an `end`
 *  carrying a watch decides: a verdict means the newest escape is already
 *  settled, an end means it is not. Fire numbers restart at 1 with every
 *  process, so they cannot be matched across a restart — position can. */
export function recoverWatch(file: string, seq: number): Watch | null {
  for (const f of [file, `${file}.1`]) {
    let lines: string[];
    try { lines = readFileSync(f, "utf8").trim().split("\n").reverse(); } catch { continue; }
    for (const l of lines) {
      let r: any;
      try { r = JSON.parse(l); } catch { continue; }
      if (!r || (r.ev !== "verdict" && r.ev !== "end")) continue;
      if (r.ev === "verdict" || !r.watch || !Array.isArray(r.watch.keys)) return null;
      if (!(r.watch.untilSeq > seq)) return null;
      return {
        fire: r.fire ?? 0, map: r.watch.map, keys: new Set<string>(r.watch.keys),
        tiles: r.watch.keys.length, fromSeq: r.watch.fromSeq ?? seq,
        untilSeq: r.watch.untilSeq, reenteredSeq: 0, offMapSamples: 0, exFires: 0, written: false,
      };
    }
  }
  return null;
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
  /** wq#1828: called once per END with the patch this run escaped, so goto can
   *  refuse it as a destination until it expires (src/exclusion.ts). */
  exclude?(e: { tiles: string[]; map: number; turn: number; turns: number; fromFire: number }): void;
  /** wq#1746: the live exclusion's refusal count, read (never mutated) when a
   *  verdict is written, so one record says both what the ban did and whether
   *  the escape held. Absent = no exclusion gate wired (probes, run_agent). */
  exclusionFires?(): number;
  bus?: { emit(kind: any, data: object): void };
  logFile: string;
  cfg: ExploreCfg;
}

interface Run {
  fire: number;
  firedTurn: number;
  turn: number;                           // last turn this run was ticked on
  from: Tile;
  map: number;
  trigger: NonNullable<StallVerdict["trigger"]>;
  footprint: Set<string>;                 // tileKey over the stall window
  footprintHere: { x: number; y: number }[];
  excludeTiles: string[];                 // the patch goto is refused, on END
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
  private watch: Watch | null = null;

  constructor(private d: OverrideDeps) {
    this.flushSeq = recoverFlushSeq(d.logFile);
    try { this.watch = recoverWatch(d.logFile, this.lastSeq()); } catch { this.watch = null; }
  }

  active(): boolean { return this.run !== null; }
  floor(): number { return this.flushSeq; }
  /** wq#1746: the escape currently being judged, or null. */
  watching(): Watch | null { return this.watch; }

  /** Newest novelty seq, or the flush floor before any sample exists. */
  private lastSeq(): number {
    const s = this.d.samples();
    return s && s.length ? s[s.length - 1].seq : this.flushSeq;
  }

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
    this.settleWatch();     // overworld only: it reads where the player stands
    if (!this.run) {
      const v = assessStall(this.d.samples(), this.flushSeq, cfg);
      if (!v.stalled) return null;
      this.start(turn, v);
    }
    this.run!.turn = turn;
    return this.advance();
  }

  /** wq#1746: is the escape still an escape? Called once per overworld turn.
   *  The first re-entry settles it; so does running out of window. Standing in
   *  the patch is the whole test — wq#1828's exclusion refuses it as a goto
   *  DESTINATION and leaves walking through it legal, so a turn that ends there
   *  is exactly what neither the end record nor the exclusion can see. */
  private settleWatch(): void {
    const w = this.watch;
    if (!w) return;
    const seq = this.lastSeq();
    // Sampled, not read once at the end: an exclusion that has already lifted
    // (expiry, map change, fire cap) is gone from the gate, and reading it then
    // would report the refusals it made as zero.
    w.exFires = Math.max(w.exFires, this.exclusionFires());
    if (!w.reenteredSeq) {
      const p = this.d.pos();
      if (p.map !== w.map) w.offMapSamples++;
      else if (w.keys.has(`${p.x},${p.y}`)) {
        w.reenteredSeq = seq;
        this.writeVerdict(w, "reentered");
      }
    }
    if (seq > w.untilSeq) {
      this.writeVerdict(w, "held");
      this.watch = null;
    }
  }

  /** One record per watched escape, at the first of re-entry / expiry /
   *  supersession. THIS is the escape metric; the end record's `escaped` is the
   *  run's own walk and cannot see what the brain does with the turn back. */
  private writeVerdict(w: Watch, reason: "reentered" | "held" | "superseded"): void {
    if (w.written) return;
    w.written = true;
    const seq = this.lastSeq();
    let at: Tile | null = null;
    try { at = this.d.pos(); } catch { at = null; }
    w.exFires = Math.max(w.exFires, this.exclusionFires());
    const rec = {
      v: 1, ev: "verdict", fire: w.fire, reason, ts: Date.now(), iso: new Date().toISOString(),
      map: w.map, tiles: w.tiles, at, seq, fromSeq: w.fromSeq, untilSeq: w.untilSeq,
      heldSamples: seq - w.fromSeq, verdictTurns: this.d.cfg.verdictTurns,
      offMapSamples: w.offMapSamples, reentered: w.reenteredSeq > 0,
      reenteredSeq: w.reenteredSeq, exclusionFires: w.exFires,
      escaped: w.reenteredSeq === 0,
    };
    appendOverrideLog(this.d.logFile, rec);
    this.d.bus?.emit("exploration_override", { stage: "verdict", ...rec });
  }

  /** Refusals wq#1828's exclusion has issued, or 0 when none is wired. */
  private exclusionFires(): number {
    try { return this.d.exclusionFires?.() ?? 0; } catch { return 0; }
  }

  private start(turn: number, v: StallVerdict): void {
    const cfg = this.d.cfg;
    // A fresh stall while an escape is still being judged means the escape did
    // not buy progress; settle it now rather than watch two at once.
    if (this.watch) { this.writeVerdict(this.watch, "superseded"); this.watch = null; }
    this.d.map.build();
    const p = this.d.pos();
    const footprintHere = v.tiles.filter(t => t.map === p.map).map(t => ({ x: t.x, y: t.y }));
    // wq#1828: what goto is refused afterwards is the footprint ON THIS MAP,
    // not the whole window. A dominant_patch window spans every map the shuttle
    // touched (map36, map88, map3 on the live run), and banning Route 25
    // because the agent paced Route 24 would be the opposite of the fix.
    // Narrower than this does not hold either: the acceptance replay refused
    // the patch core and the stub brain was back on the strip one turn later,
    // through a paced tile just outside it.
    const excludeTiles = v.tiles.filter(t => t.map === p.map).map(t => tileKey(t.map, t.x, t.y));
    this.fires++;
    const run: Run = {
      fire: this.fires, firedTurn: turn, turn, from: p, map: p.map,
      trigger: v.trigger!,
      footprint: new Set(v.tiles.map(t => tileKey(t.map, t.x, t.y))),
      footprintHere, excludeTiles, stepsLeft: cfg.stepsK, queue: [], mode: "target", target: null,
      fallbackIdx: 0, legs: 0, learnedBlocked: new Set(), walked: new Set(), executed: [],
    };
    this.run = run;
    const planned = this.replan();
    try { this.d.onFire?.(); } catch {}
    const rec = {
      v: 1, ev: "fire", fire: run.fire, turn, ts: Date.now(), iso: new Date().toISOString(),
      at: p, trigger: v.trigger,
      window: { turns: v.windowTurns, samples: v.samples, uniqueTiles: v.uniqueTiles,
                newTiles: v.newTiles, maps: v.maps, fromSeq: v.fromSeq, toSeq: v.toSeq,
                patch: v.patch && { at: [v.patch.map, v.patch.x, v.patch.y], r: v.patch.radius,
                                    share: +v.patch.share.toFixed(3), samples: v.patch.samples,
                                    newTiles: v.patch.newTiles, cells: v.patch.cells.length } },
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

  /** wq#1746: start judging the escape. The patch is the stall window's tiles
   *  on the map the run started from — the same set wq#1828 excludes, so one
   *  verdict covers both the harness's walk and the ban that followed it.
   *  Nothing is watched if the run ended standing in the patch: there is no
   *  re-entry to detect when it never left. */
  private startWatch(run: Run, at: Tile, lastSeq: number):
      { map: number; keys: string[]; fromSeq: number; untilSeq: number } | null {
    const cfg = this.d.cfg;
    if (cfg.verdictTurns <= 0 || !run.footprintHere.length) return null;
    const keys = new Set(run.footprintHere.map(t => `${t.x},${t.y}`));
    if (at.map === run.map && keys.has(`${at.x},${at.y}`)) return null;
    this.watch = {
      fire: run.fire, map: run.map, keys, tiles: keys.size, fromSeq: lastSeq,
      untilSeq: lastSeq + cfg.verdictTurns, reenteredSeq: 0, offMapSamples: 0, exFires: 0,
      written: false,
    };
    return { map: run.map, keys: [...keys], fromSeq: lastSeq, untilSeq: this.watch.untilSeq };
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
    // wq#1828: the escape only holds if the brain does not walk back. Hand the
    // patch to the exclusion gate BEFORE the turn is handed back, so the very
    // next goto is already refused.
    // A run that ended on another map needs no exclusion: goto is same-map only
    // (crossMapRefusal in agent.ts), and a map change lifts it anyway.
    const excludeUntil = cfg.excludeTurns > 0 && !mapChanged && run.excludeTiles.length
      ? run.turn + cfg.excludeTurns : null;
    if (excludeUntil !== null) {
      try {
        this.d.exclude?.({ tiles: run.excludeTiles, map: run.map, turn: run.turn,
                           turns: cfg.excludeTurns, fromFire: run.fire });
      } catch { /* bookkeeping never breaks a turn */ }
    }
    // wq#1746: and the escape is only an escape if the brain stays out. Watch
    // the patch for verdictTurns samples and settle `escaped` from that.
    const watch = escaped ? this.startWatch(run, at, lastSeq) : null;
    const rec = {
      v: 1, ev: "end", fire: run.fire, reason, ts: Date.now(), iso: new Date().toISOString(),
      from: run.from, at, stepsTaken: cfg.stepsK - run.stepsLeft, k: cfg.stepsK,
      mode: run.mode, target: run.target, executed: run.executed,
      distinctTiles: run.walked.size, newGround, mapChanged, escaped,
      excludeTiles: excludeUntil === null ? 0 : run.excludeTiles.length, excludeUntil,
      provisional: watch !== null, watch,
      flushSeq: this.flushSeq,
    };
    appendOverrideLog(this.d.logFile, rec);
    this.d.bus?.emit("exploration_override", { stage: "end", ...rec });
    this.run = null;
    const summary = `exploration_override #${run.fire} ended (${reason}): ` +
      `${rec.stepsTaken} steps, ${newGround} tiles outside the stalled patch` +
      `${mapChanged ? ", left the map" : ""}. You were pacing the same ground with no progress; ` +
      `do not walk back to it.` +
      (excludeUntil === null ? "" :
        ` goto() into those ${run.excludeTiles.length} tiles is REFUSED until turn ${excludeUntil} ` +
        `(walking through them is still fine).`);
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
