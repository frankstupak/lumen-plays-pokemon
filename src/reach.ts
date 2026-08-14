// wq#538 (+ wq#536 folded in): warp reachability for the brain-facing state block.
//
// THE DEFECT THIS FIXES. The WARPS line enumerated every warp on the map with no
// signal about which ones the player can actually walk to, and a failed goto
// replied "stuck now {map,x,y}" — which says the attempt failed and nothing about
// what would succeed. A brain cannot learn reachability from that, so it re-picks
// from the same undifferentiated list. Measured cost: 25 minutes / 9 turns
// (wq#536, rabbit12) and 19 minutes / 8 turns (wq#535, rabbit13), both while the
// player was STANDING ON the warp that was the way out.
//
// WHY THIS REUSES astar() RATHER THAN ITS OWN FLOOD FILL. The annotation must
// agree with what goto() will actually do, or it becomes a second source of truth
// that drifts. astar has two rules a naive flood fill gets wrong: the TARGET cell
// is exempt from the passability check (warp tiles are frequently impassable
// terrain — doors, ladders), and an unrelated warp tile is never CROSSED, because
// stepping on one fires a map transition nobody asked for. Calling astar itself
// makes disagreement impossible by construction. Cost is one A* per warp per state
// render — at most 8 on the Mt Moon floors, on a <=40x36 grid, against turns that
// are minutes apart.
import { MapModel } from "./map";
import { astar } from "./nav";

export type WarpState = "here" | "reachable" | "unreachable";

export interface WarpView {
  i: number;
  x: number;
  y: number;
  destMap: number;
  dest: string;        // resolved display name
  state: WarpState;
  steps: number | null; // path length when reachable and not underfoot
}

/** Gen 1 warp destinations use 0xFF = "the map you last came in from", held in
 *  wLastMap. Rendering it as "map255" put a meaningless number on the single most
 *  valuable line in the state block: on Mt Moon B1F, warp 7 (27,3)->255 IS the
 *  exit onto Route 4. Resolve it; never filter it. */
export const LAST_MAP = 0xff;

export function resolveDest(destMap: number, lastMap: number,
                            mapName: (id: number) => string | null): string {
  const id = destMap === LAST_MAP ? lastMap : destMap;
  const name = mapName(id);
  // destMap 255 with an unusable wLastMap is still better shown as "outside"
  // than as "255": the player did come in from somewhere.
  if (!name) return destMap === LAST_MAP ? `where you came in (map${id})` : `map${id}`;
  return destMap === LAST_MAP ? `${name} (outside)` : name;
}

/** Can goto(tx,ty) find a route from (px,py) right now? Same predicate goto uses. */
export function pathTo(map: MapModel, px: number, py: number,
                       tx: number, ty: number): { x: number; y: number }[] | null {
  return astar(map, px, py, tx, ty, new Set<string>());
}

export function warpViews(map: MapModel, px: number, py: number, lastMap: number,
                          mapName: (id: number) => string | null): WarpView[] {
  return map.warps.map((w, i) => {
    const dest = resolveDest(w.destMap, lastMap, mapName);
    if (w.x === px && w.y === py)
      return { i, x: w.x, y: w.y, destMap: w.destMap, dest, state: "here" as WarpState, steps: 0 };
    const p = pathTo(map, px, py, w.x, w.y);
    return {
      i, x: w.x, y: w.y, destMap: w.destMap, dest,
      state: (p ? "reachable" : "unreachable") as WarpState,
      steps: p ? p.length : null,
    };
  });
}

/** The WARPS line. Compact, fixed order, one token-cheap marker per entry. */
export function renderWarps(views: WarpView[]): string {
  if (!views.length) return "WARPS none on this map";
  const body = views.map(v => {
    const mark = v.state === "here" ? "STANDING-ON-IT"
      : v.state === "reachable" ? `${v.steps} steps`
        : "NO PATH";
    return `${v.i}:(${v.x},${v.y})->${v.dest} [${mark}]`;
  }).join("  ");
  const here = views.find(v => v.state === "here");
  // A warp underfoot is invisible as an option: it already fired when you
  // arrived, so it looks used up. It is not — enter_warp steps off and back on,
  // which re-triggers it. rabbit12 watched the brain take 25 minutes and 9 turns
  // to discover this by accident (wq#536 T40), so the state block says it now.
  const hint = here
    ? `\n! You are STANDING ON warp ${here.i} — enter_warp(${here.i}) still uses it (it steps off and back on).`
    : "";
  return `WARPS ${body}${hint}`;
}

/** The reply a failed goto gets. Says why it failed and what would work. */
export function stuckHint(map: MapModel, px: number, py: number,
                          tx: number, ty: number, views: WarpView[]): string {
  const p = pathTo(map, px, py, tx, ty);
  // wq#583: a sprite standing ON the target makes pathTo's goal-cell
  // exemption report "reachable" forever while the engine refuses every
  // arrival. Say what is actually there instead of coaching a retry.
  if (map.sprites.some(sp => sp.x === tx && sp.y === ty)) {
    return ` — (${tx},${ty}) is OCCUPIED BY AN NPC standing on it; walking onto them is` +
      ` impossible. goto an adjacent tile (nav now stops adjacent automatically) and` +
      ` talk()/interact if you meant them.`;
  }
  if (p) {
    // Reachable but the walk did not finish: encounters, a wandering NPC in a
    // one-tile gap, or the replan limit. Distinguishing this from "unreachable"
    // matters — the right response is to retry or clear the interruption, NOT to
    // pick a different target, and the old bare "stuck" pushed the brain the
    // wrong way on both.
    return ` — (${tx},${ty}) IS reachable from here (${p.length} steps) but the walk did not finish;` +
      ` something interrupted it (wild encounters or an NPC in the way), the target is not the problem.`;
  }
  const usable = views.filter(v => v.state !== "unreachable");
  if (!usable.length)
    return ` — no path to (${tx},${ty}) from here, and NO warp on this map is reachable either.`;
  const list = usable.map(v =>
    `${v.i}:(${v.x},${v.y})->${v.dest}${v.state === "here" ? " (you are standing on it)" : ""}`).join(", ");
  return ` — no path to (${tx},${ty}) from where you stand; you are in a closed-off part of this map.` +
    ` Reachable warps: ${list}. Use enter_warp to leave, not goto.`;
}
