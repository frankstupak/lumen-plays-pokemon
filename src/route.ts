// wq#1849: ROUTE KNOWLEDGE — turning "GOAL: Gym #3, Vermilion" into a direction.
//
// THE DEFECT THIS FIXES. explore.ts progressBlock() has named the next gym
// since wq#1731, and the exploration override has escaped stalls since then
// too. Measured on the 2026-09-12 live run: badges 1->2, levelSum 62->99, the
// override fired 9+ times with escaped=true — and the agent still spent days
// re-walking maps 3/35/36/67/88. Nothing was frozen. The agent knew the goal
// CITY and had no idea WHICH EXIT leads there, so every escape from a grass
// patch landed in already-visited ground ("no_farther_ground") and the run
// became an XP grind on a five-map loop. A goal without a bearing is a mood.
//
// WHAT THIS ADDS. The Kanto TRAVEL GRAPH (src/route_graph.ts, generated from
// the ROM by tools/dump_route_graph.ts) plus a shortest path over it, so the
// harness can say the one thing the agent could not derive: from THIS map, the
// next map toward the goal is THAT one, and here is the exit that reaches it.
// Two consumers: the prompt (routeBlock, appended to progressBlock) and the
// exploration override's target selection (legAim, so an escape from a stall
// heads for the exit rather than any direction with clean ground).
//
// WHAT IT DELIBERATELY DOES NOT MODEL. The graph is map-to-map. It cannot see
// a barrier INSIDE a map: Mt Moon's pockets (that is mtmoon_route.ts's job),
// the Snorlax asleep in the middle of Route 12 and Route 16, Rock Tunnel's
// dark interior inside Route 10, the Cycling Road gate. A leg is therefore a
// BEARING, not a promise that the walk is unobstructed — which is why every
// line it renders names one hop, never a multi-map plan to execute blind.
import { ROUTE_EDGES, ROUTE_NODES } from "./route_graph";

export interface RouteEdge {
  from: number;
  to: number;
  /** the map edge walked off `from`, or a door/ladder warp on `from` */
  via: "north" | "south" | "east" | "west" | "warp";
  /** warp tiles on `from` (via === "warp"); several doors can share a target */
  at?: [number, number][];
}

/** Something the player must be carrying (or have done) before a connection
 *  the ROM says exists is actually walkable. */
export type Capability = "surf" | "saffron_pass" | "badges_8";

/** The story gates, by unordered map pair. The ROM's connection and warp data
 *  is geometry and says nothing about the guard standing on it, so this is the
 *  one hand-written table in the route stack — kept to the gates that change a
 *  SHORTEST PATH, and deliberately not a general event model.
 *
 *  The load-bearing entry is Saffron. Cerulean -> Route 5 -> SAFFRON -> Route 6
 *  -> Vermilion is 5 hops and is what an ungated graph recommends for gym #3;
 *  it is also a wall, because all four Saffron gate houses hold a guard who
 *  wants a drink that is sold in Celadon, three badges later. Gating it moves
 *  the recommendation onto the Underground Path, which is the route a player
 *  actually takes at two badges. */
export const EDGE_GATES: readonly { a: number; b: number; needs: Capability; why: string }[] = [
  { a: 10, b: 16, needs: "saffron_pass", why: "the Saffron gate guard wants a drink (sold in Celadon)" },
  { a: 10, b: 17, needs: "saffron_pass", why: "the Saffron gate guard wants a drink (sold in Celadon)" },
  { a: 10, b: 18, needs: "saffron_pass", why: "the Saffron gate guard wants a drink (sold in Celadon)" },
  { a: 10, b: 19, needs: "saffron_pass", why: "the Saffron gate guard wants a drink (sold in Celadon)" },
  { a: 33, b: 34, needs: "badges_8", why: "the Route 22 gate guard checks all 8 badges" },
  { a: 0, b: 32, needs: "surf", why: "Route 21 is open sea" },
  { a: 8, b: 32, needs: "surf", why: "Route 21 is open sea" },
  { a: 7, b: 30, needs: "surf", why: "Route 19 is open sea" },
  { a: 30, b: 31, needs: "surf", why: "Route 20 is open sea" },
  { a: 8, b: 31, needs: "surf", why: "Route 20 is open sea" },
];

/** Gym city map ids, in wObtainedBadges bit order — the same order as
 *  explore.ts GYMS and names.ts BADGE_NAMES. probe_route1849 §C checks the two
 *  tables name the same city at every index, so they cannot drift apart. */
export const GYM_MAPS = [2, 3, 5, 6, 7, 10, 8, 1] as const;

/** Where "all 8 badges" points: Indigo Plateau. */
export const LEAGUE_MAP = 9;

export function mapLabel(id: number): string | null { return ROUTE_NODES[id] ?? null; }

/** A gated edge is not removed, it is made expensive: the router still answers
 *  when the only way on is through a gate, and says what the gate wants. Any
 *  weight above the graph's diameter (45 nodes) buys that ordering. */
const GATE_COST = 1000;

function gateFor(a: number, b: number): { needs: Capability; why: string } | null {
  for (const g of EDGE_GATES) if ((g.a === a && g.b === b) || (g.a === b && g.b === a)) return g;
  return null;
}

export interface Leg {
  /** the whole path, starting with `from` and ending with the goal */
  path: number[];
  /** the next map to reach: path[1]. Equal to `from` when the goal IS this map,
   *  which is the one case where `via` carries no meaning — callers test
   *  `next === from` (or `path.length === 1`) before reading it. */
  next: number;
  /** how to leave the current map for it */
  via: RouteEdge["via"];
  /** warp tiles on the current map (via === "warp"), else undefined */
  at?: [number, number][];
  /** gates the path crosses that `caps` did not satisfy, nearest first */
  gates: { needs: Capability; why: string }[];
}

/** Shortest path from `from` to `goal`, preferring routes whose gates the
 *  player can already pass. null when either map is off the travel graph (an
 *  interior, a cave floor) or nothing connects them. */
export function routeTo(from: number, goal: number, caps: ReadonlySet<Capability> = new Set()): Leg | null {
  if (!(from in ROUTE_NODES) || !(goal in ROUTE_NODES)) return null;
  if (from === goal) return { path: [from], next: from, via: "warp", gates: [] };

  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, RouteEdge>();
  const done = new Set<number>();
  for (;;) {
    let cur = -1, best = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; cur = id; }
    if (cur < 0) break;
    if (cur === goal) break;
    done.add(cur);
    for (const e of ROUTE_EDGES) {
      if (e.from !== cur || done.has(e.to)) continue;
      const g = gateFor(e.from, e.to);
      const cost = best + (g && !caps.has(g.needs) ? GATE_COST : 1);
      if (cost < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, cost); prev.set(e.to, e); }
    }
  }
  if (!prev.has(goal)) return null;

  const chain: RouteEdge[] = [];
  for (let at = goal; at !== from;) {
    const e = prev.get(at)!;
    chain.unshift(e);
    at = e.from;
  }
  const head = chain[0];
  const gates: Leg["gates"] = [];
  for (const e of chain) {
    const g = gateFor(e.from, e.to);
    if (g && !caps.has(g.needs)) gates.push(g);
  }
  return {
    path: [from, ...chain.map(e => e.to)],
    next: head.to, via: head.via, at: head.at, gates,
  };
}

/** The gym the badge bitmask says to head for, as a map id. */
export function goalMap(badges: number): number {
  const next = [0, 1, 2, 3, 4, 5, 6, 7].find(i => !((badges >> i) & 1));
  return next === undefined ? LEAGUE_MAP : GYM_MAPS[next];
}

/** What the badge bitmask alone proves the player can pass. Only the Route 22
 *  gate is decidable from badges; SURF needs the HM and SAFFRON_PASS needs an
 *  event flag, and claiming either from a badge count would route the agent
 *  into a guard. Under-claiming only costs a longer walk. */
export function capsFromBadges(badges: number): Set<Capability> {
  const caps = new Set<Capability>();
  if ((badges & 0xff) === 0xff) caps.add("badges_8");
  return caps;
}

const DIR_LETTER: Record<string, string> = { north: "N", south: "S", east: "E", west: "W" };

/** A warp as the live map reports it (map.ts Warp), which is what the prompt's
 *  WARPS list is indexed by. */
export interface WarpRef { x: number; y: number; destMap: number }

/** How to take this leg, as the tool call that takes it. Given the live warp
 *  table, a warp leg names the INDEX enter_warp actually takes — matched on
 *  destination first and on the tile second, because a door out of the
 *  underground path reports LAST_MAP (0xff) rather than the route it opens
 *  onto (reach.ts resolveDest). Without the table it names the tile, which the
 *  WARPS list also prints, so the agent can still find the index itself. */
export function legAction(leg: Leg, warps: readonly WarpRef[] = []): string {
  if (leg.via !== "warp") return `leave_edge(${DIR_LETTER[leg.via]})`;
  const at = leg.at ?? [];
  const tiles = at.map(([x, y]) => `(${x},${y})`).join(" or ");
  let i = warps.findIndex(w => w.destMap === leg.next);
  if (i < 0) i = warps.findIndex(w => at.some(([x, y]) => w.x === x && w.y === y));
  return i < 0 ? `enter_warp the door at ${tiles}`
    : `enter_warp(${i}) — the door at (${warps[i].x},${warps[i].y})`;
}

/** The ROUTE lines for the overworld state block: the bearing, the tool call
 *  that takes it, and just enough of the rest of the path that the first hop
 *  does not read as arbitrary. One hop is named as an instruction; the rest is
 *  orientation, because a map-to-map graph cannot promise the walk inside any
 *  of those maps is clear (see the header). */
export function routeBlock(from: number, badges: number, caps = capsFromBadges(badges),
                           warps: readonly WarpRef[] = [],
                           reachableEdges?: readonly string[]): string | null {
  const goal = goalMap(badges);
  const dest = mapLabel(goal);
  if (!dest) return null;
  if (from === goal) return `ROUTE: you are IN ${dest} — the goal is on THIS map. Find it here; do not leave.`;
  const leg = routeTo(from, goal, caps);
  if (!leg) return null;

  const hops = leg.path.length - 1;
  const rest = leg.path.slice(1).map(id => mapLabel(id) ?? `map${id}`);
  const via = rest.length > 3 ? `${rest.slice(0, 3).join(" > ")} > ... > ${rest[rest.length - 1]}` : rest.join(" > ");
  const lines = [
    `ROUTE to ${dest}: ${hops} map${hops === 1 ? "" : "s"} away — ${via}.`,
    `NEXT LEG: ${legAction(leg, warps)} into ${mapLabel(leg.next)}. That exit is the progress; ` +
    `ground you have already walked on this map is not.`,
  ];
  if (leg.gates.length)
    lines.push(`ROUTE IS GATED: ${leg.gates[0].why}. Expect to be turned back until that is dealt with.`);
  // wq#1877: a map-to-map graph cannot see INSIDE a map, and on a split one the
  // leg it names can start in a part of the map the player cannot walk to. That
  // is not hypothetical: for 4.6h this line told an agent in Cerulean's north
  // region "NEXT LEG: leave_edge(S) into Route 5" while the S edge sat behind a
  // seam, the supervisor pin repeated it, and 70 gotos and two leave_edge(S)
  // calls went into proving it. The caller knows which edges are walkable from
  // where the player stands (reach.ts reachableEdges); when it says so, the leg
  // stops being an order the map refuses.
  const dir = leg.via === "warp" ? null : DIR_LETTER[leg.via];
  if (dir && reachableEdges && !reachableEdges.includes(dir))
    lines.push(`NEXT LEG IS NOT STARTABLE from where you stand: the ${dir} edge is in a part of `
      + `this map you cannot walk to${reachableEdges.length
        ? ` (only ${reachableEdges.join("/")} work from here)` : ""}. Your goto/leave_edge refusal `
      + `names the way out of the part you are in — deal with that first, then take this leg.`);
  return lines.join("\n");
}

/** Rank a candidate escape tile by how well it heads for `leg` — lower is
 *  better. A warp leg aims at the door; an edge leg aims at that edge, scored
 *  by projection so it needs no map dimensions. Fed to planEscape() as a
 *  tie-break among the tiles it already considers acceptable, never as a
 *  filter: an escape that cannot go the right way must still escape. */
export function legAim(leg: Leg | null): ((t: { x: number; y: number }) => number) | null {
  if (!leg) return null;
  if (leg.via === "warp") {
    const at = leg.at ?? [];
    if (!at.length) return null;
    return t => Math.min(...at.map(([x, y]) => Math.max(Math.abs(x - t.x), Math.abs(y - t.y))));
  }
  switch (leg.via) {
    case "north": return t => t.y;
    case "south": return t => -t.y;
    case "west": return t => t.x;
    case "east": return t => -t.x;
  }
}
