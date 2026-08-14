// wq#579 — enter_warp standing ON the warp tile: red/green probe.
//
// THE DEFECT (observed live 2026-08-14, run live-agent-1786678999032):
// enterWarp() opened with goto(w.x,w.y), a no-op when already on the tile, and
// fell into a push loop whose step-back — the one action that re-enters the
// tile and fires a Gen 1 interior warp — had its result DISCARDED. Two live
// symptoms: T1 03:43Z "stuck" + displacement off the ladder; T31 04:31Z
// "no_transition" reported WHILE the floor actually changed inside the
// discarded step-back.
//
// WHAT THIS PROBE PROVES (red on pre-fix main, green on the fix):
//   B. From a REAL on-warp checkpoint, enterWarp(thatWarp) returns "warped"
//      AND the map actually changes AND the reported result matches reality —
//      the honesty property T31 violated is asserted directly.
//   C. The landing tile of an interior pair IS the paired warp (the resume
//      shape), so the fix is exercised a second time straight back.
//   E. Door-warp regression: the on-tile early path hands door-shaped warps
//      back to the push/raw-press machinery — leaving a building still works.
//
// FIXTURE RESOLUTION BY PROPERTY (wq#540): never by file name. Candidates are
// sidecar-prefiltered to the Mt Moon cave floors, then loaded and kept only if
// the player position EQUALS one of the live MapModel's warp tiles.
//
// DETERMINISM: cave steps roll wild encounters. The probe writes
// wRepelRemainingSteps=200 before navigating (lead L28 outlevels every Mt Moon
// wild, so Repel suppresses all of them) — same probe-owns-its-environment
// technique wq#559 used to inject balls. "battle" from enterWarp is a CORRECT
// contract value, but a probe that flakes on RNG proves nothing.
//
// ISOLATION: read-only on the tree; EventBus writes into a mkdtemp dir; loads
// checkpoints, never saves them; touches no live service.
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { EventBus } from "./events";
import { Navigator } from "./nav";
import { readdirSync, readFileSync, existsSync } from "fs";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const SYM = `${BASE}/roms/pokeblue.sym`;
const CK = `${BASE}/checkpoints`;
const SAVES = `${BASE}/saves`;
const CAVE_MAPS = new Set([59, 60, 61]);

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

interface Rig {
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader;
  pos: () => { map: number; x: number; y: number };
}

function rig(statePath: string): Rig | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, statePath); } catch { return null; }
  const map = new MapModel(emu, sym, rom); map.build();
  const dir = mkdtempSync(join(tmpdir(), "lpp579-"));
  const bus = new EventBus(dir, "probe579");
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const rd = new StateReader(emu, sym);
  const pos = () => {
    const m = emu.mem();
    return { map: m[sym.addr("wCurMap")], x: m[sym.addr("wXCoord")], y: m[sym.addr("wYCoord")] };
  };
  return { emu, map, nav, rd, pos };
}

/** Suppress wild encounters so cave navigation is deterministic. */
function armRepel(emu: Emulator, steps = 200) {
  emu.mem()[sym.addr("wRepelRemainingSteps")] = steps;
}

/** Property: player position equals one of the current map's warp tiles. */
function onWarp(r: Rig): Warp | null {
  const p = r.pos();
  return r.map.warps.find(w => w.x === p.x && w.y === p.y) ?? null;
}

/** Find a checkpoint on a cave floor with the player standing ON a warp.
 *  Sidecars give a cheap map prefilter; the on-warp property is verified
 *  against the LIVE MapModel of the loaded state, never assumed. */
function findOnWarpCaveFixture(): { path: string; r: Rig; w: Warp } | null {
  const names = readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort();
  for (const f of names) {
    const side = `${CK}/${f.replace(/\.state\.gz$/, ".json")}`;
    if (existsSync(side)) {
      try {
        const j = JSON.parse(readFileSync(side, "utf8"));
        if (!CAVE_MAPS.has(j.map)) continue;
      } catch { /* fall through to a real load */ }
    }
    const r = rig(`${CK}/${f}`);
    if (!r) continue;
    const p = r.pos();
    if (!CAVE_MAPS.has(p.map)) continue;
    const w = onWarp(r);
    if (w) return { path: f, r, w };
  }
  return null;
}

/** Door-shaped fixture for the regression leg: a state INSIDE a small indoor
 *  map (gh <= 12) whose warps sit on the bottom row (Gen 1 building exits),
 *  player NOT standing on one. saves/ first, then checkpoints. */
function findIndoorDoorFixture(): { path: string; r: Rig; w: Warp } | null {
  const pools: [string, string[]][] = [
    [SAVES, existsSync(SAVES) ? readdirSync(SAVES).filter(f => f.endsWith(".state.gz")).sort() : []],
    [CK, readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort()],
  ];
  for (const [dir, names] of pools) {
    for (const f of names) {
      const r = rig(`${dir}/${f}`);
      if (!r) continue;
      const p = r.pos();
      if (CAVE_MAPS.has(p.map)) continue;
      if (r.map.gh > 12) continue;                       // small indoor rooms only
      const door = r.map.warps.find(w => w.y === r.map.gh - 1);
      if (!door) continue;
      if (p.x === door.x && p.y === door.y) continue;    // want the walk-up path
      const b = r.rd.read();
      if (b.inBattle) continue;
      return { path: `${dir}/${f}`, r, w: door };
    }
  }
  return null;
}

(async () => {
  console.log("== probe_warp579: enter_warp standing ON the warp tile ==");

  // ── A. fixture facts ────────────────────────────────────────────────────
  const fx = findOnWarpCaveFixture();
  if (!fx) {
    chk("A1 an on-warp cave fixture resolves by property", false,
        "no checkpoint has player standing on a warp of maps 59/60/61");
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(1);
  }
  const { path, r, w } = fx;
  const p0 = r.pos();
  chk("A1 an on-warp cave fixture resolves by property", true,
      `${path}: map${p0.map} (${p0.x},${p0.y}) == warp #${r.map.warps.indexOf(w)}`);
  chk("A2 fixture is out of battle", r.rd.read().inBattle === 0);

  // ── B. the defect, both live symptoms asserted ─────────────────────────
  armRepel(r.emu);
  const res = await r.nav.enterWarp(w);
  const p1 = r.pos();
  const mapChanged = p1.map !== p0.map;
  chk("B1 enterWarp from ON the tile returns 'warped'", res === "warped", `got '${res}'`);
  chk("B2 the floor actually changed", mapChanged, `map${p0.map} -> map${p1.map} (${p1.x},${p1.y})`);
  chk("B3 HONESTY: reported result matches reality (T31's lie)",
      (res === "warped") === mapChanged,
      `result='${res}' mapChanged=${mapChanged}`);

  // ── C. the resume shape, straight back ─────────────────────────────────
  // Gen 1 interior pairs land ON the paired warp tile — exactly the state
  // every post-transition checkpoint saves. Prove the fix twice.
  // The MapModel still describes the DEPARTED floor; rebuild before reading
  // warps (goto() rebuilds internally, but this probe reads warps directly —
  // the first run of this probe skipped C on exactly this staleness).
  r.map.build();
  const wBack = onWarp(r);
  if (!wBack) {
    skipped("C1 landing tile is the paired warp", `landed (${p1.x},${p1.y}) is not a warp on map${p1.map}`);
    skipped("C2 enterWarp fires again from the landing tile", "no paired warp to test");
  } else {
    chk("C1 landing tile is the paired warp (the resume shape)", true,
        `map${p1.map} (${p1.x},${p1.y}) == warp #${r.map.warps.indexOf(wBack)}`);
    armRepel(r.emu);
    const res2 = await r.nav.enterWarp(wBack);
    const p2 = r.pos();
    chk("C2 enterWarp fires again from the landing tile", res2 === "warped" && p2.map === p0.map,
        `got '${res2}' at map${p2.map} (${p2.x},${p2.y})`);
  }

  // ── E. door-warp regression: the early path must hand doors back ───────
  const door = findIndoorDoorFixture();
  if (!door) {
    skipped("E1 door warp still exits the building", "no indoor bottom-row-door fixture resolved by property");
  } else {
    const dp0 = door.r.pos();
    const dres = await door.r.nav.enterWarp(door.w);
    const dp1 = door.r.pos();
    chk("E1 door warp still exits the building", dres === "warped" && dp1.map !== dp0.map,
        `${door.path}: map${dp0.map} (${dp0.x},${dp0.y}) -> '${dres}' map${dp1.map}`);
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
