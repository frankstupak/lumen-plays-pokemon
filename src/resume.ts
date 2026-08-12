// S2: checkpoint progress scoring + viability-gated resume selection.
// Sidecar-first (<file>.json written by Agent.maybeCheckpoint); legacy files
// without a sidecar fall back to a full emulator load (slow path, rare).
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
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
export const STORY_ORDER: number[] = [
  38, 37, 0, 40, 12, 1, 42, 13, 51, 2, 56, 58, 54, 14, 68, 59, 60, 61, 15, 3,
];
export function progressRank(mapId: number): number {
  const i = STORY_ORDER.indexOf(mapId);
  return i < 0 ? -1 : i;
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
      return { rank: progressRank(j.map), badges: j.badges, events: j.events,
        story: typeof j.storyScore === "number" ? j.storyScore : -1,  // v1 -> unknown
        hpPct: j.hpPct, ppOk: j.ppOk,
        viable: j.hpPct >= VIABLE_HP_PCT && j.ppOk, mtime };
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
    return { rank: progressRank(s.map), badges: s.badgeCount, events: rd.eventCount(),
      story: rd.storyScore(),
      hpPct, ppOk, viable: hpPct >= VIABLE_HP_PCT && ppOk, mtime };
  } catch {
    return { rank: -2, badges: -1, events: -1, story: -1, hpPct: 0, ppOk: false, viable: false, mtime: 0 };
  }
}

/** Pick the best resume target: viable first, then badges, event-flag
 *  progress, story rank, recency. Falls back to the best non-viable rather
 *  than refusing to resume. */
export function pickResume(dirs: string[], sym: SymbolTable, romPath: string): string {
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
  // the exact 08-11/12 regression. Worst case for a genuinely-further state
  // in a not-yet-listed interior: resume steps back to the last ranked map
  // and re-walks in — a stumble, not a trap loop.
  scored.sort((a, b) =>
    (Number(b.viable) - Number(a.viable)) || (b.badges - a.badges) ||
    ((a.story >= 0 && b.story >= 0) ? (b.story - a.story) : 0) ||
    (b.rank - a.rank) ||
    (b.events - a.events) || (b.mtime - a.mtime));
  return scored[0]?.f ?? cands[0];
}
