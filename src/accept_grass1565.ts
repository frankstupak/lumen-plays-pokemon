// wq#1565 acceptance — from the LIVE Route 24 state, a brain that can see the
// grass enters a wild battle inside one dP window.
//
// Why this is separate from probe_grass1565: it needs a real wild encounter,
// and encounters are RNG (pokered TryDoWildEncounter rolls per step against
// wGrassRate — 25/256 per step on map35). The on-main probe set is
// RNG-free by contract (wq#559/#588), so the battle proof runs here, by hand:
//
//   npx tsx src/accept_grass1565.ts
//
// The policy below is deliberately nothing but what the new observation now
// affords: walk to the nearest G tile, then keep goto()ing G tiles. One goto
// per turn = one brain turn, and the budget is novelty.ts's DP_WINDOW_TURNS —
// the same window the 582h freeze was measured in (dP == 0 over 40 turns).
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { EventBus } from "./events";
import { Navigator, astar } from "./nav";
import { DP_WINDOW_TURNS } from "./novelty";
import { readdirSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const CK = `${BASE}/checkpoints`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(ROM);
const ROUTE24 = 35;

interface Trial {
  file: string; turns: number; steps: number; battle: boolean; note: string;
  cells: number;      // encounter tiles on this map
  rendered: number;   // of those, how many the grid actually names as G
}

async function run(file: string): Promise<Trial | null> {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, `${CK}/${file}`); } catch { return null; }
  const m = emu.mem();
  if (m[sym.addr("wCurMap")] !== ROUTE24) return null;
  if (m[sym.addr("wIsInBattle")] !== 0) return null;
  const repel = m[sym.addr("wRepelRemainingSteps")];
  const map = new MapModel(emu, sym, rom); map.build();
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp1565-")), "accept1565");
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const rd = new StateReader(emu, sym);
  const pos = () => ({ x: emu.mem()[sym.addr("wXCoord")], y: emu.mem()[sym.addr("wYCoord")] });

  // Perception delta, measured on the entry state: encounter tiles present vs
  // encounter tiles the grid names. Before this ticket the second number was 0
  // — every one of them rendered ".", the same glyph as bare road.
  const p0 = pos();
  const rows0 = map.ascii(p0.x, p0.y).split("\n");
  const cells0 = map.grassCells(p0.x, p0.y);
  const rendered = cells0.filter(c => rows0[c.y][c.x] === "G").length;

  let steps = 0;
  for (let turn = 1; turn <= DP_WINDOW_TURNS; turn++) {
    map.build();
    const p = pos();
    if (rd.read().inBattle !== 0)
      return { file, turns: turn - 1, steps, battle: true, note: `repel=${repel}`, cells: cells0.length, rendered };
    // Exactly the two moves the new TALL GRASS line prescribes: off grass, walk
    // to the nearest reachable G; on grass, cross to the far side of the patch
    // (every step taken on G is one encounter roll).
    const cells = map.grassCells(p.x, p.y);
    const onGrass = map.isGrass(p.x, p.y);
    let target: { x: number; y: number } | null = null, best = -1;
    for (const c of cells) {
      if (c.x === p.x && c.y === p.y) continue;
      const path = astar(map, p.x, p.y, c.x, c.y, new Set<string>());
      if (!path) continue;
      if (!onGrass) { target = c; best = path.length; break; }    // nearest-first order
      if (path.length > best && path.length <= 20) { target = c; best = path.length; }
    }
    if (!target) return { file, turns: turn, steps, battle: false, note: "no reachable grass", cells: cells0.length, rendered };
    const before = pos();
    const r = await nav.goto(target.x, target.y);
    const after = pos();
    steps += Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    if (r === "battle" || rd.read().inBattle !== 0)
      return { file, turns: turn, steps, battle: true, note: `goto->${r} repel=${repel}`, cells: cells0.length, rendered };
  }
  return { file, turns: DP_WINDOW_TURNS, steps, battle: false, note: `repel=${repel}`, cells: cells0.length, rendered };
}

(async () => {
  const files = readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort();
  const trials: Trial[] = [];
  for (const f of files) {
    if (trials.length >= 5) break;
    const t = await run(f);
    if (!t) continue;
    trials.push(t);
    console.log(`${t.battle ? "BATTLE" : "NO BATTLE"} ${t.file} turns=${t.turns} steps=${t.steps} ${t.note}`);
  }
  if (trials.length)
    console.log(`\nmap35 encounter tiles: ${trials[0].cells}; rendered G now: ` +
      `${trials[0].rendered}; nameable before wq#1565: 0 (all rendered ".")`);
  const won = trials.filter(t => t.battle).length;
  const ok = trials.length > 0 && won === trials.length;
  console.log(`\n${ok ? "ACCEPTED" : "NOT ACCEPTED"} — ${won}/${trials.length} live Route 24 states ` +
    `entered a wild battle within ${DP_WINDOW_TURNS} turns (one dP window)`);
  process.exit(ok ? 0 : 1);
})();
