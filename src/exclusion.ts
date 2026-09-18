// wq#1828: the other half of the escape. src/explore.ts walks the agent out of
// a stalled patch; nothing stopped the brain from walking back in, and every
// one of the nine historical fires reads `escaped: true, mapChanged: false`.
//
// So the patch the override just escaped is written down, and for the next
// `excludeTurns` samples `goto` REFUSES it as a destination — the wq#1181 loss
// ledger's shape: a refusal that names the reason and its expiry, not a silent
// no-op the brain cannot plan around.
//
// ADVISORY FOR MOVEMENT, NOT FOR ROUTING. Only the DESTINATION is refused;
// walking through the patch on the way somewhere else stays legal. A patch that
// straddles the only corridor off the map would otherwise brick the run, which
// is a worse failure than the stall it is fixing.
//
// wq#1839 closed the two ways the ban missed the cycle it was written for:
//
//   LEAVING THE MAP SUSPENDS IT, it does not lift it. The measured stall IS a
//   shuttle — map35 held 398 of 512 samples while pops to Route 25 / Bill's /
//   Cerulean vetoed 259 of 363 stall windows (docs/EXPLORE_STALL_1744.md:26,48)
//   — so lifting on the excursion lifted on the very thing the ban exists to
//   survive. Off `map` the ban enforces nothing anyway: goto is same-map and
//   every key it holds names that map, so sleeping costs nothing and waking
//   costs the walk back.
//
//   ITS BUDGET IS NOVELTY SEQ, not the agent's turn counter. `Agent.turn`
//   restarts at 1 every process start and the live unit restarts ~2h, shorter
//   than a 60-turn ban: the three generations in
//   runtime/stuck_escalation_overrides.jsonl fire at turns 1/184/364, then
//   101/280/459, then 83/266/445. A turn-keyed `untilTurn` recovered after one
//   of those restarts therefore served its WHOLE span again. `seq` is monotonic
//   across runs (novelty.ts:86) — the same reason explore.ts's flush floor and
//   the wq#1746 watch key off it.
//
// It lifts on any of four things, because dead ground stops being dead: the
// sample budget runs out, a new tile is discovered inside the patch (the brain
// found something there after all — let it back in), ten refusals go unheeded,
// or the novelty counter goes backwards (the progress store was reset under us,
// so the recorded budget no longer means anything).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { REFUSAL_BUDGET_PHRASE } from "./ceiling";   // wq#1090: exempt from the retry ceiling

export interface Exclusion {
  v: 2;
  tiles: string[];    // tileKey(map,x,y) of the stalled patch
  map: number;        // the map it sits on; leaving SUSPENDS it, never lifts it
  fromSeq: number;    // the novelty sample it was written at
  untilSeq: number;   // ...and the one it lifts on. Seq, not turn: see the header
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
    // v1 (wq#1828) was turn-keyed, and there is no honest conversion from a
    // turn budget to a sample one — the counter it was written against is gone.
    // Dropping it is the same reading as a corrupt file: no exclusion.
    if (e && e.v === 2 && Array.isArray(e.tiles) && typeof e.map === "number" &&
        typeof e.fromSeq === "number" && typeof e.untilSeq === "number") {
      return { ...e, v: 2, tiles: e.tiles.filter(t => typeof t === "string") };
    }
  } catch { /* absent or corrupt: no exclusion is the safe reading */ }
  return null;
}

/** Why the exclusion is no longer live, or null while it still is. Leaving the
 *  map is NOT here — that suspends it (`exclusionSuspended`). Pure, so the probe
 *  can assert every expiry without a clock or a filesystem. */
export function exclusionLift(e: Exclusion, seq: number): string | null {
  if (seq >= e.untilSeq) return `expired at sample ${e.untilSeq}`;
  // Monotonic across restarts unless the progress store itself was reset or
  // rolled back; then the stored budget is measured against a counter that no
  // longer exists, and holding it would be holding an unknown span.
  if (seq < e.fromSeq) return `novelty counter reset (${seq} < ${e.fromSeq})`;
  if ((e.fires ?? 0) >= EXCLUSION_MAX_FIRES) return `refused ${e.fires} times without steering`;
  return null;
}

/** Off `e.map` the ban has nothing to refuse: goto is same-map (crossMapRefusal
 *  in agent.ts) and every key names `e.map`. So it sleeps rather than dies —
 *  the live stall is a shuttle, and the excursion is what it must survive. */
export function exclusionSuspended(e: Exclusion, map: number): boolean {
  return map !== e.map;
}

/** The `goto` refusal. Names the patch, what is left of its budget, and the
 *  other ways out, because a refusal with no visible exit is how wq#517 wedged.
 *  It says leaving only PAUSES it so the brain does not spend a trip to Route 25
 *  buying a lift it will not get. */
export function exclusionRefusal(e: Exclusion, seq: number, x: number, y: number,
                                 label: string): string {
  return `refused - EXPLORATION EXCLUSION on ${label} (${x},${y}): the harness escape ` +
    `(fire #${e.fromFire}) just walked you out of this ${e.tiles.length}-tile patch, ` +
    `where you paced with no new ground. It lifts in ${Math.max(0, e.untilSeq - seq)} turns, ` +
    `after ${Math.max(0, EXCLUSION_MAX_FIRES - e.fires)} ${REFUSAL_BUDGET_PHRASE}, ` +
    `or as soon as you stand somewhere new inside it. Leaving map${e.map} only PAUSES it - ` +
    `it is still waiting when you come back. Walking THROUGH the patch is ` +
    `fine - pick a destination OUTSIDE it: a warp, an edge, or unexplored ground.`;
}

/** Per-run holder of the live exclusion. One file, rewritten on set and removed
 *  on lift; every file operation is fail-soft, because bookkeeping may never
 *  break a turn (the novelty.ts / oscillation.ts contract). */
export class ExclusionGate {
  private cur: Exclusion | null;
  /** wq#1839: off the excluded map. In-memory only — it is a function of where
   *  the agent stands right now, and the ban on disk is unchanged by it. */
  private asleep = false;

  constructor(private file: string, private bus?: { emit(kind: any, data: object): void }) {
    this.cur = loadExclusion(file);
  }

  current(): Exclusion | null { return this.cur; }

  /** Held but unenforceable, because the agent is on another map. */
  suspended(): boolean { return this.cur !== null && this.asleep; }

  /** Record the patch an override just escaped. `turns <= 0` (the
   *  LPP_EXPLORE_EXCLUDE_TURNS=0 revert) records nothing. */
  set(p: { tiles: string[]; map: number; seq: number; turns: number; fromFire: number }): void {
    if (p.turns <= 0 || !p.tiles.length) return;
    const e: Exclusion = {
      v: 2, tiles: [...new Set(p.tiles)], map: p.map,
      fromSeq: p.seq, untilSeq: p.seq + p.turns,
      fromFire: p.fromFire, fires: 0, iso: new Date().toISOString(),
    };
    this.cur = e;
    this.asleep = false;   // the escape that wrote it ended on `map` by construction
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(e));
    } catch {}
    this.bus?.emit("exploration_override", {
      stage: "exclusion", tiles: e.tiles.length, map: e.map, fromSeq: e.fromSeq,
      untilSeq: e.untilSeq, fire: e.fromFire });
  }

  /** wq#1746: the exclusion as it stands, WITHOUT lifting a spent one. The
   *  escape verdict reads the refusal count while writing its record and must
   *  not change gate state to do it; `live()` is the deciding read. */
  peek(): Exclusion | null { return this.cur; }

  /** The exclusion enforceable on this sample: null when it is spent (lifted
   *  here) and null while it sleeps off-map (held, and still ageing). */
  live(seq: number, map: number): Exclusion | null {
    if (!this.cur) return null;
    const lift = exclusionLift(this.cur, seq);
    if (lift) { this.clear(lift); return null; }
    const asleep = exclusionSuspended(this.cur, map);
    if (asleep !== this.asleep) {
      this.asleep = asleep;
      this.bus?.emit("exploration_override", {
        stage: asleep ? "exclusion_suspended" : "exclusion_resumed",
        map, untilSeq: this.cur.untilSeq, fire: this.cur.fromFire });
    }
    return asleep ? null : this.cur;
  }

  /** The refusal for a goto target, or null when the target is allowed. */
  refuse(seq: number, map: number, x: number, y: number, label: string): string | null {
    const e = this.live(seq, map);
    if (!e || !e.tiles.includes(`${map},${x},${y}`)) return null;
    e.fires++;
    try { writeFileSync(this.file, JSON.stringify(e)); } catch {}
    this.bus?.emit("exploration_override", {
      stage: "exclusion_refused", map, x, y, untilSeq: e.untilSeq,
      fire: e.fromFire, fires: e.fires });
    return exclusionRefusal(e, seq, x, y, label);
  }

  /** One novelty sample. New ground inside the patch means it was not dead
   *  after all, and that lifts it; a map change only puts it to sleep. */
  observe(seq: number, map: number, x: number, y: number, newTiles: number): string | null {
    if (!this.cur) return null;
    if (newTiles > 0 && this.cur.tiles.includes(`${map},${x},${y}`)) {
      const why = `new ground at (${x},${y}) inside the patch`;
      this.clear(why);
      return why;
    }
    const lift = exclusionLift(this.cur, seq);
    if (lift) { this.clear(lift); return lift; }
    this.live(seq, map);    // the sleep/wake edge for this sample
    return null;
  }

  clear(reason: string): void {
    if (!this.cur) return;
    const fire = this.cur.fromFire;
    this.cur = null;
    this.asleep = false;
    try { if (existsSync(this.file)) unlinkSync(this.file); } catch {}
    this.bus?.emit("exploration_override", { stage: "exclusion_lifted", reason, fire });
  }
}
