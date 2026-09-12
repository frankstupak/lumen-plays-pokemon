// wq#1849 probe. Sections A-F are PURE (no ROM, no emulator, no network) and
// run in CI; section G re-derives the committed graph from the ROM and is
// skipped where the ROM is not present (scripts/probes-pure.sh).
//
// D2 is the load-bearing case, and it is the ticket: standing on Route 24 with
// two badges, the harness must say SOUTH. The live run knew "GOAL: Gym #3,
// Vermilion" for days on that map and never took the south edge.
const TAG = `${process.pid}-${Date.now()}`;
process.env.LPP_OVERRIDE_LOG = `/tmp/route1849-${TAG}.jsonl`;

import { existsSync, readFileSync, unlinkSync } from "fs";
import {
  EDGE_GATES, GYM_MAPS, capsFromBadges, goalMap, legAction, legAim, mapLabel, routeBlock, routeTo,
  type Capability,
} from "./route";
import { ROUTE_EDGES, ROUTE_NODES } from "./route_graph";
import {
  ExplorationOverride, GYMS, planEscape, progressBlock, overrideLogFile,
  type ExploreCfg, type GridLike,
} from "./explore";
import type { ProgressSample } from "./novelty";
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import { GameNames } from "./names";
import { readMaps, buildGraph } from "../tools/dump_route_graph";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const CFG: ExploreCfg = {
  enabled: true, prompt: true, windowTurns: 150, minTiles: 5, stepsK: 30,
  clearance: 3, expireFactor: 3, urgencyTurns: 60, catchParty: 3,
  patchShare: 0.5, patchRadius: 5, patchNew: 0, excludeTurns: 60, verdictTurns: 150,
};

const ROUTE_24 = 35, CERULEAN = 3, ROUTE_5 = 16, ROUTE_6 = 17, VERMILION = 5;
const SAFFRON = 10, UP_ROUTE_5 = 71, CERULEAN_MART = 67;
const TWO_BADGES = 0b11;

// ------------------------------------------------------------ A. the graph
console.log("=== A. the travel graph ===");
{
  const ids = Object.keys(ROUTE_NODES).map(Number);
  chk("A1 every edge endpoint is a node",
    ROUTE_EDGES.every(e => e.from in ROUTE_NODES && e.to in ROUTE_NODES));
  chk("A2 no self edges", ROUTE_EDGES.every(e => e.from !== e.to));
  chk("A3 every node has a way out (no sink to route into)",
    ids.every(id => ROUTE_EDGES.some(e => e.from === id)),
    ids.filter(id => !ROUTE_EDGES.some(e => e.from === id)).join(","));
  chk("A4 every node has a way in (nothing unreachable)",
    ids.every(id => id === 0 || ROUTE_EDGES.some(e => e.to === id)),
    ids.filter(id => id !== 0 && !ROUTE_EDGES.some(e => e.to === id)).join(","));

  const opposite = { north: "south", south: "north", east: "west", west: "east" } as const;
  const asym = ROUTE_EDGES.filter(e => e.via !== "warp" &&
    !ROUTE_EDGES.some(r => r.from === e.to && r.to === e.from && r.via === opposite[e.via as "north"]));
  chk("A5 map connections are symmetric and opposite", asym.length === 0,
    asym.map(e => `${e.from}-${e.via}->${e.to}`).join(" "));
  chk("A6 every warp edge carries at least one tile",
    ROUTE_EDGES.every(e => e.via !== "warp" || (e.at?.length ?? 0) > 0));
  chk("A7 the gate table only names pairs the graph has",
    EDGE_GATES.every(g => ROUTE_EDGES.some(e =>
      (e.from === g.a && e.to === g.b) || (e.from === g.b && e.to === g.a))),
    EDGE_GATES.filter(g => !ROUTE_EDGES.some(e =>
      (e.from === g.a && e.to === g.b) || (e.from === g.b && e.to === g.a)))
      .map(g => `${g.a}-${g.b}`).join(" "));
}

// ------------------------------------------------------------- B. routeTo
console.log("=== B. routeTo ===");
{
  const r = routeTo(ROUTE_24, VERMILION);
  chk("B1 Route 24 -> Vermilion exists and starts by leaving SOUTH",
    !!r && r.next === CERULEAN && r.via === "south", JSON.stringify(r?.path));
  chk("B2 and it goes through the Underground Path, not Saffron",
    !!r && r.path.includes(UP_ROUTE_5) && !r.path.includes(SAFFRON), JSON.stringify(r?.path));
  chk("B3 the Saffron shortcut is what an ungated graph would pick",
    (() => {
      const open = routeTo(ROUTE_24, VERMILION, new Set<Capability>(["saffron_pass"]));
      return !!open && open.path.includes(SAFFRON) && open.path.length < (r?.path.length ?? 0);
    })(), "gating Saffron is what moves the route onto the tunnel");

  const leg = routeTo(ROUTE_5, VERMILION);
  chk("B4 on Route 5 the next leg is the tunnel door, with its tile",
    !!leg && leg.next === UP_ROUTE_5 && leg.via === "warp" &&
    JSON.stringify(leg.at) === JSON.stringify([[17, 27]]), JSON.stringify(leg?.at));
  chk("B5 out of the tunnel, Route 6 leaves SOUTH into Vermilion",
    (() => { const l = routeTo(ROUTE_6, VERMILION); return !!l && l.next === VERMILION && l.via === "south"; })());

  chk("B6 an interior is off the graph and answers null", routeTo(CERULEAN_MART, VERMILION) === null);
  chk("B7 already there is a one-map path", (() => {
    const l = routeTo(VERMILION, VERMILION); return !!l && l.path.length === 1;
  })());
  chk("B8 Pallet -> Pewter is the canonical opening",
    JSON.stringify(routeTo(0, 2)?.path) === JSON.stringify([0, 12, 1, 13, 2]),
    JSON.stringify(routeTo(0, 2)?.path));
  chk("B9 a gated-only route still answers, and says what it wants", (() => {
    const l = routeTo(1, 9);
    return !!l && l.path.includes(34) && l.gates.some(g => g.needs === "badges_8");
  })(), JSON.stringify(routeTo(1, 9)?.gates.map(g => g.needs)));
  chk("B10 with the badges the same route reports no gate", (() => {
    const l = routeTo(1, 9, capsFromBadges(0xff));
    return !!l && l.path.includes(34) && l.gates.length === 0;
  })());
}

// ------------------------------------------------------- C. goals and gyms
console.log("=== C. gym goals ===");
{
  chk("C1 GYM_MAPS and explore.ts GYMS name the same city at every index",
    GYMS.every((g, i) => (mapLabel(GYM_MAPS[i]) ?? "").startsWith(g.city)),
    GYMS.map((g, i) => `${g.city}/${mapLabel(GYM_MAPS[i])}`).join(" "));
  chk("C2 two badges points at Vermilion", goalMap(TWO_BADGES) === VERMILION);
  chk("C3 no badges points at Pewter", goalMap(0) === 2);
  chk("C4 all eight points at Indigo Plateau", goalMap(0xff) === 9);
  chk("C5 badges alone never claim SURF or the Saffron drink",
    !capsFromBadges(0xff).has("surf") && !capsFromBadges(0xff).has("saffron_pass"));
}

// --------------------------------------------------------- D. prompt lines
console.log("=== D. routeBlock in the prompt ===");
{
  const b = routeBlock(ROUTE_24, TWO_BADGES);
  chk("D1 Route 24 with two badges gets a route block", !!b, JSON.stringify(b));
  chk("D2 and it names the tool call that leaves toward Vermilion — THE TICKET",
    !!b && /leave_edge\(S\)/.test(b) && /Vermilion/.test(b) && /Cerulean/.test(b));
  chk("D3 a warp leg names the door tile, not a direction",
    (() => { const l = routeBlock(ROUTE_5, TWO_BADGES); return !!l && /enter_warp/.test(l) && /\(17,27\)/.test(l); })(),
    String(routeBlock(ROUTE_5, TWO_BADGES)?.split("\n")[1]));
  {
    // Route 5's live warp table (map.ts order): the daycare, the gate, the
    // tunnel. Only the index the agent can actually pass to enter_warp is
    // useful, and it is not derivable from the route table alone.
    const live = [{ x: 10, y: 21, destMap: 72 }, { x: 17, y: 27, destMap: UP_ROUTE_5 }];
    const l = routeBlock(ROUTE_5, TWO_BADGES, capsFromBadges(TWO_BADGES), live);
    chk("D3b with the live warp table it names the enter_warp INDEX", !!l && /enter_warp\(1\)/.test(l),
      String(l?.split("\n")[1]));
    // Coming out of the tunnel onto Route 6, the doors report LAST_MAP (0xff)
    // rather than 17, so only the tile can find the index.
    const out = routeTo(74, VERMILION)!;
    const byTile = legAction(out,
      [{ x: 3, y: 7, destMap: 0xff }, { x: 4, y: 7, destMap: 0xff }, { x: 4, y: 4, destMap: 119 }]);
    chk("D3c a LAST_MAP door still resolves, by tile",
      out.next === ROUTE_6 && /enter_warp\(0\)/.test(byTile), `${out.next} ${byTile}`);
  }
  chk("D4 standing in the goal city says so instead of pointing away",
    (() => { const l = routeBlock(VERMILION, TWO_BADGES); return !!l && /you are IN Vermilion/.test(l) && !/leave_edge/.test(l); })());
  chk("D5 an interior gets no route line at all", routeBlock(CERULEAN_MART, TWO_BADGES) === null);
  chk("D6 a gated-only route says what turns you back",
    (() => { const l = routeBlock(1, 0xff, new Set()); return !!l && /ROUTE IS GATED/.test(l); })(),
    String(routeBlock(1, 0xff, new Set())?.split("\n")[2]));

  const samples: ProgressSample[] = [];
  for (let i = 0; i < 40; i++) samples.push({
    seq: i + 1, turn: i + 1, ts: i, map: ROUTE_24, x: 4 + (i % 2), y: 20, newTiles: 0,
    storyScore: 10, badges: 2, levelSum: 60, pokedexOwned: 5, uniqueTiles: 900, P: 1,
  });
  const block = progressBlock({ badges: TWO_BADGES, partyCount: 3, map: ROUTE_24, samples, balls: 1, money: 500 }, CFG);
  chk("D7 progressBlock carries the route line under the goal it serves",
    /GOAL: Gym #3, Vermilion/.test(block) && /ROUTE to Vermilion City/.test(block) &&
    block.indexOf("GOAL:") < block.indexOf("ROUTE to"), block.split("\n").slice(1, 3).join(" | "));
  chk("D8 progressBlock on an interior keeps its old shape",
    !/ROUTE to/.test(progressBlock({ badges: TWO_BADGES, partyCount: 3, map: CERULEAN_MART, samples: [], balls: 1, money: 500 }, CFG)));
}

// ------------------------------------------------- E. planEscape's aim
console.log("=== E. planEscape aim ===");

class Grid implements GridLike {
  gw: number; gh: number;
  walls = new Set<string>(); grass = new Set<string>(); warps = new Set<string>();
  constructor(w: number, h: number) { this.gw = w; this.gh = h; }
  passableFrom(_fx: number, _fy: number, tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.gw && ty < this.gh && !this.walls.has(`${tx},${ty}`);
  }
  isGrass(x: number, y: number) { return this.grass.has(`${x},${y}`); }
  isWarp(x: number, y: number) { return this.warps.has(`${x},${y}`); }
  hops() { return [] as { x: number; y: number }[]; }
  build() { /* the stub grid is already built */ }
  loadPending() { return false; }
}

/** A grass patch six wide and three tall, in open ground. From its middle the
 *  nearest clean tiles are exactly two — one due north, one due south, both
 *  four steps out — so nothing but the aim can decide which way an escape
 *  goes, and neither choice can be the shorter walk. */
const START = { x: 6, y: 11 };
function symmetric() {
  const g = new Grid(14, 40);
  const foot: { x: number; y: number }[] = [];
  for (let y = 10; y <= 12; y++)
    for (let x = 4; x <= 9; x++) { g.grass.add(`${x},${y}`); foot.push({ x, y }); }
  return { g, foot, avoid: new Set(foot.map(f => `${f.x},${f.y}`)) };
}
{
  const { g, foot, avoid } = symmetric();
  const aimOf = (via: "north" | "south") => legAim({ path: [0, 1], next: 1, via, gates: [] });
  const plain = planEscape(g, START.x, START.y, avoid, foot, 30, 3);
  const south = planEscape(g, START.x, START.y, avoid, foot, 30, 3, new Set(), 0,
    legAim(routeTo(ROUTE_24, VERMILION)));
  const north = planEscape(g, START.x, START.y, avoid, foot, 30, 3, new Set(), 0, aimOf("north"));
  chk("E1 with no aim the answer is unchanged from before wq#1849",
    !!plain && plain.source === "clear_non_grass" && plain.path.length === 4,
    JSON.stringify(plain?.target));
  chk("E2 aiming south picks a target south of the patch — THE TICKET",
    !!south && south.target.y > 12, JSON.stringify(south?.target));
  chk("E3 the aim is a tie-break, not a detour: same walk length",
    !!south && !!plain && south.path.length === plain.path.length,
    `${plain?.path.length} vs ${south?.path.length}`);
  chk("E4 the opposite bearing picks the opposite target", !!north && !!south &&
    north.target.y < 10 && south.target.y > 12,
    `${JSON.stringify(north?.target)} vs ${JSON.stringify(south?.target)}`);

  // An aim that points into a wall must not cost the escape.
  const { g: g2, foot: f2, avoid: a2 } = symmetric();
  for (let x = 0; x < 14; x++) g2.walls.add(`${x},13`);
  const walled = planEscape(g2, START.x, START.y, a2, f2, 30, 3);
  const walledAim = planEscape(g2, START.x, START.y, a2, f2, 30, 3, new Set(), 0,
    legAim(routeTo(ROUTE_24, VERMILION)));
  chk("E5 an unreachable bearing still escapes, the same way it would have",
    !!walled && !!walledAim && walledAim.path.length === walled.path.length &&
    JSON.stringify(walledAim.target) === JSON.stringify(walled.target),
    JSON.stringify(walledAim?.target));
}

// ---------------------------------------- F. the override end to end
console.log("=== F. the override aims its escape ===");
(async () => {
  const log = `/tmp/route1849-ov-${TAG}.jsonl`;
  const world = (badges: number | null) => {
    const { g, foot } = symmetric();
    const w = { pos: { map: ROUTE_24, ...START }, samples: [] as ProgressSample[] };
    let seq = 0;
    const push = () => {
      w.samples.push({
        seq: ++seq, turn: seq, ts: seq, map: w.pos.map, x: w.pos.x, y: w.pos.y, newTiles: 0,
        storyScore: 10, badges: 2, levelSum: 60, pokedexOwned: 5, uniqueTiles: 900, P: 1,
      });
    };
    // The stall the override must react to: pace the strip until the window is full.
    for (let i = 0; i < 150; i++) {
      w.pos = { map: ROUTE_24, x: foot[i % foot.length].x, y: foot[i % foot.length].y };
      push();
    }
    w.pos = { map: ROUTE_24, ...START };
    const move = async (dx: number, dy: number) => {
      const nx = w.pos.x + dx, ny = w.pos.y + dy;
      if (!g.passableFrom(w.pos.x, w.pos.y, nx, ny)) return "blocked";
      w.pos = { ...w.pos, x: nx, y: ny };
      return "moved";
    };
    const ov = new ExplorationOverride({
      map: g, pos: () => ({ ...w.pos }),
      step: move, hop: move,
      samples: () => w.samples, blocked: () => null,
      ...(badges === null ? {} : { badges: () => badges }),
      logFile: log, cfg: CFG,
    });
    return { w, ov, push };
  };

  const run = async (badges: number | null) => {
    if (existsSync(log)) unlinkSync(log);
    const { w, ov, push } = world(badges);
    const lines: string[] = [];
    for (let t = 1; t <= 60; t++) {
      const r = await ov.tick(t);
      if (r) lines.push(r);
      push();
    }
    const recs = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    return { end: w.pos, lines, fire: recs.find(r => r.ev === "fire"), last: lines[lines.length - 1] ?? "" };
  };

  const aimed = await run(TWO_BADGES);
  const blind = await run(null);
  chk("F1 with badges wired the fire record carries the leg it aimed at",
    !!aimed.fire?.leg && aimed.fire.leg.next === CERULEAN && aimed.fire.leg.via === "south",
    JSON.stringify(aimed.fire?.leg));
  chk("F2 without them the record says so and the run still escapes",
    blind.fire?.leg === null && blind.lines.length > 0, JSON.stringify(blind.fire?.leg));
  chk("F3 the aimed escape ends SOUTH of the patch — toward Cerulean",
    aimed.end.y > 14, JSON.stringify(aimed.end));
  chk("F4 the hand-back names the way on rather than only the way not to go",
    /The way on toward the gym is leave_edge\(S\) into Cerulean City\./.test(aimed.last),
    aimed.last.slice(-90));
  chk("F5 with no route knowledge the hand-back is the pre-wq#1849 sentence",
    !/The way on/.test(blind.lines[blind.lines.length - 1] ?? ""));

  // ------------------------------------------- G. the ROM, where there is one
  console.log("=== G. the committed graph vs the ROM ===");
  const romPath = process.env.LPP_ROM ?? "/home/lumen/pokemon/roms/pokeblue.gb";
  const symPath = process.env.LPP_SYM ?? "/home/lumen/pokemon/roms/pokeblue.sym";
  // --no-rom asserts the CI path from a host that HAS the ROM: sections A-F
  // must stand alone, or probes-pure.sh is green for the wrong reason.
  if (process.argv.includes("--no-rom") || !existsSync(romPath)) {
    console.log(`SKIP G (${existsSync(romPath) ? "--no-rom" : `no ROM at ${romPath}`} — this is the CI path)`);
  } else {
    const sym = new SymbolTable(symPath);
    const rom = new Rom(romPath);
    const { nodes, edges } = buildGraph(readMaps(rom, sym, new GameNames(rom, sym)));
    const freshNodes = Object.fromEntries(nodes.map(n => [n.id, n.name]));
    chk("G1 src/route_graph.ts nodes match the ROM",
      JSON.stringify(freshNodes) === JSON.stringify(ROUTE_NODES),
      `${nodes.length} from ROM vs ${Object.keys(ROUTE_NODES).length} committed`);
    chk("G2 src/route_graph.ts edges match the ROM",
      JSON.stringify(edges) === JSON.stringify(ROUTE_EDGES.map(e =>
        e.at ? { from: e.from, to: e.to, via: e.via, at: e.at } : { from: e.from, to: e.to, via: e.via })),
      `${edges.length} from ROM vs ${ROUTE_EDGES.length} committed`);
    chk("G3 every gym city the goal points at is a node the ROM names",
      GYM_MAPS.every(id => !!freshNodes[id]));
  }

  for (const f of [log, overrideLogFile()]) if (existsSync(f)) try { unlinkSync(f); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
