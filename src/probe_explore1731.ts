// wq#1731 probe (pure: no ROM, no emulator, no network). The exploration
// override's trigger, escape planner, controller and prompt lines, driven off
// synthetic novelty samples and a synthetic grid.
//
// A1 is the load-bearing case: it is the live Route 24 stall measured on
// 2026-09-10 (two-wide grass strip, 22 tiles, one map, zero new tiles). The
// design doc's "uniqueTiles < 5" alone does not fire on it; this probe fails if
// the trigger regresses to that.
const TAG = `${process.pid}-${Date.now()}`;
process.env.LPP_OVERRIDE_LOG = `/tmp/explore1731-${TAG}.jsonl`;

import { existsSync, readFileSync, unlinkSync } from "fs";
import type { ProgressSample } from "./novelty";
import {
  assessStall, planEscape, pathToDirs, footDistance, progressBlock, progressCounters,
  ExplorationOverride, overrideLogFile, recoverFlushSeq, FALLBACK_SEQUENCE,
  type ExploreCfg, type GridLike,
} from "./explore";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const CFG: ExploreCfg = {
  enabled: true, prompt: true, windowTurns: 150, minTiles: 5, stepsK: 30,
  clearance: 3, expireFactor: 3, urgencyTurns: 60, catchParty: 3,
};

let seqCounter = 0;
const sample = (map: number, x: number, y: number, newTiles = 0, P = 10000): ProgressSample => ({
  seq: ++seqCounter, turn: seqCounter, ts: seqCounter * 1000, map, x, y, newTiles,
  storyScore: 10, badges: 1, levelSum: 30, pokedexOwned: 4, uniqueTiles: 900, P,
});

/** The live stall: walk x=4..5, y=19..29 on map35, back and forth. */
function strip(n: number, map = 35): ProgressSample[] {
  const cells: [number, number][] = [];
  for (let y = 19; y <= 29; y++) { cells.push([4, y]); cells.push([5, y]); }
  const out: ProgressSample[] = [];
  for (let i = 0; i < n; i++) { const [x, y] = cells[i % cells.length]; out.push(sample(map, x, y)); }
  return out;
}

// ------------------------------------------------------------- A. trigger
console.log("=== A. assessStall ===");
{
  const s = strip(150);
  const v = assessStall(s, 0, CFG);
  chk("A1 live Route 24 strip (22 tiles, one map, no new tiles) STALLS",
    v.stalled && v.trigger === "no_new_ground" && v.uniqueTiles === 22, JSON.stringify({ t: v.trigger, u: v.uniqueTiles }));
  chk("A1b a tile-count threshold alone would not have fired", v.uniqueTiles >= CFG.minTiles);

  const p = assessStall(strip(149), 0, CFG);
  chk("A2 a partial window never claims a stall", !p.stalled && !p.complete, `samples=${p.samples}`);

  const withNew = strip(150); withNew[80] = { ...withNew[80], newTiles: 1 };
  chk("A3 one new tile inside the window is not a stall", !assessStall(withNew, 0, CFG).stalled);

  const door: ProgressSample[] = [];
  for (let i = 0; i < 150; i++) door.push(i % 2 ? sample(35, 10, 5) : sample(64, 3, 7));
  const dv = assessStall(door, 0, CFG);
  chk("A4 a two-map door ping-pong under minTiles is a tight pace", dv.stalled && dv.trigger === "tight_pace",
    JSON.stringify({ t: dv.trigger, maps: dv.maps }));

  const travel: ProgressSample[] = [];
  for (let i = 0; i < 150; i++) travel.push(sample(i < 75 ? 3 : 4, i % 20, 2));
  chk("A5 travel across maps on explored ground is not a stall", !assessStall(travel, 0, CFG).stalled);

  const s6 = strip(150);
  const floor = s6[s6.length - 1].seq;
  chk("A6 nothing before the flush floor counts", !assessStall(s6, floor, CFG).stalled);
  const refill = s6.concat(strip(150));
  chk("A6b a full window after the floor stalls again", assessStall(refill, floor, CFG).stalled);

  const grind = strip(150).map((x, i) => ({ ...x, P: 10000 + i * 10 }));
  chk("A7 rising levels (a grind) on the same strip still stalls", assessStall(grind, 0, CFG).stalled);
}

// ------------------------------------------------------------- grid double
class Grid implements GridLike {
  gw: number; gh: number;
  walls = new Set<string>(); grass = new Set<string>(); warps = new Set<string>();
  hopEdges = new Map<string, { x: number; y: number }[]>();
  builds = 0;
  constructor(w: number, h: number) { this.gw = w; this.gh = h; }
  passableFrom(_fx: number, _fy: number, tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.gw && ty < this.gh && !this.walls.has(`${tx},${ty}`);
  }
  isGrass(x: number, y: number) { return this.grass.has(`${x},${y}`); }
  isWarp(x: number, y: number) { return this.warps.has(`${x},${y}`); }
  hops(x: number, y: number) { return this.hopEdges.get(`${x},${y}`) ?? []; }
  build() { this.builds++; }
  loadPending() { return false; }
}

const patch = () => {
  const g = new Grid(16, 16);
  const foot: { x: number; y: number }[] = [];
  for (let y = 3; y <= 8; y++) for (const x of [4, 5]) { g.grass.add(`${x},${y}`); foot.push({ x, y }); }
  return { g, foot, avoid: new Set(foot.map(f => `${f.x},${f.y}`)) };
};
const cheb = (a: { x: number; y: number }, foot: { x: number; y: number }[]) =>
  Math.min(...foot.map(f => Math.max(Math.abs(f.x - a.x), Math.abs(f.y - a.y))));

// ------------------------------------------------------------- B. planner
console.log("=== B. planEscape ===");
{
  const { g, foot, avoid } = patch();
  const p = planEscape(g, 5, 5, avoid, foot, 30, 3);
  const contiguous = !!p && p.path.every((c, i) => {
    const prev = i ? p.path[i - 1] : { x: 5, y: 5 };
    return Math.abs(c.x - prev.x) + Math.abs(c.y - prev.y) === 1;
  });
  chk("B1 open field: a clear non-grass target outside the patch",
    !!p && p.source === "clear_non_grass" && !g.isGrass(p.target.x, p.target.y) &&
    cheb(p.target, foot) >= 3 && p.path.length <= 30 && contiguous,
    JSON.stringify(p && { t: p.target, len: p.path.length, src: p.source }));
  chk("B1b nearest such target (3 presses from the strip's middle)", !!p && p.path.length === 3,
    String(p?.path.length));
}
{
  // Pen around the patch whose only gap is a warp: no clear tile is reachable
  // without crossing the warp, so the plan settles for near non-grass ground.
  const { g, foot, avoid } = patch();
  for (let y = 0; y < 16; y++) { g.walls.add(`2,${y}`); if (y !== 5) g.walls.add(`7,${y}`); }
  for (let x = 2; x <= 7; x++) { g.walls.add(`${x},1`); g.walls.add(`${x},10`); }
  g.warps.add("7,5");
  const p = planEscape(g, 5, 5, avoid, foot, 30, 3);
  chk("B2 never routes through or onto a warp", !!p && p.source === "non_grass" &&
    !p.path.some(c => g.isWarp(c.x, c.y)), JSON.stringify(p && { t: p.target, src: p.source }));
}
{
  const { g, foot, avoid } = patch();
  for (let y = 2; y <= 9; y++) { g.walls.add(`3,${y}`); g.walls.add(`6,${y}`); }
  for (const x of [4, 5]) { g.walls.add(`${x},2`); g.walls.add(`${x},9`); }
  chk("B3 only grass reachable -> null (caller falls back)", planEscape(g, 5, 5, avoid, foot, 30, 3) === null);
}
{
  const g = new Grid(16, 16);
  for (let x = 0; x < 16; x++) { g.walls.add(`${x},4`); g.walls.add(`${x},6`); }
  g.walls.add("3,5"); g.walls.add("7,5");
  for (const x of [4, 5, 6]) g.grass.add(`${x},5`);
  g.hopEdges.set("5,5", [{ x: 5, y: 7 }]);
  const foot = [4, 5, 6].map(x => ({ x, y: 5 }));
  const p = planEscape(g, 5, 5, new Set(foot.map(f => `${f.x},${f.y}`)), foot, 30, 3);
  const dirs = p ? pathToDirs(5, 5, p.path) : [];
  chk("B4 a ledge hop is a legal escape edge and becomes one hop press",
    !!p && dirs.length > 0 && dirs[0].dir === "D" && dirs[0].hop === true,
    JSON.stringify({ t: p?.target, dirs }));
}
{
  const { g, foot, avoid } = patch();
  const p1 = planEscape(g, 5, 5, avoid, foot, 30, 3)!;
  const first = `${p1.path[0].x},${p1.path[0].y}`;
  const p2 = planEscape(g, 5, 5, avoid, foot, 30, 3, new Set([first]));
  chk("B5 a learned-blocked cell is planned around", !!p2 && !p2.path.some(c => `${c.x},${c.y}` === first), first);
  chk("B6 maxLen 0 plans nothing", planEscape(g, 5, 5, avoid, foot, 0, 3) === null);
  chk("B7 pathToDirs maps unit deltas", JSON.stringify(pathToDirs(1, 1, [{ x: 2, y: 1 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])
    .map(d => d.dir)) === JSON.stringify(["R", "U", "L", "D"]));
}
{
  // The replay trace: walked 22 tiles north up x=4 to the dead end at (4,8),
  // stepped to (5,8). The nearest unvisited non-grass tile is (5,9), back
  // south. fromDist forbids it; there is nothing farther, so no plan.
  const g = new Grid(10, 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 10; x++) if ((x !== 4 && x !== 5) || y < 8) g.walls.add(`${x},${y}`);
  const foot: { x: number; y: number }[] = [];
  for (let y = 19; y <= 29; y++) for (const x of [4, 5]) { g.grass.add(`${x},${y}`); foot.push({ x, y }); }
  const avoid = new Set(foot.map(f => `${f.x},${f.y}`));
  for (let y = 8; y <= 18; y++) avoid.add(`4,${y}`);
  avoid.add("5,8");
  const from = footDistance({ x: 5, y: 8 }, foot);
  const p = planEscape(g, 5, 8, avoid, foot, 30, 3, new Set(), from);
  chk("B8 a later leg never targets ground closer to the patch", p === null || footDistance(p.target, foot) >= from,
    JSON.stringify({ from, target: p?.target }));
  const old = planEscape(g, 5, 8, avoid, foot, 30, 3);
  chk("B8b without fromDist the planner walks back (the defect this guards)",
    !!old && footDistance(old.target, foot) < from, JSON.stringify(old?.target));
}

// ------------------------------------------------------------- C. controller
console.log("=== C. ExplorationOverride ===");

/** Route 24-shaped world: map35, grass strip x=4..5 y=19..29, player mid-strip. */
function stripWorld(opts: { enclosed?: boolean; corridor?: boolean; warpAt?: string; cfg?: Partial<ExploreCfg> } = {}) {
  const g = new Grid(20, 40);
  const foot: { x: number; y: number }[] = [];
  for (let y = 19; y <= 29; y++) for (const x of [4, 5]) { g.grass.add(`${x},${y}`); foot.push({ x, y }); }
  if (opts.corridor)       // the live shape: a 2-wide lane, dead end at y=8
    for (let y = 0; y < 40; y++) for (let x = 0; x < 20; x++)
      if ((x !== 4 && x !== 5) || y < 8) g.walls.add(`${x},${y}`);
  if (opts.enclosed) {
    for (let y = 18; y <= 30; y++) { g.walls.add(`3,${y}`); g.walls.add(`6,${y}`); }
    for (const x of [4, 5]) { g.walls.add(`${x},18`); g.walls.add(`${x},30`); }
  }
  const w = {
    g, foot, pos: { map: 35, x: 5, y: 24 }, battle: false, fires: 0,
    samples: strip(150), log: `/tmp/explore1731-${TAG}-${Math.random().toString(36).slice(2)}.jsonl`,
  };
  const move = async (dx: number, dy: number, n: number) => {
    if (w.battle) return "battle";
    const nx = w.pos.x + dx * n, ny = w.pos.y + dy * n;
    if (!g.passableFrom(w.pos.x, w.pos.y, nx, ny)) return "blocked";
    w.pos = { ...w.pos, x: nx, y: ny };
    if (opts.warpAt === `${nx},${ny}`) { w.pos = { map: 36, x: 3, y: 3 }; return "warped"; }
    return "moved";
  };
  const ov = new ExplorationOverride({
    map: g, pos: () => ({ ...w.pos }),
    step: (dx, dy) => move(dx, dy, 1), hop: (dx, dy) => move(dx, dy, 2),
    samples: () => w.samples, blocked: () => (w.battle ? "battle" : null),
    onFire: () => { w.fires++; }, logFile: w.log, cfg: { ...CFG, ...(opts.cfg ?? {}) },
  });
  /** One harness turn, then the end-of-turn novelty sample the agent takes. */
  const turn = async (t: number) => {
    const r = await ov.tick(t);
    w.samples.push(sample(w.pos.map, w.pos.x, w.pos.y));
    return r;
  };
  const records = () => existsSync(w.log)
    ? readFileSync(w.log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return { w, ov, turn, records };
}

(async () => {
  {
    const { w, ov, turn, records } = stripWorld();
    const lines: (string | null)[] = [];
    for (let t = 1; t <= 40; t++) lines.push(await turn(t));
    const recs = records();
    const fire = recs.find(r => r.ev === "fire"), end = recs.find(r => r.ev === "end");
    chk("C1 fires on the live-shaped stall on the first eligible turn",
      !!lines[0] && /step 1\/30/.test(lines[0]!) && w.fires === 1, String(lines[0]).slice(0, 90));
    chk("C2 the fire record carries where, why, what", !!fire && fire.at.map === 35 && fire.trigger === "no_new_ground" &&
      fire.window.uniqueTiles === 22 && fire.window.newTiles === 0 && fire.sequence.length > 0 && !!fire.target,
      JSON.stringify(fire && { at: fire.at, trig: fire.trigger, seq: fire.sequence, target: fire.target }));
    chk("C3 escapes within K: >= minTiles tiles outside the stalled patch",
      !!end && end.escaped === true && end.newGround >= CFG.minTiles && end.stepsTaken <= CFG.stepsK,
      JSON.stringify(end && { reason: end.reason, steps: end.stepsTaken, newGround: end.newGround }));
    const lastPos = end?.at;
    chk("C4 ends off the strip", !!lastPos && !w.g.isGrass(lastPos.x, lastPos.y), JSON.stringify(lastPos));
    const endIdx = lines.findIndex(l => l !== null && /ended/.test(l));
    chk("C5 the brain gets the turn back after the end line (flush floor holds)",
      endIdx >= 0 && lines.slice(endIdx + 1).every(l => l === null), `endIdx=${endIdx}`);
    chk("C6 exactly one fire and one end logged", recs.filter(r => r.ev === "fire").length === 1 &&
      recs.filter(r => r.ev === "end").length === 1, String(recs.length));
    const again = new ExplorationOverride({ map: w.g, pos: () => w.pos, step: async () => "moved",
      hop: async () => "moved", samples: () => w.samples, blocked: () => null, logFile: w.log, cfg: CFG });
    chk("C7 a restarted agent recovers the floor from the log", again.floor() === ov.floor() && ov.floor() > 0,
      `${again.floor()} vs ${ov.floor()}`);
    chk("C7b and does not re-fire on the window already acted on", (await again.tick(99)) === null);
    for (const f of [w.log, `${w.log}.1`]) { try { unlinkSync(f); } catch {} }
  }
  {
    const { w, turn, records } = stripWorld();
    w.battle = true;
    const inBattle = [await turn(1), await turn(2)];
    chk("C8 never fires in a battle", inBattle.every(r => r === null) && records().length === 0 && w.fires === 0);
    w.battle = false;
    const first = await turn(3);
    w.battle = true;
    const mid = [await turn(4), await turn(5), await turn(6)];
    w.battle = false;
    const resumed = await turn(7);
    chk("C8b a battle mid-run pauses it without spending steps",
      !!first && mid.every(r => r === null) && /step 2\/30/.test(resumed ?? ""), String(resumed).slice(0, 60));
    try { unlinkSync(w.log); } catch {}
  }
  {
    // A warp on the first leg's second cell: the escape lands on another map.
    const probe = stripWorld();
    await probe.turn(1);
    const fire = probe.records().find(r => r.ev === "fire");
    try { unlinkSync(probe.w.log); } catch {}
    const seq: string[] = fire?.sequence ?? [];
    let x = 5, y = 24;
    const d = (s: string) => ({ U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] } as any)[s[0]];
    for (const s of seq.slice(0, 2)) { x += d(s)[0]; y += d(s)[1]; }
    const { w, turn, records } = stripWorld({ warpAt: `${x},${y}` });
    let out: string | null = null;
    for (let t = 1; t <= 3; t++) out = (await turn(t)) ?? out;
    const end = records().find(r => r.ev === "end");
    chk("C9 leaving the map ends the run as an escape", !!end && end.reason === "map_changed" &&
      end.mapChanged === true && end.escaped === true, JSON.stringify(end && { reason: end.reason, at: end.at }));
    try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records } = stripWorld({ enclosed: true });
    for (let t = 1; t <= 40; t++) await turn(t);
    const recs = records();
    const fire = recs.find(r => r.ev === "fire"), end = recs.find(r => r.ev === "end");
    chk("C10 no reachable target -> the fixed D10/R10/U5 fallback", !!fire && fire.source === "fallback" &&
      fire.sequence.join("") === FALLBACK_SEQUENCE.join(""), JSON.stringify(fire && fire.source));
    chk("C10b a sealed pen is logged as NOT escaped, not as a success", !!end && end.escaped === false &&
      end.reason === "fallback_exhausted", JSON.stringify(end && { reason: end.reason, escaped: end.escaped }));
    try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records } = stripWorld();
    await turn(1);
    w.battle = true;
    for (let t = 2; t <= CFG.stepsK * CFG.expireFactor + 2; t++) await turn(t);
    const end = records().find(r => r.ev === "end");
    chk("C11 a run eaten by battles expires instead of holding forever", !!end && end.reason === "expired",
      JSON.stringify(end && end.reason));
    try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records } = stripWorld({ cfg: { enabled: false } });
    for (let t = 1; t <= 5; t++) await turn(t);
    chk("C12 LPP_EXPLORE_OVERRIDE=0 is a full revert", records().length === 0 && w.fires === 0);
  }
  {
    const { w, turn, records } = stripWorld({ corridor: true });
    for (let t = 1; t <= 40; t++) await turn(t);
    const end = records().find(r => r.ev === "end");
    const ex: string[] = end?.executed ?? [];
    chk("C15 replayed Route 24 lane: the escape never turns back toward the patch",
      !!end && ex.length > 0 && !ex.some(e => e.startsWith("D")) && end.escaped === true,
      JSON.stringify(end && { reason: end.reason, at: end.at, executed: ex.join(" ") }));
    chk("C15b and it stops at the dead end instead of pressing the fixed fallback",
      !!end && end.reason === "no_farther_ground" && end.mode === "target", JSON.stringify(end && end.reason));
    try { unlinkSync(w.log); } catch {}
  }
  chk("C13 log path honours LPP_OVERRIDE_LOG (probe isolation)", overrideLogFile("/nonexistent") === process.env.LPP_OVERRIDE_LOG);
  chk("C14 floor recovery from a missing log is 0", recoverFlushSeq(`/tmp/explore1731-missing-${TAG}.jsonl`) === 0);

  // ----------------------------------------------------------- D. prompt
  console.log("=== D. progressBlock ===");
  {
    const s = strip(150);
    // Resourced: one ball in the bag, so the catch line is executable.
    const b = progressBlock({ badges: 0b1, partyCount: 1, map: 35, samples: s, balls: 1, money: 0 }, CFG);
    chk("D1 one badge names Gym #2 Cerulean", /GOAL: Gym #2, Cerulean \(Misty, Cascade Badge\)/.test(b), b.split("\n")[1]);
    chk("D2 counters read the sample window", /badges 1\/8, party 1, 150\+ turns on this map, 150\+ turns since/.test(b),
      b.split("\n")[0]);
    chk("D3 a long no-new-ground stretch says leaving is high value, fights de-emphasized",
      /!! NO NEW GROUND.*leaving this map is high value.*only worth it when they block the path/.test(b));
    chk("D4 party below catchParty WITH a ball gets the catch line",
      /CATCH: you have 1 Pokemon and 1 ball\(s\)/.test(b));

    const fresh = s.concat([sample(35, 9, 9, 1)]);
    const b2 = progressBlock({ badges: 0b1, partyCount: 3, map: 35, samples: fresh, balls: 1, money: 0 }, CFG);
    chk("D5 a new tile clears the urgency line", !/NO NEW GROUND/.test(b2) && /0 turns since/.test(b2), b2.split("\n")[0]);
    chk("D6 no catch line at catchParty", !/CATCH/.test(b2));
    chk("D7 a different map than the window means 0 turns here, no urgency",
      !/NO NEW GROUND/.test(progressBlock({ badges: 1, partyCount: 3, map: 36, samples: s, balls: 1, money: 0 }, CFG)));
    chk("D8 badge bits, not badge count, pick the gym (Boulder+Cascade -> Vermilion)",
      /Gym #3, Vermilion \(Lt\. Surge, Thunder Badge\)/.test(progressBlock({ badges: 0b11, partyCount: 3, map: 1, samples: [], balls: 1, money: 0 }, CFG)));
    chk("D9 all badges -> the League", /Victory Road/.test(progressBlock({ badges: 0xff, partyCount: 6, map: 1, samples: [], balls: 1, money: 0 }, CFG)));
    chk("D10 empty sample log renders zeros without throwing",
      /party 0, 0 turns on this map, 0 turns since/.test(progressBlock({ badges: 0, partyCount: 0, map: 1, samples: [], balls: 0, money: 0 }, CFG)));
    const k = progressCounters(s.slice(-10).concat([sample(12, 1, 1)]), 12);
    chk("D11 onMap stops at the last map change", k.onMap === 1 && !k.onMapCapped, JSON.stringify(k));

    // wq#1829: the live 2026-09-12 state — party under target, ZERO balls, $96
    // against a $200 ball. The old line said "catching another is valuable"
    // here, which is a directive the agent cannot execute.
    const broke = progressBlock({ badges: 0b1, partyCount: 1, map: 35, samples: s, balls: 0, money: 96 }, CFG);
    chk("D12 broke + ballless says catching is IMPOSSIBLE, never 'valuable'",
      /CATCHING IS IMPOSSIBLE: 1 Pokemon, ZERO balls, \$96/.test(broke) && !/catching another is valuable/.test(broke),
      broke.split("\n").pop());
    chk("D13 the impossible branch names the only income source and the price",
      /TRAINER battles pay/.test(broke) && /\$200/.test(broke) && /wild Pokemon pay nothing/.test(broke));
    chk("D14 it does NOT tell a ballless agent to weaken wilds",
      !/weaken/i.test(broke) || /Do NOT spend turns hunting or weakening/.test(broke));

    // Affordable but empty-handed: the action is BUY, and the marts are named
    // from MART_ORDER (all four that stock balls, not a remembered two).
    const rich = progressBlock({ badges: 0b1, partyCount: 1, map: 35, samples: s, balls: 0, money: 1200 }, CFG);
    chk("D15 money but no balls -> BUY BALLS FIRST, with the mart list",
      /BUY BALLS FIRST: 1 Pokemon, ZERO balls, \$1200/.test(rich) && /Cerulean \(map67\)/.test(rich),
      rich.split("\n").pop());
    chk("D16 the buy branch lists every ball mart MART_ORDER knows",
      ["Viridian (map42)", "Pewter (map56)", "Cerulean (map67)", "Vermilion (map91)"].every(m => rich.includes(m)));
    chk("D17 exactly one catch/economy line renders per block",
      [broke, rich, b].every(t => t.split("\n").filter(l => /^(CATCH|BUY BALLS|CATCHING)/.test(l)).length === 1));
  }

  try { unlinkSync(process.env.LPP_OVERRIDE_LOG!); } catch {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
