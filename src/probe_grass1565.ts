// wq#1565 — tall grass is visible in the brain's map view.
//
// The 582h Route 24 freeze was a PERCEPTION hole, not a policy one: wild
// Pokemon in Gen 1 roll per step and ONLY on the tileset's grass tile, but
// MapModel.ascii() rendered those cells as plain open ground, so the brain
// reasoned "wild grass not shown ... assume we can move to a grass tile" and
// paid 725 goto calls on map35 for zero battles.
//
// Contract (probes-main rules, wq#588): no live service, no RNG, no
// position-blanket claims over the corpus — every assert here is either a
// CONSISTENCY property between two independent sources (RAM vs ROM, glyph vs
// model) or a pure-function claim about grassLine(). Repel is armed on every
// rig so a fixture walk can never mint a battle mid-probe.
//
// The battle itself — an actual wild encounter entered from the live Route 24
// state — is RNG and lives in src/accept_grass1565.ts (wq#559 rule: RNG
// probes stay out of the on-main set).
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, grassLine } from "./map";
import { readdirSync } from "fs";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const CK = `${BASE}/checkpoints`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(ROM);

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

interface Rig { file: string; map: MapModel; cur: number; x: number; y: number; grassTile: number }

function rig(file: string): Rig | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, `${CK}/${file}`); } catch { return null; }
  emu.mem()[sym.addr("wRepelRemainingSteps")] = 200;   // no wilds inside this probe
  const map = new MapModel(emu, sym, rom); map.build();
  const m = emu.mem();
  return { file, map, cur: m[sym.addr("wCurMap")], x: m[sym.addr("wXCoord")], y: m[sym.addr("wYCoord")],
           grassTile: m[sym.addr("wGrassTile")] };
}

const files = readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort();
const rigs: Rig[] = [];
for (const f of files) { const r = rig(f); if (r) rigs.push(r); }
chk("G0 corpus loaded", rigs.length >= 10, `${rigs.length} states`);

// G1: the grass tile the model uses is the tile the ENGINE uses. RAM's
// wGrassTile is written by LoadTilesetHeader from byte 10 of the 12-byte
// Tilesets entry; reading both and comparing is what makes "0x52" a derived
// fact instead of a magic number that a re-dumped ROM could silently break.
{
  const ts = sym.sym("Tilesets");
  const bad = rigs.filter(r => {
    const e = rom.bytes(ts.bank, ts.addr + r.map.tilesetId * 12, 12);
    return e[10] !== r.grassTile || r.map.grassTile !== r.grassTile;
  });
  chk("G1 wGrassTile == ROM Tilesets[tileset].grassTile on every state", bad.length === 0,
      bad.slice(0, 3).map(r => `${r.file} ts=${r.map.tilesetId}`).join(", "));
}

// G2: an encounter tile is walkable terrain. Grass you cannot stand on would
// make the advisory a lie (goto() would refuse the target it names).
{
  const bad = rigs.filter(r => r.map.grassCells(r.x, r.y).some(c => !r.map.grid[c.y][c.x]));
  chk("G2 every grass cell is walkable terrain", bad.length === 0,
      bad.slice(0, 3).map(r => r.file).join(", "));
}

// G3: the glyph and the model agree — every G in the rendered grid is an
// encounter tile, and every encounter tile not covered by a higher-priority
// glyph (player/warp/npc/ball) renders as G.
{
  let mismatches = 0, shown = "";
  for (const r of rigs) {
    const rows = r.map.ascii(r.x, r.y).split("\n");
    for (let y = 0; y < r.map.gh; y++) for (let x = 0; x < r.map.gw; x++) {
      const g = rows[y][x];
      const covered = (x === r.x && y === r.y) || r.map.isWarp(x, y) ||
                      r.map.sprites.some(s => s.x === x && s.y === y);
      const want = r.map.isGrass(x, y) && !covered;
      if ((g === "G") !== want) {
        if (!mismatches) shown = `${r.file} (${x},${y}) glyph=${g}`;
        mismatches++;
      }
    }
  }
  chk("G3 G glyph <-> isGrass() on the whole corpus", mismatches === 0, shown);
}

// G4: fail-closed where the engine has no grass pool. A map with rate 0 (town,
// interior) or a tileset with no grass tile (0xff — caves) must render no G
// and must not emit the advisory, so the line never appears as dead prose.
{
  const noPool = rigs.filter(r => r.map.grassRate === 0 || r.map.grassTile === 0xff);
  const bad = noPool.filter(r => r.map.grassCells(r.x, r.y).length > 0 ||
                                 r.map.ascii(r.x, r.y).includes("G"));
  chk("G4 no-encounter maps render no G", bad.length === 0,
      `${noPool.length} such states; bad: ${bad.slice(0, 3).map(r => r.file).join(", ")}`);
}

// G5: Route 24 (map35) — the map the campaign froze on — actually shows grass.
{
  const r24 = rigs.filter(r => r.cur === 35);
  const ok = r24.length > 0 && r24.every(r => r.map.grassCells(r.x, r.y).length > 0 &&
                                              r.map.ascii(r.x, r.y).includes("G"));
  chk("G5 live Route 24 states render grass", ok,
      r24.length ? `${r24.length} map35 states, ${r24[0].file}: ${r24[0].map.grassCells(r24[0].x, r24[0].y).length} cells`
                 : "no map35 state");
}

// G6..G9: the advisory itself, pure.
{
  chk("G6 no grass -> no line",
      grassLine({ count: 0, onGrass: false, nearest: { x: 1, y: 1 }, steps: 3 }) === null);
  const on = grassLine({ count: 28, onGrass: true, nearest: { x: 5, y: 5 }, steps: 0 }) ?? "";
  chk("G7 standing on grass says so and says per-step",
      on.includes("STANDING") && on.includes("PER STEP"), on.slice(0, 60));
  const near = grassLine({ count: 28, onGrass: false, nearest: { x: 12, y: 7 }, steps: 4 }) ?? "";
  chk("G8 reachable grass names the tile and the price",
      near.includes("(12,7)") && near.includes("4 steps"), near.slice(0, 60));
  const un = grassLine({ count: 28, onGrass: false, nearest: null, steps: null }) ?? "";
  chk("G9 unreachable grass says so, never invents a target",
      un.includes("none reachable") && !un.includes("goto("), un.slice(0, 60));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
