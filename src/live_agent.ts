// Live agent: the real brain playing on stream, resuming from the latest
// checkpoint, with budget-exhaustion recovery and stuck-restart.
import { readdirSync, statSync, existsSync } from "fs";
import { Emulator, loadSnapshotFile, saveSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus, retainEventLogs } from "./events";
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
import { Notepad } from "./notepad";   // wq#486
import { makeBorrowGuard } from "./borrow_guard";   // wq#488
import { ceruleanGuidance } from "./guidance";   // wq#478
import { RecoveryTracker, seedMaxFromSidecars } from "./recovery";
import { Metrics } from "./metrics";
import { RetryCounter } from "./retry";
import { CFG } from "./config";   // wq#476: mapStepBudgets
import { GameNames, BADGE_NAMES, STATUS_BITS } from "./names";   // wq#503
import { MilestoneLog, StuckWatch, RatesCache, sentinelAlerts, objectiveFrom, LOOP_SPAN, LOOP_WINDOW } from "./trainer_panel";
import { STORY_FLAGS } from "./state";
import { corridorPhase, phaseReason, phaseWarnings, F_SUPER_NERD, F_DOME, F_HELIX,
         type CorridorPhase } from "./phase";
import { mtMoonLeg, MT_MOON_MAPS, ROUTE_OVERVIEW, type RouteLeg } from "./mtmoon_route";   // wq#564

// wq#476/486: reference to the currently-running Agent so the step-budget
// watchdog can push warnings into the GUIDANCE channel (harness->brain), never
// the brain's own notepad. Agent is recreated per continue.
let liveAgent: Agent | null = null;

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SAVES = "/home/lumen/pokemon/saves";
const CKPTS = "/home/lumen/pokemon/checkpoints";
const RUNTIME = "/home/lumen/pokemon/runtime";   // wq#486: persisted notepad lives here

// S2: resume selection lives in resume.ts (viability-gated, sidecar-first).

const stream = new StreamServer(8871);
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator(ROM);
emu.onFrame = png => stream.broadcastFrame(png);
emu.paceMs = 0;  // run at harness speed; the brain sets the tempo

const rom = new Rom(ROM);
const EVENTS_DIR = "/home/lumen/pokemon/events";
const RUN_TAG = "live-agent-" + Date.now();
// wq#551: THE ONE AND ONLY RETENTION CALL IN THE PROJECT. The live service at
// boot is the single owner of event-log deletion; every other EventBus in this
// repo (probes, tools, link drivers) now constructs without touching a byte of
// existing history. Runs BEFORE the bus is constructed so the sweep and its
// `retention` event describe the state this run inherited.
const retention = retainEventLogs(EVENTS_DIR);
// wq#555: link drivers emit to events/link on their own budget, so that budget
// needs sweeping too — a separate directory nobody prunes is just the unbounded
// growth this machinery exists to prevent, moved one level down. Still ONE
// owner: both sweeps happen here, at boot, and nowhere else.
// existsSync-gated on purpose: wq#551 made retainEventLogs REPORT an unreadable
// directory instead of swallowing it, which is right, but events/link legitimately
// does not exist until the first link run. Calling it unconditionally would print
// an ENOENT every boot and train readers to ignore retention errors.
const linkRetention = existsSync(`${EVENTS_DIR}/link`)
  ? retainEventLogs(`${EVENTS_DIR}/link`)
  : { dir: `${EVENTS_DIR}/link`, keep: 0, scanned: 0, kept: 0, deleted: [] as string[], failed: [] as string[] };
const bus = new EventBus(EVENTS_DIR, RUN_TAG);
bus.emit("retention", {
  keep: retention.keep, scanned: retention.scanned, kept: retention.kept,
  deletedCount: retention.deleted.length, deleted: retention.deleted,
  failedCount: retention.failed.length, failed: retention.failed,
  link: {
    scanned: linkRetention.scanned, kept: linkRetention.kept,
    deletedCount: linkRetention.deleted.length,
    failedCount: linkRetention.failed.length,
  },
});
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
    retry.markPendingContinue();   // wq#470: designed restart = gameplay continue, not infra
    metrics.flush("softlock_terminal");
    process.exit(3);
  }
});
bus.on(e => stream.broadcast(e));

// wq#476: per-map step-budget watchdog (config-driven; CFG.mapStepBudgets).
// Steps proxied by manhattan position deltas between state_reads on the same
// map. Soft alarm at 2x budget: one-time notepad warning + turn_summary.
// Hard at 3x: designed continue (same path as terminal softlock) — exit(3),
// systemd relaunches, pickResume rolls back to the best (milestone-aware,
// storyScore-ranked) checkpoint. Counters are per-process; a continue resets.
const wdSteps: Record<number, number> = {};
const wdAlarmed = new Set<number>();
let wdLast: { map: number; x: number; y: number } | null = null;
bus.on(e => {
  const ev = e as any;
  if (ev.kind !== "state_read" || typeof ev.map !== "number") return;
  if (wdLast && wdLast.map === ev.map)
    wdSteps[ev.map] = (wdSteps[ev.map] ?? 0) + Math.abs(ev.x - wdLast.x) + Math.abs(ev.y - wdLast.y);
  wdLast = { map: ev.map, x: ev.x, y: ev.y };
  const budget = CFG.mapStepBudgets[ev.map];
  if (!budget) return;
  const n = wdSteps[ev.map] ?? 0;
  if (n >= budget * 3) {
    console.error(`[stepbudget] map${ev.map} hard budget ${n}/${budget * 3} - continue onto best checkpoint`);
    bus.emit("turn_summary", { line: `step budget HARD on map${ev.map} (${n} steps, budget ${budget}) - rolling back to last milestone` });
    retry.markPendingContinue();
    metrics.flush("stepbudget_hard");
    process.exit(3);
  } else if (n >= budget * 2 && !wdAlarmed.has(ev.map)) {
    wdAlarmed.add(ev.map);
    bus.emit("turn_summary", { line: `step budget SOFT alarm on map${ev.map} (${n} steps, budget ${budget}) - stop exploring, commit to a ladder/exit` });
    if (liveAgent) liveAgent.pad.setGuidance("STEP-BUDGET",
      `map${ev.map}: you have walked ${n} steps here (good run: ~${budget}). ` +
      `STOP exploring. Pick the nearest ladder/exit warp from the WARPS list and commit to it NOW.`);
  }
});
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);

// ── wq#503: kiosk trainer-stats panel ────────────────────────────────────
// The tablet had ~314px of unused width and showed no trainer stats. Jay's
// ask: progress at a glance, and "he is stuck" visible to an observer who can
// then relay it. Everything below is RAM- or ROM-derived or absent; nothing
// here may fabricate a value.
const gameNames = new GameNames(rom, sym);
const milestones = new MilestoneLog();
milestones.bind(`${RUNTIME}/milestones.json`);
const stuckWatch = new StuckWatch();
const rates = new RatesCache("/home/lumen/pokemon/tools/lpp-stats", "/home/lumen/pokemon");
rates.start(60000);
const SENTINEL_STATE = `${RUNTIME}/sentinel_state.json`;

stream.names = () => ({
  maps: gameNames.maps, mons: gameNames.mons,
  badges: BADGE_NAMES, statusBits: STATUS_BITS,
  mapCount: gameNames.mapCount, monCount: gameNames.monCount,
});

// Milestone + loop tracking ride the same state_read the panel already gets,
// so the panel can never disagree with the game about where the player is.
let lastStory: number | null = null;
bus.on(e => {
  const ev = e as any;
  if (ev.kind !== "state_read" || typeof ev.map !== "number") return;
  stuckWatch.observe(ev.map, ev.x, ev.y);
  if (typeof ev.storyScore === "number" && ev.storyScore !== lastStory) {
    lastStory = ev.storyScore;
    milestones.observe(reader.storyFlagsSet());   // only on a change: 25 bit reads
  }
});

stream.progress = () => {
  const loop = stuckWatch.state();
  const alerts = sentinelAlerts(SENTINEL_STATE);
  const reasons: string[] = [];
  if (loop?.looping)
    reasons.push(`no movement: ${loop.turns} turns inside a ${loop.spanX + 1}x${loop.spanY + 1} box on map ${loop.map}`);
  for (const a of alerts) reasons.push(`sentinel ${a.key} (${Math.round(a.agoSec / 60)}m ago)`);
  return {
    storyScore: lastStory, storyMax: STORY_FLAGS.length,
    objective: liveAgent ? objectiveFrom(liveAgent.pad.renderGuidance()) : null,
    milestone: milestones.last(),
    rates: rates.get(),
    stuck: { active: reasons.length > 0, reasons },
    loop: loop ? { turns: loop.turns, spanX: loop.spanX, spanY: loop.spanY, map: loop.map } : null,
    loopRule: { window: LOOP_WINDOW, span: LOOP_SPAN },
    sentinel: alerts,
    tokens: metrics.tokenSnapshot(),
    at: new Date().toISOString(),
  };
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// wq#476: corridor knowledge packs, selected by badge phase at agent boot so
// guidance never pollutes other corridors. Content rules: map IDs verified
// (pokered constants); NO invented tile coordinates — the state block's WARPS
// list is authoritative, guidance stays at route-intent level.
function corridorNotepad(badgeCount: number, phase: CorridorPhase,
                         superNerdBeaten = false, haveFossil = false,
                         routeLeg: RouteLeg | null = null): string {
  if (badgeCount === 0) return [
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
  if (badgeCount === 1) {
    // wq#514: the badges===1 pack used to be ONE block containing both
    // "Route4 west(map15) -> MT MOON 1F" and "DO NOT re-enter Mt Moon". The
    // brain could not tell which map15 it was on, so both applied at once.
    // The two halves are now mutually exclusive and chosen from position.
    if (phase === "CERULEAN_APPROACH") return ceruleanApproachPack();
    return mtMoonTransitPack(superNerdBeaten, haveFossil, routeLeg);
  }
  return [
    `GOAL: continue the badge campaign (badges so far: ${badgeCount}).`,
    "Follow the milestone chain: Cerulean -> Nugget Bridge -> BILL (mandatory",
    "quest trigger) -> Vermilion / SS Anne -> CUT -> Surge (badge 3).",
    "RAM-VERIFIED CLAIMS ONLY: never assert an acquisition without a state or",
    "inventory check. RULE: if a tool returns stuck twice at the same tile,",
    "try a different tool or warp index - never repeat the failing action.",
  ].join("\n");
}


// ---------------------------------------------------------------- wq#514
// MT_MOON_TRANSIT: badges 1, agent at or before the cave (Route 3, Route 4
// WEST, the Mt Moon Pokecentre, or any Mt Moon floor). This pack owns the
// crossing. It never mentions Cerulean-side navigation, and the east pack
// never mentions this one.
function mtMoonTransitPack(superNerdBeaten: boolean, haveFossil: boolean,
                           routeLeg: RouteLeg | null = null): string {
  const objective = superNerdBeaten
    ? [
        "MT MOON IS ALREADY CLEARED (RAM-verified: the exit Super Nerd is beaten).",
        "  Do NOT hunt for him again and do NOT explore for items. Your ONLY",
        "  remaining job inside the mountain is to reach the EAST EXIT.",
      ]
    : [
        "MT MOON B2F holds Rocket grunts and a SUPER NERD standing next to TWO",
        "  FOSSILS. The fossils are on the WEST side of B2F, which is several",
        "  ladders away from where you start - see the CURRENT LEG above.",
        "FOSSIL POLICY (deterministic - do NOT deliberate): take the DOME FOSSIL.",
        "  If asked to choose, choose DOME and move on immediately. One fossil",
        "  only - the other disappears; that is normal, never go back for it.",
      ];
  // wq#564: THE EXIT IS NOT ONE FORCED ROUTE FROM WHERE YOU STAND, and saying
  // it was is what cost this run five days. wq#535 named B2F (5,7) as the first
  // tile of a global forced route; (5,7) is in a pocket the agent has never
  // been able to walk to. The route is now resolved PER POCKET from the live
  // MapModel (src/mtmoon_route.ts), so guidance can only name warps that are in
  // the player's own reachable component. The old DEAD-POCKET RECOVERY is gone
  // for the same reason it was wrong: from the B1F landing pocket, "go back up
  // and take (5,7)" returns the agent to the sealed east pocket, which is the
  // 61(25,9)<->60(17,11) ping-pong measured in wq#560.
  const exitRoute = routeLeg
    ? [
        `CURRENT LEG ${routeLeg.leg} - you are in: ${routeLeg.pocket}.`,
        ...routeLeg.lines,
        "  goto can never cross a warp - only enter_warp can. If a goto returns",
        "  'stuck' here, the target is in ANOTHER POCKET of this floor: do not",
        "  re-target it, take the ladder named above.",
        ...ROUTE_OVERVIEW,
      ]
    : [
        "ROUTE: cross the mountain and come out its EAST side. Once you are on a",
        "  Mt Moon floor you will be given the exact leg you are standing on,",
        "  resolved from the tiles you can actually reach.",
      ];
  // wq#535: the two fossils are SOLID objects sitting in the only corridor to
  // (5,7). This is not flavour text - while both stand there the exit is
  // physically unreachable and goto(5,7) can only ever answer "stuck". Taking
  // one hides that object (HideObject on its own missable index) and opens the
  // path. Suppressed once a fossil is held, because then they are already gone.
  const fossilDoor = haveFossil ? [] : [
    "THE FOSSILS ARE PHYSICALLY BLOCKING THAT EXIT - THIS IS THE PUZZLE:",
    "  DOME FOSSIL (12,6) and HELIX FOSSIL (13,6) are SOLID objects standing",
    "  side by side in the only corridor to (5,7). While BOTH are there, (5,7)",
    "  is UNREACHABLE and goto(5,7) can only answer 'stuck' - that is the wall,",
    "  not a pathing bug. TAKING ONE REMOVES IT AND OPENS THE PATH:",
    "      goto(12,7)  ->  interact(12,6)  ->  choose(yes)",
    "  ((11,6) also works as the standing tile.) Then goto(5,7) and enter_warp it.",
    "  You need exactly ONE fossil. Taking it is not optional content - it is",
    "  the door.",
    // wq#564 deliverable 2. This block used to end with "DO THIS WHILE YOU ARE
    // STILL ON B2F, BEFORE TAKING ANY LADDER DOWN". From the east pocket that
    // is ANTI-guidance: the fossils are in the WEST pocket, unreachable from
    // the east one (measured: east(30,11) -> (12,7) = no path), and the true
    // first move IS a ladder down. The ordering is now positional, not global.
    "  WHERE: the fossils are in the WEST pocket of B2F. You can only get there",
    "  by going DOWN to B1F and around through 1F first - the CURRENT LEG line",
    "  above tells you which step of that you are on. If the leg above does not",
    "  say you are in the fossil pocket, you are not; go where it sends you.",
  ];
  return [
    "GOAL: cross MT MOON and come out its EAST side.",
    // wq#564: the CURRENT LEG leads, because it is the only block that knows
    // where the agent actually is. Everything below it is context for it.
    ...exitRoute,
    "CORRIDOR: Route3(map14) -> Route4 west(map15) -> MT MOON 1F(map59)",
    "  -> B1F(map60) -> B2F(map61) -> ladder back up to the EAST exit.",
    "  Floors connect by LADDER warps - use the WARPS list in your state block;",
    "  those coordinates are exact, trust them over any memory.",
    "IF YOU ARE STILL OUTSIDE (map 15, Route 4 WEST): that is a dead-end bowl",
    "  whose only ways on are the Mt Moon entrance and the Pokemon Center. You",
    "  cannot walk east from there; columns 20-23 are solid wall. Going through",
    "  the cave is the ONLY forward path, so entering Mt Moon is CORRECT.",
    "FLOOR INTENT - THE MOUNTAIN IS POCKETS, NOT FLOORS:",
    "  * 1F (map59): ONE connected floor (~890 tiles) holding all five of its",
    "    warps. A maze with trainers, but anywhere on it can be walked to from",
    "    anywhere else. Fight trainers you cannot walk around - they are income.",
    "  * B1F (map60): FOUR DISCONNECTED POCKETS, not one floor. Only the pocket",
    "    holding (23,3) touches the (27,3) doorway to the outside, and the ONLY",
    "    way into that pocket is the B2F (5,7) ladder. The other three pockets",
    // wq#564: the old text called these three "dead pockets you must climb out
    // of". Measured: the (5,5)+(21,17) pocket IS the mandatory route, and the
    // (25,15)+(13,27) pocket reaches 1F. They are not dead; they are the way.
    "    are NOT dead ends - two of them are steps ON the route. Which one you",
    "    are in decides your next move, and the CURRENT LEG line above tells you.",
    "  * B2F (map61): FOUR POCKETS. The east one (where this run began) is small",
    "    (~67 tiles) with ONE ladder, and reaches neither the fossils nor the exit.",
    "    The west one holds the fossils; taking one merges it with the north",
    "    chamber and the exit ladder (5,7).",
    ...objective,
    ...fossilDoor,
    haveFossil
      ? "  A fossil is already in hand (RAM-verified) - do not seek another."
      : "  No fossil is in hand yet (RAM-verified) - dialog claiming otherwise is wrong.",
    "RAM-VERIFIED CLAIMS ONLY (hard rule for this corridor):",
    "  NEVER write or assume 'I got the fossil / found an item' from dialog",
    "  alone. Acquisition is TRUE only if a check_inventory/state read shows it.",
    "  Past runs hallucinated 'found fossil' and looped. Verify, then act.",
    "  Item balls on the floor are OPPORTUNISTIC - grab them when adjacent on",
    "  your path, never detour more than a few tiles for one.",
    "HEAL PROTOCOL: the Route 4 WEST pocket has a POKEMON CENTER at the (11,5)",
    "  warp. Heal BEFORE going underground and any time you surface at low HP.",
    "  Inside the mountain there is no healing - manage PP.",
    "STEP DISCIPLINE: the crossing is ~1000 steps for a good run. If a floor's",
    "  step-budget warning appears, stop exploring, pick the nearest unvisited",
    "  ladder warp, and commit to it.",
    "RULE: warps INSIDE a floor are ladders/exits - enter_warp is how you change",
    "  floors here (unlike buildings). Use WARPS indices from your state block.",
    "RULE: if a tool returns stuck twice at the same tile, try a different tool",
    "  or warp index - never repeat the exact failing action.",
  ].join("\n");
}

// CERULEAN_APPROACH: badges 1, agent PAST the cave (Route 4 east or beyond).
// wq#514 deliverable 4: this pack contains no instruction about entering the
// mountain in ANY form, not even as a negation -- per wq#488, a negated
// instruction still puts the action in context, and "do not re-enter Mt Moon"
// sitting next to a ladder is how the agent spent five days re-entering it.
function ceruleanApproachPack(): string {
  return [
    "GOAL: reach CERULEAN CITY (map3) and beat MISTY for badge 2.",
    "WHERE YOU ARE: on the EAST side of the mountain, past the crossing. This",
    "  is the far half of Route 4 and it is a DIFFERENT PLACE from the pocket",
    "  you started in, even though both report map 15. You are through. The",
    "  crossing is behind you and is finished business.",
    "DIRECTION: east and downhill. Route 4 east is one-way ledges - hopping a",
    "  ledge is progress and cannot be undone, which is exactly what you want.",
    "  Keep heading EAST until the map id becomes 3 (CERULEAN CITY).",
    "IF A WARP LEADS BACK WEST UNDERGROUND, IT IS NOT YOUR ROUTE. Your route is",
    "  the open air to the EAST. Prefer walking east over any warp.",
    "IN CERULEAN (map3):",
    "  * POKEMON CENTER first if anyone is hurt - free full heal, sets respawn.",
    "  * MART: buy POKE BALLs (200 each) before anything else if you can afford",
    "    them; a party of one loses the whole run to a single whiteout.",
    "  * GYM is MISTY: STARMIE L21 / STARYU L18, both WATER. A Fire starter is",
    "    at a type DISADVANTAGE here - do not lead with Ember and expect wins.",
    "    Level up on Route 4 east and Route 24 trainers first if under L25.",
    "MONEY: trainer battles are the ONLY income in this game. Fight the trainers",
    "  you meet on the way east rather than routing around them - a full purse",
    "  is what makes balls and potions possible.",
    "RAM-VERIFIED CLAIMS ONLY: never assert an acquisition or a beaten trainer",
    "  from dialog alone; confirm with a state or inventory read.",
    "RULE: if a tool returns stuck twice at the same tile, try a different tool",
    "  or warp index - never repeat the exact failing action.",
  ].join("\n");
}

(async () => {
  // wq#477: one tracker for the whole process (survives in-process agent
  // reboots), seeded from sidecars so restarts onto older checkpoints are
  // still detected as regressions.
  const recovery = new RecoveryTracker(seedMaxFromSidecars([SAVES, CKPTS]));
  // wq#486: ONE notepad for the whole process — persists across in-process
  // continues AND service restarts (bind restores runtime/notepad.txt). The
  // brain's notes survive; the guidance channel is re-derived each boot.
  const pad = new Notepad();
  pad.bind(`${RUNTIME}/notepad.txt`);
  // wq#488: guard every brain note write against borrowed content (guidance
  // markers, tool-call syntax, code, verbatim guidance copies). Checks against
  // the LIVE guidance text so a >=15-word parrot of the current corridor/stage
  // pack is caught. Rejections feed back to the brain + emit rule_violation.
  pad.sanitizer = makeBorrowGuard({ guidanceText: () => pad.renderGuidance(), bus });
  // wq#531: WIRE the wq#519 verifier. Until this line existed, `claimChecker`
  // was assigned in exactly one file -- src/probe_claims.ts -- so verifyClaims()
  // returned at its first guard and NO false pin was ever eligible to be
  // dropped in production. runtime/notepad.txt had no `lastVerification` key at
  // all, which is the fingerprint of a verifier that has never run, while the
  // pinned region carried EIGHT "Dome Fossil ... in inventory" claims.
  //
  // Fossil possession is an EVENT FLAG, not a bag read. StateReader exposes no
  // bag, and the flag is the better evidence anyway: it cannot be tossed, and
  // it cannot be crowded out by a full bag.
  //
  // The subject must be RECOGNISED to be judged. Anything this checker does not
  // understand returns null = CANNOT CHECK, and verifyClaims() then keeps the
  // pin untouched. Inventing a negative is the same sin as inventing a
  // positive, and a checker that guessed "false" on every unknown subject would
  // silently delete the brain's legitimate notes.
  pad.claimChecker = (c) => {
    const s = c.subject.toLowerCase();
    if (!s.includes("fossil")) return null;             // not ours to judge
    const wantsDome = s.includes("dome"), wantsHelix = s.includes("helix");
    const read = (idx: number | null) => (idx === null ? null : reader.eventFlag(idx));
    const dome = read(F_DOME), helix = read(F_HELIX);
    let holds: boolean | null;
    if (wantsDome) holds = dome;
    else if (wantsHelix) holds = helix;
    else holds = dome === null && helix === null ? null : Boolean(dome) || Boolean(helix);
    if (holds === null) return null;                    // flag unresolvable -> cannot check
    const fmt = (v: boolean | null) => (v === null ? "unresolvable" : v ? "1" : "0");
    return {
      holds,
      evidence: `RAM read of wEventFlags: EVENT_GOT_DOME_FOSSIL=${fmt(dome)}, ` +
                `EVENT_GOT_HELIX_FOSSIL=${fmt(helix)}.`,
    };
  };
  for (;;) {
    const snap = pickResume([SAVES, CKPTS], sym, ROM);
    loadSnapshotFile(emu, snap);
    // wq#531: the save may have just rolled BACKWARD, and this loop runs on
    // every gameplay continue, not only at process boot. The Notepad is one
    // instance for the whole process, so without this its pins stay "verified"
    // against a state the game has abandoned. Re-arm AFTER the snapshot is
    // loaded so the next render reads the state the agent is actually in.
    pad.rearmClaimVerification();
    // wq#503: flags that arrive WITH a resumed save were earned earlier, so
    // record them as observations, not as milestones reached just now.
    milestones.observe(reader.storyFlagsSet(), new Date(), true);
    lastStory = reader.storyScore();
    const brain = new Brain(bus);
    const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, brain, bus, CKPTS);
    agent.pad = pad;                                              // wq#486: shared, persisted
    // wq#514: corridor guidance is REFRESHED EVERY TURN and selected by a
    // RAM-verified phase, replacing the wq#476 boot pin. Pinning once at boot
    // is what let a pack describing the pre-cave approach stay in context
    // after the agent had crossed -- the guidance outlived the situation it
    // described, and no amount of correct text fixes that.
    let phaseNow: CorridorPhase | undefined;
    let legNow: string | undefined;   // wq#564: last announced route leg
    const refreshCorridorGuidance = () => {
      const st = reader.read();
      const next = corridorPhase(st, phaseNow);
      // Fossil possession is an EVENT FLAG, not a bag item: wq#519 correctly
      // proved no fossil is in the BAG and that src/items.ts has no fossil
      // ids, but pokered records fossils in wEventFlags, so this is the
      // RAM-verified read that claim actually needed.
      const nerd = F_SUPER_NERD !== null && reader.eventFlag(F_SUPER_NERD);
      const fossil = (F_DOME !== null && reader.eventFlag(F_DOME)) ||
                     (F_HELIX !== null && reader.eventFlag(F_HELIX));
      if (next !== phaseNow) {
        bus.emit("turn_summary", { line: `corridor ${phaseReason(st, next)}` });
        phaseNow = next;
      }
      // wq#564: resolve WHICH LEG of the Mt Moon route the agent is standing
      // on, from its own reachable component. Guarded three ways, because a
      // wrong leg is worse than no leg: only on the three cave maps, never
      // mid-battle (the overworld model is not meaningful then), and never on a
      // throw — a geometry failure must not kill the turn loop. map.build() is
      // a pure read of emulator memory, so this cannot perturb the game; the
      // agent rebuilds it again itself when it composes the state block.
      let leg: RouteLeg | null = null;
      if (MT_MOON_MAPS.includes(st.map) && st.inBattle === 0) {
        try {
          map.build();
          leg = mtMoonLeg(map, st.map, st.x, st.y);
          if (leg && leg.leg !== legNow) {
            bus.emit("turn_summary", { line: `route leg ${leg.leg} - ${leg.pocket} (map${st.map} ${st.x},${st.y})` });
            legNow = leg.leg;
          }
        } catch (e: any) {
          bus.emit("turn_summary", { line: `route leg unresolved: ${String(e?.message ?? e).slice(0, 80)}` });
        }
      }
      pad.setGuidance("CORRIDOR", corridorNotepad(st.badgeCount, next, nerd, fossil, leg));
    };
    if (phaseWarnings.length) bus.emit("turn_summary", { line: `PHASE WARN: ${phaseWarnings.join("; ")}` });
    refreshCorridorGuidance();
    agent.recovery = recovery;   // wq#477: regression detector + goal injection
    liveAgent = agent;   // wq#476: expose to step-budget watchdog
    // wq#478/486: dynamic Cerulean/Misty stage guidance — now its OWN guidance
    // section, refreshed every turn (money/potions/level move constantly). No
    // more marker-splice inside the notepad; the brain's notes are untouchable.
    const refreshStageGuidance = () => pad.setGuidance("CERULEAN", ceruleanGuidance(emu, sym, reader));
    bus.emit("boot", { mode: "live-agent", resumedFrom: snap.split("/").pop() });
    let failStreak = 0;
    for (;;) {
      try {
        refreshStageGuidance();   // wq#478
        refreshCorridorGuidance();   // wq#514: phase can change mid-run
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
    retry.noteGameplayContinue();   // wq#470: in-process resume = gameplay continue
    metrics.flush("reboot");
    await sleep(5000);
  }
})();
