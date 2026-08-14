// wq#564: THE MT MOON ESCAPE ROUTE, resolved from the player's OWN reachable
// component every turn.
//
// THE DEFECT THIS FIXES. The wq#535 pack stated one global forced route:
// "B2F(map61) (5,7) -> B1F(map60) (23,3) -> (27,3) -> Route 4 EAST". That route
// is real, but its FIRST tile is not reachable from where the agent stands. Mt
// Moon B2F is FOUR disconnected pockets. The agent sits in the east pocket (67
// tiles, one single warp out at (25,9)); (5,7) sits in the north chamber behind
// the fossils, and the fossils themselves sit in the west pocket. Measured
// pair-aware BFS from a real checkpoint: east(30,11) -> (5,7) = UNREACHABLE,
// east(30,11) -> (12,7) = UNREACHABLE, east(30,11) -> (25,9) = 7 steps. For 123
// hours the pack named a destination the agent could never walk to, and the
// agent obeyed it faithfully: 31 of 54 real goto failures in the wq#560 window
// were map61 corridor coordinates issued while standing on map60.
//
// THE SECOND DEFECT, found while measuring this one (wq#564): the old
// DEAD-POCKET RECOVERY said "if you cannot path to (27,3), go back up and use
// B2F (5,7)". From B1F pocket C -- (17,11)+(25,9), which is exactly where the
// (25,9) ladder drops you -- "back up" returns you to the SEALED east pocket,
// where (5,7) is unreachable, so you come back down. That rule does not
// describe the observed 61(25,9)<->60(17,11) ping-pong; it CAUSES it.
//
// WHY THIS IS RESOLVED LIVE AND NOT WRITTEN DOWN AS PROSE. A pocket is
// identified here by WHICH WARPS THE PLAYER CAN ACTUALLY REACH -- a pair-aware
// BFS over the live MapModel, the same geometry nav walks on. So the guidance
// can only ever name a warp that is in the player's own component. Naming an
// unreachable tile is not "a bug we fixed", it is structurally unavailable:
// that is the whole point of the ticket's title. If a fossil is taken the west
// and north pockets merge (384 -> 448 tiles, measured) and the leg advances by
// itself, with no flag to keep in sync.
//
// READ-ONLY. Nothing here mutates MapModel, nav, or the pair tables -- wq#560
// audited wq#552 and found no missing pair edge on maps 59/60/61.
import type { MapModel, Warp } from "./map";

export const MT_MOON_MAPS = [59, 60, 61];

/** Pair-aware flood fill from the player. Uses passableFrom, not passable:
 *  Gen 1 refuses movement between certain tile pairs even when both tiles are
 *  walkable, and that is the entire seal on the east pocket (wq#552). */
function component(mm: MapModel, sx: number, sy: number): Set<string> {
  const seen = new Set([`${sx},${sy}`]);
  const q: [number, number][] = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && mm.passableFrom(x, y, nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

/** The warps the player can actually walk to from where they stand. */
export function reachableWarps(mm: MapModel, x: number, y: number): Warp[] {
  const c = component(mm, x, y);
  return mm.warps.filter(w => c.has(`${w.x},${w.y}`));
}

// ── The route table ──────────────────────────────────────────────────────
// Seven legs, measured by pair-aware BFS over real checkpoints (wq#564; leg
// lengths are from the WARP LANDING TILE, so they are exact and do not drift
// with where the player happens to stand):
//   L1 [61 east]  player -> (25,9)    ~7   -> warp -> B1F lands (17,11)
//   L2 [60 C]     (17,11) -> (25,9)    10  -> warp -> 1F  lands (17,11)
//   L3 [59 1F]    (17,11) -> (5,5)     30  -> warp -> B1F lands (5,5)
//   L4 [60 A]     (5,5) -> (21,17)     28  -> warp -> B2F lands (21,17)
//   L5 [61 west]  (21,17) -> (12,7)    91  -> interact(12,6) + yes -> corridor opens
//   L6 [61]       (12,7) -> (5,7)      17  -> warp -> B1F lands (23,3)
//   L7 [60 D]     (23,3) -> (27,3)      4  -> Route 4 EAST, out of the mountain
// ~180 steps, 5 warps, one scripted pickup. The first move from the east pocket
// is DOWN through 1F -- AWAY from the fossils -- which is why no amount of
// local exploration was ever going to find it.
//
// A rule fires only when its `needs` warp is in the player's OWN component, so
// a rule can never issue a tile the player cannot reach. Order matters: the
// most-progressed pocket is tested first.
interface LegRule {
  map: number;
  /** warp that must be reachable for this rule to apply (identifies the pocket) */
  needs: [number, number];
  leg: string;
  pocket: string;
  lines: (w: string) => string[];
}

const RULES: LegRule[] = [
  // ---- map61, B2F ----
  {
    map: 61, needs: [5, 7], leg: "L6", pocket: "B2F, exit corridor (fossil is gone)",
    lines: w => [
      `YOU ARE ON THE LAST STRETCH. The exit ladder ${w} is REACHABLE from here.`,
      `  goto${w} then enter_warp it. You land on B1F in a small 16-tile pocket -`,
      "  the ONLY one in the mountain that touches the outside.",
      // wq#564: no goto coordinate for the B1F doorway here. It is on ANOTHER
      // MAP, and "map61 coordinates issued while standing on map60" (inverted)
      // is the exact confusion wq#560 measured. L7 names it from that floor.
      "  The doorway out is a few steps from where you land; once you are down",
      "  there your instruction will name it. Do not target it from this floor.",
    ],
  },
  {
    map: 61, needs: [21, 17], leg: "L5", pocket: "B2F, west pocket (the fossils)",
    lines: () => [
      "YOU ARE IN THE FOSSIL POCKET. This is where the corridor gets opened.",
      "  goto(12,7)  ->  interact(12,6)  ->  choose(yes)   [DOME FOSSIL]",
      "  That is ~91 steps west and north from the ladder you arrived on; it is a",
      "  long leg and it is the correct one. Expect the SUPER NERD at (12,8) and",
      "  one or two ROCKETS on the way - fight them, they are your only income.",
      "  Taking ONE fossil despawns it and OPENS the corridor to the exit ladder,",
      "  which is sealed shut while both fossils stand there. The fossil is not a",
      "  collectible here - it IS the door.",
      // wq#564: deliberately NO forward coordinate for the exit ladder. While
      // both fossils stand there it is in ANOTHER COMPONENT, and naming a tile
      // the agent cannot currently reach is the defect this whole ticket is
      // about -- probe_route564 section D caught this line doing exactly that.
      // The moment the fossil is taken the pockets merge and the leg becomes
      // L6, which names the ladder from the player's own component.
      "  Once the fossil is in the bag your next instruction will name the exit",
      "  ladder for you. Do NOT target it before then - until the fossil moves it",
      "  is behind a wall and no goto can reach it.",
    ],
  },
  {
    map: 61, needs: [25, 9], leg: "L1", pocket: "B2F, east pocket (sealed, 67 tiles)",
    lines: w => [
      `YOUR ONLY WAY OUT OF THIS POCKET IS THE LADDER ${w}. Take it: enter_warp ${w}.`,
      "  This pocket is SEALED - about 67 tiles, and ONE ladder. The fossils and the exit",
      "  ladder are NOT in it and no goto can reach them from here, however many",
      "  times it is tried. Do not search this pocket for another way.",
      "  You are going DOWN and then AROUND: B1F -> 1F -> B1F -> B2F west side.",
      "  That is the route. It looks like backtracking. It is not.",
    ],
  },
  {
    map: 61, needs: [15, 27], leg: "L1s", pocket: "B2F, south pocket",
    lines: w => [
      `YOUR ONLY WAY OUT OF THIS POCKET IS THE LADDER ${w}. Take it: enter_warp ${w}.`,
      "  One ladder, and it is that one. You land on B1F at (13,27); from there walk to",
      "  (25,15) and take that ladder UP to 1F, then follow the 1F instructions.",
    ],
  },
];

// ---- map60, B1F: four pockets, and only ONE of them touches the outside ----
// The old pack called (17,11)/(21,17)/(13,27) "dead pockets you must climb out
// of". Measured (wq#564): pocket A holds (5,5)+(21,17) and IS the mandatory
// route; pocket E holds (25,15)+(13,27) and escapes to 1F; pocket C holds
// (17,11)+(25,9) and its (25,9) ladder is leg L2. None of them is a dead end.
// What IS true is that only pocket D reaches (27,3).
const B1F_RULES: LegRule[] = [
  {
    map: 60, needs: [27, 3], leg: "L7", pocket: "B1F, exit pocket (16 tiles)",
    lines: () => [
      "YOU ARE THROUGH. goto(27,3) - about 4 steps - and you leave the mountain",
      "  onto ROUTE 4 EAST. Nothing else on this floor matters now.",
    ],
  },
  {
    map: 60, needs: [21, 17], leg: "L4", pocket: "B1F, west pocket (84 tiles)",
    lines: w => [
      `THIS POCKET IS ON THE ROUTE. Walk to ${w} - about 28 steps - and enter_warp it.`,
      "  It puts you on B2F in the WEST pocket, where the fossils are. That is the",
      "  pocket that reaches the exit ladder; the one you started in never did.",
    ],
  },
  {
    map: 60, needs: [25, 9], leg: "L2", pocket: "B1F, landing pocket (48 tiles)",
    lines: w => [
      `WALK TO ${w} - about 10 steps - AND enter_warp IT. That takes you UP to 1F.`,
      "  Going UP is correct and it is the only way on. You cannot reach the exit",
      "  from this floor: (27,3) is in a different pocket of B1F and no goto will",
      "  ever path to it from here.",
      "  The OTHER ladder on this floor, at (17,11), leads straight back to the",
      "  sealed B2F pocket you just came from. That round trip is the loop that has",
      "  cost this run five days. Take (25,9).",
    ],
  },
  {
    map: 60, needs: [25, 15], leg: "L2s", pocket: "B1F, south pocket (84 tiles)",
    lines: w => [
      `WALK TO ${w} AND enter_warp IT. That takes you UP to 1F, which is the way on.`,
      "  The other ladder here, (13,27), only goes back down to the B2F south pocket.",
    ],
  },
  // ---- map59, 1F: one 894-tile component holding all five warps ----
  {
    map: 59, needs: [5, 5], leg: "L3", pocket: "1F (one connected floor)",
    lines: w => [
      `WALK TO ${w} - about 30 steps - AND enter_warp IT. This is the ladder that`,
      "  matters: it drops you into the B1F pocket that connects onward to the",
      "  fossil side of B2F, and from there to the exit.",
      "  1F is ONE connected floor - anywhere on it is walkable from anywhere else,",
      "  so a goto that fails here is a step-budget or trainer problem, not geometry.",
      "  Trainers on the way (one sits by the ladder at (5,6)) are income. Fight them.",
      "  Do NOT take the (14,35)/(15,35) warps: those are the mountain's WEST door,",
      "  back out to the Route 4 pocket you started from.",
    ],
  },
];

RULES.push(...B1F_RULES);

export interface RouteLeg {
  leg: string;
  pocket: string;
  lines: string[];
}

/** Which leg of the escape route is the player on RIGHT NOW?
 *  Returns null off the Mt Moon floors, or when the player's component holds
 *  none of the route warps -- in which case the caller must say nothing rather
 *  than guess, which is the failure this whole ticket is about. */
export function mtMoonLeg(mm: MapModel, mapId: number, x: number, y: number): RouteLeg | null {
  if (!MT_MOON_MAPS.includes(mapId)) return null;
  const here = reachableWarps(mm, x, y);
  const has = (c: [number, number]) => here.find(w => w.x === c[0] && w.y === c[1]);
  for (const r of RULES) {
    if (r.map !== mapId) continue;
    const w = has(r.needs);
    if (!w) continue;
    return { leg: r.leg, pocket: r.pocket, lines: r.lines(`(${w.x},${w.y})`) };
  }
  return null;
}

/** The whole route, as orientation. Deliberately SHORT and deliberately
 *  SECOND: the leg block above is what the agent acts on this turn; this is
 *  only so the leg does not read as an arbitrary order. It names no tile the
 *  agent is expected to path to on this turn. */
export const ROUTE_OVERVIEW = [
  "THE WHOLE ROUTE, so the current step makes sense (~180 steps, 5 ladders):",
  "  B2F east pocket -> DOWN to B1F -> UP to 1F -> DOWN to B1F west -> B2F west",
  "  -> take ONE fossil (that opens the corridor) -> exit ladder -> B1F -> Route 4 EAST.",
  "  The mountain is not one floor with one ladder chain: each floor is several",
  "  pockets that do not connect to each other, and the route weaves between",
  "  floors to get between them. Trust the CURRENT-LEG instruction above over any",
  "  intuition that you are going the wrong way.",
];
