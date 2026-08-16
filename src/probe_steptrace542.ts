// wq#542 — per-step path visibility, and the experiment it exists to make possible.
//
// THE QUESTION, and it is one question: the agent walked 919 manhattan steps
// inside TWENTY tiles (x=24..35, y=10..11) over three and a half hours on an
// open floor, with A* returning a valid route to a reachable target on 191 of
// 194 attempts. Does the PLANNED PATH leave that strip? If yes, movement is
// being undone somewhere between the plan and the emulator. If no, A* is
// planning inside the strip and encounters were never the story.
//
// WHY A PROBE AND NOT A LOG READ. The turn-level event log records position
// ONCE PER TURN, POST-ACTION. Every decision inside nav.goto — the plan, each
// step's intent, each step's result — is invisible in it. That confound has now
// defeated three separate measurements (rabbit16's resume displacement, which
// its own author withdrew; rabbit14's "something is choosing east", which its
// own author withdrew; and the ticket text I inherited, which still carries the
// withdrawn version). This probe drives the REAL Navigator against REAL
// checkpoints and records what the log cannot.
//
// ISOLATION. The EventBus here writes to a private mkdtemp directory, never
// events/. Nothing in this file writes to checkpoints/ or saves/ (wq#540:
// probe_s4 was one invocation away from unlinking the live corpus because it
// passed a bare "checkpoints" as a checkpointDir). Fixtures are resolved BY
// PROPERTY, never by name (wq#540 again).
//
// wq#588 REBASE (2026-08-14): the breakout ERASED the confinement-strip corpus
// — zero live or archived checkpoints at y=10..11 remain (live map61
// y-histogram that day: 6..9,14,16..18,28). The old F2 required journeys
// started INSIDE the strip and went red on corpus rotation: wq#540's
// live-corpus-assert rot, the same class as probe_claims K (wq#584) and
// probe_pocket534 D3 (wq#586). Rebased so every assertion is either a PURE
// GEOMETRY property (A* over MapModel needs no player anywhere — A1 now sweeps
// ALL 24 strip cells instead of sampling wherever checkpoints happened to sit)
// or a driven journey from wherever the corpus actually is (repel-armed per
// wq#559 so wilds cannot fake a red). G2/G3 still need a body at y=11: resolve
// by property, else walk in via pair-aware goto, else SKIP legibly.
//
// Usage: npx tsx src/probe_steptrace542.ts [maxCheckpoints]
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { EventBus } from "./events";
import { Sync } from "./sync";
import { Navigator, astar } from "./nav";
import { fixtureIndex, haveSamples, copyFixture } from "./fixtures";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const MAP = 61, TX = 12, TY = 7;
// (wq#588: the y=10..11 STRIP_Y gate is gone — see the rebase note above.)

let pass = 0, fail = 0, skip = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};
/** wq#554: a check a fixture could not exercise is NOT a pass.
 *
 *  G2/G3 used to read `dr === "battle" ? true : <real check>`, so an unlucky
 *  wild encounter greened a check that never touched the wall. rabbit17b found
 *  this in the INHERITED G2 during wq#542 and it survived the wq#553 re-point.
 *  probe_wall542 and probe_collision552 both got this right — record the battle
 *  as inconclusive and report it separately — and this is that shape. */
const skipped = (name: string, why: string) => {
  skip++; console.log(`SKIP ${name} :: ${why}`);
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

interface StepRec { ev: string; from?: number[]; want?: number[]; to?: number[];
                    r?: string; moved?: boolean; head?: number[][]; len?: number;
                    blocked?: string[]; replan?: number; at?: any }

interface Journey {
  file: string; start: { x: number; y: number }; target: { x: number; y: number };
  result: string; recs: StepRec[];
}

/** wq#588: probes own their environment — a wild mid-journey is RNG, not the
 *  code under test. The lead outlevels every Mt-Moon-era wild (wq#559). */
function armRepel(emu: Emulator, steps = 200) {
  emu.mem()[sym.addr("wRepelRemainingSteps")] = steps;
}

async function runJourney(path: string, tx: number, ty: number): Promise<Journey | null> {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, path); } catch { return null; }
  const st = new StateReader(emu, sym).read();
  if (st.map !== MAP) return null;
  if (st.inBattle !== 0) return null;           // wq#588: any map61 start, out of battle
  armRepel(emu);

  const map = new MapModel(emu, sym, rom); map.build();
  const dir = mkdtempSync(join(tmpdir(), "lpp542-"));
  const bus = new EventBus(dir, "probe542");
  const recs: StepRec[] = [];
  bus.on((e: any) => { if (e.kind === "nav_trace") recs.push(e); });
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);

  const result = await nav.goto(tx, ty);
  return { file: path.split("/").pop()!, start: { x: st.x, y: st.y },
           target: { x: tx, y: ty }, result, recs };
}

/** A target the agent CAN legally reach near its OWN position (wq#588: no
 *  strip requirement — the corpus no longer has one), for exercising the
 *  nav_trace plumbing. Chosen by asking A* rather than by assuming geometry. */
function reachableTarget(path: string): { x: number; y: number } | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, path); } catch { return null; }
  const st = new StateReader(emu, sym).read();
  if (st.map !== MAP || st.inBattle !== 0) return null;
  const map = new MapModel(emu, sym, rom); map.build();
  for (const dx of [-3, 3, -2, 2, -4, 4, -1, 1]) {
    for (const dy of [0, -1, 1, -2, 2]) {
      const x = st.x + dx, y = st.y + dy;
      if (x < 0 || x >= map.gw || y < 0) continue;
      // The target must be a genuinely PASSABLE, non-warp, unoccupied cell:
      // astar deliberately exempts the goal from the terrain test (doors and
      // other warp tiles read impassable), so asking only "did astar return a
      // path?" accepts targets the emulator will refuse forever. That is not a
      // nav defect — goal leniency is for callers who mean it (goto a door) —
      // but a probe that picks a rock and then calls the honest `blocked` a
      // plan/exec divergence is testing its own fixture chooser. Found the
      // hard way on 2026-08-14: 7/12 journeys "stuck" walking 85-step routes
      // whose final cell was impassable terrain.
      if (!map.passable(x, y) || map.isWarp(x, y)) continue;
      if (map.sprites.some(s => s.x === x && s.y === y)) continue;
      const p = astar(map, st.x, st.y, x, y, new Set());
      if (p && p.length >= 2) return { x, y };
    }
  }
  return null;
}

(async () => {
  const limit = Number(process.argv[2] ?? 12);
  const idx = fixtureIndex().filter(f => f.sc.map === MAP);
  haveSamples("map61 checkpoints", idx.length);
  // wq#643: a missing fixture is corpus rot, not a code defect — F1 used to
  // chk(false) here, which both failed the suite red AND left every idx[0]
  // access below it unguarded (crashed on "Cannot read properties of
  // undefined" the moment the corpus had zero map61 checkpoints).
  if (idx.length > 0) chk("F1 fixtures available", true, `${idx.length} map61 checkpoints`);
  else skipped("F1 fixtures available", "no map61 checkpoints on disk (corpus rotated)");

  // ---- A. THE TICKET'S QUESTION, AS PURE GEOMETRY (wq#553 via wq#588) ------
  // wq#542 asked "does the plan escape while execution does not?" and the answer
  // was yes: 12/12 planned, 0/12 executed. wq#552 found why — A* was routing
  // through a phantom opening, because MapModel had no representation of Gen 1
  // TILE-PAIR collisions and the y=12 boundary (tile 0x05) is refused from the
  // strip floor (tile 0x20) despite 0x05 being in the tileset's passable list.
  //
  // wq#588: the corrected expectation — A* NO LONGER PLANS A ROUTE THE EMULATOR
  // REFUSES — is a property of MapModel + astar, not of where a save file left
  // the player. So it no longer samples journeys from a corpus that has moved
  // on; it sweeps EVERY passable strip cell. There is no legal southward exit:
  // every non-terrain column of y=12 is 0x05, and probe_collision552 measures
  // that against raw emulator presses on all 11 decided columns.
  if (idx.length === 0) {
    skipped("A0-A1 sealed-strip sweep", "no map61 checkpoint on disk to build a MapModel from (corpus rotated)");
  } else {
    const emuA = new Emulator(ROM);
    loadSnapshotFile(emuA, idx[0].path);
    const mmA = new MapModel(emuA, sym, rom); mmA.build();
    let cells = 0, escapes = 0;
    const escaped: string[] = [];
    for (let x = 24; x <= 35; x++) for (const y of [10, 11]) {
      if (!mmA.passable(x, y)) continue;
      cells++;
      if (astar(mmA, x, y, TX, TY, new Set())) { escapes++; escaped.push(`(${x},${y})`); }
    }
    // Count first (wq#540 R3): a sweep over zero cells must not green.
    chk("A0 the strip has passable cells to sweep", cells > 0, `${cells} cells`);
    chk("A1 A* plans NO route out of the sealed strip, from ANY strip cell",
        cells > 0 && escapes === 0,
        `${escapes}/${cells} cells still find a route to (${TX},${TY})` +
        (escaped.length ? ` — ${escaped.slice(0, 4).join(" ")}` : ""));
  }

  // ---- JOURNEYS: the REAL Navigator, from where the corpus actually is -----
  // wq#588: starts are any out-of-battle map61 checkpoint, target is a nearby
  // cell A* itself approves, repel armed. These journeys feed C/D/E/F below.
  const journeys: Journey[] = [];
  for (const f of idx) {
    if (journeys.length >= limit) break;
    const t = reachableTarget(f.path);
    if (!t) continue;
    const j = await runJourney(f.path, t.x, t.y);
    if (j) journeys.push(j);
  }
  if (journeys.length > 0) {
    chk("F2 journeys driven from live map61 checkpoints", true, `${journeys.length} journeys`);
  } else if (idx.length === 0) {
    // Same corpus-rot condition F1 already named; not a second, independent defect.
    skipped("F2 journeys driven from live map61 checkpoints", "no map61 checkpoints on disk (corpus rotated)");
  } else {
    // idx had candidates but NONE produced a journey — reachableTarget()/
    // runJourney() finding nothing from a real corpus is a code question, not
    // a fixture-availability one, so this stays a real FAIL.
    chk("F2 journeys driven from live map61 checkpoints", false,
        `0 journeys from ${idx.length} map61 checkpoint(s) on disk`);
  }
  if (!journeys.length) {
    const skipNote = skip ? ` / ${skip} skipped` : "";
    console.log(`\n${pass} passed / ${fail} failed${skipNote}`);
    process.exit(fail ? 1 : 0);
  }

  // ---- C. PER-STEP LEDGER --------------------------------------------------
  // wq#588 rebase: the strip-specific churn counters (southward attempts) are
  // vacuous from non-strip starts, so C now asserts what any driven journey
  // must satisfy: (C1) an A*-approved target with wilds suppressed MUST be
  // reached — a `stuck` here is exactly the plan-vs-execution divergence this
  // probe was filed to expose; (C2) the trace never contradicts itself — a
  // step reported `blocked` cannot also claim the player moved.
  const results = new Map<string, number>();
  let contradictions = 0;
  for (const j of journeys) for (const r of j.recs) {
    if (r.ev !== "step") continue;
    results.set(r.r!, (results.get(r.r!) ?? 0) + 1);
    if (r.r === "blocked" && r.moved) contradictions++;
  }
  console.log(`\n# C. step results: ${[...results].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const arrived = journeys.filter(j => j.result === "arrived").length;
  const stuck = journeys.filter(j => j.result === "stuck").length;
  chk("C1 A*-approved targets are reached, never 'stuck' (plan/exec agreement)",
      arrived > 0 && stuck === 0,
      `${arrived}/${journeys.length} arrived, ${stuck} stuck ` +
      `(others: ${journeys.filter(j => j.result !== "arrived" && j.result !== "stuck")
                          .map(j => j.result).join(",") || "none"})`);
  chk("C2 no step record contradicts itself (blocked AND moved)",
      contradictions === 0, `${contradictions} contradictions`);

  // ---- D. DID A JOURNEY TALK ITSELF INTO A BOX? ---------------------------
  // wq#542 / rabbit17b: this used to derive maxBlocked from `exhausted` records
  // ONLY. Nothing here exhausts 25 replans — every journey ends in `battle`
  // first — so exh was empty and this printed "largest ... 0 cells" while the
  // plan records above it visibly carried [31,12 32,12 33,12 34,12]. Read
  // literally it says learnedBlocked never accumulates, which is the exact
  // OPPOSITE of what the trace shows and would have killed the accumulation
  // hypothesis on a reporting bug. learnedBlocked is echoed on every `plan`,
  // so measure it there and keep the exhausted view as a separate line.
  const exh = journeys.flatMap(j => j.recs.filter(r => r.ev === "exhausted"));
  const planBlocked = journeys.map(j =>
    Math.max(0, ...j.recs.filter(r => r.ev === "plan").map(r => (r.blocked ?? []).length)));
  const maxBlocked = Math.max(0, ...planBlocked);
  console.log(`# D. journeys that exhausted 25 replans: ${exh.length}; ` +
              `largest per-journey learnedBlocked set: ${maxBlocked} cells ` +
              `(measured on plan records, not on exhaustion)`);
  const growing = planBlocked.filter(n => n >= 2).length;
  console.log(`# D. journeys whose learnedBlocked grew to >=2 cells WITHIN one goto: ` +
              `${growing}/${journeys.length}`);
  // wq#542 measured 11/12. Every one of those cells was a phantom: A* planned
  // through the y=12 barrier, step() honestly reported blocked, and the model
  // learned a wall that its own map should have known about. With the tile-pair
  // rule in the model there is nothing left to learn the hard way.
  chk("D1 learnedBlocked no longer accumulates phantom walls within a single goto",
      growing === 0, `${growing}/${journeys.length} journeys grew to >=2 cells`);
  for (const r of exh.slice(0, 3))
    console.log(`#    exhausted at (${r.at}) blocked=[${(r.blocked ?? []).join(" ")}]`);

  // ---- E. NARRATE THE FIRST FEW JOURNEYS ----------------------------------
  for (const j of journeys.slice(0, 6)) {
    console.log(`\n# ${j.file} start=(${j.start.x},${j.start.y}) -> ` +
                `(${j.target.x},${j.target.y}) = ${j.result}`);
    for (const r of j.recs.slice(0, 14)) {
      if (r.ev === "plan")
        console.log(`    plan#${r.replan} len=${r.len} head=${(r.head ?? []).map(c => `(${c})`).join("")}` +
                    ` blocked=[${(r.blocked ?? []).join(" ")}]`);
      else if (r.ev === "step")
        console.log(`    step (${r.from}) -> want(${r.want}) = ${r.r} now(${r.to})`);
      else if (r.ev === "desync")
        console.log(`    desync at (${r.at?.x},${r.at?.y}) want(${r.want})`);
      else if (r.ev === "exhausted")
        console.log(`    EXHAUSTED at (${r.at}) blocked=${(r.blocked ?? []).length}`);
    }
  }

  // ---- F. THE INSTRUMENTATION ITSELF MUST BE LOAD-BEARING -----------------
  // wq#553: these used to run against strip-exit journeys, which was only sound
  // while those journeys DID something. Once wq#552 taught A* the tile-pair rule
  // the goto to the exit correctly returns no path, so there was no plan and no
  // step to trace and F3/F4/F5 went red — reporting broken instrumentation when
  // the instrumentation was fine. The plumbing was being exercised *by the bug*.
  // wq#588: the journeys above already run against targets A* says are genuinely
  // reachable, so they exercise nav_trace and nothing else — assert on them
  // directly instead of driving a second, redundant set.
  const anyPlan = journeys.some(j => j.recs.some(r => r.ev === "plan"));
  const anyStep = journeys.some(j => j.recs.some(r => r.ev === "step"));
  chk("F3 nav_trace emits plans", anyPlan);
  chk("F4 nav_trace emits per-step intent vs actual", anyStep);
  // NOTE THE GUARD, and it is not decoration: written without it this assertion
  // PASSED with the instrumentation switched off, because [].every() is true.
  // That is wq#540's R3 empty-corpus shape reappearing in the probe filed to
  // measure a different bug. A green tick must never be able to mean "nothing
  // was checked", so the count is asserted before the property.
  const stepRecs = journeys.flatMap(j => j.recs.filter(r => r.ev === "step"));
  chk("F5 every step record carries want, result and resulting position",
      stepRecs.length > 0 && stepRecs.every(r => r.want && r.r && r.to),
      `${stepRecs.length} step records`);

  // ---- G. GROUND TRUTH: THE BARRIER MapModel CANNOT SEE ---------------------
  // Gen 1 has TILE-PAIR collisions: pairs of individually-walkable tiles you
  // cannot walk BETWEEN. The ROM ships CheckForTilePairCollisions; MapModel
  // models collision per tile only and has no equivalent. On Mt Moon B2F
  // (tileset 17, CAVERN) the y=11 -> y=12 boundary is the pair 0x20 -> 0x05.
  // These assertions are properties of the GAME, so a future MapModel that
  // learns the rule keeps them green and one that regresses fails them.
  // wq#588: G1/G1b are properties of the MODEL over fixed map geometry — the
  // player's position in the save is irrelevant, so they no longer hide behind
  // a y=11 fixture that rotation has retired. Any map61 save serves; the column
  // is fixed at x=33, one of the 11 decided columns wq#552 measured.
  {
    const emuG = new Emulator(ROM); loadSnapshotFile(emuG, idx[0].path);
    const mm = new MapModel(emuG, sym, rom); mm.build();
    const gx = 33;
    chk("G1 terrain passability ALONE still calls the southward tile walkable",
        mm.passable(gx, 12), `(${gx},12) passable=${mm.passable(gx, 12)}`);
    // wq#552 deliberately left passable() terrain-only and put the pair rule in
    // passableFrom(). G1 documents why terrain alone is not enough; G1b asserts
    // the model now reaches the same verdict as the emulator does in G2.
    chk("G1b but MapModel.passableFrom() now agrees with the emulator and refuses the step",
        !mm.passableFrom(gx, 11, gx, 12),
        `passableFrom(${gx},11 -> ${gx},12)=${mm.passableFrom(gx, 11, gx, 12)} ` +
        `pairBlocked=${mm.pairBlocked(gx, 11, gx, 12)}`);
  }
  // G2/G3 press real buttons, so they DO need a body standing at y=11 x>=33.
  // Resolve by property; when the corpus has none, nothing can put one there —
  // A1 just proved the sealed strip has no walking route, so a goto walk-in is
  // impossible by the same geometry this file asserts. SKIP legibly (wq#554:
  // inconclusive is not passing, and it is not failing either). Emulator-side
  // barrier ground truth also lives in probe_collision552.
  const g = idx.find(f => f.sc.y === 11 && f.sc.x >= 33);
  if (!g) {
    const why = "no y=11 x>=33 checkpoint on disk (breakout retired the strip corpus) " +
                "and the sealed strip cannot be walked into, per A1";
    skipped("G2 the EMULATOR refuses that step", why);
    skipped("G3 the same tile column moves freely NORTH", why);
  }
  else {
    // wq#551 R4: this section reloads the same checkpoint up to
    // LPP_G23_ATTEMPTS + 1 times, and the live service's pruneAuto() unlinks
    // auto-* checkpoints on every write. wq#552 lost a run to exactly that.
    // Copy once, up front, and read only the copy from here down.
    const fixture = copyFixture(g.path);
    // wq#554: G2/G3 are the only assertions here that ask the EMULATOR rather
    // than the model, which makes them the load-bearing pair — and they were the
    // ones a wild encounter could green without touching the wall. Retry from a
    // FRESH LOAD a bounded number of times; if a battle keeps interrupting,
    // report SKIP and let the reader see that nothing was measured.
    //
    // The fixture is copied once (wq#551 R4): this loop reloads the same
    // checkpoint up to LPP_G23_ATTEMPTS times, and the live service's
    // pruneAuto() unlinks auto-* checkpoints on every write. wq#552 lost a run
    // to exactly that.
    const ATTEMPTS = Number(process.env.LPP_G23_ATTEMPTS ?? 4);
    let battles = 0, used = 0;
    let out: { y0: number; yDown: number; dr: string; yUp: number; ur: string } | null = null;

    for (let a = 1; a <= ATTEMPTS && !out; a++) {
      used = a;
      const e2 = new Emulator(ROM);
      try { loadSnapshotFile(e2, fixture); } catch { break; }
      const s3 = new Sync(e2, sym);
      const yOf2 = () => e2.mem()[sym.addr("wYCoord")];
      const press2 = async (key: number, n: number) => {
        for (let i = 0; i < n; i++) {
          await e2.tapAsync(key, 8, 2); await e2.framesAsync(22); await s3.settle(300);
          if (e2.mem()[sym.addr("wIsInBattle")] !== 0) return "battle";
        }
        return "ok";
      };
      const y0 = yOf2();
      const dr = await press2(KEYS.DOWN, 6);
      if (dr === "battle") { battles++; continue; }
      const yDown = yOf2();
      const ur = await press2(KEYS.UP, 3);
      if (ur === "battle") { battles++; continue; }
      out = { y0, yDown, dr, yUp: yOf2(), ur };
    }

    if (!out) {
      const why = `a wild battle interrupted all ${used} attempt(s) (${battles} battles). ` +
                  `INCONCLUSIVE, not passing — nothing here touched the wall.`;
      skipped("G2 the EMULATOR refuses that step", why);
      skipped("G3 the same tile column moves freely NORTH", why);
    } else {
      chk("G2 the EMULATOR refuses that step — the barrier is real, step() is honest",
          out.yDown === out.y0,
          `6 raw DOWN presses: y ${out.y0} -> ${out.yDown} (attempt ${used}/${ATTEMPTS}, ${battles} battle retries)`);
      chk("G3 the same tile column moves freely NORTH, so this is not a stuck emulator",
          out.yUp < out.y0, `y ${out.y0} -> ${out.yUp} (${out.ur})`);
    }
  }

  const skipNote = skip ? ` / ${skip} skipped` : "";
  console.log(`\n${pass} passed / ${fail} failed${skipNote}`);
  process.exit(fail ? 1 : 0);
})();
