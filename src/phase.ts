// wq#514: corridor PHASE machine.
//
// THE DEFECT THIS FIXES. The badges===1 guidance pack was one block that told
// the brain both "Route4 west(map15) -> MT MOON 1F(map59)" as a step to
// execute and, twenty lines later, "Once your map becomes 15 ... DO NOT
// re-enter Mt Moon". Route 4 is TWO disconnected places sharing one map id, so
// a brain standing on map15 could not tell which instruction applied to it.
// Both halves of a contradiction were in context at once, every turn.
//
// The fix is to make the two halves mutually exclusive and to select between
// them from RAM, not from a badge count that cannot distinguish them.
//
// PREDICATE OWNERSHIP: the WEST/EAST boundary is NOT defined here. wq#518 owns
// it (SPLIT_MAPS/progressRank in resume.ts), where it is derived from ROM
// geometry: columns 20..23 of map 15 are wall on 18/18 rows and a flood-fill
// from the west spawn reaches x 4..19 only. Duplicating that number here is
// exactly how the kiosk ends up contradicting the board, so this module
// IMPORTS it and derives its own threshold from the same source.
import { SPLIT_MAPS, progressRank } from "./resume";
import { STORY_FLAGS, type GameState } from "./state";

export type CorridorPhase =
  | "PEWTER_GYM"          // badges 0
  | "MT_MOON_TRANSIT"     // badges 1, at or before the cave
  | "CERULEAN_APPROACH"   // badges 1, past the cave
  | "OPEN_CAMPAIGN";      // badges 2+

/** Flag indices resolved BY NAME from the wq#471 table rather than retyped.
 *  A missing name is recorded instead of thrown: a bad lookup must fail the
 *  probe loudly, not kill a live turn loop mid-campaign. */
export const phaseWarnings: string[] = [];

function flagIdx(name: string): number | null {
  const f = STORY_FLAGS.find(x => x.name === name);
  if (!f) { phaseWarnings.push(`STORY_FLAGS has no ${name}`); return null; }
  return f.idx;
}

export const F_SUPER_NERD = flagIdx("EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD");
export const F_DOME = flagIdx("EVENT_GOT_DOME_FOSSIL");
export const F_HELIX = flagIdx("EVENT_GOT_HELIX_FOSSIL");

/** Rank of the two halves of Route 4, derived from wq#518's own split so the
 *  boundary can never drift out of step with the resume ranker. */
const SPLIT15 = SPLIT_MAPS[15];
export const ROUTE4_EAST_RANK = progressRank(15, SPLIT15.beyond, 0);
export const ROUTE4_WEST_RANK = progressRank(15, SPLIT15.beyond - 1, 0);

/** Select the corridor phase from RAM-verified signals.
 *
 *  `prev` exists because progressRank returns -1 for any map OFF the critical
 *  path -- and Cerulean's gym, mart and Pokecentre are all off it. Without
 *  this, walking into the Cerulean Pokecentre would rank -1, fall below the
 *  Route 4 east threshold, and hand the brain Mt Moon crossing instructions
 *  while it stood in Cerulean. Phase therefore only CHANGES on a ranked map
 *  and is held otherwise. This is deliberately NOT a one-way latch: a latch
 *  that misfires strands the agent, which is the wedge wq#517 was rewritten to
 *  avoid. On ranked maps the phase can still move in both directions.
 */
export function corridorPhase(st: GameState, prev?: CorridorPhase): CorridorPhase {
  if (st.badgeCount === 0) return "PEWTER_GYM";
  if (st.badgeCount >= 2) return "OPEN_CAMPAIGN";
  const rank = progressRank(st.map, st.x, st.y);
  if (rank < 0) return prev ?? "MT_MOON_TRANSIT";
  return rank >= ROUTE4_EAST_RANK ? "CERULEAN_APPROACH" : "MT_MOON_TRANSIT";
}

/** Why the phase is what it is -- for the boot log and the turn stream, so a
 *  wrong phase is diagnosable from the event log without a re-run. */
export function phaseReason(st: GameState, phase: CorridorPhase): string {
  const rank = progressRank(st.map, st.x, st.y);
  return `phase=${phase} badges=${st.badgeCount} map=${st.map} (${st.x},${st.y}) ` +
         `rank=${rank} eastThreshold=${ROUTE4_EAST_RANK}` +
         (rank < 0 ? " [off-path: phase held]" : "");
}
