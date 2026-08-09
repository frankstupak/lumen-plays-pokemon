// Live agent: the real brain playing on stream, resuming from the latest
// checkpoint, with budget-exhaustion recovery and stuck-restart.
import { readdirSync, statSync } from "fs";
import { Emulator, loadSnapshotFile, saveSnapshotFile } from "./emulator";
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
import { StreamServer } from "./stream";
import { pickResume } from "./resume";
import { Metrics } from "./metrics";
import { RetryCounter } from "./retry";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SAVES = "/home/lumen/pokemon/saves";
const CKPTS = "/home/lumen/pokemon/checkpoints";

// S2: resume selection lives in resume.ts (viability-gated, sidecar-first).

const stream = new StreamServer(8871);
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator(ROM);
emu.onFrame = png => stream.broadcastFrame(png);
emu.paceMs = 0;  // run at harness speed; the brain sets the tempo

const rom = new Rom(ROM);
const EVENTS_DIR = "/home/lumen/pokemon/events";
const RUN_TAG = "live-agent-" + Date.now();
const bus = new EventBus(EVENTS_DIR, RUN_TAG);
const metrics = new Metrics(bus, RUN_TAG, EVENTS_DIR);
const retry = new RetryCounter(RUN_TAG, EVENTS_DIR);
bus.on(e => retry.observe(e));
stream.retryStats = () => retry.stats();
// periodic + exit flush so a run-summary always exists even on hard kill
setInterval(() => metrics.flush("periodic"), 60000);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig as NodeJS.Signals, () => { metrics.flush("signal"); process.exit(0); });
// wq#423 terminal soft-lock: flush and exit NON-zero so Restart=on-failure
// relaunches onto the latest checkpoint (designed CONTINUES path).
bus.on(e => {
  const ev = e as any;
  if (ev.kind === "battle_softlock" && ev.stage === "terminal") {
    console.error(`[softlock] terminal after ${ev.turns} battle turns (stall ${ev.stall}) - restarting onto checkpoint`);
    metrics.flush("softlock_terminal");
    process.exit(3);
  }
});
bus.on(e => stream.broadcast(e));
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  for (;;) {
    const snap = pickResume([SAVES, CKPTS], sym, ROM);
    loadSnapshotFile(emu, snap);
    const brain = new Brain(bus);
    const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, brain, bus, CKPTS);
    agent.notepad = [
      "GOAL: beat BROCK in Pewter Gym (map54) for the Boulder Badge.",
      "PROGRESS: parcel done, forest crossed, Pewter reached. CHARMANDER ~L15",
      "  knows EMBER. You have blacked out 6 times. STOP DYING - heal first.",
      "HEAL PROTOCOL (FIRST PRIORITY whenever HP below half):",
      "  In Pewter, enter the POKEMON CENTER warp. Inside: interact with the",
      "  nurse behind the top counter, choose(yes), wait for dialog to clear =",
      "  fully healed AND respawn point set here. FREE. Never fight at low HP.",
      "PEWTER GYM (map54): you enter at the BOTTOM (4,13). The warps at the",
      "  bottom are the EXIT - never enter_warp inside the gym, that leaves!",
      "  Walk NORTH: goto(4,6) then goto(4,1). A junior trainer stands mid-gym",
      "  and BROCK is at the top - walking north triggers their battles. Good.",
      "BROCK STRATEGY: GEODUDE L12 then ONIX L14 (ROCK/GROUND).",
      "  CRITICAL MOVE CHOICE: use SCRATCH = battle_move(0), NOT Ember!",
      "  Ember is FIRE = only 0.5x vs Rock/Ground (weak). SCRATCH is Normal = 1x",
      "  (double Ember's damage here). Spam battle_move(0) SCRATCH every turn.",
      "  Never GROWL(1)/LEER(3) - they deal no damage. You are L18, Scratch wins.",
      "  Trainer battles cannot be fled - finish them with SCRATCH.",
      "AFTER THE BADGE: exit gym south, then Pewter EAST edge -> Route 3.",
      "ROUTE TO PEWTER (empirically verified from a past successful run):",
      "  CORRECT corridor: Viridian Forest(map51) -> map47 -> map13 -> PEWTER(map2).",
      "  * In the forest (map51): take the TOP warps (x,0)->map47. These are the",
      "    NORTH exit toward Pewter. (The BOTTOM warps (x,47)->map50 lead to a",
      "    DEAD-END south pocket of map13 at (3,44) - never take those; that is",
      "    the trap you kept looping in.)",
      "  * map47 is a gate; cross it to enter map13 at the NORTH pocket (~3,11).",
      "  * In map13 from (3,11): walk NORTH. goto(8,1) then leave_edge(N) exits",
      "    the top edge into PEWTER CITY (map2). The north-edge opening is x8-9.",
      "  * If you land in map13 at the SOUTH (y~44) or in map50: you took a wrong",
      "    warp. Go back via the warp and take the FOREST TOP warps instead.",
      "  * In PEWTER CITY (map2), buildings by warp (verified):",
      "    - POKEMON CENTER: warp at (13,25) -> map58. goto(13,26) then",
      "      enter_warp on the (13,25) warp. Heal here FIRST (restores HP+PP).",
      "    - GYM (Brock): warp at (16,17) -> map54. Go here AFTER healing.",
      "    - MART: (23,17)->map56. Museum: (14,7)->map52 (skip it).",
      "    Do NOT wander into map52/55/57 - those are museum/houses, not useful.",
      "  Never go WEST from Viridian (Route 22, badge-gated dead end).",
      "PP MANAGEMENT: your EMBER PP is low. If EMBER hits 0 you can only Struggle",
      "  (self-damage). HEAL AT A CENTER to restore PP before it runs out.",
      "RULE: warps INSIDE a building are exits. To progress inside a building,",
      "  goto toward the NPCs, never enter_warp.",
      "RULE: if a tool returns stuck twice at the same tile, try a different",
      "  tool or warp index - never repeat the exact failing action.",
    ].join("\n");
    bus.emit("boot", { mode: "live-agent", resumedFrom: snap.split("/").pop() });
    let failStreak = 0;
    for (;;) {
      try {
        await agent.runTurn();
        failStreak = 0;
        await sleep(1500);   // stream readability: let viewers read the THINK line
      } catch (e: any) {
        failStreak++;
        bus.emit("turn_summary", { line: `brain error (${failStreak}): ${String(e?.message ?? e).slice(0, 100)}` });
        saveSnapshotFile(emu, `${CKPTS}/error-recovery.state.gz`);
        if (failStreak >= 5 || brain.overBudget()) break;   // reboot agent, keep progress
        await sleep(10000);
      }
    }
    bus.emit("turn_summary", { line: "agent rebooting from latest checkpoint" });
    metrics.flush("reboot");
    await sleep(5000);
  }
})();
