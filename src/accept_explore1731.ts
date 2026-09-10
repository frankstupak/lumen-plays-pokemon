// wq#1731 ACCEPTANCE (replay) — the exploration override breaks the live Route
// 24 grass-strip stall inside the REAL object graph: real emulator, real
// Agent.runTurn() ladder, real MapModel/Navigator on map35's real geometry.
// The brain is a local stub that does what the live brain did for weeks: pace
// the x=4..5 strip, flee wild battles. No gateway, no network.
//
//   LPP_ACCEPT_PHASE=A npx tsx src/accept_explore1731.ts   # live window seeded
//   LPP_ACCEPT_PHASE=B npx tsx src/accept_explore1731.ts   # detect from scratch
//
// A: runtime/progress.json + visited_tiles.json are COPIED from the live
//    deployment (the 500-sample stall itself) and defaults are left alone, so
//    the rung has to fire on the production trigger and production K.
// B: empty novelty history and LPP_EXPLORE_WINDOW=40, so the stub brain's own
//    pacing has to fill the window before the rung fires.
//
// Not in probes-*.sh: it needs roms/ and a map35 checkpoint (corpus rotates).
// All writes land in a scratch tree; the live tree is read-only here.
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";

const PHASE = (process.env.LPP_ACCEPT_PHASE ?? "A").toUpperCase();
const LIVE = "/home/lumen/pokemon";
const CK_DIRS = [process.env.LPP_ACCEPT_CKPT_DIR ?? `${LIVE}/checkpoints`];
const SCRATCH = mkdtempSync(join(tmpdir(), `explore1731-${PHASE}-`));
for (const d of ["runtime", "checkpoints", "events"]) mkdirSync(join(SCRATCH, d), { recursive: true });
process.chdir(SCRATCH);

process.env.LPP_OSC_HISTORY = join(SCRATCH, "runtime", "warp_history.json");
process.env.LPP_FIGHT_LEDGER = join(SCRATCH, "runtime", "fight_ledger.json");
process.env.LPP_FALLBACK_LOG = join(SCRATCH, "runtime", "fallback_stats.jsonl");
process.env.LPP_VISITED_TILES = join(SCRATCH, "runtime", "visited_tiles.json");
process.env.LPP_PROGRESS_LOG = join(SCRATCH, "runtime", "progress.json");
process.env.LPP_OVERRIDE_LOG = join(SCRATCH, "runtime", "stuck_escalation_overrides.jsonl");
process.env.LPP_PERSONA_ENABLE = "0";
process.env.LPP_PERSONA_PATH = join(SCRATCH, "runtime", "persona.json");
if (PHASE === "A") {
  copyFileSync(`${LIVE}/runtime/progress.json`, process.env.LPP_PROGRESS_LOG);
  copyFileSync(`${LIVE}/runtime/visited_tiles.json`, process.env.LPP_VISITED_TILES);
} else {
  process.env.LPP_EXPLORE_WINDOW = process.env.LPP_EXPLORE_WINDOW ?? "40";
}

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

/** The weeks-long brain: pace the strip, flee what it meets. */
// brainCalls counts DECISION calls only. History compaction (Brain.compact, run
// at turn end every CFG.historyCompactAt lines) is a separate summarize call the
// rung does not own; it is counted apart so R3 measures what it claims to.
let brainCalls = 0, compactCalls = 0, paceIdx = 0;
const STRIP: [number, number][] = [];
for (let y = 19; y <= 29; y++) { STRIP.push([4, y]); STRIP.push([5, y]); }
function stubBrain(): Promise<number> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      let act: string;
      if (/Summarize this Pokemon gameplay log/.test(body)) {
        compactCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "paced the grass strip" },
          finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        return;
      }
      brainCalls++;
      if (/BATTLE WILD/.test(body)) act = "flee()";
      else if (/BATTLE TRAINER/.test(body)) act = "battle_move(0)";
      else { const [x, y] = STRIP[paceIdx++ % STRIP.length]; act = `goto(${x},${y})`; }
      const content = `THINK: the grass here is where the catch is\nACT: ${act}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
}

(async () => {
  const port = await stubBrain();
  process.env.LPP_GATEWAY = `http://127.0.0.1:${port}/v1/chat/completions`;
  const { CFG } = await import("./config.js");
  const { Emulator, loadSnapshotFile } = await import("./emulator.js");
  const { SymbolTable } = await import("./symbols.js");
  const { Rom } = await import("./rom.js");
  const { MapModel } = await import("./map.js");
  const { Navigator } = await import("./nav.js");
  const { EventBus } = await import("./events.js");
  const { Screen } = await import("./screen.js");
  const { Sync } = await import("./sync.js");
  const { Dialog } = await import("./dialog.js");
  const { Actions } = await import("./actions.js");
  const { Battle } = await import("./battle.js");
  const { StateReader } = await import("./state.js");
  const { Brain } = await import("./brain.js");
  const { Agent } = await import("./agent.js");

  const sym = new SymbolTable(`${LIVE}/roms/pokeblue.sym`);
  const rom = new Rom(`${LIVE}/roms/pokeblue.gb`);
  const emu = new Emulator(`${LIVE}/roms/pokeblue.gb`);

  // A map35 save standing on the strip, not in a battle.
  let fixture: string | null = null;
  for (const dir of CK_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort().reverse()) {
      try {
        const sc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const gz = join(dir, f.replace(/\.json$/, ".state.gz"));
        if (sc.map !== 35 || ![4, 5].includes(sc.x) || sc.y < 19 || sc.y > 29 || !existsSync(gz)) continue;
        loadSnapshotFile(emu, gz);
        if (emu.mem()[sym.addr("wIsInBattle")] !== 0) continue;
        fixture = gz; break;
      } catch {}
    }
    if (fixture) break;
  }
  if (!fixture) { console.log("SKIP FIXTURE MISSING: no map35 strip checkpoint (corpus rotated)"); process.exit(2); }

  const bus = new EventBus(join(SCRATCH, "events"), `accept1731-${PHASE}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const reader = new StateReader(emu, sym);
  const brain = new Brain(bus);
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, brain, bus,
    join(SCRATCH, "checkpoints"));

  const summaries: string[] = [];
  const ovr: any[] = [];
  bus.on((e: any) => {
    if (e.kind === "turn_summary") summaries.push(e.line);
    if (e.kind === "exploration_override") ovr.push(e);
  });

  const s0 = reader.read();
  console.log(`phase=${PHASE} scratch=${SCRATCH} fixture=${fixture.split("/").pop()} ` +
    `start=map${s0.map} (${s0.x},${s0.y}) window=${CFG.explore.windowTurns} minTiles=${CFG.explore.minTiles} K=${CFG.explore.stepsK}`);

  const maxTurns = PHASE === "A" ? 1 + CFG.explore.stepsK * CFG.explore.expireFactor + 20
                                 : CFG.explore.windowTurns * 4 + CFG.explore.stepsK * CFG.explore.expireFactor + 20;
  const perTurn: { turn: number; line: string; brain: number }[] = [];
  let throws = 0, endAt = -1;
  for (let t = 1; t <= maxTurns; t++) {
    const b0 = brainCalls, n0 = summaries.length;
    try { await agent.runTurn(); } catch (e) { throws++; console.log(`   T${t} THREW ${String(e).slice(0, 80)}`); }
    const line = summaries.slice(n0).join(" | ");
    perTurn.push({ turn: t, line, brain: brainCalls - b0 });
    if (/AUTO:grass_breakout/.test(line) || ovr.some(o => o.stage === "fire") && endAt < 0)
      console.log(`   T${t} brain=${brainCalls - b0} ${line.slice(0, 150)}`);
    if (endAt < 0 && ovr.some(o => o.stage === "end")) endAt = t;
    if (endAt > 0 && t >= endAt + 20) break;
  }

  const fire = ovr.find(o => o.stage === "fire");
  const end = ovr.find(o => o.stage === "end");
  const fires = ovr.filter(o => o.stage === "fire").length;
  const ovTurns = perTurn.filter(p => /AUTO:grass_breakout/.test(p.line));
  console.log(`\nfire: ${JSON.stringify(fire && { turn: fire.turn, at: fire.at, trigger: fire.trigger,
    window: fire.window, source: fire.source, target: fire.target, sequence: fire.sequence })}`);
  console.log(`end:  ${JSON.stringify(end && { reason: end.reason, from: end.from, at: end.at, steps: end.stepsTaken,
    newGround: end.newGround, distinct: end.distinctTiles, mapChanged: end.mapChanged, escaped: end.escaped,
    executed: end.executed })}`);

  chk("R1 no turn threw", throws === 0, String(throws));
  chk("R2 the rung fired on the production ladder", !!fire && ovTurns.length > 0,
    `fire turn=${fire?.turn} overrideTurns=${ovTurns.length}`);
  if (PHASE === "A")
    chk("R2a on the live stall window it fires on turn 1", fire?.turn === 1, String(fire?.turn));
  else
    chk("R2b from empty history it fires only after the brain filled a window",
      !!fire && fire.turn >= CFG.explore.windowTurns, String(fire?.turn));
  chk("R3 override turns made ZERO brain calls", ovTurns.length > 0 && ovTurns.every(p => p.brain === 0),
    ovTurns.filter(p => p.brain > 0).map(p => `T${p.turn}`).join(",") || "all zero");
  chk("R4 escaped within K (>= minTiles tiles outside the stalled patch, or left the map)",
    !!end && end.escaped === true && end.stepsTaken <= CFG.explore.stepsK,
    JSON.stringify(end && { reason: end.reason, newGround: end.newGround, mapChanged: end.mapChanged }));
  let offGrass = false;
  if (end) {
    if (end.at.map !== 35) offGrass = true;
    else { map.build(); offGrass = !map.isGrass(end.at.x, end.at.y); }
  }
  chk("R5 the run ends off the grass", offGrass, JSON.stringify(end?.at));
  chk("R6 exactly one fire (the flush floor holds for the 20 turns after)", fires === 1, String(fires));
  const logged = existsSync(process.env.LPP_OVERRIDE_LOG!)
    ? readFileSync(process.env.LPP_OVERRIDE_LOG!, "utf8").trim().split("\n").map(l => JSON.parse(l).ev) : [];
  chk("R7 telemetry file holds fire + end", logged.join(",") === "fire,end", logged.join(","));
  chk("R8 live stuck_escalation.json was not written by the agent",
    !existsSync(join(SCRATCH, "runtime", "stuck_escalation.json")));
  if (end) {
    const back = perTurn.filter(p => p.turn > endAt).findIndex(p => /\[map35 [45],(19|2\d)\]/.test(p.line));
    console.log(`info: after the run the stub brain (which only paces) was back on the strip ` +
      `${back < 0 ? "never, in the 20 turns observed" : `after ${back + 1} turns`}`);
  }
  console.log(`info: decision calls=${brainCalls} compaction calls=${compactCalls}`);
  console.log(`\n${pass} PASS / ${fail} FAIL   (scratch kept at ${SCRATCH})`);
  process.exit(fail ? 1 : 0);
})();
