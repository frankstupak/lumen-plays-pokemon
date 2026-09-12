// A* pathfinding + step executor with self-healing collision model
import { Emulator, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { MapModel, Warp } from "./map";
import { EventBus } from "./events";
import { Sync } from "./sync";

const DIRS = [
  { dx: 0, dy: -1, key: "UP" }, { dx: 0, dy: 1, key: "DOWN" },
  { dx: -1, dy: 0, key: "LEFT" }, { dx: 1, dy: 0, key: "RIGHT" },
] as const;

/** One move the planner may make from a cell: a step (cost 1) or a ledge hop
 *  (cost 2 cells of distance for one press). */
export interface Succ { x: number; y: number; cost: number }

/** wq#1870: the movement rule, in ONE place. astar() and reachableCells() both
 *  call it, so "where can I walk" and "how do I walk there" cannot disagree —
 *  the same reason reach.ts calls astar instead of running its own flood fill.
 *  (tx,ty) names the goal cell, which is exempt from the terrain and warp tests
 *  because doors and ladders are impassable warp tiles you are allowed to
 *  finish on; pass (-1,-1) when there is no goal. */
export function successors(map: MapModel, x: number, y: number, tx: number, ty: number): Succ[] {
  const out: Succ[] = [];
  for (const d of DIRS) {
    const nx = x + d.dx, ny = y + d.dy;
    const isTarget = nx === tx && ny === ty;
    const ok = isTarget ? (nx >= 0 && ny >= 0 && nx < map.gw && ny < map.gh)
                        : map.passable(nx, ny);
    if (!ok) continue;
    // wq#552: Gen 1 refuses movement between certain tile pairs even when both
    // tiles are passable, so this is checked on the EDGE and applies to the
    // target cell too — unlike the terrain test above, whose isTarget bypass
    // exists because doors and other warp tiles read impassable. A tile-pair
    // collision is a real refusal by the emulator, not a modelling artefact:
    // planning through one is what taught learnedBlocked a phantom wall on
    // every replan and produced the wq#542 east-west shuffle.
    if (map.pairBlocked(x, y, nx, ny)) continue;
    // Never route THROUGH an unrelated warp tile: stepping onto it triggers a
    // map transition we didn't ask for. Only the target warp is allowed.
    if (!isTarget && map.isWarp(nx, ny)) continue;
    out.push({ x: nx, y: ny, cost: 1 });
  }
  // wq#601: ledge-hop edges. Ledge tiles are walls in the collision grid, so
  // without these the planner reads every ledge line as sealed — Route 4
  // east's ONLY route to Cerulean is behind a hop-down line, and eastbound
  // A* died at it for 145h. Edges are DIRECTED (map.hops matches the ROM's
  // LedgeTiles entries, and the reverse direction has no entry), land two
  // cells out, and never land on an unrelated warp — same rule as steps.
  for (const hop of map.hops(x, y)) {
    if (!(hop.x === tx && hop.y === ty) && map.isWarp(hop.x, hop.y)) continue;
    out.push({ x: hop.x, y: hop.y, cost: 2 });
  }
  return out;
}

/** wq#1870: every cell the player can WALK to from (sx,sy) under successors().
 *  Warp tiles are absent by construction (no goal cell is exempt), so this
 *  answers "which parts of this map are mine" and never "can I reach that
 *  door" — warp reachability stays with astar, which has the goal exemption. */
export function reachableCells(map: MapModel, sx: number, sy: number,
                               extraBlocked: Set<string> = new Set()): Set<string> {
  const seen = new Set<string>([`${sx},${sy}`]);
  const q: { x: number; y: number }[] = [{ x: sx, y: sy }];
  while (q.length) {
    const c = q.pop()!;
    for (const s of successors(map, c.x, c.y, -1, -1)) {
      const k = `${s.x},${s.y}`;
      if (seen.has(k) || extraBlocked.has(k)) continue;
      seen.add(k); q.push({ x: s.x, y: s.y });
    }
  }
  return seen;
}

export function astar(map: MapModel, sx: number, sy: number, tx: number, ty: number,
                      extraBlocked: Set<string>): { x: number; y: number }[] | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const open = new Map<string, { x: number; y: number; g: number; f: number }>();
  const came = new Map<string, string>();
  const gScore = new Map<string, number>();
  const h = (x: number, y: number) => Math.abs(x - tx) + Math.abs(y - ty);
  open.set(key(sx, sy), { x: sx, y: sy, g: 0, f: h(sx, sy) });
  gScore.set(key(sx, sy), 0);
  while (open.size) {
    let bestK = ""; let best: any = null;
    for (const [k, n] of open) if (!best || n.f < best.f) { best = n; bestK = k; }
    open.delete(bestK);
    if (best.x === tx && best.y === ty) {
      const path = [{ x: tx, y: ty }];
      let cur = bestK;
      while (came.has(cur)) {
        cur = came.get(cur)!;
        const [cx, cy] = cur.split(",").map(Number);
        path.unshift({ x: cx, y: cy });
      }
      return path.slice(1); // drop start cell
    }
    for (const s of successors(map, best.x, best.y, tx, ty)) {
      const nk = key(s.x, s.y);
      if (extraBlocked.has(nk)) continue;
      const g = best.g + s.cost;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g); came.set(nk, bestK);
        open.set(nk, { x: s.x, y: s.y, g, f: g + h(s.x, s.y) });
      }
    }
  }
  return null;
}

/** wq#542: per-step visibility. Off costs one boolean read per step; on costs
 *  one JSONL line per planned step. Default ON — the whole point is that the
 *  live log can answer "did the agent follow its plan?" without a replay. */
const TRACE = (process.env.LPP_NAV_TRACE ?? "1") !== "0";
/** How many planned cells to record per plan. The head is what decides whether
 *  a journey escapes its starting neighbourhood; the tail is 70 cells of noise. */
const TRACE_HEAD = Number(process.env.LPP_NAV_TRACE_HEAD ?? 8);

/** wq#1662: what actually stopped the last walk, so a "stuck" result carries a
 *  reason instead of forcing reach.ts to guess "wild encounters or an NPC".
 *  Captured at the moment a step fails to move the player or a replan finds
 *  no path — the only two points inside goto() that ever learn anything about
 *  the blocker before it is discarded into learnedBlocked (a bare coordinate
 *  set with no identity). */
export interface Obstacle {
  x: number; y: number;
  kind: "sprite" | "terrain" | "no_path";
  spritePic?: number;
}

/** Pure classifier for a cell that refused a step: a sprite standing there
 *  names itself (and is the recoverable case — it can walk off); anything
 *  else is terrain the collision model called passable but the engine did
 *  not. Split out from goto()'s loop so it is unit-testable without an
 *  emulator. */
export function classifyBlockedCell(map: { sprites: { x: number; y: number; pic: number }[] },
                                    x: number, y: number): Obstacle {
  const sp = map.sprites.find(s => s.x === x && s.y === y);
  return sp ? { x, y, kind: "sprite", spritePic: sp.pic } : { x, y, kind: "terrain" };
}

export class Navigator {
  private learnedBlocked = new Set<string>();
  private lastObstacle: Obstacle | null = null;
  constructor(private emu: Emulator, private sym: SymbolTable, private map: MapModel,
              private bus: EventBus, private sync?: Sync) {}

  /** The last thing that stopped a walk in progress, if any. Cleared at the
   *  start of every goto() so a stale obstacle from a prior journey is never
   *  reported for this one. */
  lastGotoObstacle(): Obstacle | null { return this.lastObstacle; }

  private trace(data: object) { if (TRACE) this.bus.emit("nav_trace", data); }

  pos() { const m = this.emu.mem();
    return { map: m[this.sym.addr("wCurMap")], x: m[this.sym.addr("wXCoord")], y: m[this.sym.addr("wYCoord")] }; }

  /** wq#699: pos() for anything the BRAIN will see. Identical to pos() except
   *  that a read taken while the map data is mid-load — the one case where the
   *  tuple is known to be a lie — emits `torn_read` instead of passing
   *  silently. Every transition path settles before returning now, so this
   *  should never fire; it is the tripwire that says a new path forgot to. */
  posChecked(): { map: number; x: number; y: number } {
    const p = this.pos();
    if (this.map.loadPending())
      this.bus.emit("nav_trace", { ev: "torn_read", at: p,
        hdr: this.map.romHeader(p.map) });
    return p;
  }

  /** wq#699/#700: block until the engine's map state is SELF-CONSISTENT, and
   *  return the position that is then safe to report. null = never settled
   *  inside the budget, and a caller that gets null must not report a position
   *  it could not verify.
   *
   *  Three gates, in order, because each one alone is known to pass on a lie:
   *   1. MapModel.loadPending() — the loaded header must describe wCurMap.
   *      This is the gate that the old code lacked entirely.
   *   2. Sync.settle() — the engine must be accepting input again (post-warp
   *      auto-walk scripts move the player AFTER the load, wq#652).
   *   3. the tuple must hold still across consecutive samples AND sit inside
   *      the new map's bounds. Bounds are only meaningful once (1) holds, and
   *      stability alone is what the old poll loop used — it read two samples
   *      taken inside the same idle gap, found them equal, and called a
   *      transition that had not started yet "finished".
   *
   *  Any of the three going false restarts the stability count, so a second
   *  transition firing during the wait (warp chains, forced-walk scripts) is
   *  waited out rather than reported half-done. The MapModel is rebuilt on
   *  success: after a transition every caller's geometry is otherwise the
   *  DEPARTED map's (the wq#579 probe was bitten by exactly that). */
  async awaitMapSettled(maxFrames = 900): Promise<{ map: number; x: number; y: number } | null> {
    let spent = 0;
    const stableNeeded = 2;
    let last = this.pos(), stable = 0;
    while (spent < maxFrames) {
      if (this.map.loadPending()) {
        stable = 0; last = this.pos();
        await this.emu.framesAsync(4); spent += 4;
        continue;
      }
      if (this.sync && this.sync.busy()) {
        stable = 0; last = this.pos();
        await this.emu.framesAsync(4); spent += 4;
        continue;
      }
      const cur = this.pos();
      stable = (cur.map === last.map && cur.x === last.x && cur.y === last.y) ? stable + 1 : 0;
      last = cur;
      if (stable >= stableNeeded) {
        const m = this.emu.mem();
        const gw = m[this.sym.addr("wCurMapWidth")] * 2, gh = m[this.sym.addr("wCurMapHeight")] * 2;
        if (cur.x < gw && cur.y < gh) {
          this.map.build();
          this.trace({ ev: "map_settled", at: [cur.x, cur.y], map: cur.map, frames: spent });
          return cur;
        }
        // In-bounds is a HARD invariant: coordinates outside the loaded map
        // are the stale-coordinate signature (map88 with Route 25's (45,3)).
        stable = 0;
      }
      await this.emu.framesAsync(8); spent += 8;
    }
    this.trace({ ev: "map_unsettled", at: [last.x, last.y], map: last.map, frames: spent,
                 loadPending: this.map.loadPending() });
    return null;
  }

  /** wq#700: absorb a transition that was already in flight when this call
   *  started, so it is never credited to the action about to run. A goto whose
   *  first step coincides with someone else's pending warp used to return
   *  'warped' with zero net movement (live T6 2026-08-19) — and 'warped'
   *  retires the brain's transit goal, so a false one silently kills the
   *  objective. Returns true if a transition was absorbed. */
  private async absorbPendingTransition(): Promise<boolean> {
    if (!this.map.loadPending()) return false;
    const at = this.pos();
    const settled = await this.awaitMapSettled();
    this.trace({ ev: "pending_transition_absorbed", from: [at.x, at.y], fromMap: at.map,
                 to: settled ? [settled.x, settled.y] : null, toMap: settled?.map ?? null });
    return true;
  }

  inBattle(): boolean { return this.emu.mem()[this.sym.addr("wIsInBattle")] !== 0; }

  /** One walk-unit step. Returns 'moved' | 'blocked' | 'warped' */
  /** One walk-unit step. Returns 'moved' | 'blocked' | 'warped' | 'battle' */
  async step(dx: number, dy: number): Promise<string> {
    const d = DIRS.find(v => v.dx === dx && v.dy === dy)!;
    // wq#700: finish anyone else's in-flight transition BEFORE baselining
    // `before`, or this step inherits it and reports a warp it did not cause.
    await this.absorbPendingTransition();
    if (this.sync) await this.sync.settle();
    if (this.inBattle()) return "battle";
    if (this.sync?.textUp()) return "dialog";
    const before = this.pos();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.inBattle()) return "battle";
      await this.emu.tapAsync(KEYS[d.key], 8, 2);
      await this.emu.framesAsync(22);
      if (this.sync) await this.sync.settle(300);
      const now = this.pos();
      if (now.map !== before.map) {
        // wq#652: a warp exit (e.g. a building door) can hand control to a
        // SCRIPTED auto-walk that keeps moving the player after wCurMap has
        // already flipped. Root-caused frame-by-frame (RAM poll, Cerulean
        // Gym exit): wCurMap updates at once, but there is an IDLE-LOOKING
        // GAP of dozens of frames — wJoyIgnore/wStatusFlags5/wWalkCounter all
        // zero — BEFORE the walk-out script actually engages those flags and
        // starts moving wXCoord/wYCoord off the door tile. A single
        // sync.settle() call made right here can return during that gap
        // (genuinely quiet, just not yet finished), so the caller's very next
        // pos() read lands ON the door tile the warp is defined at - which
        // reads to the brain as "standing on this warp again" and drives an
        // enter_warp/enter_warp ping-pong (live-agent-1786841530991.jsonl
        // T74-75, warp3: reported landing (30,19), the door, while the engine
        // kept walking and only settled one tile south at (30,20) ~150ms
        // later, after the gap and the script had both finished). Waiting on
        // the flags alone is not sufficient because of that gap; instead poll
        // POSITION across repeated settle+wait rounds until it stops moving,
        // which is true however many idle/busy phases the exit script has.
        //
        // wq#699 SUPERSEDES that poll loop: position-stability ALONE cannot
        // tell a transition that has FINISHED from one that has not STARTED.
        // Both samples land inside the same idle gap, compare equal, and the
        // loop breaks holding the DEPARTED map's coordinates under the
        // ARRIVED map's id — reproduced deterministically from checkpoint
        // auto-mt2f0ie1-map36: enterWarp returned map88 with Route 25's
        // (45,3). awaitMapSettled() gates on the loaded map DATA first, which
        // is an invariant and not a timing guess.
        await this.awaitMapSettled();
        return "warped";
      }
      if (now.x !== before.x || now.y !== before.y) return "moved";
      // first attempt may have only turned the player; retry
    }
    return "blocked";
  }

  /** wq#601: one ledge hop — a single directional press that the game answers
   *  with a TWO-cell jump animation. Separate from step() because the hop
   *  takes ~40 frames: step()'s 22-frame wait reads the mid-air player as
   *  "didn't move", retries into ignored input, and mis-learns the landing as
   *  a wall. Returns the same vocabulary as step(). */
  async hopStep(dx: number, dy: number): Promise<string> {
    const d = DIRS.find(v => v.dx === dx && v.dy === dy)!;
    await this.absorbPendingTransition();          // wq#700, same rule as step()
    if (this.sync) await this.sync.settle();
    if (this.inBattle()) return "battle";
    if (this.sync?.textUp()) return "dialog";
    const before = this.pos();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.inBattle()) return "battle";
      await this.emu.tapAsync(KEYS[d.key], 8, 2);
      await this.emu.framesAsync(70);          // full jump arc, with margin
      if (this.sync) await this.sync.settle(300);
      const now = this.pos();
      // wq#699: a blind 90-frame sleep is the same timing guess step() used to
      // make; the destination map's data can arrive after it (or before it,
      // leaving a torn read either way). Gate on the data instead.
      if (now.map !== before.map) { await this.awaitMapSettled(); return "warped"; }
      if (now.x !== before.x || now.y !== before.y) return "moved";
      // first attempt may have only turned the player; retry
    }
    return "blocked";
  }

  /** wq#583: among the four neighbours of a sprite-occupied target, the best
   *  standing spot — passable (which already excludes sprites), not a warp
   *  (arriving would teleport us), nearest to the player first. */
  private bestAdjacent(tx: number, ty: number): { x: number; y: number } | null {
    const p = this.pos();
    const c = ([[0, 1], [0, -1], [1, 0], [-1, 0]] as const)
      .map(([dx, dy]) => ({ x: tx + dx, y: ty + dy }))
      .filter(a => this.map.passable(a.x, a.y) && !this.map.isWarp(a.x, a.y));
    if (!c.length) return null;
    c.sort((a, b) => (Math.abs(a.x - p.x) + Math.abs(a.y - p.y)) -
                     (Math.abs(b.x - p.x) + Math.abs(b.y - p.y)));
    return c[0];
  }

  /** Walk to (tx,ty) on current map.
   *  Returns 'arrived' | 'warped' | 'battle' | 'dialog' | 'adjacent_npc' | 'stuck'.
   *  'adjacent_npc' (wq#583): the target tile is occupied by an NPC sprite, so
   *  arrival is physically impossible — the walk stops on the best adjacent
   *  tile instead. The old behaviour planned ONTO the sprite (astar exempts
   *  the goal cell from passability for door warps), the engine refused, the
   *  wandering-NPC grace un-learned the block every cycle for a sprite that
   *  never moves, and 25 replans later the tool said 'stuck' while reach.ts
   *  told the brain the tile "IS reachable" — three identical retries live
   *  (wq#581 T12/T19/T21). */
  async goto(tx: number, ty: number): Promise<string> {
    this.bus.emit("tool_call", { tool: "goto", args: { tx, ty } });
    // wq#700: a journey that starts mid-transition plans against the DEPARTED
    // map's geometry and then reports the arriving map's flip as its own
    // 'warped' — zero net movement, transit goal silently retired (live T6
    // 2026-08-19). Land the pending transition first, on its own event.
    await this.absorbPendingTransition();
    this.learnedBlocked.clear();   // learned walls are per-journey, never persistent
    this.lastObstacle = null;
    let noPath = 0;
    for (let replans = 0; replans < 25; replans++) {
      if (this.inBattle()) return "battle";
      if (this.sync?.textUp()) return "dialog";
      this.map.build(); // refresh sprites/terrain
      const p = this.pos();
      if (p.x === tx && p.y === ty) return "arrived";
      // wq#583: sprite on the target — re-checked every replan so a wanderer
      // that steps off lets the journey finish normally, while a stationary
      // occupant ends it adjacent with an honest, distinct result.
      const occupied = this.map.sprites.some(sp => sp.x === tx && sp.y === ty);
      if (occupied && Math.abs(p.x - tx) + Math.abs(p.y - ty) === 1) {
        this.trace({ ev: "adjacent_npc", tx, ty, at: [p.x, p.y], replan: replans });
        return "adjacent_npc";
      }
      let gx = tx, gy = ty;
      if (occupied) {
        const adj = this.bestAdjacent(tx, ty);
        if (!adj) {
          this.bus.emit("tool_call", { tool: "goto", result: "npc_sealed" });
          return "stuck";           // every neighbour is wall/warp/sprite
        }
        gx = adj.x; gy = adj.y;
      }
      const path = astar(this.map, p.x, p.y, gx, gy, this.learnedBlocked);
      if (!path) {
        // A wandering NPC standing in a one-tile gap makes the map genuinely
        // pathless for a moment. Wait for them to move before conceding.
        if (++noPath <= 6) {
          this.learnedBlocked.clear();
          await this.emu.framesAsync(120);
          continue;
        }
        this.lastObstacle = { x: gx, y: gy, kind: "no_path" };
        this.bus.emit("tool_call", { tool: "goto", result: "no_path" });
        return "stuck";
      }
      noPath = 0;
      this.trace({ ev: "plan", tx, ty, replan: replans, from: { x: p.x, y: p.y },
                   len: path.length,
                   head: path.slice(0, TRACE_HEAD).map(c => [c.x, c.y]),
                   blocked: [...this.learnedBlocked] });
      for (const cell of path) {
        const cur = this.pos();
        const dx = cell.x - cur.x, dy = cell.y - cur.y;
        // wq#601: a 2-cell axis-aligned segment is a planned ledge hop — one
        // press, two cells. Verified against the live model so a stale plan
        // cell can never turn into a blind long-press: no hop edge here now
        // means desync -> replan, exactly like any other divergence.
        const isHop = ((Math.abs(dx) === 2 && dy === 0) || (Math.abs(dy) === 2 && dx === 0)) &&
                      this.map.hops(cur.x, cur.y).some(h => h.x === cell.x && h.y === cell.y);
        if (!isHop && Math.abs(dx) + Math.abs(dy) !== 1) {
          this.trace({ ev: "desync", replan: replans, at: { x: cur.x, y: cur.y },
                       want: [cell.x, cell.y] });
          break; // desynced from plan -> replan
        }
        const r = isHop ? await this.hopStep(Math.sign(dx), Math.sign(dy))
                        : await this.step(dx, dy);
        const now = this.pos();
        this.trace({ ev: "step", replan: replans, from: [cur.x, cur.y],
                     want: [cell.x, cell.y], d: [dx, dy], r,
                     to: [now.x, now.y], moved: now.x !== cur.x || now.y !== cur.y });
        if (r === "warped") return "warped";
        if (r === "battle") return "battle";
        if (r === "dialog") return "dialog";
        if (r === "blocked") {
          // wq#1662: name WHAT is at the cell that refused entry, not just
          // its coordinates.
          this.lastObstacle = classifyBlockedCell(this.map, cell.x, cell.y);
          this.learnedBlocked.add(`${cell.x},${cell.y}`);
          break; // replan
        }
      }
      const q = this.pos();
      if (q.x === tx && q.y === ty) return "arrived";
    }
    // 25 replans without arriving. learnedBlocked is per-journey and only ever
    // GROWS inside one goto, so its contents here are the walls this journey
    // taught itself — the difference between "the map is closed" and "we talked
    // ourselves into a box".
    const e = this.pos();
    this.trace({ ev: "exhausted", tx, ty, at: [e.x, e.y],
                 blocked: [...this.learnedBlocked] });
    return "stuck";
  }

  /**
   * wq#579: the player is standing ON an interior warp tile that did not fire
   * (typical after a resume from a post-transition checkpoint, or a goto that
   * pathed onto the tile). Gen 1 interior warps fire on STEPPING ONTO the
   * tile, so the only action that can succeed from here is: step OFF one
   * tile, then step back ON — checking BOTH results, which is the entire fix
   * (the old push loop performed exactly this step-back and threw its result
   * away). Returns null when no adjacent tile lets us detach and re-enter
   * cleanly — that is the door-warp shape (fires on outward push, not
   * step-on), which the caller's push/raw-press machinery owns.
   */
  private async detachAndReenter(): Promise<string | null> {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const before = this.pos();
      const off = await this.step(dx, dy);
      if (off === "warped") {
        // stepping OFF landed on an adjacent warp; a transition is a transition
        this.bus.emit("tool_call", { tool: "enterWarp", push: `off${dx},${dy}`, result: "warped" });
        return "warped";
      }
      if (off === "battle" || off === "dialog") return off;
      const mid = this.pos();
      if (mid.x === before.x && mid.y === before.y) continue;  // blocked; try another side
      const back = await this.step(-dx, -dy);
      if (back === "warped") {
        this.bus.emit("tool_call", { tool: "enterWarp", push: `reenter${dx},${dy}`, result: "warped" });
        return "warped";
      }
      if (back === "battle" || back === "dialog") return back;
      // We detached and (re-entered or got blocked back) without a transition:
      // an interior warp would have fired on the re-entry step, so this warp is
      // door-shaped or the tile is contested. Hand back to the normal flow —
      // goto() will walk us onto the tile again from wherever we now stand.
      return null;
    }
    return null;
  }

  /**
   * Traverse a warp. Interior warps (stairs, ladders) fire on step-on. Edge
   * door warps do not: the player must be pushed outward across the map
   * boundary. Try the boundary-implied direction first, then the rest.
   *
   * wq#579, observed live 2026-08-14 (T1 03:43Z, T22-T31 04:12-04:31Z):
   * standing ON the warp tile, goto() below is a no-op that cannot fire the
   * warp, and the push loop's discarded step-back was the one action that
   * could — see detachAndReenter(). The push loop also silently swallowed a
   * step-back that DID warp: the loop then kept stepping against the NEW
   * map's geometry and the tool finally reported "no_transition" while a
   * floor transition had actually occurred (T31). Every step result in this
   * function is now checked and honored.
   */
  async enterWarp(w: Warp): Promise<string> {
    const p0 = this.pos();
    if (p0.x === w.x && p0.y === w.y) {
      const early = await this.detachAndReenter();
      if (early) return early;
    }
    const r = await this.goto(w.x, w.y);
    if (r === "adjacent_npc") return "stuck";   // wq#583: an NPC parked on the warp tile
    if (r === "warped") return "warped";
    if (r === "battle") return "battle";
    if (r === "dialog") return "dialog";
    if (r === "stuck") return "stuck";

    const outward: [number, number][] = [];
    if (w.y >= this.map.gh - 1) outward.push([0, 1]);
    if (w.y <= 0) outward.push([0, -1]);
    if (w.x >= this.map.gw - 1) outward.push([1, 0]);
    if (w.x <= 0) outward.push([-1, 0]);
    const order: [number, number][] = [...outward, [0, 1], [0, -1], [1, 0], [-1, 0]];

    const tried = new Set<string>();
    for (const [dx, dy] of order) {
      const k = `${dx},${dy}`;
      if (tried.has(k)) continue;
      tried.add(k);
      const before = this.pos();
      const sr = await this.step(dx, dy);
      if (sr === "warped") {
        this.bus.emit("tool_call", { tool: "enterWarp", push: k, result: "warped" });
        return "warped";
      }
      // wq#579: a battle/dialog here used to be ignored, so the loop kept
      // "stepping" (each step no-ops in battle) and fell through to the
      // raw-press fallback, which then mashed direction keys INTO the battle
      // menu. Surface it; the transit machinery owns the resume.
      if (sr === "battle" || sr === "dialog") return sr;
      const after = this.pos();
      if (after.x !== before.x || after.y !== before.y) {
        const back = await this.step(-dx, -dy);
        // wq#579 (the original defect): this step-back is the action that
        // re-enters the warp tile and fires an interior ladder. Its result
        // was discarded, so the ONE step that could succeed was thrown away —
        // and when it DID warp, the loop kept running on the new map and the
        // tool reported "no_transition" over a real transition (T31 04:31Z).
        if (back === "warped") {
          this.bus.emit("tool_call", { tool: "enterWarp", push: `back${k}`, result: "warped" });
          return "warped";
        }
        if (back === "battle" || back === "dialog") return back;
      }
    }
    // Interior door warps (Center/Mart/building exits) sit on the visible bottom
    // row but the tile BELOW is collision-wall, so step() refuses and the push
    // loop above never fires. Gen1 fires these on the walk-into-wall animation:
    // raw-press the outward direction a few times regardless of the grid.
    for (const [dx, dy] of order) {
      if (dx === 0 && dy === -1) continue;   // never push back up into the room
      const key = dy > 0 ? KEYS.DOWN : dy < 0 ? KEYS.UP : dx > 0 ? KEYS.RIGHT : KEYS.LEFT;
      const startMap: number = this.pos().map ?? -1;
      for (let i = 0; i < 4; i++) {
        await this.emu.tapAsync(key, 8, 16);
        await this.sync?.settle(300);
        const nowMap: number = this.pos().map ?? -1;
        if (nowMap !== startMap) {
          // wq#699: this path declared the warp on a bare wCurMap compare with
          // no settle at all — the shortest route to a torn read in the file.
          await this.awaitMapSettled();
          this.bus.emit("tool_call", { tool: "enterWarp", push: `raw${dx},${dy}`, result: "warped" });
          return "warped";
        }
      }
    }
    this.bus.emit("tool_call", { tool: "enterWarp", result: "no_transition" });
    return "stuck";
  }

  /**
   * Leave the current map across a boundary edge (route-to-route travel).
   * Boundary openings are not warps and carry no table entry, so candidates
   * are derived from the collision grid and tried nearest-first: A* decides
   * which are actually reachable rather than us guessing from geometry.
   */
  async leaveMapEdge(dir: "N" | "S" | "E" | "W"): Promise<string> {
    this.map.build();
    const g = this.map.grid, gw = this.map.gw, gh = this.map.gh;
    const cands: { x: number; y: number }[] = [];
    if (dir === "N") for (let x = 0; x < gw; x++) { if (g[0][x]) cands.push({ x, y: 0 }); }
    if (dir === "S") for (let x = 0; x < gw; x++) { if (g[gh - 1][x]) cands.push({ x, y: gh - 1 }); }
    if (dir === "W") for (let y = 0; y < gh; y++) { if (g[y][0]) cands.push({ x: 0, y }); }
    if (dir === "E") for (let y = 0; y < gh; y++) { if (g[y][gw - 1]) cands.push({ x: gw - 1, y }); }

    const push: Record<string, [number, number]> =
      { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
    const [px, py] = [this.pos().x, this.pos().y];
    cands.sort((a, b) =>
      (Math.abs(a.x - px) + Math.abs(a.y - py)) - (Math.abs(b.x - px) + Math.abs(b.y - py)));

    this.bus.emit("tool_call", { tool: "leaveMapEdge", dir, candidates: cands.length });

    const startMap = this.pos().map;
    for (const c of cands) {
      const r = await this.goto(c.x, c.y);
      if (r === "warped") return "warped";
      if (r === "battle") return "battle";
      if (r === "stuck") continue;               // unreachable opening, try the next
      for (let i = 0; i < 3; i++) {
        const sr = await this.step(push[dir][0], push[dir][1]);
        if (sr === "battle") return "battle";
        if (sr === "warped" || this.pos().map !== startMap) {
          // wq#699: step() settles its own warps, but the `pos().map !==
          // startMap` arm fires on transitions step() never classified — an
          // edge crossing counts as a map load like any other.
          await this.awaitMapSettled();
          this.bus.emit("tool_call", { tool: "leaveMapEdge", dir, result: "left", via: c });
          return "warped";
        }
        if (sr === "blocked") break;
      }
    }
    this.bus.emit("tool_call", { tool: "leaveMapEdge", dir, result: "no_exit" });
    return "stuck";
  }

  clearLearned() { this.learnedBlocked.clear(); }
}
