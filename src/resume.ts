// S2: checkpoint progress scoring + viability-gated resume selection.
// Sidecar-first (<file>.json written by Agent.maybeCheckpoint); legacy files
// without a sidecar fall back to a full emulator load (slow path, rare).
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";

// Story progress order for Kanto maps on the critical path (early game).
export const STORY_ORDER: number[] = [
  38, 37, 0, 40, 12, 1, 42, 13, 51, 2, 54, 3,
];
export function progressRank(mapId: number): number {
  const i = STORY_ORDER.indexOf(mapId);
  return i < 0 ? -1 : i;
}

export interface Sidecar {
  v: number; kind: string; map: number; x: number; y: number;
  badges: number; events: number; hpPct: number; ppOk: boolean;
  money: number; ts: number;
}
export interface Progress {
  rank: number; badges: number; events: number;
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
      hpPct, ppOk, viable: hpPct >= VIABLE_HP_PCT && ppOk, mtime };
  } catch {
    return { rank: -2, badges: -1, events: -1, hpPct: 0, ppOk: false, viable: false, mtime: 0 };
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
  scored.sort((a, b) =>
    (Number(b.viable) - Number(a.viable)) || (b.badges - a.badges) ||
    (b.events - a.events) || (b.rank - a.rank) || (b.mtime - a.mtime));
  return scored[0]?.f ?? cands[0];
}
