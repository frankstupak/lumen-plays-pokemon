// wq#552 / rabbit18 — DISCRIMINATING EXPERIMENT for the MapModel-vs-emulator
// collision disagreement found by wq#542. Publishes the model-vs-ROM-vs-emulator
// table the ticket requires BEFORE any edit to src/map.ts.
//
// The ticket names three candidate causes and explicitly refuses to assert one:
//   (a) wrong tile sampled within the 4x4 block (row/col parity error)
//   (b) collision LIST read with the wrong bank/length (64-entry cap vs 0xff)
//   (c) Gen 1 directional collision this model cannot represent
// This probe separates them with measurements, not recall.
//
// METHOD, and why each step is here:
//  A. Recover the screen<->map tile origin BY BRUTE FORCE over all 360 offsets,
//     scoring every one of the 360 on-screen tiles against tiles rebuilt from
//     block data. No assumption about where the player sits on screen.
//  B. Ask the GAME which tile it checks: press a direction and read
//     wTileInFrontOfPlayer, which pokered's own collision routine fills in.
//     Compare against all four sub-tiles of the target walk cell. This is the
//     load-bearing measurement and it does not depend on A.
//  C. Collision list integrity — does the 64-entry cap in map.ts truncate a
//     list that 0xff would have ended later? (candidate b)
//  D. The disputed cells: what each sampling says, what the walkable set says,
//     and what the emulator actually does from all four directions.
//
// ISOLATION: read-only. Loads checkpoints, presses buttons in memory, constructs
// no EventBus (see board 2026-08-13T23:04Z — constructing one deletes event
// logs) and writes nothing to disk.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { readdirSync, copyFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const rom = new Rom(ROM);
const CK = "/home/lumen/pokemon/checkpoints";
const MAP = 61;
const SCREEN_W = 20, SCREEN_H = 18;

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
/** For checks a given fixture cannot exercise. A skipped check is NOT a pass —
 *  it is reported separately so a run that proved less than it looks like it
 *  proved cannot be mistaken for a green one. */
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };
const hex = (n: number) => "0x" + n.toString(16).padStart(2, "0");

/** Everything needed to rebuild a tile id from the block map, read once per emu. */
interface TileCtx {
  m: number[]; width: number; height: number; stride: number; base: number;
  tsBank: number; blockPtr: number; collPtr: number; collBank: number; tilesetId: number;
}
function tileCtx(emu: Emulator): TileCtx {
  const m = emu.mem(), s = sym;
  const width = m[s.addr("wCurMapWidth")], height = m[s.addr("wCurMapHeight")];
  const tilesetId = m[s.addr("wCurMapTileset")];
  const ts = s.sym("Tilesets");
  const e = rom.bytes(ts.bank, ts.addr + tilesetId * 12, 12);
  const tsBank = e[0];
  const blockPtr = e[1] | (e[2] << 8);
  const collPtr = e[5] | (e[6] << 8);
  return {
    m, width, height, stride: width + 6, base: s.addr("wOverworldMap"),
    tsBank, blockPtr, collPtr, collBank: collPtr < 0x4000 ? 0 : tsBank, tilesetId,
  };
}
/** Tile id at MAP TILE coords (4 tiles per block, 2 tiles per walk cell). */
function tileAt(c: TileCtx, tileY: number, tileX: number): number | null {
  const br = (tileY >> 2) + 3, bc = (tileX >> 2) + 3;
  if (br < 0 || bc < 0 || br >= c.height + 6 || bc >= c.width + 6) return null;
  const block = c.m[c.base + br * c.stride + bc];
  if (block === undefined) return null;
  return rom.byte(c.tsBank, c.blockPtr + block * 16 + (tileY & 3) * 4 + (tileX & 3));
}
/** The four sub-tiles of walk cell (x,y), keyed by position within the cell. */
function cellSubTiles(c: TileCtx, x: number, y: number) {
  const out: { rowInCell: number; colInCell: number; label: string; tile: number | null }[] = [];
  for (const rowInCell of [0, 1]) for (const colInCell of [0, 1]) {
    const label = `${rowInCell ? "bottom" : "top"}-${colInCell ? "right" : "left"}`;
    out.push({ rowInCell, colInCell, label, tile: tileAt(c, y * 2 + rowInCell, x * 2 + colInCell) });
  }
  return out;
}
function collisionList(c: TileCtx, cap: number): { tiles: number[]; terminated: boolean } {
  const tiles: number[] = [];
  for (let i = 0; i < cap; i++) {
    const t = rom.byte(c.collBank, c.collPtr + i);
    if (t === 0xff) return { tiles, terminated: true };
    tiles.push(t);
  }
  return { tiles, terminated: false };
}
/** TilePairCollisionsLand, straight out of the ROM, located by SYMBOL not by a
 *  hardcoded address. Each entry is (tileset, tileA, tileB); the game refuses
 *  movement between tileA and tileB IN EITHER ORDER while that tileset is
 *  loaded, regardless of both tiles being in the passable list. */
function tilePairs(tilesetId: number, symbolName: string): { a: number; b: number }[] {
  const t = sym.sym(symbolName);
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i < 64; i++) {
    const ts = rom.byte(t.bank, t.addr + i * 3);
    if (ts === 0xff) break;
    const a = rom.byte(t.bank, t.addr + i * 3 + 1), b = rom.byte(t.bank, t.addr + i * 3 + 2);
    if (ts === tilesetId) out.push({ a, b });
  }
  return out;
}
const pairBlocks = (pairs: { a: number; b: number }[], from: number, to: number) =>
  pairs.some(p => (p.a === from && p.b === to) || (p.b === from && p.a === to));

const posOf = (emu: Emulator) => { const s = new StateReader(emu, sym).read(); return { x: s.x, y: s.y, map: s.map }; };

async function step(emu: Emulator, sy: Sync, key: number): Promise<"ok" | "battle"> {
  await emu.tapAsync(key, 8, 2); await emu.framesAsync(22); await sy.settle(300);
  return emu.mem()[sym.addr("wIsInBattle")] !== 0 ? "battle" : "ok";
}

// ---- fixture: a map61 checkpoint standing in the confinement strip ---------
// COPIED to a temp dir before use. checkpoints/ is rotated by the LIVE service:
// the first run of this probe had its fixture deleted underneath it mid-loop,
// which is wq#540's "fixture rot" with a new cause. A probe that reloads the
// same file 12 times must own a stable copy of it.
let source: string | null = null;
for (const f of readdirSync(CK).filter(f => f.endsWith(".state.gz"))) {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, join(CK, f)); } catch { continue; }
  const s = new StateReader(emu, sym).read();
  if (s.map === MAP && (s.y === 10 || s.y === 11)) { source = join(CK, f); break; }
}
if (!source) { console.log("SKIP: no map61 strip checkpoint available"); process.exit(0); }
const tmpDir = mkdtempSync(join(tmpdir(), "lpp552-"));
const picked: string = join(tmpDir, "fixture.state.gz");
copyFileSync(source, picked);

async function main() {
console.log(`fixture (resolved by property, not by name): ${picked}`);
const emu0 = new Emulator(ROM);
loadSnapshotFile(emu0, picked!);
await new Sync(emu0, sym).settle(300);
const c0 = tileCtx(emu0);
const p0 = posOf(emu0);
const walkSet = new Set(collisionList(c0, 512).tiles);
console.log(`map=${p0.map} tileset=${c0.tilesetId} size=${c0.width}x${c0.height} blocks  player=(${p0.x},${p0.y})\n`);

// ================= A. recover the screen<->map tile origin =================
// Brute force: for every candidate origin, rebuild all 360 screen tiles from
// block data and count exact matches against wTileMap. The true origin should
// match essentially everything; nothing else should come close.
console.log("=== A. screen<->map tile origin, recovered by brute force over all 360 offsets ===");
const tm = sym.addr("wTileMap");
const screen: number[] = [];
for (let i = 0; i < SCREEN_W * SCREEN_H; i++) screen.push(c0.m[tm + i]);

let bestR = -1, bestC = -1, bestScore = -1, runnerUp = -1;
for (let R = 0; R < SCREEN_H; R++) for (let C = 0; C < SCREEN_W; C++) {
  // (R,C) = screen position of the TOP-LEFT map tile of the player's walk cell
  let score = 0;
  for (let r = 0; r < SCREEN_H; r++) for (let cc = 0; cc < SCREEN_W; cc++) {
    const t = tileAt(c0, p0.y * 2 + (r - R), p0.x * 2 + (cc - C));
    if (t !== null && t === screen[r * SCREEN_W + cc]) score++;
  }
  if (score > bestScore) { runnerUp = bestScore; bestScore = score; bestR = R; bestC = C; }
  else if (score > runnerUp) runnerUp = score;
}
console.log(`  best origin: player's walk cell top-left tile sits at screen (row=${bestR}, col=${bestC})`);
console.log(`  match ${bestScore}/${SCREEN_W * SCREEN_H} screen tiles; next-best offset scores ${runnerUp}`);
chk("A1 one origin explains the screen and no other comes close",
  bestScore >= 340 && bestScore > runnerUp + 40, `best=${bestScore} runnerUp=${runnerUp}`);

// pokered reads the tile the player STANDS on at screen coord (8,9) and caches
// it in hTilePlayerStandingOn. This is CORROBORATION, not the load-bearing
// measurement — A1 already pins the origin at 360/360. The HRAM byte is written
// by UpdatePlayerSprite and can be stale on a freshly loaded state (a menu tile
// >= $60 left over from before the save), so it is refreshed and REPORTED
// rather than asserted.
await emu0.framesAsync(20);
const standing = emu0.mem()[sym.addr("hTilePlayerStandingOn")];
const screen98 = screen[9 * SCREEN_W + 8];
console.log(`  [info] hTilePlayerStandingOn=${hex(standing)} vs tilemap[9][8]=${hex(screen98)}`
  + `${standing === screen98 ? "  (agree)" : standing >= 0x60
    ? "  (HRAM still holds a non-map tile >= $60 — stale, not a contradiction)"
    : "  *** DISAGREE and both are map tiles — investigate ***"}`);
chk("A2 hTilePlayerStandingOn does not contradict the recovered origin",
  standing === screen98 || standing >= 0x60, `hram=${hex(standing)} tilemap[9][8]=${hex(screen98)}`);
const standRowInCell = 9 - bestR, standColInCell = 8 - bestC;
const ORIGIN_SUB = `${standRowInCell ? "bottom" : "top"}-${standColInCell ? "right" : "left"}`;
console.log(`  => origin says the collision sub-tile is `
  + `(rowInCell=${standRowInCell}, colInCell=${standColInCell}) = ${ORIGIN_SUB.toUpperCase()} of the 2x2 cell`);

// ============ B. ask the GAME which sub-tile its collision check reads ======
// pokered's own routine writes the tile it tested to wTileInFrontOfPlayer.
// Only BLOCKED attempts are used: if the player moved, the cell the check ran
// against is ambiguous, so those trials are discarded rather than guessed at.
console.log("\n=== B. wTileInFrontOfPlayer vs the four sub-tiles of the target cell ===");
const DIRS: { name: string; key: number; dx: number; dy: number }[] = [
  { name: "DOWN", key: KEYS.DOWN, dx: 0, dy: 1 },
  { name: "UP", key: KEYS.UP, dx: 0, dy: -1 },
  { name: "LEFT", key: KEYS.LEFT, dx: -1, dy: 0 },
  { name: "RIGHT", key: KEYS.RIGHT, dx: 1, dy: 0 },
];
const tifpAddr = sym.addr("wTileInFrontOfPlayer");
let surviving: string[] | null = null;
let trials = 0, discriminating = 0;

// Columns are chosen RELATIVE TO THE FIXTURE. A fixed 31..35 list is only
// reachable from a fixture east of the x=29 wall; from a western one every
// trial is skipped and the section proves nothing.
const B_COLS = [p0.x, p0.x + 1, p0.x - 1, p0.x + 2, p0.x - 2].filter(x => x >= 0 && x < c0.width * 2);
for (const targetX of B_COLS) {
  for (const d of DIRS) {
    const emu = new Emulator(ROM);
    loadSnapshotFile(emu, picked!);
    const sy = new Sync(emu, sym);
    let p = posOf(emu), guard = 0, interrupted = false;
    while (p.x !== targetX && guard++ < 20) {
      if (await step(emu, sy, p.x < targetX ? KEYS.RIGHT : KEYS.LEFT) === "battle") { interrupted = true; break; }
      p = posOf(emu);
    }
    if (interrupted || p.x !== targetX) continue;
    const before = posOf(emu);
    // TURN FIRST. In Gen 1 a press in a direction the player is not already
    // facing turns in place and runs NO collision check, so wTileInFrontOfPlayer
    // still holds the result of the previous check — the LEFT/RIGHT presses used
    // to approach. The first run of this probe read those stale values and
    // printed "matches: NONE" for cells whose tiles were perfectly consistent.
    if (await step(emu, sy, d.key) === "battle") continue;
    if (posOf(emu).x !== before.x || posOf(emu).y !== before.y) continue;  // moved on the turn press
    if (await step(emu, sy, d.key) === "battle") continue;
    const after = posOf(emu);
    if (after.x !== before.x || after.y !== before.y) continue;   // moved -> ambiguous, discard
    trials++;
    const observed = emu.mem()[tifpAddr];
    const ctx = tileCtx(emu);
    const subs = cellSubTiles(ctx, before.x + d.dx, before.y + d.dy);
    const matches = subs.filter(s => s.tile === observed).map(s => s.label);
    if (matches.length > 0 && matches.length < 4) {
      discriminating++;
      surviving = surviving === null ? matches : surviving.filter(l => matches.includes(l));
    }
    console.log(`  (${before.x},${before.y}) ${d.name} blocked; wTileInFrontOfPlayer=${hex(observed)} `
      + `cell(${before.x + d.dx},${before.y + d.dy}) subtiles [`
      + subs.map(s => `${s.label}=${s.tile === null ? "--" : hex(s.tile)}`).join(" ")
      + `] -> matches: ${matches.join("/") || "NONE"}`);
  }
}
console.log(`  blocked trials usable: ${trials}; discriminating: ${discriminating}`);
// A DETERMINES the sub-tile (360/360 over the whole screen). B CORROBORATES it
// against the game's own collision routine. B is fixture-dependent — a fixture
// west of the x=29 wall cannot reach the columns whose cells have distinct
// sub-tiles — so when B has nothing discriminating to say it is SKIPPED, not
// failed, and it never gates the sections downstream. An earlier draft let B
// gate GAME_SUB, and a fixture with zero usable trials silently blanked every
// tile column in D and turned E into six phantom regressions.
const GAME_SUB: string = ORIGIN_SUB;
const bSet = surviving ?? [];
if (discriminating === 0)
  skipped("B1 corroboration of A against wTileInFrontOfPlayer",
    "this fixture reached no cell whose four sub-tiles differ");
else
  chk("B1 the game's collision tile never contradicts the origin recovered in A",
    bSet.includes(ORIGIN_SUB), `A=${ORIGIN_SUB} B-survivors=[${bSet.join(",")}]`);
console.log(`  *** the collision sub-tile is the ${GAME_SUB.toUpperCase()} 8px tile of the 2x2 walk cell `
  + `(A: 360/360${discriminating ? `; B narrowed to [${bSet.join(",")}]` : "; B skipped"}) ***`);

// Which sub-tile is src/map.ts ACTUALLY sampling? Derived by comparing its grid
// against each candidate over every cell of the map, not read off its comment —
// so this section stays truthful after the fix lands.
const mmA = new MapModel(emu0, sym, rom); mmA.build();
const LABELS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const consistent = LABELS.filter(label => {
  for (let y = 0; y < mmA.gh; y++) for (let x = 0; x < mmA.gw; x++) {
    const t = cellSubTiles(c0, x, y).find(s => s.label === label)!.tile;
    if (mmA.grid[y][x] !== (t !== null && walkSet.has(t))) return false;
  }
  return true;
});
const MAP_TS_SUB = consistent.length === 1 ? consistent[0] : null;
console.log(`  src/map.ts's grid is consistent with: [${consistent.join(", ") || "none"}]`
  + ` over all ${mmA.gw}x${mmA.gh} cells`);
chk("B2 map.ts samples the same sub-tile the game does", GAME_SUB !== null && GAME_SUB === MAP_TS_SUB,
  `game=${GAME_SUB ?? "undetermined"} map.ts=${MAP_TS_SUB ?? "ambiguous"}`);

// ================= C. candidate (b): is the collision LIST truncated? ======
console.log("\n=== C. tileset collision list: bank, terminator, length ===");
const capped = collisionList(c0, 64);
const uncapped = collisionList(c0, 512);
console.log(`  collPtr=${hex(c0.collPtr)} (${c0.collPtr.toString(16)}) collBank=${c0.collBank} tsBank=${c0.tsBank}`);
console.log(`  read with map.ts's 64 cap: ${capped.tiles.length} entries, 0xff terminator hit: ${capped.terminated}`);
console.log(`  read with no cap (512):    ${uncapped.tiles.length} entries, 0xff terminator hit: ${uncapped.terminated}`);
console.log(`  entries: ${uncapped.tiles.map(hex).join(" ")}`);
chk("C1 the 0xff terminator is reached well inside the 64-entry cap (list is NOT truncated)",
  capped.terminated && capped.tiles.length === uncapped.tiles.length,
  `capped=${capped.tiles.length} uncapped=${uncapped.tiles.length}`);

// ================= D. the disputed cells, three sources side by side =======
console.log("\n=== D. MODEL vs ROM vs EMULATOR for the y=12 boundary (map61) ===");
const mm0 = new MapModel(emu0, sym, rom); mm0.build();
const COLS: number[] = []; for (let x = 24; x <= 35; x++) COLS.push(x);

interface Row { x: number; model: boolean; mapTsTile: number | null; gameTile: number | null;
                gameWalkable: boolean | null; standTile: number | null; pairBlocked: boolean;
                emu: string }
const rows: Row[] = [];
const PAIRS = tilePairs(c0.tilesetId, "TilePairCollisionsLand");
console.log(`  TilePairCollisionsLand entries for tileset ${c0.tilesetId}: `
  + (PAIRS.map(p => `${hex(p.a)}<->${hex(p.b)}`).join("  ") || "(none)"));
for (const x of COLS) {
  const subs = cellSubTiles(c0, x, 12);
  const bl = MAP_TS_SUB ? subs.find(s => s.label === MAP_TS_SUB)!.tile : null;
  const gt = GAME_SUB ? subs.find(s => s.label === GAME_SUB)!.tile : null;
  // the cell the agent stands in when it attempts the step: (x, 11)
  const st = GAME_SUB ? cellSubTiles(c0, x, 11).find(s => s.label === GAME_SUB)!.tile : null;
  rows.push({ x, model: mm0.passable(x, 12), mapTsTile: bl, gameTile: gt,
    gameWalkable: gt === null ? null : walkSet.has(gt), standTile: st,
    pairBlocked: st !== null && gt !== null && pairBlocks(PAIRS, st, gt), emu: "not tested" });
}

// emulator ground truth: the only reachable approach to y=12 is from the north,
// because y=11 is the floor of the strip. Other approaches are stated as such.
console.log("  driving the emulator: raw DOWN from y=11, per column, never through Navigator");
for (const r of rows) {
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, picked!);
  const sy = new Sync(emu, sym);
  let p = posOf(emu), guard = 0, bad = "";
  while (p.x !== r.x && guard++ < 20) {
    if (await step(emu, sy, p.x < r.x ? KEYS.RIGHT : KEYS.LEFT) === "battle") { bad = "battle approaching"; break; }
    p = posOf(emu);
  }
  if (bad || p.x !== r.x) { r.emu = bad || `unreachable (stopped x=${p.x})`; continue; }
  while (p.y < 11) { if (await step(emu, sy, KEYS.DOWN) === "battle") { bad = "battle"; break; } p = posOf(emu); }
  if (bad) { r.emu = "inconclusive (battle)"; continue; }
  const before = posOf(emu);
  let moved = false;
  for (let i = 0; i < 4 && !moved; i++) {
    if (await step(emu, sy, KEYS.DOWN) === "battle") { bad = "battle"; break; }
    moved = posOf(emu).y > before.y;
  }
  r.emu = bad ? "inconclusive (battle)" : (moved ? "MOVED" : "REFUSED");
  console.log(`    x=${r.x}: from (${before.x},${before.y}) -> ${r.emu}`);
}

console.log("\n  x   | stand tile | target tile | in passable list | tile-pair blocked | emulator (from N)");
console.log("  ----+------------+-------------+------------------+-------------------+------------------");
for (const r of rows) {
  console.log(`  ${String(r.x).padStart(2)}  | `
    + `${(r.standTile === null ? "--" : hex(r.standTile)).padEnd(10)} | `
    + `${(r.gameTile === null ? "--" : hex(r.gameTile)).padEnd(11)} | `
    + `${(r.gameWalkable === null ? "--" : r.gameWalkable ? "yes" : "no").padEnd(16)} | `
    + `${(r.pairBlocked ? "YES" : "no").padEnd(17)} | ${r.emu}`);
}
console.log("  (map.ts's own verdict is the 'in passable list' column: B2 proved map.ts and the");
console.log("   game read the SAME sub-tile, so the tile ids are not in dispute — only what is");
console.log("   done with them. Approaches from S/E/W are UNREACHABLE for this row: y=11 is the");
console.log("   strip floor and y=12 is exactly what the agent cannot enter.)");

const decided = rows.filter(r => r.emu === "MOVED" || r.emu === "REFUSED");
// Two rules, both computed from ROM data, scored against the emulator:
//   LEGACY = passable-list membership alone (what MapModel used before wq#552)
//   NEW    = passable-list membership AND not tile-pair blocked
// x=30 is why these must be scored as "can the player enter?" and not as
// "is it pair-blocked?": it is REFUSED because its tile is absent from the
// passable list, which the legacy rule already got right. Scoring refusal
// against pair-blocking alone marks that column a miss and prints 5/6 under a
// table that plainly shows 6/6 — the first draft of this probe did exactly
// that, which is the third summary-vs-evidence contradiction this lane has
// caught today.
const legacyOK = (r: Row) => r.gameWalkable === true;
const newOK = (r: Row) => r.gameWalkable === true && !r.pairBlocked;
const entersInGame = (r: Row) => r.emu === "MOVED";
const legacyRight = decided.filter(r => legacyOK(r) === entersInGame(r));
const newRight = decided.filter(r => newOK(r) === entersInGame(r));
const shippedRight = decided.filter(r => mm0.passableFrom(r.x, 11, r.x, 12) === entersInGame(r));
console.log(`\n  columns with a decided emulator result: ${decided.length}`);
console.log(`  LEGACY rule (passable list alone)      predicts the emulator on: ${legacyRight.length}/${decided.length}`);
console.log(`  NEW rule (passable list + tile pairs)  predicts the emulator on: ${newRight.length}/${decided.length}`);
console.log(`  the SHIPPED MapModel.passableFrom()    predicts the emulator on: ${shippedRight.length}/${decided.length}`);
chk("D1 the legacy passable-list-alone rule mispredicts at least one decided column",
  legacyRight.length < decided.length, `${legacyRight.length}/${decided.length} correct`);
chk("D2 passable list + TilePairCollisionsLand explains every decided column",
  decided.length > 0 && newRight.length === decided.length, `${newRight.length}/${decided.length}`);
chk("D3 the shipped MapModel matches the emulator on every decided column",
  decided.length > 0 && shippedRight.length === decided.length, `${shippedRight.length}/${decided.length}`);

// ============ E. does the new rule break the moves that ACTUALLY WORK? =====
// A rule that blocks everything would also satisfy D2 while walling off the
// game. So: every transition the emulator demonstrably PERFORMED must survive
// both the passable-list test and the tile-pair test.
console.log("\n=== E. regression guard — transitions the emulator demonstrably PERFORMED ===");
const moves: { fx: number; fy: number; tx: number; ty: number }[] = [];
{
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, picked);
  const sy = new Sync(emu, sym);
  let p = posOf(emu);
  const walk = [KEYS.UP, KEYS.LEFT, KEYS.LEFT, KEYS.UP, KEYS.RIGHT, KEYS.RIGHT, KEYS.RIGHT,
                KEYS.DOWN, KEYS.LEFT, KEYS.UP, KEYS.RIGHT, KEYS.RIGHT];
  for (const k of walk) {
    if (await step(emu, sy, k) === "battle") break;
    const q = posOf(emu);
    if (q.map !== MAP) break;
    if (q.x !== p.x || q.y !== p.y) moves.push({ fx: p.x, fy: p.y, tx: q.x, ty: q.y });
    p = q;
  }
}
let regressions = 0;
for (const mv of moves) {
  const from = GAME_SUB ? cellSubTiles(c0, mv.fx, mv.fy).find(s => s.label === GAME_SUB)!.tile : null;
  const to = GAME_SUB ? cellSubTiles(c0, mv.tx, mv.ty).find(s => s.label === GAME_SUB)!.tile : null;
  const listOk = to !== null && walkSet.has(to);
  const pairOk = !(from !== null && to !== null && pairBlocks(PAIRS, from, to));
  if (!listOk || !pairOk) regressions++;
  console.log(`  (${mv.fx},${mv.fy})->(${mv.tx},${mv.ty}) `
    + `${from === null ? "--" : hex(from)}->${to === null ? "--" : hex(to)} `
    + `list=${listOk ? "ok" : "WALL"} pair=${pairOk ? "ok" : "BLOCKED"}`
    + `${listOk && pairOk ? "" : "   *** REGRESSION ***"}`);
}
chk("E1 every move the emulator actually made survives both rules",
  moves.length > 0 && regressions === 0, `${moves.length} moves, ${regressions} regressions`);

console.log(`\nprobe_collision552: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
}
main();
