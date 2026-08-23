// wq#699 / wq#700 — the post-warp position read race: red/green probe.
//
// THE DEFECT (observed live 2026-08-19 T5/T6, reproduced deterministically
// here): Gen 1 sets wCurMap to the DESTINATION early in the warp handler and
// only loads that map's header, block data, warp table and player coordinates
// some frames later. In between, RAM describes two maps at once.
//
// MEASURED on this ROM (checkpoint auto-mt2f0ie1-map88, Route 25 -> Bill's
// house): wCurMap flips at frame 0, the header arrives at frame 15, the
// coordinates at frame 16 — and for the first 12 frames wJoyIgnore,
// wStatusFlags5 and wWalkCounter are ALL ZERO, so Sync.busy() reads idle and
// Sync.settle() returns INSIDE the window. Quiet is not finished.
//
// Consequences the old code shipped:
//   * enterWarp() returned 'warped' reporting map88 at Route 25's (45,3) —
//     an interior map id with the outdoor door's coordinates, which is the
//     exact string the live agent handed the brain at T5 while the system
//     prompt tells it POS is exact.
//   * every auto-*-map88 checkpoint on disk was SAVED in that window, so
//     resume ranked an impossible tile and computed onWarp against the
//     DEPARTED map's warp list.
//   * step()'s post-warp poll loop compared two position samples taken inside
//     the same idle gap, found them equal, and called a transition that had
//     not started yet "settled" (wq#699).
//   * an action that begins mid-load inherits the flip and reports someone
//     else's transition as its own 'warped' with zero net movement — and
//     'warped' retires the brain's transit goal (wq#700).
//
// WHAT THIS PROBE PROVES (red on pre-fix main, green on the fix):
//   A. the detector is exact: ROM map headers agree with loaded WRAM headers
//      on settled states, and disagree on a synthetic torn one.
//   B. the OLD gate is blind to it: on a genuinely torn state Sync.busy() is
//      false while the position is impossible for the map it claims.
//   C. HONESTY: every nav result reports a position the reported map can
//      physically hold, and leaves no transition pending for its caller.
//   D. wq#700: a journey that starts mid-transition absorbs it instead of
//      reporting it as its own 'warped'.
//   E. resume scoring never returns an impossible position for a checkpoint.
//
// FIXTURE RESOLUTION BY PROPERTY (wq#540/#588): never by file name. Torn
// fixtures are found by asking MapModel.loadPending(); door fixtures by
// standing next to a warp whose destination map has different dimensions.
// Missing fixtures SKIP (wq#643) — corpus rotation is not a defect.
//
// ISOLATION: read-only on the tree; EventBus writes into a mkdtemp dir; loads
// checkpoints, never saves them; touches no live service.
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp, romMapHeader, coordsPlausible } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { EventBus } from "./events";
import { Navigator } from "./nav";
import { readProgress } from "./resume";
import { readdirSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const SYM = `${BASE}/roms/pokeblue.sym`;
const CK = `${BASE}/checkpoints`;

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

interface Rig {
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader; sync: Sync;
  pos: () => { map: number; x: number; y: number };
}

function rig(statePath: string): Rig | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, statePath); } catch { return null; }
  const map = new MapModel(emu, sym, rom); map.build();
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp699-")), "probe699");
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  return { emu, map, nav, rd: new StateReader(emu, sym), sync, pos: () => nav.pos() };
}

/** Suppress wild encounters so route navigation is deterministic. */
function armRepel(emu: Emulator, steps = 200) {
  emu.mem()[sym.addr("wRepelRemainingSteps")] = steps;
}

const states = () => readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort();

/** A checkpoint saved mid-map-load, found by asking the detector. */
function findTornFixture(): { path: string; r: Rig } | null {
  for (const f of states()) {
    const r = rig(`${CK}/${f}`);
    if (r && r.map.loadPending()) return { path: f, r };
  }
  return null;
}

/** A settled checkpoint standing NEXT TO a warp whose destination map has
 *  different dimensions — the shape where a torn read is visible as an
 *  impossible coordinate rather than a plausible-but-wrong one. */
function findDoorFixture(): { path: string; r: Rig; w: Warp } | null {
  for (const f of states()) {
    const r = rig(`${CK}/${f}`);
    if (!r || r.map.loadPending()) continue;
    if (r.rd.read().inBattle) continue;
    const p = r.pos();
    const here = romMapHeader(sym, rom, p.map);
    const w = r.map.warps.find(w =>
      Math.abs(w.x - p.x) + Math.abs(w.y - p.y) === 1 &&
      (() => { const d = romMapHeader(sym, rom, w.destMap);
               return !!d && !!here && (d.width !== here.width || d.height !== here.height); })());
    if (w) return { path: f, r, w };
  }
  return null;
}

(async () => {
  console.log("== probe_warprace699: post-warp position read race ==");

  // ── A. the detector is exact ───────────────────────────────────────────
  // Known ROM facts, so a re-dumped ROM or a moved table fails loudly here
  // rather than silently disabling every gate built on this table.
  const r25 = romMapHeader(sym, rom, 36), bills = romMapHeader(sym, rom, 88);
  chk("A1 ROM map headers decode", !!r25 && !!bills,
      `map36=${JSON.stringify(r25)} map88=${JSON.stringify(bills)}`);
  chk("A2 the two maps differ in shape (the torn read is visible)",
      !!r25 && !!bills && (r25.width !== bills.width || r25.height !== bills.height));
  chk("A3 Route 25's (45,3) is impossible on map88",
      !coordsPlausible(sym, rom, 88, 45, 3) && coordsPlausible(sym, rom, 36, 45, 3));

  const anySettled = states().map(f => rig(`${CK}/${f}`)).find(r => r && !r.map.loadPending());
  if (!anySettled) {
    skipped("A4 settled states read as settled", "no checkpoints on disk");
  } else {
    const p = anySettled.pos();
    chk("A4 a settled state reads as settled and in bounds",
        !anySettled.map.loadPending() && coordsPlausible(sym, rom, p.map, p.x, p.y),
        `map${p.map} (${p.x},${p.y})`);
    // Synthetic torn state: same RAM, wCurMap alone moved to a differently
    // shaped map. This is the detector's own unit test and never skips.
    const other = p.map === 88 ? 36 : 88;
    anySettled.emu.mem()[sym.addr("wCurMap")] = other;
    chk("A5 SYNTHETIC torn state is detected", anySettled.map.loadPending(),
        `wCurMap:=${other} over map${p.map}'s loaded data`);
    anySettled.emu.mem()[sym.addr("wCurMap")] = p.map;
  }

  // ── B. the old gate is blind to it ─────────────────────────────────────
  const torn = findTornFixture();
  if (!torn) {
    skipped("B1-B3 torn-checkpoint properties", "no checkpoint on disk is mid-map-load (corpus rotated)");
  } else {
    const p = torn.r.pos();
    chk("B1 a torn checkpoint exists and is detected", true,
        `${torn.path}: map${p.map} (${p.x},${p.y})`);
    chk("B2 Sync.busy() reads IDLE inside the window (why settle() was not enough)",
        !torn.r.sync.busy(), JSON.stringify(torn.r.sync.debug()));
    chk("B3 its reported position is impossible for the map it claims",
        !coordsPlausible(sym, rom, p.map, p.x, p.y));
    const settled = await torn.r.nav.awaitMapSettled();
    chk("B4 awaitMapSettled() lands it on a real tile",
        !!settled && coordsPlausible(sym, rom, settled.map, settled.x, settled.y) &&
        !torn.r.map.loadPending(),
        settled ? `-> map${settled.map} (${settled.x},${settled.y})` : "never settled");
  }

  // ── C. HONESTY: no nav result reports an impossible position ───────────
  const door = findDoorFixture();
  if (!door) {
    skipped("C1-C4 enterWarp honesty", "no settled checkpoint stands beside a shape-changing warp");
  } else {
    const p0 = door.r.pos();
    armRepel(door.r.emu);
    const res = await door.r.nav.enterWarp(door.w);
    const p1 = door.r.pos();
    chk("C1 enterWarp still fires", res === "warped" && p1.map !== p0.map,
        `${door.path}: map${p0.map} (${p0.x},${p0.y}) -> '${res}' map${p1.map} (${p1.x},${p1.y})`);
    // THE wq#699 ASSERT. Pre-fix this is map88 (45,3): the interior map id
    // carrying the outdoor door's coordinates, reported to the brain as exact.
    chk("C2 the reported position is one the reported map can hold",
        coordsPlausible(sym, rom, p1.map, p1.x, p1.y),
        `map${p1.map} (${p1.x},${p1.y}) vs header ${JSON.stringify(romMapHeader(sym, rom, p1.map))}`);
    chk("C3 no transition is left pending for the caller", !door.r.map.loadPending());
    // The MapModel astar plans on must describe the map the player is ON: a
    // stale warp table is what lets a path be routed through a real door.
    const h = romMapHeader(sym, rom, p1.map);
    chk("C4 the map model describes the ARRIVED map",
        !!h && door.r.map.gw === h.width * 2 && door.r.map.gh === h.height * 2,
        `model ${door.r.map.gw}x${door.r.map.gh}, header ${h ? h.width * 2 : "?"}x${h ? h.height * 2 : "?"}`);
  }

  // ── D. wq#700: a journey must not inherit someone else's transition ────
  // HONEST SCOPE: this leg is a regression guard, not the leg that goes red.
  // With the fix disabled a goto from a torn state still reaches the right
  // tile, because its per-replan map.build() picks up the finished load and it
  // re-plans out of the lie. What it cannot recover is the REPORTED position
  // (leg C2) — and that is where wq#700's observable comes from: the brain's
  // "at map36 (45,4)" baseline for T6 was a torn read from T5, so a genuine
  // warp back out of the door reads as "asked for two tiles south, ended
  // exactly where it started, class warped". Ticket option (a) — a warp astar
  // failed to model — is RULED OUT: map36's warp list is exactly [(45,3)->88]
  // and astar refuses non-target warp tiles. The only way a path crosses a
  // real door is planning on the DEPARTED map's warp table, which is the state
  // leg C4 catches (model 60x18 while standing on an 8x8 map).
  if (!torn) {
    skipped("D1-D3 pending-transition absorption", "no torn checkpoint to start a journey from");
  } else {
    // Where that torn state actually resumes to, measured WITHOUT the code
    // under test: run frames until the loaded header matches wCurMap, which is
    // the invariant itself. Deriving `truth` from awaitMapSettled() would make
    // this leg degenerate whenever awaitMapSettled() is the thing that broke.
    const oracle = rig(`${CK}/${torn.path}`);
    let truth: { map: number; x: number; y: number } | null = null;
    if (oracle) {
      for (let i = 0; i < 600 && oracle.map.loadPending(); i += 4) await oracle.emu.framesAsync(4);
      await oracle.sync.settle();
      if (!oracle.map.loadPending()) truth = oracle.pos();
    }
    const fresh = rig(`${CK}/${torn.path}`);
    if (!truth || !fresh) {
      skipped("D1-D3 pending-transition absorption", "torn fixture would not settle");
    } else {
      armRepel(fresh.emu);
      const r = await fresh.nav.goto(truth.x, truth.y);
      const p = fresh.pos();
      // Pre-fix the journey plans against the DEPARTED map's geometry from a
      // position on it, and the arriving map is nowhere in the plan.
      chk("D1 a goto begun mid-transition ends on the real tile",
          r === "arrived" && p.map === truth.map && p.x === truth.x && p.y === truth.y,
          `'${r}' at map${p.map} (${p.x},${p.y}), truth map${truth.map} (${truth.x},${truth.y})`);
      chk("D2 it does NOT report the absorbed transition as its own 'warped'",
          r !== "warped", `got '${r}'`);
      chk("D3 it leaves nothing pending", !fresh.map.loadPending());
    }
  }

  // ── E. resume scoring never ranks an impossible position ───────────────
  const files = states();
  if (!files.length) {
    skipped("E1 resume scoring plausibility", "no checkpoints on disk");
  } else {
    const bad: string[] = [];
    for (const f of files) {
      const pr = readProgress(`${CK}/${f}`, sym, ROM);
      if (pr.rank === -2) continue;                       // unreadable, scored last already
      if (!coordsPlausible(sym, rom, pr.map, pr.x, pr.y)) bad.push(`${f}=map${pr.map}(${pr.x},${pr.y})`);
    }
    chk("E1 every scored checkpoint has a position its map can hold", bad.length === 0,
        bad.length ? bad.join(" ") : `${files.length} checkpoints`);
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
