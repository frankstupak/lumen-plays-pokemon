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
import { fixtureIndex, haveSamples } from "./fixtures";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const MAP = 61, TX = 12, TY = 7;
const STRIP_Y = new Set([10, 11]);

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

interface StepRec { ev: string; from?: number[]; want?: number[]; to?: number[];
                    r?: string; moved?: boolean; head?: number[][]; len?: number;
                    blocked?: string[]; replan?: number; at?: any }

interface Journey {
  file: string; start: { x: number; y: number }; result: string;
  recs: StepRec[]; planEscapesAt: number; leftStrip: boolean;
}

async function runJourney(path: string, sc: any, tx = TX, ty = TY): Promise<Journey | null> {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, path); } catch { return null; }
  const st = new StateReader(emu, sym).read();
  if (st.map !== MAP) return null;
  if (!STRIP_Y.has(st.y)) return null;          // only the confinement strip

  const map = new MapModel(emu, sym, rom); map.build();
  const dir = mkdtempSync(join(tmpdir(), "lpp542-"));
  const bus = new EventBus(dir, "probe542");
  const recs: StepRec[] = [];
  bus.on((e: any) => { if (e.kind === "nav_trace") recs.push(e); });
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);

  // What A* says BEFORE we move: at which step does the plan leave y=10..11?
  const p0 = astar(map, st.x, st.y, tx, ty, new Set());
  const planEscapesAt = p0 ? p0.findIndex(c => !STRIP_Y.has(c.y)) + 1 : -1;

  const result = await nav.goto(tx, ty);
  const leftStrip = recs.some(r => r.ev === "step" && r.to && !STRIP_Y.has(r.to[1]));
  return { file: path.split("/").pop()!, start: { x: st.x, y: st.y },
           result, recs, planEscapesAt, leftStrip };
}

/** A target the agent CAN legally reach, inside the strip, for exercising the
 *  nav_trace plumbing. Chosen by asking A* rather than by assuming geometry. */
function reachableTarget(path: string): { x: number; y: number } | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, path); } catch { return null; }
  const st = new StateReader(emu, sym).read();
  if (st.map !== MAP || !STRIP_Y.has(st.y)) return null;
  const map = new MapModel(emu, sym, rom); map.build();
  for (const dx of [-3, 3, -2, 2, -4, 4, -1, 1]) {
    for (const y of [st.y, st.y === 10 ? 11 : 10]) {
      const x = st.x + dx;
      if (x < 0 || x >= map.gw) continue;
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
  chk("F1 fixtures available", idx.length > 0, `${idx.length} map61 checkpoints`);

  const journeys: Journey[] = [];
  for (const f of idx) {
    if (journeys.length >= limit) break;
    const j = await runJourney(f.path, f.sc);
    if (j) journeys.push(j);
  }
  chk("F2 journeys driven from inside the strip", journeys.length > 0,
      `${journeys.length} journeys`);
  if (!journeys.length) { console.log(`\n${pass} passed / ${fail} failed`); process.exit(fail ? 1 : 0); }

  // ---- A. THE TICKET'S QUESTION, RE-BASED BY wq#553 -----------------------
  // wq#542 asked "does the plan escape while execution does not?" and the answer
  // was yes: 12/12 planned, 0/12 executed. wq#552 found why — A* was routing
  // through a phantom opening, because MapModel had no representation of Gen 1
  // TILE-PAIR collisions and the y=12 boundary (tile 0x05) is refused from the
  // strip floor (tile 0x20) despite 0x05 being in the tileset's passable list.
  //
  // So this assertion is re-pointed, NOT inverted. The old A1 asserted the
  // phantom opening still exists and would now fail by design. The corrected
  // expectation is that A* NO LONGER PLANS A ROUTE THE EMULATOR REFUSES. It is
  // not "the agent escapes": there is no legal southward exit to find, every
  // non-terrain column of y=12 is 0x05, and probe_collision552 measures that
  // against raw emulator presses on all 11 decided columns.
  const planned = journeys.filter(j => j.planEscapesAt > 0);
  const worst = planned.length ? Math.max(...planned.map(j => j.planEscapesAt)) : 0;
  chk("A1 A* no longer plans a southward escape the emulator refuses",
      planned.length === 0,
      `${planned.length}/${journeys.length} still plan an escape` +
      (planned.length ? `, latest at planned step ${worst}` : ""));

  // ---- B. DID EXECUTION FOLLOW IT? ----------------------------------------
  const left = journeys.filter(j => j.leftStrip).length;
  console.log(`\n# B. EXECUTION: ${left}/${journeys.length} journeys actually placed the ` +
              `agent on a tile outside y=10..11`);

  // ---- C. PER-STEP LEDGER --------------------------------------------------
  const results = new Map<string, number>();
  let southAttempts = 0, southBlocked = 0, southMoved = 0;
  for (const j of journeys) for (const r of j.recs) {
    if (r.ev !== "step") continue;
    results.set(r.r!, (results.get(r.r!) ?? 0) + 1);
    const leavingSouth = r.want && !STRIP_Y.has(r.want[1]) && r.want[1] === 12;
    if (leavingSouth) {
      southAttempts++;
      if (r.r === "blocked") southBlocked++;
      if (r.moved) southMoved++;
    }
  }
  console.log(`# C. step results: ${[...results].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`# C. southward escape attempts (want y=12): ${southAttempts} ` +
              `blocked=${southBlocked} moved=${southMoved}`);
  // The churn itself, asserted. wq#542 measured 90 attempts of which 83 were
  // blocked and 0 moved — the agent spending its turns on a step the game was
  // never going to allow. Zero attempts is the point of wq#552; a non-zero
  // count here means the tile-pair rule has stopped reaching A*.
  chk("C1 the agent no longer ATTEMPTS the refused southward step",
      southAttempts === 0, `${southAttempts} attempts (${southBlocked} blocked, ${southMoved} moved)`);
  chk("C2 and if it ever does attempt one, it must not be silently blocked",
      southMoved === 0 && southBlocked === 0,
      `blocked=${southBlocked} moved=${southMoved}`);

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
    console.log(`\n# ${j.file} start=(${j.start.x},${j.start.y}) -> ${j.result} ` +
                `planEscapesAt=${j.planEscapesAt} leftStrip=${j.leftStrip}`);
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
  // wq#553: these used to run against the journeys above, which is only sound
  // while those journeys DO something. Once wq#552 taught A* the tile-pair rule
  // the goto to the exit correctly returns no path, so there is no plan and no
  // step to trace and F3/F4/F5 went red — reporting broken instrumentation when
  // the instrumentation was fine. The plumbing was being exercised *by the bug*.
  // It is now exercised against a target A* says is genuinely reachable, so it
  // tests nav_trace and nothing else.
  const reachJourneys: Journey[] = [];
  for (const f of idx) {
    if (reachJourneys.length >= 3) break;
    const t = reachableTarget(f.path);
    if (!t) continue;
    const j = await runJourney(f.path, f.sc, t.x, t.y);
    if (j) { reachJourneys.push(j); console.log(`# F. plumbing journey ${j.file} -> (${t.x},${t.y}) = ${j.result}`); }
  }
  chk("F2b a reachable in-strip target could be driven at all",
      reachJourneys.length > 0, `${reachJourneys.length} journeys`);
  const anyPlan = reachJourneys.some(j => j.recs.some(r => r.ev === "plan"));
  const anyStep = reachJourneys.some(j => j.recs.some(r => r.ev === "step"));
  chk("F3 nav_trace emits plans", anyPlan);
  chk("F4 nav_trace emits per-step intent vs actual", anyStep);
  // NOTE THE GUARD, and it is not decoration: written without it this assertion
  // PASSED with the instrumentation switched off, because [].every() is true.
  // That is wq#540's R3 empty-corpus shape reappearing in the probe filed to
  // measure a different bug. A green tick must never be able to mean "nothing
  // was checked", so the count is asserted before the property.
  const stepRecs = reachJourneys.flatMap(j => j.recs.filter(r => r.ev === "step"));
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
  const g = idx.find(f => f.sc.map === MAP && f.sc.y === 11 && f.sc.x >= 33);
  if (!g) { chk("G0 a y=11 x>=33 fixture exists", false, "no sample"); }
  else {
    const emu = new Emulator(ROM); loadSnapshotFile(emu, g.path);
    const mm = new MapModel(emu, sym, rom); mm.build();
    const sy2 = new Sync(emu, sym);
    const gx = g.sc.x;
    chk("G1 terrain passability ALONE still calls the southward tile walkable",
        mm.passable(gx, 12), `(${gx},12) passable=${mm.passable(gx, 12)}`);
    // wq#552 deliberately left passable() terrain-only and put the pair rule in
    // passableFrom(). G1 documents why terrain alone is not enough; G1b asserts
    // the model now reaches the same verdict as the emulator does in G2.
    chk("G1b but MapModel.passableFrom() now agrees with the emulator and refuses the step",
        !mm.passableFrom(gx, 11, gx, 12),
        `passableFrom(${gx},11 -> ${gx},12)=${mm.passableFrom(gx, 11, gx, 12)} ` +
        `pairBlocked=${mm.pairBlocked(gx, 11, gx, 12)}`);
    const yOf = () => emu.mem()[sym.addr("wYCoord")];
    const press = async (key: number, n: number) => {
      for (let i = 0; i < n; i++) {
        await emu.tapAsync(key, 8, 2); await emu.framesAsync(22); await sy2.settle(300);
        if (emu.mem()[sym.addr("wIsInBattle")] !== 0) return "battle";
      }
      return "ok";
    };
    const y0 = yOf();
    const dr = await press(KEYS.DOWN, 6);
    const yDown = yOf();
    chk("G2 the EMULATOR refuses that step — the barrier is real, step() is honest",
        dr === "battle" ? true : yDown === y0,
        `6 raw DOWN presses: y ${y0} -> ${yDown} (${dr})`);
    const ur = await press(KEYS.UP, 3);
    chk("G3 the same tile column moves freely NORTH, so this is not a stuck emulator",
        ur === "battle" ? true : yOf() < y0, `y ${y0} -> ${yOf()} (${ur})`);
  }

  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
