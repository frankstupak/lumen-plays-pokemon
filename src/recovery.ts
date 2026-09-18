// wq#477: whiteout / story-regression recovery — goal injection ONLY.
// No navigation-engine changes: this module decides WHEN the brain needs a
// top-priority recovery objective and WHAT frontier point to name; the brain
// still does all the driving with its normal tools.
//
// Two regression modes, one tracker:
//   whiteout          — party all-fainted edge; game respawns at the last
//                       Pokemon Center. storyScore is intact (flags are
//                       permanent) but POSITION regressed. Goal clears when
//                       the player reaches the frontier target map.
//   score_regression  — current storyScore < max ever reached this campaign
//                       (happens when a reboot resumes an OLDER checkpoint).
//                       Goal clears when storyScore re-attains the max.
// Frontier invariant: score == max and no whiteout pending => evaluate()
// returns null. Normal exploration is never touched.
import { STORY_FLAGS, GameState } from "./state";
import { EventBus } from "./events";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

/** storyScore->corridor mapping (the "small table" of wq#477): for the
 *  FURTHEST story milestone attained, where the campaign frontier is.
 *  Ordered most-advanced-first; the first entry whose flag is set wins.
 *  Map ids are pret/pokered map constants, cross-checked against the live
 *  notepad corpus (Pewter=2, Route2=13, Route3=14, Route4=15, MtMoon=59). */
export interface CorridorPoint { afterFlag: string; targetMap: number; desc: string }
export const CORRIDOR: CorridorPoint[] = [
  { afterFlag: "EVENT_BEAT_BLAINE",   targetMap: 1, desc: "Viridian City - the final gym (Giovanni) is here" },
  { afterFlag: "EVENT_BEAT_SABRINA",  targetMap: 8, desc: "Cinnabar Island - Blaine's gym is next" },
  { afterFlag: "EVENT_BEAT_KOGA",     targetMap: 10, desc: "Saffron City - Sabrina's gym is next" },
  { afterFlag: "EVENT_GOT_POKE_FLUTE", targetMap: 7, desc: "Fuchsia City - Koga's gym; the Poke Flute wakes Snorlax on the way" },
  { afterFlag: "EVENT_RESCUED_MR_FUJI", targetMap: 4, desc: "Lavender Town - Mr. Fuji gives the Poke Flute" },
  { afterFlag: "EVENT_BEAT_ERIKA",    targetMap: 4, desc: "Lavender Town / Pokemon Tower - rescue Mr. Fuji" },
  { afterFlag: "EVENT_BEAT_LT_SURGE", targetMap: 6, desc: "Celadon City - Erika's gym (east via Rock Tunnel, then west)" },
  { afterFlag: "EVENT_SS_ANNE_LEFT",  targetMap: 5, desc: "Vermilion City - Lt. Surge's gym" },
  { afterFlag: "EVENT_GOT_SS_TICKET", targetMap: 5, desc: "Vermilion City - board the SS Anne for HM01 Cut" },
  { afterFlag: "EVENT_BEAT_MISTY",    targetMap: 3, desc: "Cerulean City - then south via Route 5 toward Vermilion" },
  { afterFlag: "EVENT_BEAT_CERULEAN_RIVAL", targetMap: 3, desc: "Cerulean City - Misty's gym" },
  { afterFlag: "EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD", targetMap: 15, desc: "Route 4 EAST of Mt Moon (map15) - continue east to Cerulean City (map3)" },
  { afterFlag: "EVENT_GOT_DOME_FOSSIL",  targetMap: 15, desc: "Route 4 EAST of Mt Moon (map15) - continue east to Cerulean City (map3)" },
  { afterFlag: "EVENT_GOT_HELIX_FOSSIL", targetMap: 15, desc: "Route 4 EAST of Mt Moon (map15) - continue east to Cerulean City (map3)" },
  { afterFlag: "EVENT_BEAT_BROCK",    targetMap: 14, desc: "Route 3 east of Pewter (map14) - head east into Mt Moon (map59)" },
  { afterFlag: "EVENT_GOT_POKEDEX",   targetMap: 2, desc: "Pewter City (map2) - Brock's gym; corridor Forest(51)->gate47->Route2(13)->Pewter" },
  { afterFlag: "EVENT_OAK_GOT_PARCEL", targetMap: 2, desc: "Pewter City (map2) - Brock's gym; corridor Forest(51)->gate47->Route2(13)->Pewter" },
  { afterFlag: "EVENT_GOT_OAKS_PARCEL", targetMap: 0, desc: "Pallet Town (map0) - deliver Oak's parcel at the lab" },
  { afterFlag: "EVENT_GOT_STARTER",   targetMap: 1, desc: "Viridian City (map1) - Oak's parcel waits at the Mart" },
];
const FALLBACK: CorridorPoint = { afterFlag: "(none)", targetMap: 0, desc: "Pallet Town (map0) - Oak's lab, get your starter" };
const FLAG_IDX = new Map(STORY_FLAGS.map(f => [f.name, f.idx]));

/** First (most advanced) corridor entry whose milestone flag is set.
 *  flagAt = StateReader.eventFlag (injected for probe testability). */
export function corridorPoint(flagAt: (idx: number) => boolean): CorridorPoint {
  for (const c of CORRIDOR) {
    const idx = FLAG_IDX.get(c.afterFlag);
    if (idx !== undefined && flagAt(idx)) return c;
  }
  return FALLBACK;
}

/** Seed the campaign-level max storyScore from existing checkpoint sidecars
 *  so a service restart onto an older checkpoint is still detected as a
 *  regression. Reads storyScore AND maxStoryScore fields (v2 sidecars may
 *  lack either - typeof-guarded, same convention as resume.ts). */
export function seedMaxFromSidecars(dirs: string[]): number {
  let max = 0;
  for (const d of dirs) {
    let files: string[] = [];
    try { files = readdirSync(d).filter(f => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(`${d}/${f}`, "utf8"));
        if (typeof j.storyScore === "number") max = Math.max(max, j.storyScore);
        if (typeof j.maxStoryScore === "number") max = Math.max(max, j.maxStoryScore);
      } catch {}
    }
  }
  return max;
}

interface ActiveGoal { reason: "whiteout" | "score_regression"; target: CorridorPoint; sinceTurn: number }

// wq#1178 (roadmap item 8): divergence-on-repeat. A recovery objective above
// names WHERE the frontier is but not HOW to get there, and if the brain's
// plan from THIS EXACT SPOT keeps producing zero progress, repeating the
// same objective text just re-runs the same failed plan — the improvement
// plan's section 2d RESUME_DEADEND behavioral half: "replaying identical
// context from an identical state produces an identical run". This tracks
// (map, x, y, objective) recurrence WHILE a recovery goal is active — the one
// regime where "no frontier progress" is already an established fact here
// (evaluate() only reaches this point when `this.active` is still set),
// not a guess — and once the same tuple has come up REPEAT_LIMIT times,
// swaps the plain objective text for one that explicitly forbids repeating
// the plan that already failed that many times.
export interface RepeatEntry { map: number; x: number; y: number; objective: string; turn: number }
export const REPEAT_LIMIT = 3;
const REPEAT_KEEP = 32;

function repeatKey(map: number, x: number, y: number, objective: string): string {
  return `${map}:${x}:${y}:${objective}`;
}

/** How many times this exact (map,x,y,objective) tuple already appears in
 *  the history — pure, so the repeat rule is unit-testable without wiring up
 *  a whole RecoveryTracker. */
export function countRepeats(history: RepeatEntry[], map: number, x: number, y: number,
                             objective: string): number {
  const key = repeatKey(map, x, y, objective);
  return history.filter(e => repeatKey(e.map, e.x, e.y, e.objective) === key).length;
}

/** Rotating, never the sub-goal it just replaced — a fixed divergent remedy
 *  that never changes is the same wedge as no remedy, just with an extra
 *  layer of prose (wq#517 lesson, restated for objectives instead of bans). */
const DIVERGENT_SUBGOALS = [
  "STOP repeating that plan: pick a warp INDEX you have not fired from this exact spot.",
  "STOP repeating that plan: try leave_edge() toward a direction you have not tried from here.",
  "STOP repeating that plan: goto() an unexplored tile nearby before touching any warp again.",
];

export function divergentObjective(base: CorridorPoint, attempt: number): string {
  const sub = DIVERGENT_SUBGOALS[attempt % DIVERGENT_SUBGOALS.length];
  return `${sub} Frontier target is unchanged: ${base.desc} (map${base.targetMap}). Your last ` +
    `${REPEAT_LIMIT}+ attempts from this exact (map,position) with this exact objective produced ` +
    `zero progress — the plan is the thing that has to change, not the target.`;
}

export function repeatHistoryFile(): string {
  return process.env.LPP_RECOVERY_REPEAT_HISTORY ?? `${process.cwd()}/runtime/recovery_repeat.json`;
}

export function loadRepeatHistory(file: string): RepeatEntry[] {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as { v: number; entries: RepeatEntry[] };
    if (s && Array.isArray(s.entries)) {
      return s.entries.filter(e => e && typeof e.map === "number" && typeof e.x === "number"
        && typeof e.y === "number" && typeof e.objective === "string"
        && typeof e.turn === "number").slice(-REPEAT_KEEP);
    }
  } catch {}
  return [];
}

export function saveRepeatHistory(file: string, entries: RepeatEntry[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, entries: entries.slice(-REPEAT_KEEP) }));
  } catch {}
}

export class RecoveryTracker {
  maxStoryScore: number;
  private wasAllFainted = false;
  private active: ActiveGoal | null = null;
  // wq#1178: lazy-loaded from disk on first use, same convention as
  // agent.ts's crossRunWarps — must survive both a `continue` (new
  // RecoveryTracker instance) and a full restart, mirroring
  // seedMaxFromSidecars' reason for existing at all.
  private repeatHistory: RepeatEntry[] | null = null;

  constructor(seedMax = 0) { this.maxStoryScore = seedMax; }

  /** Once per turn, BEFORE the brain sees the state. Returns the goal line to
   *  inject into the state block, or null (the frontier / no-regression case). */
  evaluate(st: GameState, score: number, flagAt: (idx: number) => boolean,
           bus: EventBus, turn: number): string | null {
    // whiteout edge (same all-fainted edge logic as metrics.ts / retry.ts)
    const allFainted = st.party.length > 0 && st.party.every(p => p.hp === 0);
    const whiteoutEdge = allFainted && !this.wasAllFainted;
    this.wasAllFainted = allFainted;

    if (score > this.maxStoryScore) this.maxStoryScore = score;

    // clear before trigger, so re-attaining and re-triggering can't overlap
    if (this.active) {
      const cleared =
        (this.active.reason === "score_regression" && score >= this.maxStoryScore) ||
        (this.active.reason === "whiteout" && st.map === this.active.target.targetMap);
      if (cleared) {
        bus.emit("regression", { stage: "cleared", reason: this.active.reason,
          score, max: this.maxStoryScore, turns: turn - this.active.sinceTurn });
        this.active = null;
      }
    }

    if (!this.active && score < this.maxStoryScore) {
      this.active = { reason: "score_regression", target: corridorPoint(flagAt), sinceTurn: turn };
      bus.emit("regression", { stage: "detected", reason: "score_regression",
        score, max: this.maxStoryScore, targetMap: this.active.target.targetMap, desc: this.active.target.desc });
    } else if (!this.active && whiteoutEdge) {
      this.active = { reason: "whiteout", target: corridorPoint(flagAt), sinceTurn: turn };
      bus.emit("regression", { stage: "detected", reason: "whiteout",
        score, max: this.maxStoryScore, targetMap: this.active.target.targetMap, desc: this.active.target.desc });
    }

    if (!this.active) return null;
    const t = this.active.target;
    const why = this.active.reason === "whiteout"
      ? "You BLACKED OUT and respawned at the last Pokemon Center"
      : `You resumed BEHIND your best progress (story ${score}/${this.maxStoryScore})`;

    // wq#1178 (roadmap item 8): recurrence check, scoped to exactly the
    // regime where "no progress" is already established — a live recovery
    // goal (we only reach here when this.active is still set).
    if (this.repeatHistory === null) this.repeatHistory = loadRepeatHistory(repeatHistoryFile());
    const objective = t.desc;
    const priorCount = countRepeats(this.repeatHistory, st.map, st.x, st.y, objective);
    this.repeatHistory.push({ map: st.map, x: st.x, y: st.y, objective, turn });
    if (this.repeatHistory.length > REPEAT_KEEP) this.repeatHistory.shift();
    saveRepeatHistory(repeatHistoryFile(), this.repeatHistory);
    if (priorCount + 1 >= REPEAT_LIMIT) {
      bus.emit("regression", { stage: "divergent_objective", reason: this.active.reason,
        map: st.map, x: st.x, y: st.y, objective, count: priorCount + 1 });
      return `!! RECOVERY OBJECTIVE (top priority): ${why}. ${divergentObjective(t, priorCount)}`;
    }
    return `!! RECOVERY OBJECTIVE (top priority): ${why}. Return to the frontier: ${t.desc}. Target map${t.targetMap}. Heal if needed, then head straight there - no detours.`;
  }
}
