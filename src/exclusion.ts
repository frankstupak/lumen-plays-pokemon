// wq#1828: the other half of the escape. src/explore.ts walks the agent out of
// a stalled patch; nothing stopped the brain from walking back in, and every
// one of the nine historical fires reads `escaped: true, mapChanged: false`.
//
// So the patch the override just escaped is written down, and for the next
// `excludeTurns` turns `goto` REFUSES it as a destination — the wq#1181 loss
// ledger's shape: a refusal that names the reason and its expiry, not a silent
// no-op the brain cannot plan around.
//
// ADVISORY FOR MOVEMENT, NOT FOR ROUTING. Only the DESTINATION is refused;
// walking through the patch on the way somewhere else stays legal. A patch that
// straddles the only corridor off the map would otherwise brick the run, which
// is a worse failure than the stall it is fixing.
//
// It lifts on any of three things, because dead ground stops being dead: the
// turn budget runs out, the agent leaves the map, or a new tile is discovered
// inside the patch (the brain found something there after all — let it back in).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface Exclusion {
  v: 1;
  tiles: string[];    // tileKey(map,x,y) of the stalled patch
  map: number;        // the map it sits on; leaving lifts it
  untilTurn: number;
  fromFire: number;   // the override fire that produced it
  fires: number;      // refusals issued so far
  iso: string;
}

/** Refusals one exclusion may issue before it lifts itself. The wq#1181 gate's
 *  anti-wedge number, for the wq#1181 reason: an exclusion that keeps refusing
 *  is not steering the brain, it is arguing with it, and the brain has already
 *  spent ten turns hearing no. */
export const EXCLUSION_MAX_FIRES = 10;

export function exclusionFile(runtimeDir?: string): string {
  return process.env.LPP_EXPLORE_EXCLUSION ??
    `${runtimeDir ?? `${process.cwd()}/runtime`}/explore_exclusion.json`;
}

export function loadExclusion(file: string): Exclusion | null {
  try {
    const e = JSON.parse(readFileSync(file, "utf8")) as Exclusion;
    if (e && Array.isArray(e.tiles) && typeof e.untilTurn === "number" && typeof e.map === "number") {
      return { ...e, v: 1, tiles: e.tiles.filter(t => typeof t === "string") };
    }
  } catch { /* absent or corrupt: no exclusion is the safe reading */ }
  return null;
}

/** Why the exclusion is no longer live, or null while it still is. Pure, so the
 *  probe can assert every expiry without a clock or a filesystem. */
export function exclusionLift(e: Exclusion, turn: number, map: number): string | null {
  if (turn >= e.untilTurn) return `expired at turn ${e.untilTurn}`;
  if (map !== e.map) return `you left map${e.map}`;
  if ((e.fires ?? 0) >= EXCLUSION_MAX_FIRES) return `refused ${e.fires} times without steering`;
  return null;
}

/** The `goto` refusal. Names the patch, the turn it lifts, and the two other
 *  ways out, because a refusal with no visible exit is how wq#517 wedged. */
export function exclusionRefusal(e: Exclusion, turn: number, x: number, y: number,
                                 label: string): string {
  return `refused - EXPLORATION EXCLUSION on ${label} (${x},${y}): the harness escape ` +
    `(fire #${e.fromFire}) just walked you out of this ${e.tiles.length}-tile patch, ` +
    `where you paced with no new ground. It lifts at turn ${e.untilTurn} ` +
    `(${Math.max(0, e.untilTurn - turn)} turns), after ${Math.max(0, EXCLUSION_MAX_FIRES - e.fires)} ` +
    `more refusals, the moment you leave map${e.map}, ` +
    `or as soon as you stand somewhere new inside it. Walking THROUGH the patch is ` +
    `fine - pick a destination OUTSIDE it: a warp, an edge, or unexplored ground.`;
}

/** Per-run holder of the live exclusion. One file, rewritten on set and removed
 *  on lift; every file operation is fail-soft, because bookkeeping may never
 *  break a turn (the novelty.ts / oscillation.ts contract). */
export class ExclusionGate {
  private cur: Exclusion | null;

  constructor(private file: string, private bus?: { emit(kind: any, data: object): void }) {
    this.cur = loadExclusion(file);
  }

  current(): Exclusion | null { return this.cur; }

  /** Record the patch an override just escaped. `turns <= 0` (the
   *  LPP_EXPLORE_EXCLUDE_TURNS=0 revert) records nothing. */
  set(p: { tiles: string[]; map: number; turn: number; turns: number; fromFire: number }): void {
    if (p.turns <= 0 || !p.tiles.length) return;
    const e: Exclusion = {
      v: 1, tiles: [...new Set(p.tiles)], map: p.map, untilTurn: p.turn + p.turns,
      fromFire: p.fromFire, fires: 0, iso: new Date().toISOString(),
    };
    this.cur = e;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(e));
    } catch {}
    this.bus?.emit("exploration_override", {
      stage: "exclusion", tiles: e.tiles.length, map: e.map, untilTurn: e.untilTurn, fire: e.fromFire });
  }

  /** The live exclusion for this turn, lifting it first if it is spent. */
  live(turn: number, map: number): Exclusion | null {
    if (!this.cur) return null;
    const lift = exclusionLift(this.cur, turn, map);
    if (lift) { this.clear(lift); return null; }
    return this.cur;
  }

  /** The refusal for a goto target, or null when the target is allowed. */
  refuse(turn: number, map: number, x: number, y: number, label: string): string | null {
    const e = this.live(turn, map);
    if (!e || !e.tiles.includes(`${map},${x},${y}`)) return null;
    e.fires++;
    try { writeFileSync(this.file, JSON.stringify(e)); } catch {}
    this.bus?.emit("exploration_override", {
      stage: "exclusion_refused", map, x, y, untilTurn: e.untilTurn,
      fire: e.fromFire, fires: e.fires });
    return exclusionRefusal(e, turn, x, y, label);
  }

  /** One novelty sample. New ground inside the patch means it was not dead
   *  after all; a map change means we are no longer near it. Both lift. */
  observe(turn: number, map: number, x: number, y: number, newTiles: number): string | null {
    if (!this.cur) return null;
    if (newTiles > 0 && this.cur.tiles.includes(`${map},${x},${y}`)) {
      const why = `new ground at (${x},${y}) inside the patch`;
      this.clear(why);
      return why;
    }
    const lift = exclusionLift(this.cur, turn, map);
    if (lift) { this.clear(lift); return lift; }
    return null;
  }

  clear(reason: string): void {
    if (!this.cur) return;
    const fire = this.cur.fromFire;
    this.cur = null;
    try { if (existsSync(this.file)) unlinkSync(this.file); } catch {}
    this.bus?.emit("exploration_override", { stage: "exclusion_lifted", reason, fire });
  }
}
