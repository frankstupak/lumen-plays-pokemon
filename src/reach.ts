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
//
// wq#1870 (Cerulean, 26 turns): "reachable" was the wrong question. The agent
// stood in Cerulean's main region, which the ROM collision data really does cut
// off from the map's south and east edges — every warp it could reach was a
// shop or a house whose only door back onto map3 is the one it walked in by, so
// "Use enter_warp to leave, not goto" sent it through the Mart and the
// Pokecenter sixteen times and returned it to the same tile. What a split map
// needs named is an exit that CHANGES REGION: a warp with a second door you
// cannot walk to, or a boundary edge you can. Both are computed here from data
// warpViews already has, and stuckHint names them instead of the raw list.
import { MapModel } from "./map";
import { astar, reachableCells, Obstacle } from "./nav";
import { ROUTE_EDGES } from "./route_graph";
import { mapLabel } from "./route";

export type WarpState = "here" | "reachable" | "unreachable";

export interface WarpView {
  i: number;
  x: number;
  y: number;
  destMap: number;
  dest: string;        // resolved display name
  state: WarpState;
  steps: number | null; // path length when reachable and not underfoot
  /** wq#1870: a second door to the same map that you CANNOT walk to from here.
   *  Gen 1 pass-through buildings (Cerulean's trashed house, the underground
   *  path huts) put their two doors in different parts of the outdoor map, so
   *  this warp is the one thing on the WARPS line that moves you across a split.
   *  null when the warp has no such sibling — including every ordinary shop,
   *  whose single door returns you to the tile you left.
   *
   *  `opens` is what separates a way out from another trap: Cerulean has two
   *  pass-throughs, and the Badge House's far door leads to a 33-cell fenced
   *  yard with no edge and no other warp. The live agent went in twice. */
  otherSide: { i: number; x: number; y: number; opens: boolean; edges: EdgeDir[] } | null;
}

export type EdgeDir = "N" | "S" | "E" | "W";

/** pokered map_data_constants, as read by MapModel.connections (wq#606). */
const CONN_BIT: Record<EdgeDir, number> = { E: 1, W: 2, S: 4, N: 8 };
const EDGE_VIA: Record<EdgeDir, string> = { N: "north", S: "south", E: "east", W: "west" };

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
  const base = map.warps.map((w, i) => {
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
  return base.map(v => ({ ...v, otherSide: crossingSibling(map, base, v) }));
}

/** The far door of a pass-through building: another warp on THIS map with the
 *  same destination that the player cannot walk to. destMap 0xFF is excluded —
 *  it means "wherever I came in from", so two of them are not the same building
 *  and pairing them would invent a crossing that does not exist. */
function crossingSibling(map: MapModel, all: Omit<WarpView, "otherSide">[],
                         v: Omit<WarpView, "otherSide">): WarpView["otherSide"] {
  if (v.state === "unreachable" || v.destMap === LAST_MAP) return null;
  const s = all.find(o => o.i !== v.i && o.destMap === v.destMap && o.state === "unreachable");
  if (!s) return null;
  // What the far door opens onto, walked from the door itself: a region with a
  // map edge, or one holding a door other than this building's two, is somewhere
  // to go. One with neither is a yard.
  const far = reachableCells(map, s.x, s.y);
  const edges = edgesOf(map, far);
  const otherWarps = map.warps.some((w, i) =>
    i !== v.i && i !== s.i && far.has(`${w.x},${w.y}`));
  return { i: s.i, x: s.x, y: s.y, opens: edges.length > 0 || otherWarps, edges };
}

/** Boundary directions a set of cells touches, filtered by the map header's
 *  connection byte: a direction with no connection is 14 steps into a wall
 *  (wq#606), reachable opening or not. */
function edgesOf(map: MapModel, cells: ReadonlySet<string>): EdgeDir[] {
  const out: EdgeDir[] = [];
  for (const d of ["N", "S", "E", "W"] as EdgeDir[]) {
    if (!(map.connections & CONN_BIT[d])) continue;
    let hit = false;
    if (d === "N") for (let x = 0; x < map.gw && !hit; x++) hit = cells.has(`${x},0`);
    if (d === "S") for (let x = 0; x < map.gw && !hit; x++) hit = cells.has(`${x},${map.gh - 1}`);
    if (d === "W") for (let y = 0; y < map.gh && !hit; y++) hit = cells.has(`0,${y}`);
    if (d === "E") for (let y = 0; y < map.gh && !hit; y++) hit = cells.has(`${map.gw - 1},${y}`);
    if (hit) out.push(d);
  }
  return out;
}

/** wq#1870: the boundary directions with an opening the player can actually
 *  WALK to — the ones leave_edge can succeed on from where they stand. */
export function reachableEdges(map: MapModel, px: number, py: number): EdgeDir[] {
  return edgesOf(map, reachableCells(map, px, py));
}

/** "leave_edge(N) -> Route 24, leave_edge(W) -> Route 4" for the edges that
 *  work from here. The neighbour name comes from the ROM-derived travel graph
 *  (route_graph.ts) when curMap is known; a direction it has no edge for is
 *  still offered, unnamed, because the connection byte says it exists. */
function edgeMenu(dirs: EdgeDir[], curMap?: number): string {
  return dirs.map(d => {
    const e = curMap === undefined ? undefined
      : ROUTE_EDGES.find(r => r.from === curMap && r.via === EDGE_VIA[d]);
    const name = e ? mapLabel(e.to) : null;
    return `leave_edge(${d})${name ? ` -> ${name}` : ""}`;
  }).join(", ");
}

/** The sentence that names the warps which cross the split into somewhere with
 *  a way onward, or "" when there is none. */
function crossingHint(views: WarpView[], curMap?: number): string {
  const c = views.filter(v => v.otherSide?.opens);
  if (!c.length) return "";
  return ` The way across: ${c.map(v => {
    const o = v.otherSide!;
    const onward = o.edges.length ? `, from which ${edgeMenu(o.edges, curMap)} work` : "";
    return `enter_warp(${v.i}) -> ${v.dest}, whose second door comes out at (${o.x},${o.y})${onward}`;
  }).join("; ")}.`;
}

/** Why the rest of the reachable warps are not an answer: a shop's only door
 *  back onto this map is the one you walk in by, and a pass-through whose far
 *  door opens on a fenced yard is the same trap one step further away. */
function deadEndHint(views: WarpView[]): string {
  const plain = views.filter(v => v.state !== "unreachable" && !v.otherSide);
  const closed = views.filter(v => v.otherSide && !v.otherSide.opens);
  const parts: string[] = [];
  if (plain.length)
    parts.push(`${plain.map(v => `${v.i}:${v.dest}`).join(", ")} — no second door onto this map,` +
      ` so each puts you back where you stand`);
  if (closed.length)
    parts.push(`${closed.map(v => `${v.i}:${v.dest}`).join(", ")} — comes out at ` +
      `${closed.map(v => `(${v.otherSide!.x},${v.otherSide!.y})`).join(", ")}, closed off in turn` +
      ` with no map edge and no other door`);
  return parts.length ? ` Dead ends: ${parts.join("; ")}.` : "";
}

/** The WARPS line. Compact, fixed order, one token-cheap marker per entry. */
export function renderWarps(views: WarpView[]): string {
  if (!views.length) return "WARPS none on this map";
  const body = views.map(v => {
    const mark = v.state === "here" ? "STANDING-ON-IT"
      : v.state === "reachable" ? `${v.steps} steps`
        : "NO PATH";
    // wq#1870: a pass-through is worth its few tokens — it is the only entry on
    // this line that can put the player somewhere walking cannot. Marked closed
    // when its far door opens on a yard, so the brain stops re-entering it.
    const cross = !v.otherSide ? ""
      : v.otherSide.opens ? `, CROSSES to (${v.otherSide.x},${v.otherSide.y})`
        : `, far door (${v.otherSide.x},${v.otherSide.y}) is CLOSED OFF`;
    return `${v.i}:(${v.x},${v.y})->${v.dest} [${mark}${cross}]`;
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
                          tx: number, ty: number, views: WarpView[],
                          obstacle?: Obstacle | null, curMap?: number): string {
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
    //
    // wq#1662: the walk loop DOES know what stopped it (nav.lastGotoObstacle()) —
    // say that instead of guessing. Naming a sprite tells the brain the retry is
    // only worth it once that sprite has moved; naming terrain tells it the
    // retry ceiling is right to refuse a verbatim repeat.
    const why = !obstacle
      ? `something interrupted it (wild encounters or an NPC in the way)`
      : obstacle.kind === "sprite"
        ? `an NPC/object (sprite ${obstacle.spritePic}) at (${obstacle.x},${obstacle.y}) blocked a step on the route` +
          ` — retry once it has moved, don't repeat the exact same goto from here`
        : obstacle.kind === "no_path"
          ? `no route to (${obstacle.x},${obstacle.y}) could be planned on this pass — likely a` +
            ` wandering NPC sealed the only gap; wait and retry`
          : `a step onto (${obstacle.x},${obstacle.y}) was refused by terrain the map model marks` +
            ` passable — a scripted tile or ledge the collision grid doesn't know about`;
    return ` — (${tx},${ty}) IS reachable from here (${p.length} steps) but the walk did not finish;` +
      ` ${why}, the target is not the problem.`;
  }
  // wq#1870: the target is in a part of the map walking cannot reach. Naming the
  // reachable warps was worse than saying nothing — on Cerulean every one of
  // them came straight back, and the brain spent 26 turns proving it. Name the
  // exits that change where you are: the boundary edges you can walk to, and the
  // pass-through warp (if any) whose far door is on the other side.
  // ...but only once the target is a cell anything could stand on. An enclosed
  // wall tile is pathless for a mundane reason, and "this map is SPLIT" would be
  // a confident lie about it — astar exempts the goal cell from the terrain test
  // (doors are impassable warp tiles), so a solid goal reaches this branch too.
  if (tx < 0 || ty < 0 || tx >= map.gw || ty >= map.gh)
    return ` — (${tx},${ty}) is off this map, which is ${map.gw}x${map.gh} cells; nothing there to walk to.`;
  if (!map.grid[ty][tx] && !map.isWarp(tx, ty))
    return ` — (${tx},${ty}) is not a tile anything can stand on: the collision grid marks it solid` +
      ` (a building, a fence, water or scenery). goto a walkable cell beside it instead.`;
  const edges = reachableEdges(map, px, py);
  const head = ` — no path to (${tx},${ty}) from where you stand: this map is SPLIT and (${tx},${ty})` +
    ` is in a part of it you cannot walk to. No goto will ever reach it from here.`;
  const out = edges.length
    ? `${head} Ways out of the part you are in: ${edgeMenu(edges, curMap)}.`
    : `${head} No map edge is reachable from here either.`;
  const body = crossingHint(views, curMap) + deadEndHint(views);
  return body ? out + body
    : out + (edges.length ? "" : " Nothing reachable from here leaves this part of the map.");
}

/** wq#1870: the reply a leave_edge that found no opening gets. nav.leaveMapEdge
 *  returns a bare "stuck" after silently trying every walkable cell on that
 *  boundary, which reads as "try again" — on Cerulean the ROUTE line said
 *  leave_edge(S) and the south edge is in the half of the map the player cannot
 *  walk to, so the retry was doomed and the refusal said nothing about that. */
export function edgeStuckHint(map: MapModel, px: number, py: number, dir: EdgeDir,
                              views: WarpView[], curMap?: number): string {
  if (!(map.connections & CONN_BIT[dir]))
    return ` — this map has no ${dir} connection at all; nothing to walk off that side.`;
  const all = reachableEdges(map, px, py);
  // leaveMapEdge also reports "stuck" when it DID reach an opening and the three
  // pushes across it went nowhere — a sprite in the gap, an encounter, a
  // scripted refusal. Saying "that edge is in a part you cannot walk to" there
  // would be a confident lie, and would push the brain off a retry that works.
  if (all.includes(dir))
    return ` — the ${dir} edge IS reachable from where you stand, but the crossing did not happen:` +
      ` something stopped the walk (an NPC in the opening, a wild encounter, a scripted refusal).` +
      ` The edge is not the problem — clear the interruption and retry.`;
  const edges = all.filter(d => d !== dir);
  const head = ` — no opening on the ${dir} edge is reachable from where you stand:` +
    ` this map is split and that edge is in a part of it you cannot walk to.`;
  const alt = edges.length ? ` Edges that DO work from here: ${edgeMenu(edges, curMap)}.` : "";
  return head + alt + crossingHint(views, curMap) + deadEndHint(views);
}
