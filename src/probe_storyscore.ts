// wq#471 offline proof: storyScore-based resume ranking over ALL sidecar'd
// checkpoints, including checkpoints/archive-regressed-20260812 (the poisoned
// Pewter-trap lineage). Loads every .state.gz in the emulator (RAM truth, not
// sidecar trust), verifies the flag-index scheme (badge/Brock invariant),
// then ranks with the OLD and NEW comparators side by side.
// Usage: npx tsx src/probe_storyscore.ts
import { readdirSync } from "fs";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader, STORY_FLAGS } from "./state";
import { progressRank, VIABLE_HP_PCT } from "./resume";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const DIRS = [
  "/home/lumen/pokemon/checkpoints",
  "/home/lumen/pokemon/checkpoints/archive-regressed-20260812",
];

interface Row {
  f: string; dir: string; map: number; badges: number; events: number;
  story: number; rank: number; hpPct: number; ppOk: boolean; viable: boolean;
  mtime: number; brock: boolean; flags: string[];
}

const sym = new SymbolTable(SYM);
const rows: Row[] = [];
for (const dir of DIRS) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".state.gz")) continue;
    if (f.startsWith("error-recovery") || f.startsWith("pocket-debug")) continue;
    const path = `${dir}/${f}`;
    try {
      const e = new Emulator(ROM);
      loadSnapshotFile(e, path);
      const rd = new StateReader(e, sym);
      const s = rd.read();
      const lead = s.party[0];
      const hpPct = lead && lead.maxHp > 0 ? lead.hp / lead.maxHp : 1;
      const ppOk = !lead || lead.moves.some((mv, i) => mv !== 0 && lead.pp[i] > 0);
      const flags = STORY_FLAGS.filter(x => rd.eventFlag(x.idx)).map(x => x.name);
      rows.push({ f, dir: dir.endsWith("20260812") ? "ARCHIVE" : "live",
        map: s.map, badges: s.badgeCount, events: rd.eventCount(),
        story: rd.storyScore(), rank: progressRank(s.map, s.x, s.y), hpPct, ppOk,
        viable: hpPct >= VIABLE_HP_PCT && ppOk, mtime: 0,
        brock: rd.eventFlag(0x077), flags });
    } catch (err) { console.log(`LOAD-FAIL ${path}: ${err}`); }
  }
}

// Invariant check: Boulder Badge <=> EVENT_BEAT_BROCK (validates bit scheme)
let bad = 0;
for (const r of rows) {
  if ((r.badges >= 1) !== r.brock) {
    bad++; console.log(`INVARIANT-FAIL ${r.f}: badges=${r.badges} brock=${r.brock}`);
  }
}
console.log(`\nBrock invariant: ${rows.length - bad}/${rows.length} OK${bad ? " *** FAILURES ***" : ""}`);

const oldSort = (a: Row, b: Row) =>
  (Number(b.viable) - Number(a.viable)) || (b.badges - a.badges) ||
  ((a.rank >= 0 && b.rank >= 0) ? (b.rank - a.rank) : 0) ||
  (b.events - a.events) || (b.rank - a.rank) || (b.mtime - a.mtime);
const newSort = (a: Row, b: Row) =>
  (Number(b.viable) - Number(a.viable)) || (b.badges - a.badges) ||
  ((a.story >= 0 && b.story >= 0) ? (b.story - a.story) : 0) ||
  (b.rank - a.rank) ||
  (b.events - a.events) || (b.mtime - a.mtime);

const fmt = (r: Row, i: number) =>
  `${String(i + 1).padStart(3)} ${r.dir.padEnd(7)} v=${r.viable ? 1 : 0} b=${r.badges} ` +
  `story=${String(r.story).padStart(2)} rank=${String(r.rank).padStart(2)} ev=${String(r.events).padStart(3)} ` +
  `map=${String(r.map).padStart(3)} hp=${r.hpPct.toFixed(2)} ${r.f}`;

console.log("\n=== NEW sort (viable > badges > storyScore > rank > events) — top 15 ===");
[...rows].sort(newSort).slice(0, 15).forEach((r, i) => console.log(fmt(r, i)));
console.log("\n=== OLD sort — top 15 ===");
[...rows].sort(oldSort).slice(0, 15).forEach((r, i) => console.log(fmt(r, i)));

const top = [...rows].sort(newSort)[0];
console.log(`\nNEW winner: ${top.f} (map ${top.map}, story ${top.story}) [${top.flags.join(", ")}]`);
const pewter = rows.filter(r => [2, 52, 53, 54, 56, 58].includes(r.map) && r.dir === "ARCHIVE");
const rte4up = rows.filter(r => [15, 59, 60, 61, 68, 3].includes(r.map));
const worstR4 = Math.min(...rte4up.map(r => r.story));
const bestPewter = Math.max(...pewter.map(r => r.story), -1);
console.log(`Pewter-era ARCHIVE best story=${bestPewter}; Route4/MtMoon+ worst story=${worstR4} -> ` +
  (bestPewter < worstR4 ? "TRAP DEFEATED (score separates them)" : "WARNING: overlap, rank tiebreak decides"));
