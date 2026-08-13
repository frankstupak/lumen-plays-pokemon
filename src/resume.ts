// S2: checkpoint progress scoring + viability-gated resume selection.
// Sidecar-first (<file>.json written by Agent.maybeCheckpoint); legacy files
// without a sidecar fall back to a full emulator load (slow path, rare).
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";

// Story progress order for Kanto maps on the critical path.
// 2026-08-12: extended past Pewter Gym — Route 3 (14), Mt Moon Pokecenter (68),
// Mt Moon 1F/B1F/B2F (59/60/61), Route 4 (15), Cerulean (3). The old list ended
// one step past Pewter Gym, so post-Pewter checkpoints ranked -1 and resume
// selection fell to Pewter-era states whose incidental event flags (museum
// NPCs) ran higher — that is how the run regressed from Route 4 to Pewter.
// Extend this list at the START of each new campaign leg.
// Pewter Mart (56) + Pewter Pokecenter (58) are ranked below the gym so their
// heal-milestones can't out-"event" Route 4 states (they carry events=25 from
// museum wandering vs Route 4's 24).
//
// wq#518: map 15 (Route 4) APPEARS TWICE, and that is not a typo. Route 4 is
// two disconnected places sharing one map id — the pre-cave west pocket and
// the post-cave east run to Cerulean — so one rank cannot order it. The west
// occurrence sits before the cave, the east occurrence after it. See
// SPLIT_MAPS for the ROM-measured boundary and progressRank() for the lookup.
//
// wq#534: map 60 (Mt Moon B1F) ALSO appears twice, for a different reason than
// map 15. B1F is not two halves of one floor — it is FOUR mutually unreachable
// pockets, and only one of them (16 tiles, x=20..27 y=2..3) contains the (27,3)
// exit onto Route 4 east. That pocket's only other connection is (23,3), which
// leads UP to B2F, so B2F is not a dead end: it is the mandatory way in to the
// pocket that holds the exit. The first 60 ranks the three dead pockets BELOW
// B2F; the second ranks the exit pocket ABOVE it. See POCKET_MAPS.
export const STORY_ORDER: number[] = [
  38, 37, 0, 40, 12, 1, 42, 13, 51, 2, 56, 58, 54, 14, 15, 68, 59, 60, 61, 60, 15, 3,
];

/** Maps that are TWO places sharing one map id, separated by terrain the player
 *  cannot cross — the only route between the halves runs through another map. A
 *  split map appears twice in STORY_ORDER; `beyond` selects the later (further
 *  along the story) occurrence.
 *
 *  wq#518, measured from the ROM rather than assumed. probe_resume518 re-derives
 *  every number below from the shipped ROM on each run and fails if a future ROM
 *  disagrees, so this comment cannot quietly rot:
 *    map 15 is 90x18 walk units. Its warps are (11,5)->68 Mt Moon Pokecenter,
 *    (18,5)->59 Mt Moon 1F, (24,5)->60 Mt Moon B1F. A four-column wall at
 *    x=20..23 spans EVERY row, so a flood fill from the checkpointed player
 *    position (11,6) reaches x=4..19 only — 159 of 729 walkable tiles — and can
 *    touch the Pokecenter and Mt Moon 1F warps but NOT the (24,5) cave exit.
 *    The east half holds that exit plus the open east edge onto Cerulean.
 *    Columns 20..23 are wall, hence unreachable, so any threshold in 20..24 is
 *    equivalent; 20 is the first wall column. */
export const SPLIT_MAPS: Record<number, { axis: "x" | "y"; beyond: number; before: string; after: string }> = {
  15: { axis: "x", beyond: 20, before: "Route 4 west (pre-Mt Moon)", after: "Route 4 east (post-Mt Moon)" },
};

/** Maps whose walkable area is several MUTUALLY UNREACHABLE pockets rather than
 *  two halves cut by one straight wall. SPLIT_MAPS cannot express these: a
 *  {axis, beyond} line only works when the two places fall on opposite sides of
 *  one coordinate, and here the pockets are spatially INTERLEAVED, so no such
 *  line exists. `tiles` therefore enumerates the pocket that is FURTHER along
 *  the story; every other position on the map is the earlier occurrence.
 *
 *  wq#534, measured from RAM+ROM and NOT from the ticket, whose topology was
 *  wrong. probe_pocket534 re-derives this set by flood-filling the live map on
 *  every run and fails if it drifts by a single tile, the same contract
 *  SPLIT_MAPS keeps.
 *
 *  map 60 (Mt Moon B1F), 28x28 walk units, ZERO sprites — so the decomposition
 *  is pure terrain and no NPC can move it. Four components:
 *      84 tiles  warps (5,5)->59   (21,17)->61
 *      84 tiles  warps (25,15)->59 (13,27)->61
 *      48 tiles  warps (17,11)->61 (25,9)->59
 *      16 tiles  warps (23,3)->61  (27,3)->OUTSIDE   <- the exit pocket, below
 *  The exit pocket's only non-outside warp is (23,3), whose destination is
 *  map61 warp #3 = (5,7) — and map61 (5,7) points back at map60 warp #6 =
 *  (23,3). The pair is bijective, so B2F is the ONLY way in and the ticket's
 *  "B2F is a dead end" premise is false. A run standing in this pocket is
 *  genuinely further along than one in the fossil room; a run in any other
 *  pocket is genuinely further BACK, because none of them can reach (27,3). */
export const POCKET_MAPS: Record<number, { tiles: ReadonlySet<string>; before: string; after: string }> = {
  60: {
    tiles: new Set([
      "20,2", "21,2", "22,2", "23,2", "24,2", "25,2", "26,2", "27,2",
      "20,3", "21,3", "22,3", "23,3", "24,3", "25,3", "26,3", "27,3",
    ]),
    before: "Mt Moon B1F (dead pocket)",
    after: "Mt Moon B1F (exit pocket)",
  },
};

/** Rank a POSITION on the story path. Coordinates are optional for callers that
 *  genuinely lack them; a split or pocket map with unknown coordinates resolves
 *  to the EARLIER half, because claiming progress that cannot be proved is the
 *  exact failure this ticket exists to fix. */
export function progressRank(mapId: number, x?: number, y?: number): number {
  const pocket = POCKET_MAPS[mapId];
  if (pocket) {
    const known = typeof x === "number" && typeof y === "number";
    return known && pocket.tiles.has(`${x},${y}`)
      ? STORY_ORDER.lastIndexOf(mapId) : STORY_ORDER.indexOf(mapId);
  }
  const split = SPLIT_MAPS[mapId];
  if (split) {
    const v = split.axis === "x" ? x : y;
    return typeof v === "number" && v >= split.beyond
      ? STORY_ORDER.lastIndexOf(mapId) : STORY_ORDER.indexOf(mapId);
  }
  const i = STORY_ORDER.indexOf(mapId);
  return i < 0 ? -1 : i;
}

/** Human-readable place name for a position, for boot logs and reports. */
export function rankLabel(mapId: number, x?: number, y?: number): string {
  const pocket = POCKET_MAPS[mapId];
  if (pocket) {
    const known = typeof x === "number" && typeof y === "number";
    return known && pocket.tiles.has(`${x},${y}`) ? pocket.after : pocket.before;
  }
  const split = SPLIT_MAPS[mapId];
  if (!split) return `map${mapId}`;
  const v = split.axis === "x" ? x : y;
  return typeof v === "number" && v >= split.beyond ? split.after : split.before;
}

export interface Sidecar {
  v: number; kind: string; map: number; x: number; y: number;
  badges: number; events: number; hpPct: number; ppOk: boolean;
  money: number; ts: number;
  storyScore?: number;  // v2+ (wq#471): popcount of STORY_FLAGS at write time
}
export interface Progress {
  rank: number; badges: number; events: number;
  story: number;  // wq#471: monotonic story-flag score; -1 = unknown (v1 sidecar)
  hpPct: number; ppOk: boolean; viable: boolean; mtime: number;
  map: number; x: number; y: number;   // wq#518: rank inputs, kept for diagnostics
}

// Resume viability: never hand the brain a near-dead or move-dead state when
// any healthy alternative exists. White-out is a designed recovery (Gen 1:
// half money, full heal at last Center) - a healthy older checkpoint beats a
// "further" checkpoint that is one encounter away from a loop of deaths.
export const VIABLE_HP_PCT = 0.5;

export function readProgress(file: string, sym: SymbolTable, romPath: string): Progress {
  const mtime = (() => { try { return statSync(file).mtimeMs; } catch { return 0; } })();
  const sc = file.replace(/\.state\.gz$/, ".json");
  if (existsSync(sc)) {
    try {
      const j: Sidecar = JSON.parse(readFileSync(sc, "utf8"));
      return { rank: progressRank(j.map, j.x, j.y), badges: j.badges, events: j.events,
        story: typeof j.storyScore === "number" ? j.storyScore : -1,  // v1 -> unknown
        hpPct: j.hpPct, ppOk: j.ppOk,
        viable: j.hpPct >= VIABLE_HP_PCT && j.ppOk, mtime,
        map: j.map, x: j.x, y: j.y };
    } catch {}
  }
  // legacy slow path: boot an emulator and read the state directly
  try {
    const e = new Emulator(romPath);
    loadSnapshotFile(e, file);
    const rd = new StateReader(e, sym);
    const s = rd.read();
    const lead = s.party[0];
    const hpPct = lead && lead.maxHp > 0 ? lead.hp / lead.maxHp : 1;
    const ppOk = !lead || lead.moves.some((mv, i) => mv !== 0 && lead.pp[i] > 0);
    return { rank: progressRank(s.map, s.x, s.y), badges: s.badgeCount, events: rd.eventCount(),
      story: rd.storyScore(),
      hpPct, ppOk, viable: hpPct >= VIABLE_HP_PCT && ppOk, mtime,
      map: s.map, x: s.x, y: s.y };
  } catch {
    return { rank: -2, badges: -1, events: -1, story: -1, hpPct: 0, ppOk: false, viable: false,
      mtime: 0, map: -1, x: -1, y: -1 };
  }
}

// wq#518 second half: a rank-INDEPENDENT backstop, because the coordinate split
// above only fixes the one mis-ranking that was found. The class of failure is
// "the selector prefers a state the campaign has already left, and keeps
// preferring it" — 34 runs, ~5000 turns and ~120 wall hours went into re-walking
// Mt Moon because three consecutive resumes picked the same pre-cave save.
//
// DELIBERATELY NOT the per-lineage high-water mark the ticket proposed, and the
// arithmetic is worth keeping because it is not obvious: every Mt Moon
// checkpoint on disk descends from a resume OF the map15 save, so a lineage
// high-water carries the pre-cave rank forward onto the map61 states, all
// candidates tie on it, and selection falls through to raw rank — the same trap.
// Enforced as "never resume below the high-water" it is worse than neutral: it
// pins selection to the pre-cave states permanently and converts a recoverable
// rewind into a wedge, which is the wq#517 lesson repeated. A high-water is only
// safe ON TOP of a correct order, so it is not the durable half. This is.
//
// What is durable without trusting the order: refuse to make the same losing
// choice a third time when the previous run demonstrably produced something
// newer. It never claims to know which state is further along — only that
// repeating an identical resume that keeps being abandoned is not working. It
// cannot wedge: it demotes exactly one file, for exactly one selection, and only
// when a newer alternative exists to take instead.
export const RESUME_REPEAT_LIMIT = 2;   // consecutive identical picks tolerated
const HISTORY_KEEP = 8;
interface HistoryEntry { file: string; at: string }
interface History { v: number; picks: HistoryEntry[] }

export interface ResumeOpts {
  /** Where the pick history lives. Default <cwd>/runtime/resume_history.json —
   *  runtime/ is gitignored and already holds notepad + sentinel state. */
  historyFile?: string;
  /** Diagnostics sink. Default console.log, so the reason a boot chose what it
   *  chose lands in the journal beside the boot event. */
  log?: (line: string) => void;
  now?: () => Date;
}

function readHistory(file: string): History {
  try {
    const h = JSON.parse(readFileSync(file, "utf8")) as History;
    if (h && Array.isArray(h.picks)) return { v: 1, picks: h.picks.slice(-HISTORY_KEEP) };
  } catch {}
  return { v: 1, picks: [] };
}
function writeHistory(file: string, h: History): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, picks: h.picks.slice(-HISTORY_KEEP) }));
  } catch {}   // bookkeeping must never break a resume
}

/** Pick the best resume target: viable first, then badges, event-flag
 *  progress, story rank, recency. Falls back to the best non-viable rather
 *  than refusing to resume. */
export function pickResume(dirs: string[], sym: SymbolTable, romPath: string, opts: ResumeOpts = {}): string {
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? (() => new Date());
  const historyFile = opts.historyFile ?? `${process.cwd()}/runtime/resume_history.json`;
  const cands: string[] = [];
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".state.gz")) continue;
        if (f.startsWith("error-recovery")) continue;  // wedged states
        if (f.startsWith("pocket-debug")) continue;
        cands.push(`${dir}/${f}`);
      }
    } catch {}
  }
  const scored = cands.map(f => ({ f, ...readProgress(f, sym, romPath) }));
  // wq#471 ordering: viable -> badges -> storyScore -> STORY_ORDER rank
  // (tiebreak) -> raw events -> mtime.
  // storyScore is a popcount over STORY-CRITICAL flags only (src/state.ts
  // STORY_FLAGS), each permanent once set, so it is monotonic and immune to
  // the Pewter-museum incidental-flag trap that raw eventCount fell into.
  // It compares only when both sides know it (-1 = v1 sidecar without the
  // field); mixed/unknown pairs fall through to rank/events as before.
  // STORY_ORDER rank stays as a positional tiebreak between states with equal
  // story flags (e.g. Route 3 vs Route 4, no flag between them) and needs
  // extending only for that purpose now — the score, not the map list, is the
  // primary progress signal.
  // Rank compares DIRECTLY (unranked -1 sorts below any ranked map): at equal
  // story, an on-critical-path map beats an off-path interior. The old
  // "both-ranked-only" guard is what let the unranked museum floors (52/53,
  // rank -1) skip rank and win on incidental events (26 vs Route 4's 24) —
  // the exact 08-11/12 regression.
  // wq#518: rank is now per-POSITION, so a map that is two places no longer
  // collapses into a single comparator value. Mt Moon 1F/B1F/B2F (16/17/18) sit
  // ABOVE Route 4 west (14) and BELOW Route 4 east (19) — the order the player
  // actually walks, and the reason a Mt Moon B2F state now beats the pre-cave
  // save it used to lose to.
  scored.sort((a, b) =>
    (Number(b.viable) - Number(a.viable)) || (b.badges - a.badges) ||
    ((a.story >= 0 && b.story >= 0) ? (b.story - a.story) : 0) ||
    (b.rank - a.rank) ||
    (b.events - a.events) || (b.mtime - a.mtime));
  let winner = scored[0];
  if (!winner) return cands[0];

  const short = (p: string) => p.split("/").pop();
  const hist = readHistory(historyFile);
  const recent = hist.picks.slice(-RESUME_REPEAT_LIMIT).map(p => p.file);
  const repeated = recent.length >= RESUME_REPEAT_LIMIT && recent.every(f => f === winner.f);
  if (repeated) {
    // Only step aside if the last run actually produced something newer to step
    // aside TO. Without that, the repeat is not evidence of a trap — it is just
    // the only state there is. Never trade a viable state for a non-viable one.
    const alt = scored.find(c => c.f !== winner.f && c.mtime > winner.mtime && (c.viable || !winner.viable));
    if (alt) {
      log(`resume: REPEAT GUARD — ${short(winner.f)} picked ${RESUME_REPEAT_LIMIT}x running while newer states exist; ` +
        `demoting it for this selection and taking ${short(alt.f)} ` +
        `[${rankLabel(alt.map, alt.x, alt.y)} rank ${alt.rank} vs ${rankLabel(winner.map, winner.x, winner.y)} rank ${winner.rank}]`);
      winner = alt;
    } else {
      log(`resume: repeat guard saw ${RESUME_REPEAT_LIMIT} identical picks but no newer alternative — keeping ${short(winner.f)}`);
    }
  }
  log(`resume: ${short(winner.f)} — ${rankLabel(winner.map, winner.x, winner.y)} (map ${winner.map} @ ${winner.x},${winner.y}) ` +
    `rank=${winner.rank} story=${winner.story} badges=${winner.badges} viable=${winner.viable}, ${scored.length} candidates`);
  hist.picks.push({ file: winner.f, at: now().toISOString() });
  writeHistory(historyFile, hist);
  return winner.f;
}
