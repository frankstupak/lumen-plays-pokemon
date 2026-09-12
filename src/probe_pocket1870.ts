// wq#1870 acceptance: Cerulean City is really cut in two, and the state block
// now says something the brain can act on.
//
// WHAT THE LIVE AGENT DID (2026-09-12 15:29-16:44Z, 26 of 132 turns): it stood
// in map3 at (25,26)/(25,27)/(30,20), its ROUTE line said "NEXT LEG:
// leave_edge(S) into Route 5", and every goto came back with reach.ts's
// "closed-off part of this map. Reachable warps: ... Use enter_warp to leave,
// not goto". It obeyed: the last 16 entries of warp_history are map3 alternating
// with the Mart (67) and the Pokecenter (64), each door returning it to the
// tile it left. leave_edge(S) answered a bare "stuck".
//
// WHAT IS ACTUALLY TRUE, measured here:
//   - the split is REAL ROM collision data, not a map.ts artefact. Section C
//     re-derives it from the grid; section B drives the EMULATOR into the seam
//     and the engine refuses. (The investigation swept all 86 candidate
//     crossings out of the player's region — every one refused; this probe
//     spot-checks three so the suite stays quick.)
//   - the player's region owns the NORTH and WEST edges and NOT the south or
//     east ones, so leave_edge(S) could never have worked from there.
//   - the only link to the region holding the Route 5 / Route 9 edges is the
//     Cerulean Trashed House: warp 0 at (27,11) in, warp 7 at (27,9) out. It is
//     unreachable because object 11 (a STAY sprite, toggle flag 9) stands on
//     (27,12), the door's only approach cell. Section E shows the crossing
//     appearing the moment that object is flagged hidden — SYNTHETIC, and said
//     so out loud, exactly as probe_pocket534 §D handles its unreachable case.
//   - and a second, independent defect found on the way: map.ts counted
//     DESPAWNED objects as obstacles. Section B is the red/green for that.
//
// Usage: npx tsx src/probe_pocket1870.ts
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { Navigator, astar, reachableCells } from "./nav";
import { EventBus } from "./events";
import { Sync } from "./sync";
import { hiddenObjectSlots, toggleableGlobalIds } from "./objects";
import { warpViews, renderWarps, stuckHint, edgeStuckHint, reachableEdges } from "./reach";
import { findFixture, requireFixture } from "./fixtures";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CERULEAN = 3;

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

/** The ROM's own object table for a map, decoded the way pokered lays it out:
 *  border, warps, signs, then objects (pic, y+4, x+4, movement, range, text),
 *  with two extra bytes for a trainer (text bit 6) and one for an item (bit 7). */
function romObjects(symbolName: string) {
  const o = sym.sym(symbolName);
  let p = o.addr;
  const b = () => rom.byte(o.bank, p++);
  b();                                            // border block
  const nw = b(); for (let i = 0; i < nw; i++) { b(); b(); b(); b(); }
  const ns = b(); for (let i = 0; i < ns; i++) { b(); b(); b(); }
  const no = b();
  const out: { i: number; pic: number; x: number; y: number; stay: boolean }[] = [];
  for (let i = 1; i <= no; i++) {
    const pic = b(), y = b() - 4, x = b() - 4, mv = b(); b(); const txt = b();
    if (txt & 0x40) { b(); b(); } else if (txt & 0x80) b();
    out.push({ i, pic, x, y, stay: mv === 0xff });
  }
  return out;
}

(async () => {
  const path = findFixture(sc => sc.map === CERULEAN);
  requireFixture("a checkpoint standing in Cerulean City (map3)", path);
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, path!);
  const st = new StateReader(emu, sym).read();
  const mm = new MapModel(emu, sym, rom); mm.build();
  const mem = emu.mem();
  console.log(`fixture ${path!.split("/").pop()} at (${st.x},${st.y}) on map${st.map}\n`);

  // ---------------------------------------------- A: the object table lines up
  console.log("=== A. Sprite slot i IS object i, and the hidden set is decodable ===");
  const objs = romObjects("CeruleanCity_Object");
  const d1 = sym.addr("wSpriteStateData1"), d2 = sym.addr("wSpriteStateData2");
  const slotMismatch = objs.filter(o =>
    mem[d1 + o.i * 16] !== o.pic ||
    mem[d2 + o.i * 16 + 4] - 4 !== o.y || mem[d2 + o.i * 16 + 5] - 4 !== o.x);
  chk("A1 every ROM object sits in the sprite slot of its own index",
    objs.length > 0 && slotMismatch.length === 0,
    `${objs.length} objects, ${slotMismatch.length} mismatched`);
  const hidden = hiddenObjectSlots(mem, sym);
  chk("A2 the toggleable list names objects and some of them are flagged hidden",
    toggleableGlobalIds(mem, sym).size > 0 && hidden.size > 0,
    `toggleable=${[...toggleableGlobalIds(mem, sym).keys()].join(",")} hidden=${[...hidden].join(",")}`);
  chk("A3 map.sprites excludes every hidden object",
    ![...hidden].some(i => mm.sprites.some(s => s.x === objs[i - 1].x && s.y === objs[i - 1].y)),
    `sprites=${mm.sprites.length} of ${objs.length} objects`);

  // ------------------------------------- B: the ENGINE decides, in the sandbox
  console.log("\n=== B. Engine ground truth: hidden objects do not block, shown ones do ===");
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp1870-")), "probe1870");
  const nav = new Navigator(emu, sym, mm, bus, new Sync(emu, sym));
  /** Stand on `from` and push toward the adjacent cell; did the player move? */
  const push = async (from: [number, number], dx: number, dy: number) => {
    const g = await nav.goto(from[0], from[1]);
    if (g !== "arrived") return { ok: false, why: `goto ${g}` };
    for (let i = 0; i < 2; i++) {
      const r = await nav.step(dx, dy);
      if (r !== "blocked") return { ok: true, why: `${r} -> (${nav.pos().x},${nav.pos().y})` };
    }
    return { ok: false, why: "blocked" };
  };
  const hiddenCells = objs.filter(o => hidden.has(o.i));
  const shownBlocker = objs.find(o => o.i === 11);
  const h1 = hiddenCells[0];
  const rh = await push([h1.x, h1.y + 1], 0, -1);
  chk(`B1 the engine walks ONTO (${h1.x},${h1.y}) — object ${h1.i}, flagged hidden`, rh.ok, rh.why);
  chk("B2 ...and the model agrees: that cell is passable now", mm.passable(h1.x, h1.y),
    `grid=${mm.grid[h1.y][h1.x]} sprite=${mm.sprites.some(s => s.x === h1.x && s.y === h1.y)}`);
  const rs = await push([shownBlocker!.x, shownBlocker!.y + 1], 0, -1);
  chk(`B3 control: (${shownBlocker!.x},${shownBlocker!.y}) — object 11, flagged SHOWN — refuses every push`,
    !rs.ok && rs.why === "blocked", rs.why);
  chk("B4 ...and the model agrees: still an obstacle", !mm.passable(shownBlocker!.x, shownBlocker!.y));

  // ------------------------------------------- C: the split is in the collision data
  console.log("\n=== C. map3 really is two regions, and the player's has no S or E edge ===");
  const stuckAt = { x: 25, y: 26 };            // where the live agent burned the turns
  const mine = reachableCells(mm, stuckAt.x, stuckAt.y);
  chk("C1 the live stuck position is walkable and is the region under test",
    mine.has(`${stuckAt.x},${stuckAt.y}`) && mine.size > 100, `region=${mine.size} cells`);
  const edges = reachableEdges(mm, stuckAt.x, stuckAt.y);
  chk("C2 reachableEdges from there is exactly N,W — the ROUTE line's S is not on it",
    edges.join(",") === "N,W", `edges=[${edges.join(",")}]`);
  const southOpenings = Array.from({ length: mm.gw }, (_, x) => x).filter(x => mm.grid[mm.gh - 1][x]);
  chk("C3 the south edge HAS walkable openings — they are simply in the other region",
    southOpenings.length > 0 && !southOpenings.some(x => mine.has(`${x},${mm.gh - 1}`)),
    `${southOpenings.length} openings, none reachable`);
  // physical spot-check of the seam: the fence gap at (16,28)/(17,28) and the
  // east wall at (34,20) are the three most tempting crossings on the map.
  for (const [c, d] of [[[16, 28], [0, 1]], [[17, 28], [0, 1]], [[34, 20], [1, 0]]] as const) {
    const r = await push([c[0], c[1]], d[0], d[1]);
    chk(`C4 the engine refuses (${c[0]},${c[1]}) push(${d[0]},${d[1]}) — seam, not a modelling artefact`,
      !r.ok && r.why === "blocked", r.why);
  }

  // ------------------------------------------------- D: what the brain is told
  console.log("\n=== D. The replies name exits that exist ===");
  await nav.goto(stuckAt.x, stuckAt.y);
  const views = warpViews(mm, stuckAt.x, stuckAt.y, 0, () => null);
  const hint = stuckHint(mm, stuckAt.x, stuckAt.y, 20, 34, views, null, CERULEAN);
  console.log(`  goto hint: ${hint.trim()}`);
  chk("D1 the goto refusal no longer tells the brain to take a door",
    !/Use enter_warp to leave/.test(hint), hint.slice(0, 60));
  chk("D2 it names the edges that work", /leave_edge\(N\)/.test(hint) && /leave_edge\(W\)/.test(hint));
  chk("D3 it names Route 24 / Route 4 from the ROM travel graph",
    /Route 24/.test(hint) && /Route 4/.test(hint));
  chk("D4 it says the shops have no second door onto this map", /no second door/.test(hint));
  // The Badge House IS a second region — and a fenced yard. The live agent went
  // through it twice; the hint has to say that rather than offer it as the exit.
  chk("D5 the Badge House crossing is called a dead end, not a way across",
    !/The way across/.test(hint) && /closed off in turn/.test(hint), hint.slice(-120).trim());
  const eh = edgeStuckHint(mm, stuckAt.x, stuckAt.y, "S", views, CERULEAN);
  console.log(`  leave_edge(S) hint: ${eh.trim()}`);
  chk("D6 leave_edge(S) explains itself instead of a bare stuck",
    /no opening on the S edge is reachable/.test(eh) && /leave_edge\(N\)/.test(eh));
  chk("D7 the WARPS line marks the yard door closed and offers no crossing",
    renderWarps(views).includes("CLOSED OFF") && !renderWarps(views).includes("CROSSES"),
    renderWarps(views).split("  ").find(s => s.includes("CLOSED OFF")) ?? "");
  // A wall tile inside the player's OWN region is pathless for a mundane reason;
  // claiming a split there would be a confident lie.
  const wall = stuckHint(mm, stuckAt.x, stuckAt.y, 13, 24, views, null, CERULEAN);
  chk("D8 a solid target is called solid, not a split", /marks it solid/.test(wall) && !/SPLIT/.test(wall),
    wall.slice(0, 70).trim());

  // --------------------------------------- E: the crossing, with the door open
  console.log("\n=== E. SYNTHETIC (object 11 flagged hidden): the pass-through appears ===");
  const fa = sym.addr("wToggleableObjectFlags");
  const gid = toggleableGlobalIds(mem, sym).get(11)!;
  mem[fa + (gid >> 3)] |= 1 << (gid & 7);
  mm.build();
  const v2 = warpViews(mm, stuckAt.x, stuckAt.y, 0, id => `map${id}`);
  const cross = v2.filter(v => v.otherSide?.opens);
  chk("E1 warp 0 (the trashed house) is now reachable and is the one crossing that opens",
    cross.length === 1 && cross[0].i === 0 && cross[0].otherSide!.x === 27 && cross[0].otherSide!.y === 9,
    v2.filter(v => v.otherSide).map(v =>
      `${v.i}->(${v.otherSide!.x},${v.otherSide!.y})${v.otherSide!.opens ? " opens" : " closed"}`).join(" ") || "none");
  chk("E2 the WARPS line shows it", renderWarps(v2).includes("CROSSES to (27,9)"));
  const hint2 = stuckHint(mm, stuckAt.x, stuckAt.y, 20, 34, v2, null, CERULEAN);
  chk("E3 the goto refusal now points at the warp that crosses, not at the shops",
    /The way across: enter_warp\(0\)/.test(hint2) && /leave_edge\(S\)/.test(hint2),
    hint2.slice(hint2.indexOf("The way across")).slice(0, 150).trim());
  const g0 = await nav.goto(27, 11);
  chk("E4 and the engine agrees: the door is walkable and warps into the house",
    g0 === "warped" && nav.pos().map === 62, `${g0} -> map${nav.pos().map}`);
  mm.build();
  const back = mm.warps.find(w => w.destWarp === 7);
  const g1 = back ? await nav.goto(back.x, back.y) : "no back door";
  chk("E5 the house's second door puts the player at map3 (27,9), inside the OTHER region",
    g1 === "warped" && nav.pos().map === CERULEAN && nav.pos().x === 27 && nav.pos().y === 9,
    `${g1} -> ${JSON.stringify(nav.pos())}`);
  mm.build();
  const p = nav.pos();
  const eAfter = reachableEdges(mm, p.x, p.y);
  chk("E6 from there the SOUTH edge (Route 5, the ROUTE line's next leg) is reachable",
    eAfter.includes("S"), `edges=[${eAfter.join(",")}]`);

  // ---------------------------------------------- F: ordinary paths unchanged
  console.log("\n=== F. Pin: the refactored successors() did not move ordinary navigation ===");
  const from = { x: 19, y: 18 };
  const sample: [number, number][] = [[25, 26], [30, 20], [21, 10], [20, 0], [16, 28], [20, 34], [27, 9]];
  const reach = reachableCells(mm, from.x, from.y);
  const disagree = sample.filter(([x, y]) =>
    (!!astar(mm, from.x, from.y, x, y, new Set())) !== reach.has(`${x},${y}`));
  chk("F1 astar and reachableCells agree on every sampled non-warp cell",
    disagree.length === 0, disagree.map(c => c.join(",")).join(" ") || "all agree");
  const pth = astar(mm, from.x, from.y, 25, 26, new Set());
  chk("F2 a planned path is still a chain of single steps and 2-cell hops",
    !!pth && pth.every((c, i) => {
      const prev = i === 0 ? from : pth[i - 1];
      const d = Math.abs(c.x - prev.x) + Math.abs(c.y - prev.y);
      return d === 1 || d === 2;
    }), pth ? `len=${pth.length}` : "NULL");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
