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

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import type { ProgressSample } from "./novelty";
import {
  assessStall, dominantPatch, stallMap, planEscape, pathToDirs, footDistance, progressBlock, progressCounters,
  ExplorationOverride, overrideLogFile, recoverFlushSeq, recoverWatch, FALLBACK_SEQUENCE,
  type ExploreCfg, type GridLike,
} from "./explore";
import { ExclusionGate, exclusionLift, exclusionSuspended, loadExclusion, EXCLUSION_MAX_FIRES,
         type Exclusion } from "./exclusion";
import { STALL_WINDOW, PROGRESS_WINDOW, rehydrate } from "./fixture_stall1828";

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

// ------------------------------------------- A-live. the wq#1828 falsifier
// Both windows are slices of the live run's own novelty samples
// (src/fixture_stall1828.ts). The claim under test: the dominant_patch trigger
// fires on the shuttle that defeated wq#1731, and stays silent on the stretch
// of the SAME run where the agent was genuinely covering ground.
console.log("=== A-live. dominant_patch vs the live samples ===");
{
  const stall = rehydrate(STALL_WINDOW);
  const prog = rehydrate(PROGRESS_WINDOW);
  const off = { ...CFG, patchShare: 0 };

  const miss = assessStall(stall, 0, off);
  chk("A8 wq#1731's two triggers miss this window — the measured defect",
    !miss.stalled && miss.complete && miss.maps.length > 1 && miss.newTiles > 0 &&
    miss.uniqueTiles >= CFG.minTiles,
    JSON.stringify({ maps: miss.maps.length, newTiles: miss.newTiles, tiles: miss.uniqueTiles }));

  const v = assessStall(stall, 0, CFG);
  chk("A9 dominant_patch fires on it", v.stalled && v.trigger === "dominant_patch" && !!v.patch &&
    v.patch.map === 35 && v.patch.share >= CFG.patchShare && v.patch.newTiles === 0,
    JSON.stringify(v.patch && { at: [v.patch.map, v.patch.x, v.patch.y],
                                share: +v.patch.share.toFixed(3), fresh: v.patch.newTiles }));
  chk("A9b every new tile it holds was earned OUTSIDE the patch (the laundering it stops)",
    v.newTiles > 0 && v.patch!.newTiles === 0, `newTiles=${v.newTiles}`);

  const pcfg = { ...CFG, windowTurns: PROGRESS_WINDOW.length };
  const pv = assessStall(prog, 0, pcfg);
  chk("A10 it stays silent on the same run's progressing Route 25 stretch",
    pv.complete && !pv.stalled && !!pv.patch && pv.patch.newTiles > 0,
    JSON.stringify(pv.patch && { at: [pv.patch.map, pv.patch.x, pv.patch.y],
                                 share: +pv.patch.share.toFixed(3), fresh: pv.patch.newTiles }));
  chk("A10b and density alone would have convicted it — new ground inside the patch is the acquittal",
    pv.patch!.share >= CFG.patchShare, String(+pv.patch!.share.toFixed(3)));

  chk("A11 LPP_EXPLORE_PATCH_SHARE=0 reverts the trigger", !assessStall(stall, 0, off).stalled);
  chk("A12 a radius below the stalled strip's height does not find it",
    !assessStall(stall, 0, { ...CFG, patchRadius: 2 }).stalled);
  chk("A13 a partial window has no patch and no verdict",
    (() => { const p = assessStall(stall.slice(0, 149), 0, CFG); return !p.stalled && !p.complete && p.patch === null; })());
  chk("A14 dominantPatch on an empty window is null, not a throw", dominantPatch([], 5) === null);
  const one = dominantPatch(strip(1), 0);
  chk("A14b radius 0 is the single cell it stood on",
    !!one && one.samples === 1 && one.share === 1 && one.cells.length === 1, JSON.stringify(one?.cells));
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
  const uniq = `${TAG}-${Math.random().toString(36).slice(2)}`;
  const w = {
    g, foot, pos: { map: 35, x: 5, y: 24 }, battle: false, fires: 0,
    samples: strip(150), log: `/tmp/explore1731-${uniq}.jsonl`,
    exFile: `/tmp/explore1828-${uniq}.json`,
  };
  const gate = new ExclusionGate(w.exFile);
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
    onFire: () => { w.fires++; }, exclude: e => gate.set(e),
    exclusionFires: () => gate.peek()?.fires ?? 0,
    logFile: w.log, cfg: { ...CFG, ...(opts.cfg ?? {}) },
  });
  /** One harness turn, then the end-of-turn novelty sample the agent takes —
   *  which is also what the exclusion gate ages off (agent.ts runTurn). */
  const turn = async (t: number) => {
    const r = await ov.tick(t);
    const s = sample(w.pos.map, w.pos.x, w.pos.y);
    w.samples.push(s);
    gate.observe(s.seq, s.map, s.x, s.y, s.newTiles);
    return r;
  };
  /** Newest novelty seq — what the gate ages in (wq#1839), never the turn `t`,
   *  which restarts at 1 with the process. */
  const seqNow = () => w.samples[w.samples.length - 1].seq;
  const records = () => existsSync(w.log)
    ? readFileSync(w.log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return { w, ov, turn, records, gate, seqNow };
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

  // ------------------------------------------------------- E. exclusion (wq#1828)
  // All nine historical fires read `escaped: true, mapChanged: false`: the walk
  // out worked and the brain walked back. These cover the refusal that stops it.
  console.log("=== E. ExclusionGate ===");
  {
    const { w, turn, records, gate, seqNow } = stripWorld();
    let endTurn = 0, endSeq = 0;
    for (let t = 1; t <= 40; t++) {
      const before = seqNow();                      // the seq finish() will budget from
      const r = await turn(t);
      if (r && /ended/.test(r) && !endTurn) { endTurn = t; endSeq = before; }
    }
    const end = records().find(r => r.ev === "end");
    const e = gate.current();
    chk("E1 the escaped patch is persisted on END, budgeted in novelty seq",
      !!e && e.map === 35 && e.fromFire === 1 && e.tiles.includes("35,5,24") &&
      e.fromSeq === endSeq && e.untilSeq === endSeq + CFG.excludeTurns,
      JSON.stringify(e && { tiles: e.tiles.length, from: e.fromSeq, until: e.untilSeq, endSeq }));
    chk("E1b the end record says so too", !!end && end.excludeUntilSeq === e!.untilSeq &&
      end.excludeTiles === e!.tiles.length, JSON.stringify(end && { u: end.excludeUntilSeq, n: end.excludeTiles }));
    chk("E1c only the stalled map's tiles are in it", !!e && e.tiles.every(t => t.startsWith("35,")));
    const onDisk = loadExclusion(w.exFile);
    chk("E2 a restarted agent recovers it from runtime/explore_exclusion.json",
      !!onDisk && onDisk.untilSeq === e!.untilSeq && onDisk.fromSeq === e!.fromSeq &&
      onDisk.tiles.length === e!.tiles.length &&
      new ExclusionGate(w.exFile).current()?.fromFire === 1);

    const seq = seqNow();
    const ref = gate.refuse(seq, 35, 5, 24, "Route 24 (map35)");
    chk("E3 goto INTO the patch is refused, naming the reason and what is left of it",
      !!ref && /EXPLORATION EXCLUSION on Route 24 \(map35\) \(5,24\)/.test(ref) &&
      ref.includes(`lifts in ${e!.untilSeq - seq} turns`), String(ref).slice(0, 120));
    chk("E3b the refusal says leaving only pauses it, and walking through stays legal",
      !!ref && /Leaving map35 only PAUSES it/.test(ref) && /somewhere new inside it/.test(ref) &&
      /THROUGH/.test(ref));
    chk("E4 a destination outside the patch is untouched — advisory for movement only",
      gate.refuse(seq, 35, 12, 12, "Route 24 (map35)") === null);
    chk("E4b and the refusal is a function of the TARGET, not of where you stand",
      gate.refuse(seq, 35, 5, 25, "Route 24 (map35)") !== null &&
      gate.refuse(seq, 35, 0, 0, "Route 24 (map35)") === null);
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    // wq#1839 (1), on the shape the live run actually has: the agent pops to
    // Route 25 for a few turns and comes back. map35 held 398 of 512 samples
    // and that excursion vetoed 259 of 363 stall windows
    // (docs/EXPLORE_STALL_1744.md:26,48) — so wq#1828's lift-on-map-change
    // cancelled the ban on the very cycle it was written to survive.
    const { w, turn, gate, seqNow } = stripWorld();
    for (let t = 1; t <= 40; t++) await turn(t);
    const until = gate.current()!.untilSeq;
    w.pos = { map: 36, x: 3, y: 3 };                          // off to Route 25
    for (let t = 41; t <= 44; t++) await turn(t);
    chk("E5 leaving the map SUSPENDS the ban, it does not lift it",
      gate.current() !== null && gate.suspended() && existsSync(w.exFile) &&
      gate.current()!.untilSeq === until, JSON.stringify(gate.current() && { until }));
    chk("E5b it refuses nothing while it sleeps — goto is same-map anyway",
      gate.refuse(seqNow(), 36, 5, 24, "Route 25 (map36)") === null && gate.current() !== null);
    w.pos = { map: 35, x: 5, y: 22 };                         // ...and back to the strip
    await turn(45);
    chk("E5c coming back wakes it: the walk-back is refused, on the same budget",
      !gate.suspended() && gate.refuse(seqNow(), 35, 5, 24, "map35") !== null &&
      gate.current()!.untilSeq === until);
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    // Sleeping is not a stay of execution: the budget runs in samples wherever
    // the agent stands, so an excursion longer than it expires the ban off-map.
    const { w, turn, gate, seqNow } = stripWorld({ cfg: { excludeTurns: 5 } });
    let endTurn = 0;
    for (let t = 1; t <= 40 && !endTurn; t++) { const r = await turn(t); if (r && /ended/.test(r)) endTurn = t; }
    const until = gate.current()!.untilSeq;
    w.pos = { map: 36, x: 3, y: 3 };
    for (let t = endTurn + 1; t <= endTurn + 5; t++) await turn(t);
    chk("E5d an excursion longer than the budget expires it where it sleeps",
      gate.current() === null && !existsSync(w.exFile), `until=${until} seq=${seqNow()}`);
    try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, gate } = stripWorld();
    for (let t = 1; t <= 40; t++) await turn(t);
    const until = gate.current()!.untilSeq;
    chk("E6 it holds right up to untilSeq", gate.refuse(until - 1, 35, 5, 24, "map35") !== null);
    chk("E6b and lifts on it", gate.refuse(until, 35, 5, 24, "map35") === null && !existsSync(w.exFile),
      `until=${until}`);
    try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, gate, seqNow } = stripWorld();
    for (let t = 1; t <= 40; t++) await turn(t);
    const lift = gate.observe(seqNow(), 35, 5, 24, 1);
    chk("E7 new ground INSIDE the patch lifts it — the patch stopped being dead",
      !!lift && /new ground/.test(lift) && gate.current() === null &&
      gate.refuse(seqNow(), 35, 5, 24, "map35") === null, String(lift));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, gate, seqNow } = stripWorld();
    for (let t = 1; t <= 40; t++) await turn(t);
    chk("E7b new ground outside it does not",
      gate.observe(seqNow(), 35, 9, 9, 1) === null && gate.current() !== null &&
      gate.refuse(seqNow(), 35, 5, 24, "map35") !== null);
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records, gate, seqNow } = stripWorld({ cfg: { excludeTurns: 0 } });
    for (let t = 1; t <= 40; t++) await turn(t);
    const end = records().find(r => r.ev === "end");
    chk("E8 LPP_EXPLORE_EXCLUDE_TURNS=0 is a full revert: nothing recorded, nothing refused",
      gate.current() === null && !existsSync(w.exFile) && !!end && end.excludeUntilSeq === null &&
      gate.refuse(seqNow(), 35, 5, 24, "map35") === null);
    try { unlinkSync(w.log); } catch {}
  }
  {
    // The escape that left the map has nothing to refuse: goto is same-map only.
    const probe = stripWorld();
    await probe.turn(1);
    const seq: string[] = probe.records().find(r => r.ev === "fire")?.sequence ?? [];
    try { unlinkSync(probe.w.log); } catch {}
    let x = 5, y = 24;
    const d = (s: string) => ({ U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] } as any)[s[0]];
    for (const s of seq.slice(0, 2)) { x += d(s)[0]; y += d(s)[1]; }
    const { w, turn, gate } = stripWorld({ warpAt: `${x},${y}` });
    for (let t = 1; t <= 3; t++) await turn(t);
    chk("E9 a run that ended on another map writes no exclusion",
      gate.current() === null && !existsSync(w.exFile));
    try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, gate, seqNow } = stripWorld();
    for (let t = 1; t <= 40; t++) await turn(t);
    const said: (string | null)[] = [];
    for (let i = 0; i < EXCLUSION_MAX_FIRES + 2; i++) said.push(gate.refuse(seqNow(), 35, 5, 24, "map35"));
    chk("E11 it gives itself up after EXCLUSION_MAX_FIRES refusals (the wq#1181 anti-wedge)",
      said.filter(Boolean).length === EXCLUSION_MAX_FIRES && said[EXCLUSION_MAX_FIRES] === null &&
      gate.current() === null, `${said.filter(Boolean).length} refusals`);
    chk("E11b and it counts them down out loud, so the last one says so",
      /after 1 more refusals/.test(said[EXCLUSION_MAX_FIRES - 2] ?? "") &&
      /after 0 more refusals/.test(said[EXCLUSION_MAX_FIRES - 1] ?? ""),
      String(said[EXCLUSION_MAX_FIRES - 1]).slice(0, 200).split(".")[1]);
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const e: Exclusion = { v: 2, tiles: ["35,5,24"], map: 35, fromSeq: 40, untilSeq: 100,
                           fromFire: 2, fires: 0, iso: "" };
    chk("E10 the lift rule is pure and states which rule fired",
      exclusionLift(e, 99) === null && /expired/.test(exclusionLift(e, 100) ?? "") &&
      /counter reset/.test(exclusionLift(e, 39) ?? "") &&
      /without steering/.test(exclusionLift({ ...e, fires: EXCLUSION_MAX_FIRES }, 99) ?? ""));
    chk("E10b leaving the map is no lift at all — it is a separate, reversible state",
      exclusionLift(e, 99) === null && exclusionSuspended(e, 36) && !exclusionSuspended(e, 35));
    chk("E10c a missing or corrupt file excludes nothing",
      loadExclusion(`/tmp/explore1828-missing-${TAG}.json`) === null);
  }
  {
    // wq#1839 (2). `Agent.turn` restarts at 1 with the process and the live unit
    // restarts about every 2h — shorter than a 60-turn ban. The three
    // generations in the live stuck_escalation_overrides.jsonl fire at turns
    // 1/184/364, then 101/280/459, then 83/266/445: a turn-keyed ban recovered
    // at turn 1 therefore served its whole span again. Seq does not restart.
    const file = `/tmp/explore1839-${TAG}.json`;
    const e = { v: 2, tiles: ["35,5,24"], map: 35, fromSeq: 21000, untilSeq: 21060,
                fromFire: 3, fires: 0, iso: "" };
    writeFileSync(file, JSON.stringify(e));
    const fresh = new ExclusionGate(file);                 // turn 1 of the next process
    chk("E12 a ban recovered across a restart holds only its REMAINING samples",
      fresh.refuse(21059, 35, 5, 24, "map35") !== null &&
      fresh.refuse(21060, 35, 5, 24, "map35") === null && fresh.current() === null);
    writeFileSync(file, JSON.stringify(e));
    const late = new ExclusionGate(file);
    chk("E12b one whose budget ran out while the process was down is dead on arrival",
      late.refuse(21500, 35, 5, 24, "map35") === null && late.current() === null &&
      !existsSync(file));
    writeFileSync(file, JSON.stringify({ v: 1, tiles: ["35,5,24"], map: 35, untilTurn: 100,
                                         fromFire: 1, fires: 0, iso: "" }));
    chk("E12c a wq#1828 turn-keyed v1 file is dropped, never read as if it were seq",
      loadExclusion(file) === null && new ExclusionGate(file).current() === null);
    try { unlinkSync(file); } catch {}
  }
  {
    // The progress store can also go backwards (restored from a checkpoint).
    // Then the recorded budget is measured against a counter that no longer
    // exists, and holding it would be holding an unknown span.
    const file = `/tmp/explore1839b-${TAG}.json`;
    writeFileSync(file, JSON.stringify({ v: 2, tiles: ["35,5,24"], map: 35, fromSeq: 21000,
                                         untilSeq: 21060, fromFire: 3, fires: 0, iso: "" }));
    const g = new ExclusionGate(file);
    chk("E13 a novelty counter that went backwards lifts it instead of banning for ever",
      g.refuse(12, 35, 5, 24, "map35") === null && g.current() === null && !existsSync(file));
    try { unlinkSync(file); } catch {}
  }

  // --------------------------------------------------- F. the verdict (wq#1746)
  // The end record's `escaped` is the run's own walk: all nine live fires read
  // true while the brain's next goto went straight back in. F covers the record
  // that settles it from where the player actually stood afterwards — including
  // the walk-back E cannot see, the one that ENDS on a patch tile after walking
  // THROUGH it, which the exclusion deliberately allows.
  console.log("=== F. escape verdict ===");
  /** Drive turns until the run ends; the turn it ended on and the line it said. */
  const runOut = async (turn: (n: number) => Promise<string | null>, max = 40) => {
    for (let n = 1; n <= max; n++) {
      const l = await turn(n);
      if (l && /ended/.test(l)) return { turn: n, line: l };
    }
    return { turn: -1, line: "" };
  };
  {
    const { w, turn, records } = stripWorld({ cfg: { verdictTurns: 5 } });
    const { turn: endTurn } = await runOut(turn);
    const end = records().find(r => r.ev === "end");
    chk("F1 an escaped run ends PROVISIONAL and starts watching the patch it left",
      !!end && end.provisional === true && !!end.watch && end.watch.map === 35 &&
      end.watch.keys.length === 22 && end.watch.keys.includes("5,24") &&
      end.watch.untilSeq === end.watch.fromSeq + 5,
      JSON.stringify(end && { prov: end.provisional, keys: end.watch?.keys?.length,
        from: end.watch?.fromSeq, until: end.watch?.untilSeq }));
    for (let t = endTurn + 1; t <= endTurn + 7; t++) await turn(t);
    const v = records().filter(r => r.ev === "verdict");
    chk("F2 staying out for the window settles it as a real escape",
      v.length === 1 && v[0].reason === "held" && v[0].escaped === true &&
      v[0].reentered === false && v[0].fire === 1 && v[0].heldSamples >= 5,
      JSON.stringify(v[0] && { reason: v[0].reason, escaped: v[0].escaped, held: v[0].heldSamples }));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, ov, turn, records } = stripWorld({ cfg: { verdictTurns: 50 } });
    const { turn: endTurn } = await runOut(turn);
    // The live walk-back, and the one the exclusion allows by design: the turn
    // ENDS on a patch tile, whatever the goto's stated destination was.
    w.pos = { map: 35, x: 4, y: 24 };
    await turn(endTurn + 1);
    const v = records().filter(r => r.ev === "verdict");
    chk("F3 standing in the patch again settles it as NOT an escape",
      v.length === 1 && v[0].reason === "reentered" && v[0].escaped === false &&
      v[0].reentered === true && v[0].at.x === 4 && v[0].at.y === 24 && v[0].reenteredSeq > 0,
      JSON.stringify(v[0] && { reason: v[0].reason, escaped: v[0].escaped, at: v[0].at }));
    await turn(endTurn + 2);
    chk("F3b one verdict per fire, not one per turn spent in the patch",
      records().filter(r => r.ev === "verdict").length === 1 && ov.watching() !== null);
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records } = stripWorld({ cfg: { verdictTurns: 8 } });
    const { turn: endTurn } = await runOut(turn);
    w.pos = { map: 36, x: 3, y: 3 };                      // the shuttle: off to Route 25
    for (let t = endTurn + 1; t <= endTurn + 3; t++) await turn(t);
    const mid = records().filter(r => r.ev === "verdict");
    w.pos = { map: 35, x: 5, y: 22 };                     // ...and back to the strip
    await turn(endTurn + 4);
    const v = records().filter(r => r.ev === "verdict");
    chk("F4 a shuttle off the map is not an escape: coming back is still re-entry",
      mid.length === 0 && v.length === 1 && v[0].reason === "reentered" &&
      v[0].escaped === false && v[0].offMapSamples === 3,
      JSON.stringify(v[0] && { off: v[0].offMapSamples, reason: v[0].reason }));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records, gate, seqNow } = stripWorld({ cfg: { verdictTurns: 5 } });
    const { turn: endTurn } = await runOut(turn);
    gate.refuse(seqNow(), 35, 5, 24, "map35");
    gate.refuse(seqNow(), 35, 4, 24, "map35");
    for (let t = endTurn + 1; t <= endTurn + 7; t++) await turn(t);
    const v = records().find(r => r.ev === "verdict");
    chk("F5 the verdict carries what the wq#1828 exclusion did beside its own answer",
      !!v && v.exclusionFires === 2 && v.escaped === true,
      JSON.stringify(v && { fires: v.exclusionFires, escaped: v.escaped }));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, ov, turn, records } = stripWorld({ cfg: { verdictTurns: 0 } });
    const { turn: endTurn } = await runOut(turn);
    for (let t = endTurn + 1; t <= endTurn + 7; t++) await turn(t);
    const end = records().find(r => r.ev === "end");
    chk("F6 LPP_EXPLORE_VERDICT_TURNS=0 is a full revert to the wq#1731 record",
      !!end && end.provisional === false && end.watch === null && ov.watching() === null &&
      !records().some(r => r.ev === "verdict"));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, ov, turn, records } = stripWorld({ enclosed: true, cfg: { verdictTurns: 50 } });
    for (let t = 1; t <= 40; t++) await turn(t);
    const end = records().find(r => r.ev === "end");
    chk("F7 a run that never escaped is judged by nothing — there is no escape to watch",
      !!end && end.escaped === false && end.provisional === false && ov.watching() === null);
    try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records } = stripWorld({ cfg: { verdictTurns: 50 } });
    const { turn: endTurn } = await runOut(turn);
    const cfg = { ...CFG, verdictTurns: 50 };
    const again = new ExplorationOverride({ map: w.g, pos: () => w.pos, step: async () => "moved",
      hop: async () => "moved", samples: () => w.samples, blocked: () => null, logFile: w.log, cfg });
    chk("F8 a restarted agent recovers the watch (turn counters reset, seq does not)",
      (again.watching()?.tiles ?? 0) === 22 && again.watching()!.map === 35 &&
      again.watching()!.untilSeq === records().find(r => r.ev === "end")!.watch.untilSeq,
      String(again.watching()?.untilSeq));
    w.pos = { map: 35, x: 4, y: 24 };
    await again.tick(1);                                   // turn 1 of the new process
    const v = records().filter(r => r.ev === "verdict");
    chk("F8b and settles it, so a restart mid-window cannot launder an escape",
      v.length === 1 && v[0].escaped === false && v[0].reason === "reentered");
    chk("F8c once the verdict is logged there is nothing left to recover",
      recoverWatch(w.log, w.samples[w.samples.length - 1].seq) === null);
    for (let t = endTurn + 1; t <= endTurn + 3; t++) await turn(t);
    chk("F8d and the original instance does not write a second one for the same fire",
      records().filter(r => r.ev === "verdict").length <= 2, String(records().filter(r => r.ev === "verdict").length));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    const { w, turn, records } = stripWorld({ cfg: { windowTurns: 10, verdictTurns: 500 } });
    const { turn: endTurn } = await runOut(turn, 60);
    // Parked off the strip, the samples become a tight pace: the rung fires
    // again while the first escape is still being judged.
    for (let t = endTurn + 1; t <= endTurn + 40; t++) await turn(t);
    const v = records().filter(r => r.ev === "verdict");
    chk("F9 a second fire settles the first escape instead of watching two at once",
      records().filter(r => r.ev === "fire").length >= 2 && v.length === 1 &&
      v[0].reason === "superseded",
      JSON.stringify({ fires: records().filter(r => r.ev === "fire").length, v: v.map(x => x.reason) }));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }

  // ------------------------------------------- G. the patch's map (wq#2160)
  // Every case above starts the player ON the stalled ground, which is the one
  // shape the live shuttle almost never has: STALL_WINDOW ends on Route 25
  // (map36) while the patch it convicts is the map35 strip, and 19 of the 20
  // firing windows in the live fixtures are off the patch's map
  // (docs/VERIFY_1837_EXCLUSION_MAP.md). Fired there, wq#1828 banned Route 25 —
  // the ground the agent was covering — and left the strip open.
  console.log("=== G. the ban lands on the patch's map, not the player's ===");
  /** The live window on open ground, so the escape always has somewhere to go.
   *  The sample log is fixed: this replays a window, it does not grow one. */
  function liveWorld(start: { map: number; x: number; y: number }) {
    const g = new Grid(60, 60);
    const uniq = `${TAG}-${Math.random().toString(36).slice(2)}`;
    const w = {
      g, pos: { ...start }, fires: 0, samples: rehydrate(STALL_WINDOW),
      log: `/tmp/explore2160-${uniq}.jsonl`, exFile: `/tmp/explore2160-${uniq}.json`,
    };
    const gate = new ExclusionGate(w.exFile);
    const move = async (dx: number, dy: number, n: number) => {
      const nx = w.pos.x + dx * n, ny = w.pos.y + dy * n;
      if (!g.passableFrom(w.pos.x, w.pos.y, nx, ny)) return "blocked";
      w.pos = { ...w.pos, x: nx, y: ny };
      return "moved";
    };
    const ov = new ExplorationOverride({
      map: g, pos: () => ({ ...w.pos }),
      step: (dx, dy) => move(dx, dy, 1), hop: (dx, dy) => move(dx, dy, 2),
      samples: () => w.samples, blocked: () => null, onFire: () => { w.fires++; },
      exclude: e => gate.set(e), exclusionFires: () => gate.peek()?.fires ?? 0,
      logFile: w.log, cfg: CFG,
    });
    const records = () => existsSync(w.log)
      ? readFileSync(w.log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    const seqNow = () => w.samples[w.samples.length - 1].seq;
    return { w, ov, records, gate, seqNow };
  }
  const onMap = (tiles: string[], map: number) => tiles.filter(k => k.startsWith(`${map},`)).length;
  {
    const live = rehydrate(STALL_WINDOW);
    const last = live[live.length - 1];
    const v = assessStall(live, 0, CFG);
    chk("G1 the live window's own last sample is off the patch it convicts",
      last.map === 36 && v.trigger === "dominant_patch" && v.patch!.map === 35,
      JSON.stringify({ standing: last.map, patch: v.patch!.map }));
    chk("G1b stallMap blames the patch, not the player's map", stallMap(v, last) === 35);
    chk("G1c and blames where you stand when the verdict has no patch to point at",
      stallMap(assessStall(strip(150), 0, CFG), { map: 99, x: 1, y: 1 }) === 99);
  }
  {
    const { w, ov, records, gate, seqNow } = liveWorld({ map: 36, x: 7, y: 4 });
    const held: (string | null)[] = [];
    for (let t = 1; t <= 6; t++) held.push(await ov.tick(t));
    const defers = records().filter(r => r.ev === "defer");
    chk("G2 standing on Route 25 the rung holds instead of firing on Route 25",
      held.every(l => l === null) && w.fires === 0 && !records().some(r => r.ev === "fire") &&
      w.pos.x === 7 && w.pos.y === 4,
      JSON.stringify({ lines: held.filter(Boolean).length, at: w.pos }));
    chk("G2b the hold is logged once, naming the map it is waiting for",
      defers.length === 1 && defers[0].waitingFor === 35 && defers[0].at.map === 36 &&
      defers[0].trigger === "dominant_patch" && defers[0].patch.at[0] === 35,
      JSON.stringify(defers.map(d => ({ wait: d.waitingFor, at: d.at.map }))));

    w.pos = { map: 35, x: 4, y: 24 };                     // the shuttle swings back
    const fired = await ov.tick(7);
    const fire = records().find(r => r.ev === "fire");
    chk("G3 back on the strip it fires, and counts the turns it waited",
      !!fired && !!fire && fire.at.map === 35 && fire.trigger === "dominant_patch" &&
      fire.deferredTurns === 6, JSON.stringify(fire && { at: fire.at, held: fire.deferredTurns }));

    for (let t = 8; t <= 45 && ov.active(); t++) await ov.tick(t);
    const e = gate.current();
    chk("G4 the ban is the patch's map — the defect was 10 map36 tiles and 0 strip tiles",
      !!e && e.map === 35 && onMap(e.tiles, 35) === e.tiles.length && e.tiles.length > 0 &&
      onMap(e.tiles, 36) === 0,
      JSON.stringify(e && { map: e.map, strip: onMap(e.tiles, 35), route25: onMap(e.tiles, 36) }));
    chk("G4b so the walk back into the strip is refused",
      gate.refuse(seqNow(), 35, 4, 24, "map35") !== null);
    chk("G4c and Route 25, the ground it was covering, is not",
      gate.refuse(seqNow(), 36, 7, 4, "map36") === null);
    const end = records().find(r => r.ev === "end");
    chk("G4d the escape walked out of the strip, not off Route 25",
      !!end && end.from.map === 35 && end.at.map === 35 && end.escaped === true,
      JSON.stringify(end && { from: end.from, at: end.at, reason: end.reason }));
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }
  {
    // The hold needs no timeout: the verdict is a share of the last windowTurns
    // samples, so an agent that stays away loses the patch and the hold lapses.
    const { w, ov, records, gate } = liveWorld({ map: 36, x: 7, y: 4 });
    await ov.tick(1);
    const from = w.samples[w.samples.length - 1].seq;
    w.samples = w.samples.concat(Array.from({ length: CFG.windowTurns }, (_, i) =>
      ({ ...sample(36, i % 40, 4 + (i % 3), 1), seq: from + 1 + i, turn: from + 1 + i })));
    const after = await ov.tick(2);
    w.pos = { map: 35, x: 4, y: 24 };
    const back = await ov.tick(3);
    chk("G5 a hold whose window recovered lapses — it is not a fire queued for later",
      records().filter(r => r.ev === "defer").length === 1 && after === null && back === null &&
      !records().some(r => r.ev === "fire") && gate.current() === null && w.fires === 0);
    try { unlinkSync(w.exFile); } catch {} try { unlinkSync(w.log); } catch {}
  }

  try { unlinkSync(process.env.LPP_OVERRIDE_LOG!); } catch {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
