// wq#652 — warp-loop-on-exit: red/green probe.
//
// THE DEFECT (observed live 2026-08-16, live-agent-1786841530991.jsonl T74-75,
// sentinel loop_repeat 01:25Z/02:28Z): exiting Cerulean Gym (map65 -> map3
// door warp3 at (30,19)) reports "warped now {map:3,x:30,y:19}" - landing
// exactly on the door tile the warp itself fires from. The brain reads that
// as "standing on the warp again" and calls enter_warp right back in, ping-
// ponging map3<->map65 forever (never actually progressing).
//
// ROOT CAUSE, RAM-verified frame-by-frame (see report): Navigator.step()
// (nav.ts) detects a warp the instant wCurMap flips, then used to wait a flat
// framesAsync(90) before returning "warped" — so the caller's very next
// pos() read raced the game's own post-warp script. The RAM trace shows why a
// flag-only wait (sync.settle(), which watches wJoyIgnore / wStatusFlags5 /
// wWalkCounter) is not enough either: there is an IDLE-LOOKING GAP of dozens
// of frames — all three flags genuinely zero — BETWEEN the map id flipping
// and the walk-out script actually engaging those flags. A single settle()
// call made right after the map-change check can return during that gap,
// before wXCoord/wYCoord have moved off the door tile.
//
// THE FIX: nav.ts now polls POSITION across repeated settle+wait rounds after
// a warp, and only returns once two consecutive rounds report the same
// (map,x,y) - true regardless of how many idle/busy phases the exit script
// has, with no frame-count guess.
//
// WHAT THIS PROBE PROVES (red on pre-fix main, green on the fix): from a REAL
// checkpoint standing one step from Cerulean Gym's door, entering then
// immediately exiting the gym must land the reported position OFF every warp
// tile on the map (so the brain never mistakes "just arrived" for "still on
// the door") and that reported position must be STABLE - unchanged across a
// further wait, proving it was not read mid-animation.
//
// FIXTURE RESOLUTION BY PROPERTY (wq#540): never by file name. Any map3
// checkpoint standing within 2 tiles of the gym door satisfies the scenario;
// a missing fixture SKIPs loudly (corpus rotation, not a code defect) rather
// than failing red, same shape as probe_cerulean638 section A.
//
// ISOLATION: read-only on the tree; EventBus writes into a mkdtemp dir; loads
// checkpoints, never saves them; touches no live service.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { EventBus } from "./events";
import { Navigator } from "./nav";
import { findFixture, copyFixture } from "./fixtures";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const CK = `${BASE}/checkpoints`;
const SAVES = `${BASE}/saves`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(ROM);

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

// The gym door: map3 (30,19), one step north of the (30,20) approach tile
// used by every live checkpoint that reached Cerulean's gym.
const DOOR = { map: 3, x: 30, y: 19 };
const near = (sc: { map: number; x: number; y: number }) =>
  sc.map === DOOR.map && Math.abs(sc.x - DOOR.x) <= 1 && Math.abs(sc.y - DOOR.y) <= 2;

async function main() {
  const fixture = findFixture(near, [CK, SAVES]);
  if (!fixture) {
    console.log("SKIP -- no map3 checkpoint near the Cerulean Gym door on disk (corpus rotated).");
    console.log("     This is corpus rot, not a code defect (wq#643 shape).");
    console.log("\n0 passed, 0 failed (fixture unavailable, skipped)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "probe652-"));
  const snap = copyFixture(fixture);

  const e = new Emulator(ROM);
  loadSnapshotFile(e, snap);
  const bus = new EventBus(dir, "probe652");
  const sync = new Sync(e, sym);
  const map = new MapModel(e, sym, rom);
  const nav = new Navigator(e, sym, map, bus, sync);
  const rd = new StateReader(e, sym);

  const st0 = rd.read();
  chk("fixture is really near the gym door", near(st0), JSON.stringify(st0));

  map.build();
  const door = map.warps.find(w => w.x === DOOR.x && w.y === DOOR.y);
  if (!door) { chk("gym door warp present on map3", false, "no warp at (30,19) - map data changed"); return; }

  const rIn = await nav.enterWarp(door);
  chk("entering the gym warps to a different map", rIn === "warped" && nav.pos().map !== 3,
      `${rIn} ${JSON.stringify(nav.pos())}`);
  if (rIn !== "warped") return;

  // give the interior's own map data time to finish loading (independent of
  // the fix under test - this is the natural multi-second gap between turns
  // in production, not part of what's being measured).
  await sync.settle();
  await e.framesAsync(120);
  map.build();
  const exitWarp = map.warps.find(w => w.destMap === 3 || w.destMap === 0xff);
  if (!exitWarp) { chk("gym has a warp back to map3", false, JSON.stringify(map.warps)); return; }

  const rOut = await nav.enterWarp(exitWarp);
  const immediate = nav.pos();
  chk("exiting the gym warps back", rOut === "warped" && immediate.map === 3,
      `${rOut} ${JSON.stringify(immediate)}`);

  map.build();
  const onWarpTile = map.warps.some(w => w.x === immediate.x && w.y === immediate.y);
  chk("reported landing position is OFF every map3 warp tile (not back on the door)",
      !onWarpTile, `landed ${JSON.stringify(immediate)}, map3 warps: ${JSON.stringify(map.warps)}`);

  await e.framesAsync(150);
  const later = nav.pos();
  chk("reported position does not drift afterward (was not read mid-animation)",
      later.map === immediate.map && later.x === immediate.x && later.y === immediate.y,
      `immediate=${JSON.stringify(immediate)} later=${JSON.stringify(later)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
