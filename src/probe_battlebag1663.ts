// wq#1663 — battle bag driver: opens on page 1 of a long list, and reaches
// items past the first page. Regression cover for two chained defects found
// live on map35 (Route 24/25) with a 7-item bag (TM34/DOME FOSSIL/ANTIDOTE/
// NUGGET/TM45/ETHER/REPEL ahead of POKe BALL):
//   (1) the "did the bag open" verify OR'd screen-text checks for CANCEL/
//       BALL/"a quantity" - none of which is guaranteed on page 1 of a long
//       list, and the quantity regex (/x\d/) couldn't match Gen 1's
//       right-justified single-digit count ("x 1", not "x1") at all. This
//       produced a PERMANENT false "didn't open" (the live symptom: 1200x in
//       one run, agent stuck in every wild battle on the map35 grass strip).
//   (2) once (1) is fixed, selecting an item PAST the first page failed too:
//       moveCur(idx) compared the page-relative row (wCurrentMenuItem) to an
//       ABSOLUTE bag index and could never scroll far enough.
// Both are fixed in Items (structural cursor-quadrant check + shared
// moveToBagIndex). This probe drives the REAL useInBattle(POKE_BALL) path
// end to end and requires an actual throw outcome (caught / broke free /
// battle ended) - not just "didn't error" - so a regression in either class
// fails loud.
//
// DETERMINISM NOTE: reaching a live battle MENU needs the ROM's own
// battle-entry code to run (tilemap/cursor state isn't something you can
// poke into RAM and expect rendered correctly), so like probe_catch559 and
// probe_battle587 this probe forces a REAL wild encounter and is
// RNG-dependent (skip-capable). Excluded from probes-main.sh for the same
// reason those two are - see the exclusion comment there. Run manually
// around battle/item work: npx tsx src/probe_battlebag1663.ts
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { EventBus } from "./events";
import { Navigator } from "./nav";
import { Screen } from "./screen";
import { Dialog } from "./dialog";
import { Battle } from "./battle";
import { Items, ITEM, ITEM_NAME } from "./items";
import { readdirSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(ROM);
const CK = `${BASE}/checkpoints`;
const ROUTE_MAPS = new Set([35]);   // Route 24/25 - the map35 grass strip

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

interface Rig {
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader; items: Items;
  bat: Battle; pos: () => { map: number; x: number; y: number }; r: (s: string) => number;
}
function rig(statePath: string): Rig | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, statePath); } catch { return null; }
  const map = new MapModel(emu, sym, rom); map.build();
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp1663-")), "probe1663");
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const items = new Items(emu, sym, scr, sync, dlg, nav, map, bat, bus);
  const rd = new StateReader(emu, sym);
  const r = (s: string) => emu.mem()[sym.addr(s)];
  const pos = () => {
    const m = emu.mem();
    return { map: m[sym.addr("wCurMap")], x: m[sym.addr("wXCoord")], y: m[sym.addr("wYCoord")] };
  };
  return { emu, map, nav, rd, items, bat, pos, r };
}

function findFixture(): { path: string; r: Rig } | null {
  for (const f of readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort()) {
    const r = rig(`${CK}/${f}`);
    if (!r) continue;
    const p = r.pos();
    if (!ROUTE_MAPS.has(p.map)) continue;
    if (r.map.warps.some((w: Warp) => w.x === p.x && w.y === p.y)) continue;
    const st = r.rd.read();
    if (st.inBattle !== 0 || st.partyCount < 1) continue;
    return { path: f, r };
  }
  return null;
}

/** Append N filler items then a POKE_BALL stack, so POKe BALL always lands
 *  at an index deep enough to require scrolling past page 1 - the exact
 *  shape of the live regression (TM34/DOME FOSSIL/ANTIDOTE/NUGGET/TM45/
 *  ETHER/REPEL ahead of it) - regardless of whatever the fixture's own bag
 *  happens to hold. */
function stackDeepBall(r: Rig, fillerId: number, fillerCount: number, ballQty: number) {
  const m = r.emu.mem();
  const a = sym.addr("wBagItems");
  let n = m[sym.addr("wNumBagItems")];
  for (let i = 0; i < fillerCount; i++) {
    m[a + n * 2] = fillerId; m[a + n * 2 + 1] = 1; n++;
  }
  m[a + n * 2] = ITEM.POKE_BALL; m[a + n * 2 + 1] = ballQty; n++;
  m[a + n * 2] = 0xff;
  m[sym.addr("wNumBagItems")] = n;
  return n - 1;   // POKe BALL's absolute bag index
}

async function forceEncounter(r: Rig): Promise<boolean> {
  const p0 = r.pos();
  const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const cands = dirs.filter(([dx, dy]) => {
    const nx = p0.x + dx, ny = p0.y + dy;
    return (r.map as any).passableFrom?.(p0.x, p0.y, nx, ny) &&
      (r.map as any).passableFrom?.(nx, ny, p0.x, p0.y) &&
      !r.map.warps.some((w: Warp) => w.x === nx && w.y === ny);
  });
  for (const [dx, dy] of cands) {
    const nb = { x: p0.x + dx, y: p0.y + dy };
    for (let i = 0; i < 80; i++) {
      const here = r.pos();
      if (here.x === p0.x && here.y === p0.y) await r.nav.step(dx, dy);
      else if (here.x === nb.x && here.y === nb.y) await r.nav.step(-dx, -dy);
      else break;
      if (r.rd.read().inBattle === 1) return true;
    }
    const here = r.pos();
    if (here.x === nb.x && here.y === nb.y) await r.nav.step(-dx, -dy);
    if (r.rd.read().inBattle === 1) return true;
  }
  return false;
}

(async () => {
  console.log("== probe_battlebag1663: bag opens + selects past page 1 in a real wild battle ==");
  const fx = findFixture();
  if (!fx) {
    chk("A1 map35 fixture (off-warp, out of battle) resolves", false, "none on disk");
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(1);
  }
  const { path, r } = fx;
  chk("A1 map35 fixture (off-warp, out of battle) resolves", true,
      `${path}: (${r.pos().x},${r.pos().y})`);

  const idx = stackDeepBall(r, ITEM.ANTIDOTE, 6, 3);
  chk("A2 POKe BALL forced to a deep, must-scroll bag index", idx >= 6, `idx=${idx}`);
  chk("A3 production reader agrees on the stack", r.items.has(ITEM.POKE_BALL) === 3,
      `has=${r.items.has(ITEM.POKE_BALL)}`);

  if (!await forceEncounter(r)) {
    skipped("B wild encounter on map35", "no encounter across pair-safe neighbours - rerun");
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(fail ? 1 : 0);
  }
  const w = await r.bat.waitForMenu?.();
  chk("B battle reaches the main menu", w === "menu", String(w));
  if (w !== "menu") {
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(fail ? 1 : 0);
  }

  const party0 = r.r("wPartyCount");
  const before = r.items.has(ITEM.POKE_BALL);
  const res = await r.items.useInBattle(ITEM.POKE_BALL);
  const openedAndSelected = !res.includes("didn't open") && !res.includes("not at menu") &&
                             !res.includes("cursor lost") && !res.includes("unverified");
  chk("C bag opened + POKe BALL selected past page 1 (not the old false negatives)",
      openedAndSelected, res);
  chk("C a ball was actually consumed (real throw happened)",
      r.items.has(ITEM.POKE_BALL) === before - 1, `${before} -> ${r.items.has(ITEM.POKE_BALL)} :: ${res}`);
  const realOutcome = /caught it with|broke free|battle ended, not caught/.test(res);
  chk("C outcome is a genuine catch-path result, not an error string", realOutcome, res);

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
