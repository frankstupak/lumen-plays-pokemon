// wq#658 — the wq#621 vision valve's OTHER trigger shape: red/green.
//
// THE GAP wq#652's audit found, RAM-verified live (report 652):
// VisionValve.recordStuck() requires the SAME (map,x,y) on consecutive
// stuck_dumps, and stuck_dump itself is only ever emitted by ActionCeiling
// tripping on a VERIFY FAILURE or a goto returning "stuck" — never by a
// "successful" enter_warp. A warp ping-pong is neither: each individual call
// reports "warped" (a success) and the position it lands on typically
// DIFFERS call to call (that's what oscillation means), so the valve was
// structurally invisible to this whole failure class at both the feed point
// and the trigger shape. Confirmed live: zero vision events across the full
// loop_repeat window that produced this ticket.
//
// THE FIX: notePotentialOscillation() (wq#517's own N-in-a-window detector
// over repeated map ids — the same signal the board's loop_repeat alert
// reads) now ALSO feeds the valve directly on every trip, bypassing
// recordStuck's same-tile streak requirement entirely (assessOscillation
// already did the counting). Still gated by the same enabled flag and
// shared hourly budget as the original stuck_dump path — this is a second
// TRIGGER, not a second, ungoverned channel.
//
// WHAT THIS PROBE PROVES: driving the REAL Agent.notePotentialOscillation
// (same reflection technique as probe_oscillation.ts) through a real trip
// invokes a vision consult; a second trip within the hour, past a
// deliberately tiny budget, is refused and named as such; disabling the
// valve silences both; and the fake Brain (no network - CFG.gateway is never
// reached) proves the consult result lands in notepad GUIDANCE.
//
// wq#517: this probe drives the REAL Agent method, which persists warp
// history across runs — redirect it to a private file exactly like
// probe_oscillation.ts, or a stray run pollutes the live deployment's
// warp_history.json.
process.env.LPP_OSC_HISTORY = `/tmp/vision658-osc-${process.pid}-${Date.now()}.json`;
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { Battle } from "./battle";
import { StateReader } from "./state";
import { Brain } from "./brain";
import { Agent } from "./agent";
import { CFG } from "./config";
import { findFixture, requireFixture } from "./fixtures";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
// wq#540: fixture resolved BY PROPERTY, never by name — this probe only
// needs SOME loaded state to build a grid/screenshot from.
const ANY_FIXTURE = requireFixture("any checkpoint with a sidecar", findFixture(() => true));

interface Rig { agent: Agent; calls: { messages: any[] }[] }

/** A fresh Agent + a fake Brain.complete() that never touches the network,
 *  records every call it receives, and returns a canned reply. maxPerHour
 *  MUST be set before construction: Agent's `visionValve = new VisionValve()`
 *  field initializer captures CFG.visionValve.maxPerHour at construct time. */
function rig(maxPerHour: number): Rig {
  CFG.visionValve.maxPerHour = maxPerHour;
  const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
  loadSnapshotFile(emu, ANY_FIXTURE);
  const bus = new EventBus("/tmp", `probe-vision658-${process.pid}-${Date.now()}-${Math.random()}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const reader = new StateReader(emu, sym);
  const brain = new Brain(bus);
  const calls: { messages: any[] }[] = [];
  (brain as any).complete = async (messages: any[]) => {
    calls.push({ messages });
    return { text: "canned vision reply", usage: { prompt: 1, completion: 1, model: "lumen-vision" } };
  };
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, brain, bus,
    `/tmp/vision658-ck-${process.pid}-${Date.now()}-${Math.random()}`);
  return { agent, calls };
}

let events: any[] = [];
function trackEvents(agent: Agent) {
  events = [];
  agent.bus.on((e: any) => events.push(e));
}
function toolCalls(tool: string) { return events.filter(e => e.tool === tool); }

const note = (agent: Agent, m: number): Promise<string> => (agent as any).notePotentialOscillation(m);
/** Drive the exact map-id sequence probe_oscillation.ts proved trips a
 *  fresh LOOP NOTICE: three repeats of a 51<->50 ping-pong in a 6-entry
 *  window. */
async function tripOscillation(agent: Agent): Promise<string> {
  let out = "";
  for (const m of [51, 50, 51, 50, 51, 50]) out = await note(agent, m);
  return out;
}

(async () => {
  console.log("-- A. enabled: an oscillation trip fires a real consult (network faked) --");
  {
    CFG.visionValve.enabled = true;
    const { agent, calls } = rig(4);
    trackEvents(agent);
    const msg = await tripOscillation(agent);
    chk("A1 the oscillation itself still fires (unchanged wq#517 behavior)",
        /LOOP NOTICE/.test(msg), msg.slice(0, 60));
    chk("A2 a stuck_dump is emitted, tagged as the oscillation trigger",
        toolCalls("stuck_dump").length === 1 && toolCalls("stuck_dump")[0].trigger === "oscillation",
        JSON.stringify(toolCalls("stuck_dump")));
    chk("A3 a vision_consult fires, tagged as the oscillation trigger",
        toolCalls("vision_consult").length === 1 && toolCalls("vision_consult")[0].trigger === "oscillation",
        JSON.stringify(toolCalls("vision_consult")));
    chk("A4 the fake Brain actually received the call (no network touched)",
        calls.length === 1, `${calls.length} call(s)`);
    const visionGuidance: string | undefined = (agent.pad as any).guidance?.get("VISION");
    chk("A5 the reply lands in notepad GUIDANCE, hint-only",
        agent.pad.hasGuidance("VISION") && !!visionGuidance?.includes("canned vision reply") &&
        !!visionGuidance?.includes("hint only"),
        `guidance="${visionGuidance}"`);
  }

  console.log("\n-- B. budget is SHARED with the stuck_dump path, not a second free channel --");
  {
    CFG.visionValve.enabled = true;
    const { agent, calls } = rig(1);   // one consult per hour, total
    trackEvents(agent);
    await tripOscillation(agent);
    chk("B1 first trip consumes the only budget slot",
        toolCalls("vision_consult").length === 1, `${toolCalls("vision_consult").length} consult(s)`);
    // A second, independent oscillation streak (different map pair) trips again...
    events.length = 0;
    for (const m of [2, 3, 2, 3, 2, 3]) await note(agent, m);
    chk("B2 second trip within the hour is REFUSED, not consulted",
        toolCalls("vision_consult").length === 0 && toolCalls("vision_refused").length === 1,
        JSON.stringify(events.filter(e => e.tool?.startsWith("vision"))));
    chk("B3 the refusal names the oscillation trigger",
        toolCalls("vision_refused")[0]?.trigger === "oscillation",
        JSON.stringify(toolCalls("vision_refused")));
    chk("B4 the fake Brain was called exactly once total (refusal never reaches it)",
        calls.length === 1, `${calls.length} call(s)`);
  }

  console.log("\n-- C. disabled: the valve stays fully silent on an oscillation trip --");
  {
    CFG.visionValve.enabled = false;
    const { agent, calls } = rig(4);
    trackEvents(agent);
    const msg = await tripOscillation(agent);
    chk("C1 the oscillation NOTICE itself still fires (independent of the valve)",
        /LOOP NOTICE/.test(msg), msg.slice(0, 60));
    chk("C2 no stuck_dump, no vision_consult, no vision_refused",
        toolCalls("stuck_dump").length === 0 && toolCalls("vision_consult").length === 0 &&
        toolCalls("vision_refused").length === 0,
        JSON.stringify(events.filter(e => e.tool?.startsWith("vision") || e.tool === "stuck_dump")));
    chk("C3 the fake Brain was never called", calls.length === 0, `${calls.length} call(s)`);
    CFG.visionValve.enabled = true;   // restore for any later probe in the same process
  }

  console.log("\n-- D. the stuck-tile path (wq#621) is unchanged by this refactor --");
  {
    CFG.visionValve.enabled = true;
    const { agent, calls } = rig(4);
    trackEvents(agent);
    const pos = { map: 3, x: 5, y: 5 };
    // recordStuck requires stuckN (default 3) consecutive same-position dumps.
    await (agent as any).maybeConsultVision(pos, "grid");
    await (agent as any).maybeConsultVision(pos, "grid");
    chk("D1 dumps 1-2/3: no consult yet", toolCalls("vision_consult").length === 0);
    await (agent as any).maybeConsultVision(pos, "grid");
    chk("D2 dump 3/3: consult fires, tagged as the stuck trigger",
        toolCalls("vision_consult").length === 1 && toolCalls("vision_consult")[0].trigger === "stuck",
        JSON.stringify(toolCalls("vision_consult")));
    chk("D3 the fake Brain received exactly one call", calls.length === 1, `${calls.length} call(s)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
