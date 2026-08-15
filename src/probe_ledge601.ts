// wq#601 acceptance: ledge hops exist in the nav model + executor, and the Mt
// Moon re-entry warp is refused in tooling while phase=CERULEAN_APPROACH.
//
// Sections A and D are REGRESSION PINS — they hold on both builds and prove
// nothing about this diff. Sections B, C and E are the discriminators: B runs
// the RED half in-probe by stripping mm.ledges (the pre-change model is
// exactly "this model with zero ledge entries"), C tests the refusal decision,
// E makes the sandbox sprite physically hop a ledge under the new executor —
// on the pre-change build E's goto returns no_path/stuck without moving.
//
// Usage: npx tsx src/probe_ledge601.ts   (sandbox emulator only; never the live service)
import { readdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { astar, Navigator } from "./nav";
import { EventBus } from "./events";
import { Sync } from "./sync";
import { mtMoonReentryRefusal } from "./agent";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CK = "/home/lumen/pokemon/checkpoints";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

function loadOn(wantMap: number): { file: string; emu: Emulator; x: number; y: number; mm: MapModel } | null {
  for (const f of readdirSync(CK).filter(n => n.endsWith(".state.gz"))) {
    const emu = new Emulator(ROM);
    try { loadSnapshotFile(emu, `${CK}/${f}`); } catch { continue; }
    const st = new StateReader(emu, sym).read();
    if (st.map !== wantMap) continue;
    const mm = new MapModel(emu, sym, rom); mm.build();
    return { file: f, emu, x: st.x, y: st.y, mm };
  }
  return null;
}

(async () => {
// ------------------------------------------------ A: model facts (regression pins)
console.log("\n=== A. LedgeTiles parsing + the overworld-only gate (pins) ===");
const r4 = loadOn(15);
chk("A0 a map15 checkpoint exists", !!r4, r4?.file ?? "none");
if (!r4) { process.exit(2); }
chk("A1 map15 is tileset 0 and parses 8 LedgeTiles entries", r4.mm.tilesetId === 0 && r4.mm.ledges.length === 8,
  `tileset=${r4.mm.tilesetId} ledges=${r4.mm.ledges.length}`);
chk("A2 entries carry down/left/right hops, never up",
  r4.mm.ledges.some(l => l.dy === 1) && r4.mm.ledges.some(l => l.dx === -1) &&
  r4.mm.ledges.some(l => l.dx === 1) && !r4.mm.ledges.some(l => l.dy === -1),
  JSON.stringify(r4.mm.ledges));
const cave = loadOn(60) ?? loadOn(61) ?? loadOn(59);
chk("A3 a Mt Moon map (non-overworld tileset) has ZERO ledge entries — HandleLedges' tileset gate",
  !!cave && cave.mm.tilesetId !== 0 && cave.mm.ledges.length === 0,
  cave ? `${cave.file} tileset=${cave.mm.tilesetId} ledges=${cave.mm.ledges.length}` : "no cave checkpoint");

// ------------------------------------------------ B: RED/GREEN reachability
console.log("\n=== B. Eastbound reachability comes exactly from the hop edges ===");
// the east-edge column of Route 4 (gw-1=89); rows 10/11 are the Cerulean-side path
const target = { x: r4.mm.gw - 1, y: 10 };
const green = astar(r4.mm, r4.x, r4.y, target.x, target.y, new Set());
chk(`B1 GREEN: astar (${r4.x},${r4.y}) -> (${target.x},${target.y}) finds a path with hops`,
  !!green, green ? `len=${green.length}` : "NULL");
const hopSeg = green?.find((c, i) => {
  const p = i === 0 ? { x: r4.x, y: r4.y } : green[i - 1];
  return Math.abs(c.x - p.x) + Math.abs(c.y - p.y) === 2;
});
chk("B2 the path contains a 2-cell hop segment", !!hopSeg, hopSeg ? `lands (${hopSeg.x},${hopSeg.y})` : "none");
const saved = r4.mm.ledges;
r4.mm.ledges = [];   // the pre-change model IS this model with no ledge entries
const red = astar(r4.mm, r4.x, r4.y, target.x, target.y, new Set());
chk("B3 RED: same astar with ledges stripped is NULL (pre-change behaviour)", red === null,
  red ? `unexpected len=${red.length}` : "NULL as expected");
r4.mm.ledges = saved;
// one-way: the DIRECTED property is a property of the EDGE, not of global
// topology — Route 4's midsection has a walkable gap at y=9 x=46..49 that
// legitimately reconnects the levels on foot (the game allows it too), so a
// whole-map "no return path" assertion is false in-game and would pin a lie.
// Assert the edge itself: hops from the ledge's north side land south, and
// the landing cell offers NO hop back up.
const upEdge = r4.mm.hops(70, 8);
const downEdge = r4.mm.hops(70, 10);
chk("B4 hops are DIRECTED: hops(70,8) lands (70,10); hops(70,10) never offers (70,8)",
  upEdge.some(h => h.x === 70 && h.y === 10) && !downEdge.some(h => h.x === 70 && h.y === 8),
  `hops(70,8)=${JSON.stringify(upEdge)} hops(70,10)=${JSON.stringify(downEdge)}`);

// ------------------------------------------------ C: re-entry refusal decision
console.log("\n=== C. mtMoonReentryRefusal — the wq#532 'make it bite' half ===");
const wMoon = r4.mm.warps.find(w => w.x === 24 && w.y === 5)!;
const wPc = r4.mm.warps.find(w => w.x === 11 && w.y === 5)!;
chk("C0 map15's (24,5) warp really leads into Mt Moon; (11,5) really is the Pokecenter",
  !!wMoon && [59, 60, 61].includes(wMoon.destMap) && !!wPc && ![59, 60, 61].includes(wPc.destMap),
  `24,5->map${wMoon?.destMap} 11,5->map${wPc?.destMap}`);
const ref = mtMoonReentryRefusal(true, "CERULEAN_APPROACH", wMoon);
chk("C1 CERULEAN_APPROACH + (24,5): refused, reason names Mt Moon and the eastward rule",
  !!ref && ref.includes("Mt Moon") && ref.includes("EAST"), ref ?? "null");
chk("C2 MT_MOON_TRANSIT + (24,5): allowed (westbound recovery keeps every warp)",
  mtMoonReentryRefusal(true, "MT_MOON_TRANSIT", wMoon) === null);
chk("C3 CERULEAN_APPROACH + Pokecenter (11,5): allowed (only Mt Moon dests are refused)",
  mtMoonReentryRefusal(true, "CERULEAN_APPROACH", wPc) === null);
chk("C4 CERULEAN_APPROACH + non-warp target: allowed (undefined warp)",
  mtMoonReentryRefusal(true, "CERULEAN_APPROACH", undefined) === null);
chk("C5 off map15: allowed regardless", mtMoonReentryRefusal(false, "CERULEAN_APPROACH", wMoon) === null);

// ------------------------------------------------ D: plain walking unchanged (pin)
console.log("\n=== D. Ordinary walking is untouched (pin, green on both builds) ===");
const near = astar(r4.mm, r4.x, r4.y, Math.min(r4.x + 5, 43), r4.y, new Set());
chk("D1 a same-component walk still paths without any hop", !!near &&
  near.every((c, i) => { const p = i === 0 ? { x: r4.x, y: r4.y } : near[i - 1];
                         return Math.abs(c.x - p.x) + Math.abs(c.y - p.y) === 1; }),
  near ? `len=${near.length}` : "NULL");

// ------------------------------------------------ E: the sprite actually hops (sandbox)
console.log("\n=== E. Executor: a scripted goto crosses the ledge in the sandbox emulator ===");
const emu = r4.emu;
emu.mem()[sym.addr("wGrassRate")] = 0;   // sandbox only: no wild encounters mid-journey
const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp601-")), "probe601");
const sync = new Sync(emu, sym);
const mm = new MapModel(emu, sym, rom); mm.build();
const nav = new Navigator(emu, sym, mm, bus, sync);
const st0 = new StateReader(emu, sym).read();
console.log(`  start (${st0.x},${st0.y}) sprites=${JSON.stringify(mm.sprites)}`);
const g1 = await nav.goto(70, 10);
const p1 = nav.pos();
chk("E1 goto(70,10) from the west component ARRIVES — the hop physically happened",
  g1 === "arrived" && p1.x === 70 && p1.y === 10, `result=${g1} now=(${p1.x},${p1.y}) map=${p1.map}`);
chk("E2 the player is in the EAST component now: continuing east paths on foot",
  !!astar(mm, p1.x, p1.y, 88, 10, new Set()), "astar (70,10)->(88,10)");
const g2 = await nav.goto(88, 10);
const p2 = nav.pos();
chk("E3 goto(88,10) arrives — x=88 is 9 cells past the old x=79 frontier",
  g2 === "arrived" && p2.x === 88 && p2.y === 10, `result=${g2} now=(${p2.x},${p2.y})`);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
