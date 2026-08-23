// wq#907 END-TO-END ACCEPTANCE — "kill the primary brain, prove LPP keeps playing".
//
// NOT a probe: this needs the live LiteLLM gateway on :4000, so it is deliberately
// absent from scripts/probes-*.sh (those must be deterministic and offline).
// Run it by hand after touching brain routing:
//
//     npx tsx src/accept_brain907.ts
//
// It drives the REAL object graph — real emulator, real Agent.runTurn(), real
// Brain, real gateway for whichever rung is meant to answer — through a proxy
// that can blackhole one model by name. Blackhole, not connection-refused: on
// 2026-08-23 the socket to the gateway was open the whole time and LPP sat at
// 0.0% CPU for 12h, so a refused-connection test would have passed while the
// actual failure mode walked straight through it.
//
// All writes go to a scratch tree (cwd, checkpoints, notepad, warp history,
// fallback log). The live game state under /home/lumen/pokemon is read-only here.
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, request as httpRequest, IncomingMessage, ServerResponse, Server } from "http";
import { AddressInfo } from "net";

// A full pass outlives an interactive shell (two 120s deadlines are the point),
// so the transcript goes to a file as well as stdout — a detached run is the
// normal way to take this measurement.
const OUT = process.env.WQ907_OUT ?? "/tmp/wq907-accept.log";
writeFileSync(OUT, "");
const say = (line: string) => { console.log(line); try { appendFileSync(OUT, line + "\n"); } catch {} };

const SCRATCH = mkdtempSync(join(tmpdir(), "wq907-accept-"));
mkdirSync(join(SCRATCH, "runtime"), { recursive: true });
mkdirSync(join(SCRATCH, "checkpoints"), { recursive: true });
process.chdir(SCRATCH);                      // notepad.txt + runtime/ land here

const UPSTREAM = { host: "127.0.0.1", port: 4000, path: "/v1/chat/completions" };
/** Models the proxy accepts and then never answers. Mutated per phase. */
const blackholed = new Set<string>();
const held: ServerResponse[] = [];
const seen: string[] = [];

function proxy(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let model = "?";
      try { model = JSON.parse(raw.toString()).model; } catch {}
      seen.push(model);
      if (blackholed.has(model)) { held.push(res); return; }   // open socket, no reply — the bug
      const up = httpRequest({ ...UPSTREAM, method: "POST", headers: { ...req.headers, host: "127.0.0.1:4000" } },
        upRes => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); });
      up.on("error", e => { res.writeHead(502); res.end(String(e)); });
      up.end(raw);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () =>
    resolve({ server, port: (server.address() as AddressInfo).port })));
}

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  say(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

(async () => {
  const { server, port } = await proxy();
  process.env.LPP_GATEWAY = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.LPP_FALLBACK_LOG = join(SCRATCH, "fallback_stats.jsonl");
  process.env.LPP_OSC_HISTORY = join(SCRATCH, "runtime", "warp_history.json");
  process.env.LPP_BRAIN_PRIMARY = "qwen36-local";
  // Everything else is left at its production default ON PURPOSE: the numbers
  // under test are the ones the service will actually run with.

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
  const { findFixture, requireFixture } = await import("./fixtures.js");

  say(`scratch=${SCRATCH} proxy=:${port} primary=${CFG.profiles.primary.model} ` +
    `deadline=${CFG.brain.timeoutMs}ms fallback=${CFG.brain.fallbackTimeoutMs}ms ` +
    `rungs=${CFG.brain.fallbackModels.join(",")}`);

  const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
  const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
  const fixture = requireFixture("any checkpoint with a sidecar", findFixture(() => true));
  const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
  loadSnapshotFile(emu, fixture);
  const bus = new EventBus(join(SCRATCH, "events"), `wq907-accept-${process.pid}`);
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

  const rungHits = () => seen.slice();
  /** One turn through the exact shape live_agent.ts's loop uses: a throw is a
   *  survivable outcome there (failStreak -> checkpoint -> reboot), a hang is not. */
  const turn = async (): Promise<{ ms: number; err: any }> => {
    const t0 = Date.now();
    try { await agent.runTurn(); return { ms: Date.now() - t0, err: null }; }
    catch (e) { return { ms: Date.now() - t0, err: e }; }
  };

  // ---- PHASE A: primary HUNG. The exact 2026-08-23 failure. ---------------
  say("\n-- PHASE A: primary rung accepts and never answers (the 12h bug) --");
  blackholed.add("qwen36-local");
  const a: { ms: number; err: any }[] = [];
  for (let i = 0; i < 4; i++) {
    seen.length = 0;
    const t = await turn();
    a.push(t);
    say(`   turn ${i + 1}: ${t.ms}ms err=${t.err ? String(t.err).slice(0, 50) : "none"} rungs=${rungHits().join(",")}`);
  }
  chk("every turn finished (no hang)", a.every(t => t.ms < CFG.brain.timeoutMs * 2), a.map(t => t.ms).join(","));
  chk("every turn produced a playable result, not an error", a.every(t => t.err === null),
    a.map(t => t.err ? String(t.err).slice(0, 40) : "ok").join(" | "));
  chk("the FIRST hung turn is bounded by the primary deadline",
    a[0].ms >= CFG.brain.timeoutMs && a[0].ms < CFG.brain.timeoutMs + 60_000, `${a[0].ms}ms`);
  chk("the breaker takes over: later turns cost SECONDS, not a deadline",
    a[3].ms < 30_000, `turn4=${a[3].ms}ms vs turn1=${a[0].ms}ms`);

  // ---- PHASE B: primary KILLED (gateway does not know the model) ----------
  say("\n-- PHASE B: primary rung killed outright (unknown model group) --");
  CFG.profiles.primary.model = "wq907-killed-model";
  seen.length = 0;
  const b = await turn();
  say(`   turn: ${b.ms}ms err=${b.err ? String(b.err).slice(0, 50) : "none"} rungs=${rungHits().join(",")}`);
  chk("a dead primary degrades in SECONDS", b.ms < 30_000, `${b.ms}ms`);
  chk("and the turn still plays", b.err === null, String(b.err ?? "").slice(0, 60));

  // ---- PHASE C: TOTAL BLACKOUT. Test to failure. --------------------------
  say("\n-- PHASE C: every rung blackholed — the ladder must FAIL, bounded --");
  CFG.profiles.primary.model = "qwen36-local";
  for (const m of CFG.brain.fallbackModels) blackholed.add(m);
  blackholed.add("wq907-killed-model");
  seen.length = 0;
  const c = await turn();
  say(`   turn: ${c.ms}ms err=${String(c.err ?? "none").slice(0, 70)}`);
  // primary breaker is still open from phase A, so this is fallback deadlines only:
  // 30s + 2x30s terminal + 1.5s backoff, well inside the bound below.
  chk("total blackout THROWS (live_agent.ts's failStreak path) instead of hanging", c.err !== null);
  chk("total blackout is bounded", c.ms < CFG.brain.timeoutMs * 2, `${c.ms}ms`);
  chk("the throw names a deadline", /deadline \d+ms exceeded/.test(String(c.err?.message ?? "")),
    String(c.err?.message ?? "").slice(0, 60));

  // ---- PHASE D: recovery ---------------------------------------------------
  say("\n-- PHASE D: rungs restored — play resumes without a restart --");
  blackholed.clear();
  seen.length = 0;
  const d = await turn();
  say(`   turn: ${d.ms}ms err=${d.err ? String(d.err).slice(0, 50) : "none"} rungs=${rungHits().join(",")}`);
  chk("agent recovers on its own", d.err === null, String(d.err ?? "").slice(0, 60));
  chk("recovery is fast", d.ms < 60_000, `${d.ms}ms`);

  for (const res of held) { try { res.destroy(); } catch {} }
  server.close();
  say(`\n${pass} PASS / ${fail} FAIL   (scratch tree kept at ${SCRATCH})`);
  process.exit(fail ? 1 : 0);
})();
