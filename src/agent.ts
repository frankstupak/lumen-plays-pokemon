// The agent loop: state -> prompt -> brain -> tool dispatch -> repeat.
// Every capability the harness owns is exposed as one tool the brain can call.

import { writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { Emulator, KEYS, saveSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp, grassLine } from "./map";
import { mtMoonLeg, MT_MOON_MAPS } from "./mtmoon_route";
import { corridorPhase } from "./phase";
import { Navigator, astar } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { Battle } from "./battle";
import { StateReader } from "./state";
import { Brain } from "./brain";
import { History, buildMessages, renderState } from "./prompt";
import { Notepad } from "./notepad";
import { PersonaMemory } from "./persona";              // wq#1176
import { moveLabel, MOVES, pickBestMove } from "./moves";
import { GameState } from "./state";
import { Items, itemId, ITEM_NAME, ITEM, MART_ORDER,
         backfillItemNames, backfillItemPrices } from "./items";
import { Heal, knownCenter } from "./heal";
import { economyAdvice, BALL_PRICE } from "./economy";  // wq#516
import { decodeTrainers, pickEngageTarget, engageAdvice } from "./trainers";  // wq#528
import { MISTY_MIN_LEVEL, mistyGymEntryRefusal,
         engagementGateLine, grindPressure, gateLiftedLine } from "./guidance";  // wq#516/#674/#1181
import { catchAdvice, WANTED } from "./catch_policy";
import { assessBattleLock, assessWinnability } from "./softlock";
import { FightLedger, fightWasLost, grindJustified, GateCtx } from "./ledger";   // wq#1181 item 6
import { Winnability } from "./calc";                              // wq#1181 item 5
import { RecoveryTracker } from "./recovery";
import { TransitTracker, repelAdvice } from "./transit";   // wq#487
import { NoveltyTracker, levelSum } from "./novelty";   // wq#1179 (observe-only)
import { ExplorationOverride, overrideLogFile, progressBlock } from "./explore";   // wq#1731
import { ExclusionGate, exclusionFile, exclusionLift, exclusionSuspended } from "./exclusion";   // wq#1828
import { pinExpiry, renderPin, type PinnedDirective } from "./pin";   // wq#1840
import { assess as assessOscillation, historyFile as oscHistoryFile,
         loadHistory as loadOscHistory, saveHistory as saveOscHistory } from "./oscillation";  // wq#517
import { warpViews, renderWarps, stuckHint, edgeStuckHint, reachableEdges, WarpView, EdgeDir,
         type BlockedCrossing } from "./reach";   // wq#538, wq#1870, wq#1877
import { clearedByLine } from "./unblock";   // wq#1877
import { GameNames } from "./names";
import { parseGotoTarget, crossMapRefusal, scopeNoteCoords, edgeRefusal } from "./scope";  // wq#606
import { renderMenuLine } from "./menu";  // wq#620
import { decodeItemObjects, itemBallLine, toggleableFlags, flippedBits,
         toggleableGlobalIds } from "./objects";  // wq#607, wq#1877
import { nearbyHiddenItems, hiddenItemLine, hiddenItemFlags } from "./hidden_items";  // wq#622
import { ActionCeiling, CEILING } from "./ceiling";  // wq#606 deliverable 7
import { CFG } from "./config";
import { VisionValve, consultVision } from "./vision";  // wq#621

const CKPT_KEEP_AUTO = 40;   // rolling window of auto-* checkpoints kept on disk

/** wq#601: while the phase says the agent is PAST Mt Moon, a warp that leads
 *  back INTO it is refused in the tool itself. The pack forbade this in prose
 *  and the agent took the (24,5) re-entry twenty times in one evening — the
 *  wq#532 lesson again: a rule that exists only as prose is not a rule. Scope
 *  is deliberately one tile-class on one map in one phase: Cerulean is full
 *  of doors the agent must use, and MT_MOON_TRANSIT (westbound recovery,
 *  blackout re-cross) keeps every warp. Pure so the probe can test the
 *  decision without a live brain. Returns the refusal line, or null. */
export function mtMoonReentryRefusal(onMap15: boolean, phase: string,
                                     warp: Warp | undefined): string | null {
  if (!onMap15 || phase !== "CERULEAN_APPROACH" || !warp) return null;
  if (!MT_MOON_MAPS.includes(warp.destMap)) return null;
  return `refused - (${warp.x},${warp.y}) warps back into Mt Moon (map${warp.destMap}) ` +
         `and you are PAST the cave. Cerulean is EAST on foot; hopping DOWN a ledge ` +
         `is one-way progress, never re-enter the cave (wq#601)`;
}

// wq#724: load the supervisor directive and extract map bans. The supervisor
// (tools/lpp_stuck_intervene.py) writes runtime/supervisor_directive.json
// with a gotoBan list of map IDs when it detects a NAV_LOOP or WARP_OSC.
// The agent reads this at boot and refuses enter_warp to any banned map
// until the story advances (storyScore/badges/eventFlags rise).
interface SupervisorDirective {
  gotoBan: number[];
  mode: string;
  summary: string;
  notepadPin: string;
  // wq#1840: the supervisor stamps every file it writes. Read here so the
  // directive can expire on its own age instead of only on the story advance
  // it is blocking (src/pin.ts).
  generatedAt?: string;
  baselineScore?: number;
  baselineBadges?: number;
  baselineEvents?: number;
}

export function loadSupervisorDirective(base: string): SupervisorDirective | null {
  const p = join(base, "runtime", "supervisor_directive.json");
  try {
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (!d) return null;
    // Bans are honoured ONLY for loop/oscillation modes; every other directive
    // (e.g. FIGHT_LOSS_LOOP) carries GUIDANCE via notepadPin but never a ban.
    // wq#1081/#1084: previously this returned null unless gotoBan was non-empty,
    // so a guidance-only directive never loaded and its pin was silently dropped.
    const banMode = d.mode === "NAV_LOOP" || d.mode === "WARP_OSC";
    const bans = banMode && Array.isArray(d.gotoBan)
      ? d.gotoBan.filter((m: any) => typeof m === "number")
      : [];
    const pin = typeof d.notepadPin === "string" ? d.notepadPin : "";
    if (bans.length === 0 && !pin) return null;   // nothing actionable
    return {
      gotoBan: bans,
      mode: d.mode ?? "",
      summary: d.summary ?? "",
      notepadPin: pin,
      generatedAt: typeof d.generatedAt === "string" ? d.generatedAt : undefined,
      baselineScore: d.baselineScore,
      baselineBadges: d.baselineBadges,
      baselineEvents: d.baselineEvents,
    };
  } catch { return null; }
}

export class Agent {
  hist = new History();
  pad = new Notepad();               // wq#486: structured notes + guidance channel
  // wq#1176: the character behind the stream. REPLACED by live_agent with a
  // process-lifetime, disk-backed instance (same pattern as `pad`), so it
  // survives gameplay continues and service restarts. The default here keeps
  // probes and run_agent working with no wiring at all.
  //
  // There is no `chat` here any more: wq#1192 moved the audience channel out to
  // streamer.ts, which owns the transport directly. The agent does not speak.
  persona = new PersonaMemory();
  turn = 0;
  noActStreak = 0;
  // wq#472: planned deterministic turns remaining before the next brain call.
  // Refilled to CFG.autoTurnRatio after every brain-driven turn; 0 ratio = feature off.
  private autoBudget = 0;
  // wq#477: whiteout/regression recovery goal injection. Set by live_agent
  // after construction (survives in-process agent reboots there); undefined
  // in probes/run_agent = feature simply absent, zero behavior change.
  recovery?: RecoveryTracker;
  // wq#487: movement-goal ownership. A goto interrupted by a wild battle stays
  // OURS: we flee the encounter and re-walk the same target deterministically
  // instead of paying a brain turn per encounter. Per-agent, not persisted.
  transit = new TransitTracker();
  // wq#606: retry ceiling — verbatim replay of a verify-failing action stops
  // at CEILING. Per-agent on purpose: a gameplay continue is a fresh brain
  // turn and deserves a fresh budget.
  private ceiling = new ActionCeiling();
  // wq#621: escalation-only vision valve. Per-agent, same lifetime as ceiling
  // — a fresh continue deserves a fresh streak/budget, same reasoning as
  // wq#606's ActionCeiling above.
  private visionValve = new VisionValve();
  private mapHistory: number[] = [];   // recent map ids for oscillation detection (this run)
  // wq#517: the same list, but surviving restarts and continues. A new Agent
  // is constructed inside live_agent's outer `for (;;)` loop, so the field
  // above resets on every continue while the loop it is meant to catch spans
  // dozens of runs.
  private crossRunWarps: number[] | null = null;
  // wq#658: rising-edge debounce for the oscillation->vision escalation.
  // assessOscillation() has NO debounce of its own — the LOOP NOTICE is
  // meant to keep repeating every turn the condition holds, unlike
  // VisionValve.recordStuck()'s explicit once-per-streak latch. Escalating
  // vision on every trip (not just the first) would burn the hourly budget
  // in a handful of turns and defeat the "rare escalation" design (wq#621
  // config comment: "not a channel the brain gets every turn").
  private lastOscTrip = false;
  // wq#674: true once at least one goto/leave_edge has actually MOVED the
  // player since the last warp arrival. False right after any warp lands —
  // see the enter_warp refusal below for why this exists.
  private movedSinceWarp = true;
  // wq#1086: identity of the door we just arrived through, valid only while
  // movedSinceWarp is false. wq#674's guard compared PLAYER POSITION to the
  // target warp's tile (p.x===w.x && p.y===w.y), which only catches re-entry
  // from the exact landing tile. Some edge/door warps land the player
  // ADJACENT to the door instead of on it (observed live at the Bills
  // House(88)<->Route25(36) boundary), so that comparison silently misses
  // the bounce. Tracking the fired warp's OWN identity (map + index) instead
  // of a coordinate catches re-entry regardless of where the landing tile is.
  private justWarpedBack: { map: number; index: number } | undefined;
  private unwedgeDirs = ["N", "S", "E", "W"];
  // wq#697: consecutive noise turns (unknown tool/parse_error/tool error).
  // After NOISE_K consecutive, inject a '!' urgent directive. After 2*NOISE_K,
  // escalate via the vision valve + brain escalation, same path as NAV_LOOP.
  private noiseStreak = 0;
  private static readonly NOISE_K = 5;
  private static readonly NOISE_RE = /unknown tool|parse_error|tool error|no tool call/i;
  // wq#423 battle soft-lock tracking (per battle, reset when it ends)
  private btTurns = 0;
  private btStall = 0;                 // consecutive turns with no HP change either side
  private btLastSig = "";
  // wq#538: map id -> display name for the WARPS line. Built lazily and exactly
  // once: the GameNames constructor walks the whole ROM map-header table and
  // throws if the ROM and .sym disagree. A cosmetic label must never be able to
  // take the agent down, so a failure degrades to "mapN" and is never retried.
  private names: GameNames | null = null;
  private namesTried = false;
  // wq#724: supervisor map bans — loaded from runtime/supervisor_directive.json
  // at boot. The stuck supervisor writes gotoBan with real map IDs when it
  // detects a NAV_LOOP/WARP_OSC. enter_warp refuses targets in this set.
  // Cleared when story advances past the directive's baseline.
  private supervisorBans: Set<number> = new Set();
  private supervisorBaseline: { score: number; badges: number; events: number } | null = null;
  // wq#1081/#1084: the directive's textual guidance, rendered every turn in
  // observe(). wq#724 wired ban consumption but never rendered this, so the
  // entire FIGHT_LOSS_LOOP grind remedy was written to disk and ignored.
  private supervisorPin = "";
  // wq#1840: what the pin needs to expire on its OWN age. Null whenever no pin
  // is live; carries the supervisor's generatedAt stamp plus the turn/clock the
  // agent picked it up at (src/pin.ts).
  private supervisorPinned: PinnedDirective | null = null;
  // wq#1840: latch for the suppression event, so the transition is logged once
  // rather than once per turn for the hundreds of turns the condition holds.
  private pinSuppressed = false;
  // wq#1179: tile novelty + composite progress scalar. observe() writes
  // runtime/{visited_tiles,progress}.json and emits a `progress` event;
  // tools/lpp_stuck_mode.py consumes the files. wq#1731: the exploration
  // override below READS the sample window back (never writes it) to decide a
  // stall. Assigned in the constructor body rather than as a field initializer
  // because it needs `checkpointDir` and `bus`, which are parameter properties.
  private novelty!: NoveltyTracker;
  // wq#1731: the hard exploration rung in runTurn's ladder (src/explore.ts).
  private explore!: ExplorationOverride;
  // wq#1828: the patch that rung just escaped, refused as a goto destination
  // until it expires (src/exclusion.ts).
  private exclusion!: ExclusionGate;
  // wq#1181: the fight loss ledger + its gates. Unlike the tracker files above
  // this one gates travel — enter_warp consults it (CFG.fightGate) — which is why every
  // gate it hands out carries three expiries and a fire cap (ledger.ts header).
  private ledger!: FightLedger;
  // Identity of the battle currently in progress, captured on the turn it
  // starts: wCurOpponent/wTrainerNo are only meaningful while the fight is
  // loaded, and the outcome has to be recorded AFTER they have been cleared.
  private btId: { opponent: number; trainerNo: number; map: number;
                  levelSum: number; badges: number;
                  money: number; grace: number } | null = null;
  // wq#1181: consecutive turns the grind governor has called grinding
  // unjustified. Drives the escalating pressure line, nothing else.
  private grindUnjustified = 0;

  constructor(
    public emu: Emulator, public sym: SymbolTable, public rom: Rom,
    public map: MapModel, public nav: Navigator, public scr: Screen,
    public sync: Sync, public dlg: Dialog, public act: Actions,
    public bat: Battle, public reader: StateReader, public brain: Brain,
    public bus: EventBus, public checkpointDir: string,
    public items: Items = new Items(emu, sym, scr, sync, dlg, nav, map, bat),
    public heal: Heal = new Heal(emu, sym, scr, sync, dlg, nav, reader, bat, bus)) {
    // checkpointDir is <base>/checkpoints, so <base>/runtime is its sibling —
    // the same anchor loadSupervisorBans() uses, and correct for probes and
    // one-off drivers that run from a different cwd than the live deployment.
    this.novelty = new NoveltyTracker({ dir: join(checkpointDir, "..", "runtime"), bus });
    this.ledger = new FightLedger({ dir: join(checkpointDir, "..", "runtime"), bus });
    this.exclusion = new ExclusionGate(exclusionFile(join(checkpointDir, "..", "runtime")), bus);
    this.explore = new ExplorationOverride({
      map: this.map,
      pos: () => this.nav.posChecked(),
      step: (dx, dy) => this.nav.step(dx, dy),
      hop: (dx, dy) => this.nav.hopStep(dx, dy),
      samples: () => this.novelty.recent(),
      blocked: () =>
        (this.emu.mem()[this.sym.addr("wIsInBattle")] !== 0 || this.bat.active()) ? "battle"
        : (this.dlg.open() || this.sync.textUp()) ? "dialog" : null,
      // An interrupted goto the transit policy would resume is the brain's
      // stalled intent; resuming it after the escape walks straight back.
      onFire: () => this.transit.clear(),
      // wq#1828: every historical fire read `escaped: true, mapChanged: false` —
      // the escape worked and the brain walked back. Now it is refused.
      exclude: e => this.exclusion.set(e),
      // wq#1746: the verdict record carries what the ban did beside whether the
      // escape held, so one line answers both.
      exclusionFires: () => this.exclusion.peek()?.fires ?? 0,
      // wq#1849: read straight from WRAM rather than a cached GameState — the
      // override plans between turns, and a badge won mid-escape should move
      // the bearing to the next gym on the next replan, not at the next
      // observe().
      badges: () => this.emu.mem()[this.sym.addr("wObtainedBadges")],
      bus,
      logFile: overrideLogFile(join(checkpointDir, "..", "runtime")),
      cfg: CFG.explore,
    });
    // wq#1829: name the bag from THIS ROM's ItemNames table. backfillItemNames
    // has existed since wq#519 but was called only from probes, so the LIVE
    // prompt still rendered raw ids: the 2026-09-12 run read
    // "BAG: item234x1 ... item49x1 ... item80x1 ... item82x1" while the brain
    // was reasoning about what it could sell or throw. id49 is the NUGGET the
    // agent picked up on Nugget Bridge. Gaps-only and idempotent by contract
    // (see items.ts), and a ROM whose tables disagree throws — caught here,
    // because an unnameable bag must not cost the run its boot.
    try {
      const bf = backfillItemNames(rom, sym);
      bus.emit("tool_call", { tool: "item_names_backfilled", src: "harness", ...bf });
    } catch (e: any) {
      bus.emit("tool_call", { tool: "item_names_backfill_failed", src: "harness",
                              error: String(e?.message ?? e) });
    }
    // wq#1835: and PRICE it from the same ROM's ItemPrices table, so the nugget
    // that names itself above can also be VALUED. No mart stocks it, so
    // economy.PRICE cannot price it and sell_item would have nothing to check a
    // payout against. Same contract, same reason for the catch.
    try {
      const bp = backfillItemPrices(rom, sym);
      bus.emit("tool_call", { tool: "item_prices_backfilled", src: "harness", ...bp });
    } catch (e: any) {
      bus.emit("tool_call", { tool: "item_prices_backfill_failed", src: "harness",
                              error: String(e?.message ?? e) });
    }
    this.loadSupervisorBans();
  }

  /** wq#724: read the supervisor directive at boot and enforce map bans. */
  private loadSupervisorBans(): void {
    try {
      // checkpointDir is <base>/checkpoints; directive is at <base>/runtime/
      const base = join(this.checkpointDir, "..");
      const dir = loadSupervisorDirective(base);
      if (!dir) return;
      // wq#1840: age it BEFORE it can reach the prompt even once. A directive
      // whose K-attempt ladder finished days ago is residue, not guidance, and
      // the 14-day FIGHT_LOSS_LOOP@3 pin was re-loaded on every continue.
      const pinned: PinnedDirective = {
        pin: dir.notepadPin || "", mode: dir.mode,
        generatedAt: dir.generatedAt, loadedTurn: this.turn, loadedMs: Date.now(),
      };
      const dead = pinExpiry(pinned, { turn: this.turn, ms: pinned.loadedMs }, CFG.pin);
      if (dead) {
        this.bus.emit("tool_call", {
          tool: "supervisor_directive_expired", src: "harness",
          reason: dead, mode: dir.mode, maps: dir.gotoBan, atBoot: true,
        });
        return;
      }
      for (const m of dir.gotoBan) this.supervisorBans.add(m);
      this.supervisorPin = pinned.pin;
      // Held whether or not there is a pin: a ban-only directive ages on the
      // same clock, and a single run outlives the cap (6.7h measured 2026-09-12).
      this.supervisorPinned = pinned;
      // wq#1081/#1084: load the baseline whenever EITHER a ban or a pin is
      // present, so a guidance-only directive still auto-lifts on advance.
      if (this.supervisorBans.size === 0 && !this.supervisorPin) return;
      const st = this.reader.read();
      this.supervisorBaseline = {
        score: st.storyScore,
        badges: st.badgeCount,
        events: this.reader.eventCount(),
      };
      this.bus.emit("tool_call", {
        tool: "supervisor_directive_loaded", src: "harness",
        maps: dir.gotoBan, mode: dir.mode, summary: dir.summary, pin: !!this.supervisorPin,
      });
    } catch { /* a bookkeeping failure must never break boot */ }
  }

  /** wq#724: if story advanced past the baseline, the ban is stale — clear it.
   *  Called at the top of each dispatch. */
  private checkSupervisorLift(): void {
    // wq#1081/#1084: baseline is set whenever a ban OR a pin loaded, so gate on
    // it alone — a guidance-only directive must lift its pin on advance too.
    if (!this.supervisorBaseline) return;
    // wq#1840: age first, because the story-advance test below can never fire
    // for a directive whose own remedy IS the blocked story advance. Retires
    // the whole artifact — pin and bans share one generatedAt and one ladder,
    // and a ban that outlives its ladder wedges exactly as the pin does.
    if (this.supervisorPinned) {
      const dead = pinExpiry(this.supervisorPinned, { turn: this.turn, ms: Date.now() }, CFG.pin);
      if (dead) {
        this.bus.emit("tool_call", {
          tool: "supervisor_directive_expired", src: "harness",
          reason: dead, mode: this.supervisorPinned.mode,
          maps: [...this.supervisorBans], atBoot: false,
        });
        this.supervisorBans.clear();
        this.supervisorPin = "";
        this.supervisorPinned = null;
        this.supervisorBaseline = null;
        return;
      }
    }
    try {
      const st = this.reader.read();
      const b = this.supervisorBaseline;
      if (st.storyScore > b.score ||
          st.badgeCount > b.badges ||
          this.reader.eventCount() > b.events) {
        this.bus.emit("tool_call", {
          tool: "supervisor_directive_lifted", src: "harness",
          reason: "story advanced past supervisor baseline",
        });
        this.supervisorBans.clear();
        this.supervisorPin = "";
        this.supervisorPinned = null;
        this.supervisorBaseline = null;
      }
    } catch { /* never crash on a bookkeeping read */ }
  }

  /** wq#1829: throwable balls of every grade. One reader, because the catch
   *  line in progressBlock() and the economy directive must never disagree
   *  about whether the agent can throw something. */
  private ballCount(): number {
    return this.items.count(ITEM.POKE_BALL) + this.items.count(ITEM.GREAT_BALL)
         + this.items.count(ITEM.ULTRA_BALL);
  }

  private mapLabel(id: number): string | null {
    if (!this.namesTried) {
      this.namesTried = true;
      try { this.names = new GameNames(this.rom, this.sym); } catch { this.names = null; }
    }
    return this.names ? this.names.mapName(id) : null;
  }

  /** wq#1877: the second half of a blocked-crossing refusal — where the game
   *  itself clears the NPC that is holding the region's one door. Read off the
   *  ROM (unblock.ts): the brain is told to go do that, instead of being left
   *  with an obstacle and no lever. Silent whenever the ROM does not answer —
   *  an invented prerequisite is worse than none (wq#1091). */
  private clearedByHint(bc: BlockedCrossing): string | null {
    try {
      const gid = toggleableGlobalIds(this.emu.mem(), this.sym).get(bc.by.slot);
      if (gid === undefined) return null;
      return clearedByLine(this.rom, this.sym, gid, id => this.mapLabel(id));
    } catch { return null; }
  }

  /** wq#538: the warp list annotated with reachability from where the player is
   *  standing right now, resolved through the same astar that goto() uses. */
  private currentWarpViews(): WarpView[] {
    const p = this.nav.posChecked();
    let lastMap = 0;
    try { lastMap = this.emu.mem()[this.sym.addr("wLastMap")]; } catch { lastMap = 0; }
    return warpViews(this.map, p.x, p.y, lastMap, id => this.mapLabel(id));
  }

  /** wq#621/wq#658: spend one vision-valve budget slot and consult, or refuse
   *  loudly past the hourly cap. Shared by both trigger shapes below — never
   *  throws into the caller's turn (a vision failure must not take down
   *  navigation), and the result is a GUIDANCE hint only (notepad.ts), never
   *  RAM-overriding. `trigger` is board-visible so a reader can tell which
   *  detector fired the consult apart from another. */
  private async escalateVision(pos: { map: number; x: number; y: number },
                               grid: string, trigger: "stuck" | "oscillation" | "noise_storm"): Promise<void> {
    if (!this.visionValve.tryConsumeBudget()) {
      this.bus.emit("tool_call", { tool: "vision_refused", trigger,
        line: `vision valve budget cap (${CFG.visionValve.maxPerHour}/hour) reached — ` +
              `refused at map${pos.map} (${pos.x},${pos.y}) [${trigger}]` });
      return;
    }
    this.bus.emit("tool_call", { tool: "vision_consult", pos, model: CFG.profiles.vision.model, trigger });
    try {
      const text = await consultVision(this.brain, this.emu.screenPngBuffer(), grid);
      if (text) this.pad.setGuidance("VISION", `(hint only, does not override RAM/grid) ${text}`);
    } catch (e: any) {
      this.bus.emit("tool_call", { tool: "vision_error", reason: String(e?.message ?? e).slice(0, 200) });
    }
  }

  /** wq#621: feed one stuck_dump into the vision valve. Fires at most once per
   *  stuck streak (same tile, `stuckN` consecutive stuck_dumps) — see
   *  vision.ts. */
  private async maybeConsultVision(pos: { map: number; x: number; y: number }, grid: string): Promise<void> {
    if (!CFG.visionValve.enabled) return;
    if (!this.visionValve.recordStuck(pos)) return;
    await this.escalateVision(pos, grid, "stuck");
  }

  /** wq#658: the wq#621 valve's OTHER trigger shape. recordStuck() above
   *  requires the SAME (map,x,y) on consecutive stuck_dumps, which a warp
   *  PING-PONG structurally never produces — stuck_dump itself is also never
   *  emitted for a "successful" enter_warp, so a looping-but-warped warp was
   *  invisible to the valve at both the feed point AND the trigger shape
   *  (wq#652's audit: confirmed live, zero vision events across a full
   *  loop_repeat window). wq#517's oscillation detector already does its OWN
   *  N-in-a-window counting over exactly this shape (repeated map ids), so
   *  this bypasses recordStuck's streak requirement entirely and treats an
   *  oscillation TRIP itself as the signal — still gated by the same
   *  enabled flag and hourly budget as every other consult. */
  private async maybeConsultVisionOnOscillation(pos: { map: number; x: number; y: number }): Promise<void> {
    if (!CFG.visionValve.enabled) return;
    if (this.bat.active()) return;   // a script-owned/battle frame has no stable grid to show
    try {
      this.map.build();
      const grid = this.map.ascii(pos.x, pos.y);
      this.bus.emit("tool_call", { tool: "stuck_dump", pos, sprites: this.map.sprites, grid, trigger: "oscillation" });
      await this.escalateVision(pos, grid, "oscillation");
    } catch { /* a geometry failure must not kill the turn */ }
  }

  /** Everything the brain needs to see this turn, rendered deterministically. */
  observe(): string {
    const st = this.reader.read();
    let block = renderState(st, null);

    if (this.bat.active()) {
      const b = this.bat.state();
      const trainer = b.inBattle === 2;
      block += `\nBATTLE ${trainer ? "TRAINER (no escape - must fight)" : "WILD"}` +
        ` my #${b.mySpecies} L${b.myLevel} ${b.myHp}/${b.myMaxHp}` +
        ` vs foe #${b.foeSpecies} L${b.foeLevel} ${b.foeHp}/${b.foeMaxHp}` +
        `\nMOVES ${b.moves.map((m, i) => m ? `${i}:${moveLabel(m)}(pp${b.pp[i] & 0x3f})` : "").filter(Boolean).join(" ")}` +
        `\nMENU ${b.atMainMenu ? "main" : "busy"}`;
      if (b.moves.every((mv, i) => !mv || (b.pp[i] & 0x3f) === 0))
        block += `\n! ALL PP EXHAUSTED - only Struggle remains`;
      if (b.myMaxHp > 0 && b.myHp / b.myMaxHp <= 0.25)
        block += trainer
          ? `\n! HP CRITICAL - healing unavailable... use_item(potion) if you have one, else strongest move`
          : `\n! HP CRITICAL - use_item(potion) if you have one, or end this battle fast`;
      if (!trainer) {
        const balls = this.items.count(ITEM.POKE_BALL) + this.items.count(ITEM.GREAT_BALL) + this.items.count(ITEM.ULTRA_BALL);
        const adv = catchAdvice(b.foeSpecies, b.foeHp, b.foeMaxHp, st.party.length, balls,
          b.myMaxHp > 0 ? b.myHp / b.myMaxHp : 1);
        if (adv) block += `\n${adv}`;
      }
      // wq#1181: the damage calc's read on this exchange. This is the line the
      // level-number gates were standing in for — MISTY_MIN_LEVEL says "L30 is
      // enough", the calc says how many turns each side actually needs.
      const win = this.winnabilityNow();
      if (win) {
        block += `\nWINNABILITY ${win.verdict}${win.confidence === "low" ? "?" : ""}: ${win.reason}`;
        if (win.bestSlot >= 0)
          block += `\nBEST BY DAMAGE slot ${win.bestSlot} (${win.bestName}), ~${win.myDmg} dmg/turn`;
        const wa = assessWinnability(win, !trainer, CFG.winnability.force);
        if (wa.directive) block += `\n${wa.directive}`;
      }
      const lock = assessBattleLock(this.btTurns, this.btStall, !trainer);
      if (lock.directive) block += `\n${lock.directive}`;
      block += `\nBAG ${this.items.bagLine()}`;
      return block;
    }

    // wq#1081/#1084: surface the stuck supervisor's guidance to the brain every
    // turn. Without this the entire FIGHT_LOSS_LOOP grind remedy was inert —
    // written to runtime/supervisor_directive.json and never read (wq#724 wired
    // ban enforcement but not this). Prefixed "!!" so it reads as high-priority.
    // wq#1840: and only when the live bag has not refuted it. A pin ordering a
    // CATCH at $96 with zero balls is not guidance, it is a second voice
    // arguing with progressBlock()'s CATCHING IS IMPOSSIBLE line below; a pin
    // ordering the agent into tall grass while wq#1828's exclusion refuses that
    // patch gets the exclusion named rather than left to contradict it.
    if (this.supervisorPin) {
      // wq#1839: `peek()` plus the pure rules, so rendering a prompt line never
      // moves gate state. A ban asleep on another map refutes nothing here.
      const ex = this.exclusion.peek();
      const seq = this.novelty.lastSeq();
      const live = ex && !exclusionLift(ex, seq) && !exclusionSuspended(ex, st.map)
        ? { tiles: ex.tiles.length, map: ex.map, turnsLeft: Math.max(0, ex.untilSeq - seq) } : null;
      const r = renderPin(this.supervisorPin,
        { balls: this.ballCount(), money: st.money, ballPrice: BALL_PRICE }, live, CFG.pin);
      if (r) block += `\n!! ${r.text}`;
      // Rising edge only: the condition holds for hundreds of consecutive
      // turns (wq#1829 measured $96 for a whole run), and an event per turn
      // would bury the transition that is the actual finding.
      const now = !!r?.suppressed;
      if (now !== this.pinSuppressed) {
        this.pinSuppressed = now;
        this.bus.emit("tool_call", {
          tool: now ? "supervisor_pin_suppressed" : "supervisor_pin_restored", src: "harness",
          balls: this.ballCount(), money: st.money,
        });
      }
    }

    // wq#1731: the reward weights as stated goals. Overworld only, so a fight
    // never gets a "leave this map" line in the middle of it; the battle branch
    // above returns before this.
    if (CFG.explore.prompt) {
      try {
        const here = this.nav.posChecked();
        block += `\n${progressBlock({ badges: st.badges, partyCount: st.partyCount,
          map: st.map, samples: this.novelty.recent(),
          balls: this.ballCount(), money: st.money,
          // wq#1849: the same table the WARPS list above is indexed by, so a
          // route leg through a door names the index rather than only the tile.
          warps: this.map.warps,
          // wq#1877: which edges are walkable from HERE, so the ROUTE line can
          // stop ordering a leg that starts across a seam.
          edges: reachableEdges(this.map, here.x, here.y),
        }, CFG.explore)}`;
      } catch { /* prompt salience must never cost the turn */ }
    }

    // wq#1181 (roadmap item 6): the grind governor. Evaluated ONLY while a loss
    // gate is live — that is the state in which the harness itself put the
    // agent into a grind, so it is the only state in which "is this grind still
    // paying" is a question about grinding rather than about ordinary travel
    // (levelSum is flat for most story turns, and pressuring those would be
    // noise). The other edge, the gate LIFTING, is announced for a few turns by
    // recentLift() below: that is the moment grinding stops being justified.
    {
      const gate = this.ledger.anyLiveGate(this.gateCtx());
      if (gate.blocked) {
        const g = grindJustified(this.novelty.recent(), { gated: true });
        this.grindUnjustified = g.justified ? 0 : this.grindUnjustified + 1;
        const line = grindPressure(g, this.grindUnjustified, this.storyObjective());
        if (line) block += `\n${line}`;
      } else {
        this.grindUnjustified = 0;
        const lift = this.ledger.recentLift();
        if (lift) block += `\n${gateLiftedLine(this.mapLabel(lift.map) ?? `map${lift.map}`, lift.reason)}`;
      }
    }

    const inCenter = this.emu.mem()[this.sym.addr("wCurMapTileset")] === 6;  // POKECENTER tileset
    const lead = st.party[0];
    if (lead && lead.maxHp > 0) {
      if (lead.hp / lead.maxHp <= 0.25)
        block += inCenter
          ? `\n! HP CRITICAL - you are INSIDE a Pokemon Center: heal_at_center() now`
          : `\n! HP CRITICAL - heal before anything else (Pokemon Center); avoid grass and battles`;
      if (lead.moves.every((mv, i) => !mv || lead.pp[i] === 0))
        block += inCenter
          ? `\n! ALL PP EXHAUSTED - heal_at_center() now to restore PP`
          : `\n! ALL PP EXHAUSTED - moves will fail (Struggle only); go to a Pokemon Center to restore PP`;
    }
    // S4: gentle nudges (not urgent) - free heal available / shopping policy
    if (inCenter && st.party.some(p => p.hp < p.maxHp || p.status !== 0))
      block += `\nTIP: Pokemon Center - heal_at_center() restores HP/PP/status for free`;
    const stock = MART_ORDER[st.map];
    if (stock && st.money >= 100) {
      const balls = this.items.count(ITEM.POKE_BALL);
      const heals = stock.filter(id => this.items.isHpHeal(id));
      const wants: string[] = [];
      if (stock.includes(ITEM.POKE_BALL) && balls < 3) wants.push(`poke_ball (have ${balls}, want 3+)`);
      for (const h of heals) if (this.items.count(h) < 2) wants.push(`${ITEM_NAME[h]} (have ${this.items.count(h)})`);
      if (stock.includes(ITEM.ANTIDOTE) && this.items.count(ITEM.ANTIDOTE) < 1) wants.push(`antidote (have 0)`);
      // wq#487: repels are the cheapest turn-saver we can buy for cave transits
      // (Cerulean map67 and Vermilion map91 stock them, $350 each — GameFAQs RB
      // mart list, cross-checked vs the MART_ORDER tables in items.ts).
      if (stock.includes(ITEM.REPEL) && this.items.count(ITEM.REPEL) < 2 && st.money >= 350)
        wants.push(`repel (have ${this.items.count(ITEM.REPEL)}, want 2 - $350, blocks cave encounters for 100 steps)`);
      if (wants.length)
        block += `\nTIP: in a Mart with $${st.money} - stock up via buy_item: ${wants.join(", ")}`;
    }
    // wq#516: the mart TIP above is gated on money >= 100, and the catch and
    // transit guards are gated on balls > 0, so at $71 with an empty bag every
    // one of them goes silent — which is how the campaign sat at exactly $71
    // for 81 hours of play with nothing ever telling the brain it was broke.
    // This says the quiet part, and says only the one thing that is binding.
    {
      const eco = economyAdvice({
        money: st.money,
        balls: this.ballCount(),
        partyCount: st.party.length,
        leadLevel: st.party[0]?.level ?? 0,
        inMart: !!stock,
        martStock: stock,
        gymMinLevel: MISTY_MIN_LEVEL,
        // wq#1835: what the bag is WORTH. The 2026-09-12 run was broke while
        // carrying $5000 of nugget; nothing in the prompt could say so because
        // nothing had ever asked what an item sells for.
        sellables: this.items.sellables(),
      });
      if (eco) block += `\n${eco}`;
    }
    block += `\nBAG ${this.items.bagLine()}`;
    // wq#487: transit handback (a goto target that has burned its resume cap)
    // and the repel advisory for cave transits.
    const tAdv = this.transit.advice();
    if (tAdv) block += `\n${tAdv}`;
    const rAdv = repelAdvice(st.map, this.items.count(ITEM.REPEL), this.repelSteps(),
                             Object.keys(CFG.mapStepBudgets).map(Number));
    if (rAdv) block += `\n${rAdv}`;

    this.map.build();
    const p = this.nav.posChecked();
    block += `\n${renderWarps(this.currentWarpViews())}`;
    block += `\nMAPGRID (P=you W=warp N=npc B=item ball G=tall grass #=wall .=open)\n${this.map.ascii(p.x, p.y)}`;
    // wq#1565: encounter-tile perception. Wild Pokemon in Gen 1 roll per step
    // and ONLY on the tileset's grass tile, so a grid that renders grass as
    // plain open ground makes catching unsolvable by observation — which is
    // what froze the campaign on Route 24 (map35) for 582h at "we must go into
    // tall grass ... assume we can move to a grass tile". Perception + a nudge,
    // never a nav goal, same rule as the item-ball line below.
    {
      const cells = this.map.grassCells(p.x, p.y);
      const onGrass = this.map.isGrass(p.x, p.y);
      let nearest: { x: number; y: number } | null = null, steps: number | null = null;
      for (const c of cells) {
        const path = astar(this.map, p.x, p.y, c.x, c.y, new Set<string>());
        if (!path) continue;
        nearest = c; steps = path.length; break;
      }
      const gline = grassLine({ count: cells.length, onGrass, nearest, steps });
      if (gline) block += `\n${gline}`;
    }
    // wq#607: item-ball perception — the line renders ONLY when a ball is on
    // this map (no dead prose). Steps via the same astar goto() uses, so
    // "N steps" is a promise the executor can keep. NO auto-detour: this is
    // perception + a nudge, never a nav goal (ticket deliverable 5).
    {
      const balls = decodeItemObjects(this.emu.mem(), this.sym);
      if (balls.length) {
        const bsteps = new Map<number, number | null>();
        for (const b of balls)
          bsteps.set(b.sprite, astar(this.map, p.x, p.y, b.x, b.y, new Set<string>())?.length ?? null);
        const bline = itemBallLine(balls, bsteps);
        if (bline) block += `\n${bline}`;
      }
    }
    // wq#622: hidden-item perception — no pixels can ever see this class (no
    // sprite exists at all), so this is the ONLY channel. Line renders ONLY
    // when an undiscovered one is on/adjacent to the player (no dead prose,
    // same wq#488 rule as the item-ball line above). NO auto-detour: pure
    // perception, mirrors the item-ball nudge, never a nav goal.
    {
      const hidden = nearbyHiddenItems(this.rom, this.sym, this.emu.mem(), st.map, p.x, p.y);
      const hline = hiddenItemLine(hidden);
      if (hline) block += `\n${hline}`;
    }

    // wq#528: the ONE income/XP goal the harness can actually complete, or
    // nothing. Every gate lives in trainers.ts and the module is fail-closed on
    // any map whose trainer header table we have not verified, so this is
    // silent everywhere except Mt Moon 1F/B2F today. The step budget is the
    // load-bearing gate: rabbit15 measured 2-4 steps per encounter against a
    // resume cap of 5, so a target further than ~cap*3 cannot be walked to and
    // offering one would reproduce wq#521 wearing this ticket's clothes.
    {
      const lead = st.party[0];
      const leadLevel = lead?.level ?? 0;
      const trs = decodeTrainers(this.emu.mem(), this.rom, this.sym, st.map);
      const steps = new Map<number, number | null>();
      // Beaten trainers are never pathed to: astar over a dozen sprites every
      // brain turn is affordable, but farming a corpse is not.
      for (const t of trs)
        steps.set(t.sprite, t.beaten ? null
          : (astar(this.map, p.x, p.y, t.x, t.y, new Set<string>())?.length ?? null));
      const ch = pickEngageTarget(trs, {
        leadLevel,
        hpFrac: lead && lead.maxHp > 0 ? lead.hp / lead.maxHp : 1,
        money: st.money,
        ballPrice: BALL_PRICE,
        gymMinLevel: MISTY_MIN_LEVEL,
        resumeCap: CFG.transitResumeCap,
        steps,
      });
      const eng = engageAdvice(ch, leadLevel, leadLevel > 0 && leadLevel < MISTY_MIN_LEVEL);
      if (eng) block += `\n${eng}`;
    }

    const text = this.scr.text();
    if (text.trim()) block += `\nSCREEN TEXT:\n${text}`;
    // wq#620: structured window view — decoded menu label/prices/cursor and
    // dialog text, rendered ONLY while a window is open (no dead prose). This
    // is the symbolic perception the vision research prescribed for menus.
    {
      const mv = this.items.menuView();
      const mline = renderMenuLine(mv, this.emu.mem()[this.sym.addr("wCurrentMenuItem")],
        this.emu.mem()[this.sym.addr("wListScrollOffset")], MART_ORDER[st.map]?.length ?? 0);
      if (mline) block += `\n${mline}`;
    }
    if (this.scr.cursor()) block += `\nCURSOR AT CHOICE (use choose(yes) / choose(no) / choose(<index>))`;
    return block;
  }

  /** Parse "ACT: tool(args)" and run it. Returns a one-line result summary.
   *  wq#606: wraps dispatchInner with the RETRY CEILING — an action that
   *  fails its own verify CEILING times consecutively from the same tile is
   *  refused verbatim (forced stuck_dump + a board-visible event) instead of
   *  being replayed forever. The 04:00-04:26Z live burn was 12 identical
   *  failing buy_item calls; the ceiling ends that class at 3. */
  async dispatch(actLine: string): Promise<string> {
    this.checkSupervisorLift();  // wq#724: auto-clear bans on story advance
    const m = actLine.match(/(\w+)\s*\(([^)]*)\)/);
    if (!m) return "parse_error: no tool call found";
    const tool = m[1].toLowerCase();
    let rawArgs = m[2];
    // wq#606: the generic arg regex stops at the FIRST ")", which truncated any
    // note containing coordinates — "note(counter at (4,7))" lost everything
    // from ")" on and the map-scoping could never see a complete token. Notes
    // are free text: take everything to the LAST ")" for them.
    if (tool === "note") {
      const g = actLine.match(/\w+\s*\(([\s\S]*)\)/);
      if (g) rawArgs = g[1];
    }
    const args = rawArgs.split(",").map(a => a.trim().replace(/^["']|["']$/g, ""));
    this.bus.emit("tool_call", { tool, args, src: "brain" });

    // S1 trainer-battle gate: movement is meaningless in any battle and the
    // brain must never believe it fled a trainer fight.
    if ((tool === "goto" || tool === "enter_warp" || tool === "leave_edge") && this.bat.active()) {
      return this.bat.state().inBattle === 2
        ? `${tool}: refused - TRAINER battle, there is no escape; you must fight (battle_move)`
        : `${tool}: refused - in a wild battle; fight it with battle_move`;
    }

    const cpos = this.nav.posChecked();
    const argsKey = args.join(",");
    // wq#1662: a goto ceilinged by a sprite blocking the route is worth
    // re-arming the instant that sprite moves — the walk that failed 3x in a
    // row was refused by an NPC that is, by construction, not permanent
    // terrain. Re-checking the same tile after it clears is not a verbatim
    // retry of the failure; it is the first attempt that can actually
    // succeed. Anything else ceilinged (terrain, no_path) is left alone: the
    // ceiling's job there is exactly to stop the repeat.
    if (tool === "goto") {
      const ob = this.nav.lastGotoObstacle();
      if (ob && ob.kind === "sprite") {
        this.map.build();
        const stillThere = this.map.sprites.some(
          sp => sp.x === ob.x && sp.y === ob.y && sp.pic === ob.spritePic);
        if (!stillThere) this.ceiling.reset();
      }
    }
    const pre = this.ceiling.check(tool, argsKey, cpos);
    if (pre) return pre;
    const result = await this.dispatchInner(tool, args, rawArgs);
    if (this.ceiling.record(tool, argsKey, cpos, result)) {
      // one board-visible line: lpp-sentinel forwards retry_ceiling events
      this.bus.emit("tool_call", { tool: "retry_ceiling",
        line: `${tool}(${argsKey}) failed its verify ${CEILING}x at map${cpos.map} ` +
              `(${cpos.x},${cpos.y}) — verbatim retries stopped`, src: "harness" });
      if (!this.bat.active()) {
        try {
          this.map.build();
          const grid = this.map.ascii(cpos.x, cpos.y);
          this.bus.emit("tool_call", { tool: "stuck_dump", pos: cpos,
            sprites: this.map.sprites, grid });
          await this.maybeConsultVision(cpos, grid);
        } catch { /* a geometry failure must not kill the turn */ }
      }
      return result + `\n! RETRY CEILING (${CEILING}x): this exact action has now failed its own ` +
        `verify ${CEILING} times from this tile and will be REFUSED verbatim. Do NOT repeat it. ` +
        `Reconsider the goal — move at least one tile, use a different tool, or pick a new target.`;
    }
    return result;
  }

  private async dispatchInner(tool: string, args: string[], rawArgs: string): Promise<string> {
    try {
      switch (tool) {
        case "goto": {
          // wq#606: a goto target is a (map,x,y) tuple. Bare (x,y) means the
          // CURRENT map (backcompat); a target carrying a different map id —
          // whether written goto(67,4,7), goto(map67 4,7), or a notepad
          // annotation replayed verbatim — is refused with both maps named,
          // never silently pathed to the same-numbered tile on the wrong map.
          const st0 = this.reader.read();
          const tgt = parseGotoTarget(rawArgs);
          if (!tgt) return "goto: bad args — use goto(x,y) for a tile on YOUR CURRENT map, " +
            "or goto(map,x,y) to name the map explicitly";
          const xref = crossMapRefusal(tgt, st0.map, id => this.mapLabel(id));
          if (xref) return `goto: ${xref}`;
          const tx = tgt.x, ty = tgt.y;
          // wq#1828: the patch the exploration override just escaped is not a
          // destination for the next excludeTurns turns. Movement only — the
          // route may still cross it, so an escape cannot seal the map.
          // wq#1839: counted in novelty seq, which survives a restart.
          {
            const ex = this.exclusion.refuse(this.novelty.lastSeq(), st0.map, tx, ty,
              this.mapLabel(st0.map) ?? `map${st0.map}`);
            if (ex) return `goto: ${ex}`;
          }
          // wq#601: past the cave, the Mt Moon re-entry warp tile is refused
          // here, not in prose. reader.read() is fresh RAM; map15 is ranked on
          // every tile so corridorPhase needs no prev there.
          {
            const st = st0;
            if (st.map === 15) {
              this.map.build();
              const w = this.map.warps.find(w => w.x === tx && w.y === ty);
              const ref = mtMoonReentryRefusal(true, corridorPhase(st), w);
              if (ref) return `goto: ${ref}`;
            }
            // wq#674: Cerulean Gym's outside door (map3) is a single-tile
            // warp that fires the instant goto() steps onto it — there is no
            // separate enter_warp call to intercept for THIS direction (the
            // enter_warp gate below only covers re-entry from inside). Same
            // gate, same reason: see guidance.ts's mistyGymEntryRefusal.
            if (st.map === 3) {
              this.map.build();
              const w = this.map.warps.find(w => w.x === tx && w.y === ty);
              if (w && w.destMap === 65) {
                const ref = mistyGymEntryRefusal(this.emu, this.sym, this.reader);
                if (ref) return `goto: ${ref}`;
              }
            }
          }
          const r = await this.nav.goto(tx, ty);
          // wq#487: a goto cut short by a battle becomes a harness-owned goal;
          // any other outcome retires it. Must run before the returns below.
          this.transit.onGoto(tx, ty, r, this.nav.posChecked().map);
          if (r === "battle") return "goto interrupted by a wild battle - the harness will flee it and resume this goto automatically";
          if (r === "dialog") return "goto blocked: a dialog or sign text is open - use talk() to clear it first";
          if (r === "adjacent_npc") {
            const p = this.nav.posChecked();
            // wq#583: honest arrival-adjacent instead of 25 replans + a lying
            // "reachable" hint. The brain's next verb is the point.
            return `goto: (${tx},${ty}) is occupied by an NPC standing on it, so you cannot stand there.` +
              ` You are now ADJACENT at ${JSON.stringify(p)} - talk() or interact if you meant that NPC,` +
              ` or pick a different destination tile.`;
          }
          if (r === "stuck") {
            const p = this.nav.posChecked();
            const stuckGrid = this.map.ascii(p.x, p.y);
            this.bus.emit("tool_call", { tool: "stuck_dump", pos: p,
              sprites: this.map.sprites, grid: stuckGrid });
            await this.maybeConsultVision(p, stuckGrid);
            // wq#538: a bare "stuck now {map,x,y}" carries no information the
            // brain can act on, so it re-picks from the same list and burns the
            // turn again. Say WHY it failed and name what would work instead.
            this.map.build();
            return `goto -> stuck now ${JSON.stringify(p)}` +
              stuckHint(this.map, p.x, p.y, tx, ty, this.currentWarpViews(),
                        this.nav.lastGotoObstacle(), p.map, bc => this.clearedByHint(bc));
          }
          // wq#674: "warped" lands on the new map's arrival tile with zero
          // steps taken there yet; anything else that actually got the player
          // moving (arrived/moved) clears the just-arrived state.
          // wq#1086: goto() doesn't report which warp fired, only that one
          // did — so identify it after the fact: on the map we just landed
          // on, the door that leads back to where we came from. Only trust
          // this when it's UNAMBIGUOUS (exactly one such warp); a route with
          // several ways back to the departure map is exactly the case where
          // guessing wrong would refuse a legitimate re-entry, so leave
          // justWarpedBack unset and let the tile-equality check alone cover
          // it, same as before this fix.
          if (r === "warped") {
            this.map.build();
            const dst = this.nav.posChecked().map;
            const backDoors = this.map.warps
              .map((cw, ci) => ({ cw, ci }))
              .filter(({ cw }) => cw.destMap === st0.map);
            this.justWarpedBack = backDoors.length === 1
              ? { map: dst, index: backDoors[0].ci }
              : undefined;
          } else {
            this.justWarpedBack = undefined;
          }
          this.movedSinceWarp = r !== "warped";
          return `goto -> ${r} now ${JSON.stringify(this.nav.posChecked())}`;
        }
        case "enter_warp": {
          // wq#601: refresh warps before indexing on map15 — the loop below
          // reads the index against CURRENT geometry, and the refusal must
          // name the warp the game would actually fire.
          {
            const st = this.reader.read();
            if (st.map === 15) {
              this.map.build();
              const ref = mtMoonReentryRefusal(true, corridorPhase(st),
                                               this.map.warps[Number(args[0])]);
              if (ref) return `enter_warp: ${ref}`;
            }
            // wq#674: hard-gate entry into Cerulean Gym (map65) while the
            // roster/level/potions aren't ready — see guidance.ts for why the
            // pre-existing "MISTY GATE" prose alone did not stop this (three
            // whiteouts, partyCount stuck at 1 for 30+ hours booted solo).
            if (st.map === 3) {
              this.map.build();
              const target = this.map.warps[Number(args[0])];
              if (target && target.destMap === 65) {
                const ref = mistyGymEntryRefusal(this.emu, this.sym, this.reader);
                if (ref) return `enter_warp: ${ref}`;
              }
            }
          }
          const w = this.map.warps[Number(args[0])];
          if (!w) return "enter_warp: bad index";
          // wq#724: supervisor map ban — the stuck supervisor detected a
          // NAV_LOOP/WARP_OSC and banned the loop maps. Hard refusal, same
          // principle as mtMoonReentryRefusal and the gym gate: a rule that
          // exists only as prose is not a rule (wq#532 lesson).
          if (w.destMap !== undefined && this.supervisorBans.has(w.destMap)) {
            const label = this.mapLabel(w.destMap) ?? `map${w.destMap}`;
            this.bus.emit("tool_call", { tool: "supervisor_ban_refused", src: "harness",
              destMap: w.destMap, label });
            return `enter_warp: refused — ${label} (map${w.destMap}) is BANNED by the ` +
              `stuck supervisor (navigation loop detected). Pick a different destination ` +
              `or pursue a different objective. The ban lifts when story progress advances.`;
          }
          // wq#1181 (roadmap item 6): the generalized loss gate. Same principle
          // as the Misty gate above and, unlike it, derived from what actually
          // happened rather than from a hand-picked level threshold — and it
          // expires four different ways (ledger.ts), because a gate that cannot
          // expire is the wq#517 wedge with a new name.
          if (CFG.fightGate && w.destMap !== undefined) {
            const g = this.ledger.gateForMap(w.destMap, this.gateCtx());
            if (g.blocked && g.key) {
              this.ledger.noteFire(g.key);
              const label = this.mapLabel(w.destMap) ?? `map${w.destMap}`;
              return `enter_warp: ${engagementGateLine(g, `${label} (map${w.destMap})`)}`;
            }
          }
          // wq#674: the door tile you just warped IN on is ALSO the warp back
          // out (true of every gym/building entrance) - firing enter_warp on
          // it again with zero steps taken since arrival just replays your
          // own arrival and bounces you straight back where you came from.
          // Observed live 43h straight at Cerulean Gym (map65 30,19,
          // live-agent-1786898534540.jsonl): the brain read "standing on a
          // warp" as "must enter it", never took the one step further into
          // the room, and never once reached inBattle - the "losing to Misty"
          // read on this stall was wrong; it never got the fight to start.
          // A hard refusal here, not a prose warning - the LOOP NOTICE text
          // already said this every time and was ignored for two days
          // (wq#532 lesson, same as mtMoonReentryRefusal above).
          if (!this.movedSinceWarp) {
            const p = this.nav.posChecked();
            const onTile = p.x === w.x && p.y === w.y;
            // wq#1086: the tile-equality check above only catches re-entry
            // from the EXACT landing tile. Some door warps (Bills House(88)
            // <->Route25(36) confirmed live) land the player ADJACENT to the
            // door instead of on it, so p!==w even though this is still the
            // same doorway fired straight back — compare the WARP'S IDENTITY
            // (map + index), not the player's coordinate, to catch that case
            // too. this.justWarpedBack is only set while movedSinceWarp is
            // false, so this can't misfire once a real step has been taken.
            const sameDoor = this.justWarpedBack !== undefined &&
              this.justWarpedBack.map === p.map &&
              this.justWarpedBack.index === Number(args[0]);
            if (onTile || sameDoor) {
              return `enter_warp: refused - this is the door you just arrived through and you ` +
                `have not moved since. Firing it again replays your OWN arrival and sends you ` +
                `right back out. goto() a DIFFERENT tile first to actually go somewhere (wq#674, wq#1086).`;
            }
          }
          const r = await this.nav.enterWarp(w);
          // wq#487: enterWarp walks to the tile first, so a wild encounter
          // interrupts it exactly like a goto - same ownership rules.
          this.transit.onWarp(w, r, this.nav.posChecked().map);
          if (r === "battle") return "enter_warp interrupted by a wild battle - the harness will flee it and resume this warp automatically";
          if (r === "dialog") return "enter_warp blocked: a dialog or sign text is open - use talk() to clear it first";
          if (r === "warped") {
            this.movedSinceWarp = false;
            // wq#1086: unlike goto's implicit warp, an explicit enter_warp(w)
            // tells us EXACTLY which door fired — w.destWarp is the index of
            // its partner on the map we just landed on. No ambiguity to guess
            // around, unlike the goto branch above.
            this.justWarpedBack = { map: this.nav.posChecked().map, index: w.destWarp };
          }
          // wq#517: record an arrival ONLY when the warp actually happened.
          // This call used to be unconditional, so an enter_warp that returned
          // "stuck" pushed the CURRENT map into the warp-arrival history as
          // though the agent had travelled there. Measured consequence: of the
          // eight times this guard fired in production (2026-08-13 03:36-04:54Z,
          // events/live-agent-1786589724686.jsonl) SEVEN fired on warps that did
          // not move the player at all — the agent sat at map60 (5,5) for three
          // turns and the guard's own history read 59->60->60->60->60, four of
          // which never happened. The auto path at the bottom of this file has
          // always been guarded this way; the brain-facing path was not.
          const osc = r === "warped"
            ? await this.notePotentialOscillation(this.reader.read().map)
            : "";
          return `enter_warp -> ${r} now ${JSON.stringify(this.nav.posChecked())}${osc}`;
        }
        case "leave_edge": {
          const dir = String(args[0] ?? "").toUpperCase();
          if (!["N", "S", "E", "W"].includes(dir)) return "leave_edge: bad direction (N|S|E|W)";
          // wq#606: interiors have NO edge connections (header byte = 0), so
          // walking an edge there is 14 steps into a wall — refuse with the
          // door warps listed instead. Decided from the connection byte, never
          // a hardcoded map list. Outdoor maps refuse only directions whose
          // connection bit is unset.
          {
            const st = this.reader.read();
            this.map.build();
            const eref = edgeRefusal(this.map.connections, dir as any, this.map.warps,
                                     st.map, this.mapLabel(st.map));
            if (eref) return `leave_edge: ${eref}`;
          }
          const r = await this.nav.leaveMapEdge(dir as any);
          if (r === "battle") return "leave_edge interrupted by a wild battle - fight it with battle_move";
          if (r === "dialog") return "leave_edge blocked: a dialog or sign text is open - use talk() to clear it first";
          // wq#1870: leaveMapEdge tries every walkable cell on that boundary and
          // then returns a bare "stuck", which reads as "retry" — and on a split
          // map the retry is doomed for as long as the player stands where they
          // are. Say that the edge is in a part of the map they cannot walk to,
          // and name the ones they can.
          if (r === "stuck") {
            const p = this.nav.posChecked();
            this.map.build();
            return `leave_edge -> stuck now ${JSON.stringify(p)}` +
              edgeStuckHint(this.map, p.x, p.y, dir as EdgeDir, this.currentWarpViews(), p.map,
                            bc => this.clearedByHint(bc));
          }
          // wq#674: edge crossings land off any warp tile, so they can't
          // trigger the door-bounce refusal above - but they DO count as
          // having moved, same as a successful goto.
          this.movedSinceWarp = true;
          this.justWarpedBack = undefined; // wq#1086: stale identity, no longer relevant once truly moved
          return `leave_edge -> ${r} now ${JSON.stringify(this.nav.posChecked())}`;
        }
        case "interact": {
          // wq#607: when the target tile holds a decoded item ball, confirm
          // the pickup by GROUND TRUTH — the missable flag region flips
          // exactly one bit, the sprite despawns, and the bag grows. Dialog
          // text is reported but never the confirmation.
          const ix = Number(args[0]), iy = Number(args[1]);
          const ballAt = decodeItemObjects(this.emu.mem(), this.sym)
            .find(o => o.x === ix && o.y === iy);
          const flagsBefore = ballAt ? toggleableFlags(this.emu.mem(), this.sym) : [];
          const bagBefore = ballAt ? this.items.has(ballAt.itemId) : 0;
          // wq#622: the same ground-truth diff for a hidden item, checked
          // BEFORE the `!d` early return below — a hidden item has no
          // sprite/dialog, so interactAt() may legitimately return null even
          // on a real pickup, and this must still get to see it.
          const stMap = this.reader.read().map;
          const hiddenAt = nearbyHiddenItems(this.rom, this.sym, this.emu.mem(), stMap, ix, iy)
            .find(h => h.x === ix && h.y === iy);
          const hiddenFlagsBefore = hiddenAt ? hiddenItemFlags(this.emu.mem(), this.sym) : [];
          const d = await this.act.interactAt(ix, iy);
          if (hiddenAt) {
            const hflips = flippedBits(hiddenFlagsBefore, hiddenItemFlags(this.emu.mem(), this.sym));
            if (hflips.length)
              return `interact -> ${d?.stoppedAt ?? "no_response"}; ` +
                `text: ${(d?.lines ?? []).slice(-4).join(" / ").slice(0, 200)} | ` +
                `HIDDEN ITEM FOUND at (${hiddenAt.x},${hiddenAt.y}) (flag bit ${hflips.join(",")} set)`;
          }
          if (!d) return "interact -> no_response";
          let pickup = "";
          if (ballAt) {
            // Ground truths: the missable flag flip + the bag delta. The
            // sprite despawn is EVENTUAL (probe-measured: still drawn for some
            // frames after the flag flips, gone by the next interaction), so
            // it is reported when observed but never gates the confirmation.
            const flips = flippedBits(flagsBefore, toggleableFlags(this.emu.mem(), this.sym));
            const gained = this.items.has(ballAt.itemId) - bagBefore;
            const rightBit = ballAt.globalId !== null && flips.length === 1 && flips[0] === ballAt.globalId;
            if (gained > 0 && (rightBit || (ballAt.globalId === null && flips.length === 1)))
              pickup = ` | PICKED UP ${ballAt.name} (bag +${gained}, object flag bit ${flips[0]} set)`;
            else if (gained > 0)
              pickup = ` | PICKED UP ${ballAt.name} (bag +${gained}; flag region flipped ${flips.length} bits - unusual, noting it)`;
            else
              pickup = ` | pickup NOT confirmed (bag unchanged - bag full, or the interaction missed)`;
          }
          return `interact -> ${d.stoppedAt}; text: ${d.lines.slice(-4).join(" / ").slice(0, 200)}${pickup}`;
        }
        case "talk": {   // advance whatever dialog is up
          const d = await this.dlg.advance(80);
          return `talk -> ${d.stoppedAt}; text: ${d.lines.slice(-4).join(" / ").slice(0, 200)}`;
        }
        case "choose": {
          const a = args[0].toLowerCase();
          if (a === "yes") { await this.act.answerYesNo(true); }
          else if (a === "no") { await this.act.answerYesNo(false); }
          else { await this.act.choose(Number(a)); }
          const d = await this.dlg.advance(80);
          return `choose(${a}) -> ${d.stoppedAt}; text: ${d.lines.slice(-3).join(" / ").slice(0, 160)}`;
        }
        case "press": {
          const key = KEYS[args[0].toUpperCase()];
          if (key === undefined) return "press: unknown button";
          // wq#622: a hidden item has no sprite to watch despawn, so pickup is
          // confirmed the same way as wq#607's item balls — a before/after
          // flag-region diff, ground truth from the engine itself. Only
          // computed when A is pressed near an undiscovered hidden item
          // (cheap no-op everywhere else — a 54-entry filter, skipped
          // entirely for every other button).
          const isA = args[0].toUpperCase() === "A";
          const p0 = this.nav.posChecked();
          const candidates = isA
            ? nearbyHiddenItems(this.rom, this.sym, this.emu.mem(), p0.map, p0.x, p0.y) : [];
          const flagsBefore = candidates.length ? hiddenItemFlags(this.emu.mem(), this.sym) : [];
          await this.sync.settle();
          await this.emu.tapAsync(key, 8, 24);
          await this.sync.settle(300);
          if (candidates.length) {
            const flips = flippedBits(flagsBefore, hiddenItemFlags(this.emu.mem(), this.sym));
            if (flips.length) {
              const got = candidates.find(c => flips.includes(c.idx));
              return `press(a) done | HIDDEN ITEM FOUND at ${got ? `(${got.x},${got.y})` : "?"} ` +
                `(flag bit ${flips.join(",")} set)`;
            }
          }
          return `press(${args[0]}) done`;
        }
        case "flee": {
          if (!this.bat.active()) return "flee: not in battle";
          const r = await this.bat.flee();
          if (r === "trainer") return "flee: cannot flee a TRAINER battle - you must fight (battle_move)";
          if (r === "fled") return "fled the battle successfully";
          if (r === "trapped") return "flee: could not escape (blocked) - try battle_move instead";
          return "flee: failed - try again or battle_move";
        }
        case "battle_move": {
          if (!this.bat.active()) return "battle_move: not in battle";
          const w = await this.bat.waitForMenu();
          if (w !== "menu") return `battle_move: ${w}`;
          await this.bat.useMove(Number(args[0]));
          const w2 = await this.bat.waitForMenu();
          const b = this.bat.state();
          return `battle_move -> ${w2}; my ${b.myHp}/${b.myMaxHp} foe ${b.foeHp}/${b.foeMaxHp}`;
        }
        case "use_item": {
          const id = itemId(args[0] ?? "");
          if (id === null) return `use_item: unknown item "${args[0]}" (try potion, poke_ball, antidote)`;
          const slot = args[1] ? Number(args[1]) : 0;
          return this.bat.active()
            ? await this.items.useInBattle(id, slot)
            : await this.items.useOverworld(id, slot);
        }
        case "buy_item": {
          const id = itemId(args[0] ?? "");
          if (id === null) return `buy_item: unknown item "${args[0]}"`;
          if (this.bat.active()) return "buy_item: not during a battle";
          const qty = Math.max(1, Math.min(9, Number(args[1] ?? 1) || 1));
          return await this.items.buy(id, qty);
        }
        case "sell_item": {
          const id = itemId(args[0] ?? "");
          if (id === null) return `sell_item: unknown item "${args[0]}" (use the name the BAG line shows)`;
          if (this.bat.active()) return "sell_item: not during a battle";
          const qty = Math.max(1, Math.min(99, Number(args[1] ?? 1) || 1));
          return await this.items.sell(id, qty);
        }
        case "heal_at_center": {
          return await this.heal.atCenter();
        }
        case "note": {
          // wq#606: mechanically map-scope bare (x,y) tokens at WRITE time —
          // "(4,7)" written inside the mart is stored as "(4,7 on map67)", so
          // a note replayed on another map either reads correctly or, pasted
          // verbatim into goto(), carries the map id the refusal needs.
          const raw = args.join(",");
          const res = this.pad.note(scopeNoteCoords(raw, this.reader.read().map));
          // wq#1176: a note is Lumen talking to himself, and a self-fact stated
          // there is as canonical as one said on stream — the store is about
          // WHO HE IS, not about which channel carried the sentence. Only the
          // note text that actually landed is mined (a rejected note is not
          // something he said).
          if (res.startsWith("note saved") || res.startsWith("PINNED")) {
            const notice = await this.rememberSelf(raw, "notepad");
            if (notice) return `${res}\n${notice}`;
          }
          return res;
        }
        default: return `unknown tool: ${tool}`;
      }
    } catch (e: any) {
      return `tool error: ${String(e?.message ?? e).slice(0, 120)}`;
    }
  }

  // ── wq#1176 persona memory ─────────────────────────────────────────────────
  //
  // The agent no longer SPEAKS (wq#1192 moved the audience channel out to
  // streamer.ts, off the gameplay model and off the gameplay clock). It still
  // owns persona because the notepad is a self-disclosure surface: `note(...)`
  // is the brain writing about itself, and what it writes there has to agree
  // with what the streamer has already told people. `chat` survives on the
  // class only so live_agent has one place to install the process-lifetime
  // instance both surfaces share.

  /** Canonical self-facts for the prompt. Empty string when the feature is off
   *  or nothing has been said yet, which buildMessages renders as no block at
   *  all — an empty PERSONA header would read as "you have no self". */
  private recallPersona(): string {
    if (!CFG.persona.enabled) return "";
    try { return this.persona.recall(CFG.persona.recallBudget); } catch { return ""; }
  }

  /**
   * Mine a sentence Lumen just produced for self-facts and record them.
   * Returns the "!" notice for the brain when it contradicted itself, "" when
   * there is nothing to report. Never throws: a persona failure must not cost
   * a game turn.
   *
   * wq#1191: awaited because extraction is a model call on the cheap rung. It
   * runs on lines Lumen SPEAKS (a SAY, a note), not on every turn, and the
   * extractor is deadline-bounded — see persona_llm.ts.
   */
  private async rememberSelf(text: string, platform: string): Promise<string> {
    if (!CFG.persona.enabled || !text.trim()) return "";
    try {
      const events = await this.persona.observe(text, platform);
      for (const e of events) {
        // Reaffirmations are the common case and are not worth an event each;
        // a NEW canonical fact and a CONTRADICTION are both worth counting.
        if (e.outcome === "reaffirmed") continue;
        // "updated" is a change of mind: a new valid-from in lumen_state, not a
        // conflict. Worth an event (the overlay shows it), no notice.
        this.bus.emit("persona", {
          outcome: e.outcome, key: e.key, value: e.value,
          canonical: e.fact.value, platform, src: "brain",
        });
      }
      return PersonaMemory.conflictNotice(events);
    } catch { return ""; }
  }

  /**
   * Deterministic recovery when the brain won't commit to an action. Clears any
   * open dialog, fights if a battle is up, otherwise rotates through cardinal
   * edge-exits so we physically leave a wedged pocket instead of spinning.
   */
  async unwedge(): Promise<string> {
    if (this.bat.active()) {
      // auto-fight: shared wq#587 picker (lock-in moves last resort)
      const b = this.bat.state();
      const best = pickBestMove(b.moves, b.pp);
      await this.bat.useMove(best);
      return `battle_move(${best}) auto [${moveLabel(b.moves[best])}]`;
    }
    if (this.sync.textUp() || this.dlg.open()) { await this.dlg.advance(40); return "talk auto"; }
    // Prefer a reachable warp: on gatehouse-chain maps (Route 2, forest) the map
    // edges are walled and only warps make progress. enterWarp returns "stuck"
    // when a warp is unreachable, so walk the list until one takes.
    this.map.build();
    const start = (this.noActStreak * 2) % Math.max(1, this.map.warps.length);
    for (let i = 0; i < this.map.warps.length; i++) {
      const w = this.map.warps[(start + i) % this.map.warps.length];
      const r = await this.nav.enterWarp(w);
      if (r === "warped") { await this.notePotentialOscillation(this.reader.read().map); return `enter_warp->${w.destMap} auto`; }
      if (r === "battle") { await this.bat.run(() => 0); return "battle auto"; }
    }
    // no warp took: fall back to rotating edge pushes
    const dir = this.unwedgeDirs[this.noActStreak % 4];
    const r = await this.nav.leaveMapEdge(dir as any);
    if (r !== "warped") { await this.act.backOut(); }
    return `leave_edge(${dir}) auto -> ${r}`;
  }

  /**
   * wq#472: PLANNED deterministic turn — the intentional counterpart to
   * unwedge (which is failure recovery). Only fires while autoBudget > 0 and
   * only in states where the correct action is not a judgment call:
   *   - TRAINER battle, main menu, HP > 25%, at least one damaging move with
   *     PP: strongest-move swing. Wild battles stay with the brain (catch
   *     decisions); critical HP stays with the brain (item decisions);
   *     PP-exhausted stays with the brain (Struggle awareness).
   *   - Dialog/sign text open with NO cursor choice: advance it. Choices
   *     always go to the brain.
   * Returns null when the state needs judgment -> normal brain path.
   */
  private async plannedAuto(): Promise<{ kind: string; result: string } | null> {
    if (this.bat.active()) {
      const b = this.bat.state();
      if (b.inBattle !== 2) return null;                               // wild: brain decides (catch?)
      if (b.myMaxHp > 0 && b.myHp / b.myMaxHp <= 0.25) return null;    // critical: brain decides (item?)
      const usable = b.moves.map((m, i) => (m && (b.pp[i] & 0x3f) > 0) ? i : -1).filter(i => i >= 0);
      if (!usable.length) return null;                                 // Struggle-only: brain should see it
      const w = await this.bat.waitForMenu();
      if (w !== "menu") return null;                                   // battle resolving/over: brain re-reads
      const best = pickBestMove(b.moves, b.pp);   // wq#587: shared, lock-in-aware
      this.bus.emit("tool_call", { tool: "battle_move", args: [String(best)], src: "planned_auto" });
      await this.bat.useMove(best);
      const b2 = this.bat.state();
      return { kind: "battle", result: `battle_move(${best}) planned [${moveLabel(b.moves[best])}] my ${b2.myHp}/${b2.myMaxHp} foe ${b2.foeHp}/${b2.foeMaxHp}` };
    }
    if ((this.sync.textUp() || this.dlg.open()) && !this.scr.cursor()) {
      this.bus.emit("tool_call", { tool: "talk", args: [], src: "planned_auto" });
      const d = await this.dlg.advance(40);
      if (this.scr.cursor()) return { kind: "talk", result: `talk planned -> ${d.stoppedAt}; CURSOR up - brain next turn` };
      return { kind: "talk", result: `talk planned -> ${d.stoppedAt}; text: ${d.lines.slice(-2).join(" / ").slice(0, 120)}` };
    }
    return null;
  }

  /** wq#487: live repel timer (wRepelRemainingSteps, 0xd0db). 0 when the symbol
   *  is missing so the advisory degrades to "no repel active", never throws. */
  private repelSteps(): number {
    try { return this.emu.mem()[this.sym.addr("wRepelRemainingSteps")] ?? 0; } catch { return 0; }
  }

  /**
   * wq#487: TRANSIT deterministic turn — fires ONLY while a goto goal the
   * harness owns is in flight (set in dispatch when a goto is interrupted by a
   * wild battle). Two jobs, both zero brain calls:
   *   - in a WILD battle: flee (fight only after two failed flees); trainer
   *     battles, HP <= 25%, catch targets and XP-grind mode all hand back.
   *   - in the overworld: re-walk the SAME target, capped at
   *     CFG.transitResumeCap attempts, after which the brain gets the goal back
   *     with an explicit "pick a different target" line (see observe()).
   * Independent of autoBudget by design: this removes brain calls that were
   * pure waste, so it must work at LPP_AUTO_TURN_RATIO=0.
   * Returns null whenever the brain should own the turn.
   */
  private async transitAuto(): Promise<{ kind: string; result: string } | null> {
    if (!CFG.transitPolicy || !this.transit.active()) return null;
    const goal = this.transit.goal!;

    if (this.bat.active()) {
      // The battle-intro frames leave wBattleMonHP at 0 until the HP bar
      // finishes drawing, so reading state here would read "0/76" and the
      // HP<=25% gate would hand every FRESH encounter back to the brain —
      // exactly the loop this ticket exists to kill (observed live 02:49Z:
      // full-HP Charmeleon, 0 balls, wild Zubat, still handed back). Wait for
      // the main menu first: menu-up is the harness's existing proof that
      // battle RAM has settled (battle.ts gates every move the same way).
      const wm = await this.bat.waitForMenu();
      if (wm !== "menu") return null;      // ended/resolving: brain re-reads next turn
      const b = this.bat.state();
      const wild = b.inBattle !== 2;
      const st = this.reader.read();
      const balls = this.items.count(ITEM.POKE_BALL) + this.items.count(ITEM.GREAT_BALL) + this.items.count(ITEM.ULTRA_BALL);
      const usable = b.moves.map((m, i) => (m && (b.pp[i] & 0x3f) > 0) ? i : -1).filter(i => i >= 0);
      const d = this.transit.battleStep({
        wild,
        hpFrac: b.myMaxHp > 0 ? b.myHp / b.myMaxHp : 1,
        hasUsableMove: usable.length > 0,
        wanted: wild && balls > 0 && st.party.length < 6 && !!WANTED[b.foeSpecies],
        grind: CFG.xpGrind,
      });
      if (d.action === "brain") return null;
      if (d.action === "flee") {
        this.bus.emit("tool_call", { tool: "flee", args: [], src: "transit" });
        const r = await this.bat.flee();
        this.transit.noteFlee(r);
        return { kind: "flee", result: r === "fled"
          ? `flee transit -> fled; resuming goto(${goal.x},${goal.y})`
          : `flee transit -> ${r} (fail ${goal.fleeFails}/2, then fight)` };
      }
      // fight: shared wq#587 picker - identical selection to plannedAuto,
      // and lock-in moves (RAGE) only as the last damage standing.
      const best = pickBestMove(b.moves, b.pp);
      this.bus.emit("tool_call", { tool: "battle_move", args: [String(best)], src: "transit" });
      await this.bat.useMove(best);
      this.transit.noteFight();
      const b2 = this.bat.state();
      return { kind: "fight", result: `battle_move(${best}) transit [${moveLabel(b.moves[best])}] my ${b2.myHp}/${b2.myMaxHp} foe ${b2.foeHp}/${b2.foeMaxHp}` };
    }

    // Overworld. Dialogs and open choices are never ours: wq#472/the brain
    // clear them, and only then does walking make sense again.
    if (this.sync.textUp() || this.dlg.open() || this.scr.cursor()) return null;
    this.transit.battleEnded();
    const p = this.nav.posChecked();
    const d = this.transit.overworldStep({ map: p.map, x: p.x, y: p.y }, CFG.transitResumeCap);
    if (d.action !== "resume") return null;

    if (goal.kind === "warp") {
      // Warp tables are rebuilt per map.build(); re-find OUR warp by tile (and
      // destination when known) rather than trusting a stale index.
      this.map.build();
      const w = this.map.warps.find(v => v.x === goal.x && v.y === goal.y &&
        (goal.destMap === undefined || v.destMap === goal.destMap));
      if (!w) { this.transit.clear(); return null; }   // warp gone: brain re-reads WARPS
      // wq#1181: this is the OTHER way into a warp — a goal the brain set
      // before the loss, resumed by the harness without passing the dispatch
      // gate. A gate the agent can walk around by being interrupted is not a
      // gate, so the same refusal applies here; the goal is dropped and handed
      // back rather than refused in prose, because nobody is asking.
      if (CFG.fightGate && w.destMap !== undefined &&
          this.ledger.gateForMap(w.destMap, this.gateCtx()).blocked) {
        this.transit.clear();
        return null;
      }
      this.bus.emit("tool_call", { tool: "enter_warp", args: [`${goal.x},${goal.y}`], src: "transit" });
      const rw = await this.nav.enterWarp(w);
      this.transit.onWarp(w, rw, this.nav.posChecked().map);
      return { kind: "resume_warp", result: `enter_warp(${goal.x},${goal.y}->map${goal.destMap}) resumed [${goal.attempts}/${CFG.transitResumeCap}] -> ${rw} now ${JSON.stringify(this.nav.posChecked())}` };
    }

    this.bus.emit("tool_call", { tool: "goto", args: [String(goal.x), String(goal.y)], src: "transit" });
    const r = await this.nav.goto(goal.x, goal.y);
    this.transit.onGoto(goal.x, goal.y, r, this.nav.posChecked().map);
    return { kind: "resume", result: `goto(${goal.x},${goal.y}) resumed [${goal.attempts}/${CFG.transitResumeCap}] -> ${r} now ${JSON.stringify(this.nav.posChecked())}` };
  }

  /** wq#423: per-battle counters. HP-only signature: PP is deliberately
   *  excluded so a move that fires but never lands (Normal vs Ghost) still
   *  reads as a stall. Reset the moment the battle is over.
   *  wq#1181: also opens and closes the loss-ledger record for the fight. */
  private trackBattleLock(): void {
    if (!this.bat.active()) {
      this.btTurns = 0; this.btStall = 0; this.btLastSig = "";
      this.resolveFight();
      return;
    }
    const b = this.bat.state();
    this.btTurns++;
    const sig = `${b.mySpecies}:${b.myHp}|${b.foeSpecies}:${b.foeHp}`;
    if (sig === this.btLastSig) this.btStall++;
    else { this.btStall = 0; this.btLastSig = sig; }
    if (this.btTurns === 1) this.openFight();
  }

  /** wq#1181: capture who this fight is against while the fight is loaded.
   *  wCurOpponent/wTrainerNo are cleared when it ends, and a LOSS teleports the
   *  player to a Pokemon Center, so neither the identity nor the map survives
   *  to the turn the outcome is known. Money is captured for the same reason
   *  the blackout detector uses it (blackout.ts): a Gen 1 white-out halves the
   *  purse and that is the one signature a normal Center heal cannot fake. */
  private openFight(): void {
    // A pending outcome from the previous fight must be settled before its slot
    // is reused, or a loss whose white-out landed inside the grace window would
    // vanish silently — exactly the record the gate depends on.
    this.resolveFight(true);
    try {
      const id = this.bat.fightId();
      if (!id.trainer) { this.btId = null; return; }   // see resolveFight()
      const st = this.reader.read();
      this.btId = {
        opponent: id.opponent, trainerNo: id.trainerNo, map: st.map,
        levelSum: levelSum(st), badges: st.badgeCount,
        money: st.money, grace: 0,
      };
    } catch { this.btId = null; }
  }

  /**
   * wq#1181: decide how the fight that just ended went, and record it.
   *
   * ONLY TRAINER FIGHTS ARE LEDGERED. A gate is a refusal to walk back into a
   * place, and wild encounters have no place to refuse — gating Route 24 grass
   * because a Rattata got lucky would ban the very grind the gate is asking
   * for. Trainer fights are also the ones that cannot be fled, so an outcome
   * there is a real verdict on the party rather than a policy choice.
   *
   * The loss signature is the white-out, not "party was fainted": the fainted
   * window closes inside one poll interval and is unobservable at one read per
   * turn (blackout.ts measured 0 sightings in 1285 reads). fightWasLost()
   * (ledger.ts) owns which consequences count — including the $0 purse a run of
   * losses converges to (wq#1246) — and it is given a few turns of grace here
   * because those consequences land behind the white-out dialog.
   */
  private resolveFight(final = false): void {
    const f = this.btId;
    if (!f) return;
    try {
      const st = this.reader.read();
      const lost = fightWasLost({ map: f.map, money: f.money }, st);
      if (!lost && !final && f.grace < 3) { f.grace++; return; }   // the consequences lag the fight
      this.ledger.record({
        ts: Date.now(), turn: this.turn, outcome: lost ? "loss" : "win",
        opponent: f.opponent, trainerNo: f.trainerNo, map: f.map,
        levelSum: f.levelSum, badges: f.badges,
      });
    } catch { /* a bookkeeping failure must never break a turn */ }
    this.btId = null;
  }

  /** wq#1181: the verdict for the exchange on screen, or null outside a battle
   *  / on a frame whose RAM is mid-load. Cheap (array indexes + arithmetic),
   *  and CFG.winnability.advisory turns the whole feature off in one env flip. */
  private winnabilityNow(): Winnability | null {
    if (!CFG.winnability.advisory) return null;
    try { return this.bat.winnability(); } catch { return null; }
  }

  /** wq#1181: where the grind governor points when it says stop. The notepad
   *  already carries the stage's ordered NEXT OBJECTIVE (guidance.ts) and the
   *  corridor pack carries the route, so this names them rather than inventing
   *  a third, competing objective. */
  private storyObjective(): string {
    return "the NEXT OBJECTIVE line in your notes - heal, then advance the story " +
      "(next gym / next story map), not more wild encounters.";
  }

  /** wq#1181: what the gates need to know about right now. */
  private gateCtx(estimate?: GateCtx["estimate"]): GateCtx {
    let ls = 0;
    try { ls = levelSum(this.reader.read()); } catch {}
    return { levelSum: ls, now: Date.now(), estimate };
  }

  /** wq#423: deterministic escalation. Returns a result line when the harness
   *  acted (skip the brain this turn), or null for the normal path. */
  private async battleLockForce(): Promise<string | null> {
    if (!this.bat.active()) return null;
    const b = this.bat.state();
    const wild = b.inBattle !== 2;

    // wq#1181 (roadmap item 5): the winnability half of this escalation. The
    // stall counters below need 15 wasted turns to notice a hopeless fight; the
    // damage calc knows on turn 1. ADVISORY FOR A SOAK WEEK: with
    // CFG.winnability.force off, this emits the verdict and the action it
    // withheld and then falls through to the counters exactly as before, which
    // is the evidence the flip is supposed to be argued from.
    const win = this.winnabilityNow();
    if (win) {
      const wa = assessWinnability(win, wild, CFG.winnability.force);
      this.bus.emit("winnability", {
        turn: this.turn, battleTurn: this.btTurns, wild,
        verdict: win.verdict, confidence: win.confidence,
        myDmg: win.myDmg, foeDmg: win.foeDmg, myTurns: win.myTurns,
        foeTurns: win.foeTurns, clearTurns: win.clearTurns, faster: win.faster,
        bestSlot: win.bestSlot, bestName: win.bestName, eff: win.eff,
        foe: b.foeSpecies, foeLevel: b.foeLevel,
        force: wa.force, withheld: wa.withheld, reason: win.reason,
      });
      if (wa.force === "flee") {
        const r = await this.bat.flee();
        if (r === "fled")
          return `winnability: forced flee() on turn ${this.btTurns} — UNWINNABLE (${win.reason})`;
        // trapped/failed: the fight continues and the stall counters below own
        // it from here, same handback the wq#423 forced flee already uses.
      }
    }

    const lock = assessBattleLock(this.btTurns, this.btStall, wild);
    if (lock.terminal) {
      this.bus.emit("battle_softlock", { stage: "terminal", turns: this.btTurns, stall: this.btStall, wild,
        foe: b.foeSpecies, note: "live_agent exits 3; systemd restarts onto latest checkpoint" });
      // live_agent's bus listener flushes metrics and exits(3). If nobody is
      // listening (probes, run_agent), fall through and keep forcing below.
    }
    if (!lock.force) return null;
    this.bus.emit("battle_softlock", { stage: "force", action: lock.force, turns: this.btTurns, stall: this.btStall, wild, foe: b.foeSpecies });
    if (lock.force === "flee") {
      const r = await this.bat.flee();
      if (r === "fled") return `battle_lock: forced flee() after ${this.btTurns} turns (stall ${this.btStall}) -> fled`;
      // trapped/failed: fall through to a strongest-move swing this turn
    }
    // rotate: deterministic slot cycle over moves WITH PP, so a whiffing move
    // cannot be re-picked forever; different slot each forced turn.
    const usable = b.moves.map((m, i) => (m && (b.pp[i] & 0x3f) > 0) ? i : -1).filter(i => i >= 0);
    const slot = usable.length ? usable[this.btTurns % usable.length] : 0;
    const w = await this.bat.waitForMenu();
    if (w !== "menu") return `battle_lock: ${w} during forced action`;
    await this.bat.useMove(slot);
    return `battle_lock: forced battle_move(${slot}) [${moveLabel(b.moves[slot])}] after ${this.btTurns} turns (stall ${this.btStall})`;
  }

  /** wq#1731: the exploration rung. Never acts in a battle (wIsInBattle must
   *  read 0 on this turn's state); src/explore.ts owns the trigger, the escape
   *  plan and the telemetry. A throw here is swallowed into the brain path: the
   *  rung is a loop breaker, and a bug in it must not cost the turn. */
  private async explorationOverride(before: GameState): Promise<string | null> {
    if (before.inBattle !== 0) return null;
    try { return await this.explore.tick(this.turn); }
    catch (e: any) {
      this.bus.emit("exploration_override", { stage: "error", turn: this.turn,
        reason: String(e?.message ?? e).slice(0, 200) });
      return null;
    }
  }

  async runTurn(): Promise<void> {
    this.turn++;
    await this.sync.settle();
    this.trackBattleLock();
    const before = this.reader.read();
    let stateBlock = this.observe();
    this.bus.emit("state_read", before as unknown as object);

    // wq#477: regression detector runs EVERY turn (edge detection needs the
    // sampling) but only augments the prompt; frontier turns return null.
    if (this.recovery) {
      const goal = this.recovery.evaluate(before, this.reader.storyScore(),
        idx => this.reader.eventFlag(idx), this.bus, this.turn);
      if (goal) stateBlock += `\n${goal}`;
    }

    let think = "", act = "", result = "";
    let plannedTurn = false;
    const forced = await this.battleLockForce();
    // wq#1731: hard exploration override. Below the soft-lock escalation (which
    // only acts in battle, and this rung never does), above everything that
    // would hand the turn back to the brain's stalled intent.
    const explored = forced === null ? await this.explorationOverride(before) : null;
    // wq#487: transit turns (flee an interrupting encounter / resume the
    // interrupted goto). Checked BEFORE plannedAuto and independent of the
    // wq#472 budget: soft-lock escalation still outranks it.
    const transited = (forced === null && explored === null) ? await this.transitAuto() : null;
    // wq#472: planned deterministic turn between brain calls (null = feature
    // off, budget spent, or state needs judgment -> brain path).
    const planned = (forced === null && explored === null && transited === null && this.autoBudget > 0)
      ? await this.plannedAuto() : null;
    if (forced !== null) {
      result = forced;
      act = "AUTO:battle_lock";
      think = "[soft-lock escalation - harness action, no brain call]";
    } else if (explored !== null) {
      // A harness turn, so it stays out of the brain's stall accounting, the
      // same as transit: stallTurns measures the brain failing to progress.
      plannedTurn = true;
      result = explored;
      act = "AUTO:grass_breakout";
      think = "[exploration override - no brain call]";
    } else if (transited !== null) {
      plannedTurn = true;
      result = transited.result;
      act = `DET:transit_${transited.kind}`;
      think = "[transit policy - harness action, no brain call (wq#487)]";
    } else if (planned !== null) {
      this.autoBudget--;
      plannedTurn = true;
      result = planned.result;
      act = `DET:${planned.kind}`;
      think = "[planned deterministic turn - no brain call (wq#472)]";
    } else {
      const r0 = await this.brain.complete(buildMessages(this.hist, this.pad.renderNotes(), stateBlock, this.pad.renderGuidance(), this.recallPersona()));
      let text = r0.text;
      think = (text.match(/THINK:\s*(.+)/i)?.[1] ?? "").slice(0, 200);
      act = text.match(/ACT:\s*(.+)/i)?.[1] ?? "";

      // The reasoning model sometimes spends its whole budget narrating and never
      // emits an ACT line. Retry with the actRetry profile - a DIFFERENT, cheap,
      // content-reliable model (wq#426) - instead of asking the same model to
      // fail the same way; then deterministic un-wedge so we never burn turns
      // doing nothing.
      if (!act) {
        const nudge = stateBlock + "\n\nYou did not give an ACT line last time. Reply with ONLY:\nACT: <tool>(<args>)";
        const retry = await this.brain.complete(buildMessages(this.hist, this.pad.renderNotes(), nudge, this.pad.renderGuidance(), this.recallPersona()), CFG.profiles.actRetry);
        act = retry.text.match(/ACT:\s*(.+)/i)?.[1] ?? "";
        if (act) think = (think || "retry") + " [ACT recovered via actRetry model]";
      }

      if (act) {
        result = await this.dispatch(act);
      } else {
        this.noActStreak++;
        result = await this.unwedge();
        act = `AUTO:${result.split(" ")[0]}`;
      }
      if (act && !act.startsWith("AUTO:")) this.noActStreak = 0;
      // wq#697: noise-storm tracking. A result matching the NOISE regex
      // increments the streak; any clean result resets it. At NOISE_K, inject
      // an urgent directive naming the valid tools. At 2*NOISE_K, escalate
      // via the vision valve (same path as warp oscillation).
      if (Agent.NOISE_RE.test(result)) {
        this.noiseStreak++;
        if (this.noiseStreak === Agent.NOISE_K) {
          const validTools = "goto(x,y), enter_warp(idx), leave_edge(N|S|E|W), talk(), " +
            "battle_move(slot), flee(), use_item(name), buy_item(name,qty), sell_item(name,qty), " +
            "heal_at_center(), note(text), interact(x,y), choose(yes|no|idx), press(btn)";
          result += `\n! NOISE STORM (${this.noiseStreak} consecutive invalid calls): ` +
            `you are pattern-completing failures. VALID TOOLS: ${validTools}. ` +
            `Read the MAPGRID and WARPS above and pick a REAL target.`;
          this.bus.emit("tool_call", { tool: "noise_storm_breaker",
            streak: this.noiseStreak, src: "harness" });
        }
        if (this.noiseStreak >= Agent.NOISE_K * 2) {
          // Escalate: vision valve + stuck_dump, same as oscillation path
          const p = this.nav.posChecked();
          if (!this.bat.active()) {
            try {
              this.map.build();
              const grid = this.map.ascii(p.x, p.y);
              this.bus.emit("tool_call", { tool: "stuck_dump", pos: p,
                sprites: this.map.sprites, grid, trigger: "noise_storm" });
              await this.escalateVision(p, grid, "stuck");
            } catch { /* geometry failure must not kill the turn */ }
          }
          this.bus.emit("tool_call", { tool: "noise_storm_escalation",
            streak: this.noiseStreak, src: "harness" });
        }
      } else {
        this.noiseStreak = 0;
      }
      // wq#472: a brain-driven turn just happened - refill the planned-auto
      // budget. ratio=0 keeps this at 0 -> plannedAuto never gates in.
      this.autoBudget = CFG.autoTurnRatio;
    }
    this.bus.emit("think_chunk", { turn: this.turn, think });
    // wq#699: settle() alone returns inside the map-load gap, so `after` — and
    // therefore the turn-summary POS prefix, the `progressed` test, and the
    // checkpoint sidecar written from it — could all carry the departed map's
    // coordinates under the arriving map's id. awaitMapSettled() waits on the
    // loaded map DATA, then quiet, then a stable in-bounds tuple.
    await this.nav.awaitMapSettled();

    const after = this.reader.read();
    const progressed = after.map !== before.map || after.x !== before.x ||
      after.y !== before.y || after.partyCount !== before.partyCount ||
      after.badgeCount !== before.badgeCount || this.bat.active();
    // wq#472: planned harness turns don't count toward the brain's stall
    // escalation - stallTurns measures the BRAIN failing to progress, and no
    // brain call happened this turn. (No-op while ratio=0: plannedTurn never true.)
    if (!plannedTurn) this.brain.reportProgress(progressed);

    // wq#1179: one progress sample per turn, taken from the SAME settled `after`
    // read the turn summary and the checkpoint sidecar use — a novelty signal
    // read mid-map-load would count the departed map's coordinates under the
    // arriving map's id (the wq#699 class) and invent tiles that do not exist.
    // Wrapped because bookkeeping may never break a turn; the tracker's own file
    // I/O is fail-soft too, so this catch is for arithmetic on a torn read.
    try {
      const s = this.novelty.observe(this.turn, after);
      // wq#1828: the same sample decides whether the exclusion still holds —
      // new ground inside the patch means it was not dead after all — and
      // wq#1839: ages it, in the sample's own seq rather than in `this.turn`.
      this.exclusion.observe(s.seq, s.map, s.x, s.y, s.newTiles);
    } catch { /* observe-only */ }

    const line = `T${this.turn} [map${after.map} ${after.x},${after.y}] ${act.slice(0, 60)} => ${result.slice(0, 120)}`;
    this.hist.push(line);
    this.bus.emit("turn_summary", { line });

    if (this.hist.needsCompaction()) {
      const [old, keep] = this.hist.splitForCompaction();
      try { this.hist.applyCompaction(await this.brain.compact(old), keep); } catch {}
    }
    this.maybeCheckpoint(before, after);
  }

  /** wq#517: deterministic loop NOTICE. Repetition is evidence of repetition
   *  and nothing more -- see src/oscillation.ts for why this no longer tells
   *  the agent which direction is forward, and why the `distinct <= 2` conjunct
   *  that made the wider loop invisible is gone.
   *  CALLERS MUST ONLY CALL THIS ON AN ACTUAL ARRIVAL (r === "warped"). */
  private async notePotentialOscillation(mapId: number): Promise<string> {
    this.mapHistory.push(mapId);
    if (this.mapHistory.length > 16) this.mapHistory.shift();
    const file = oscHistoryFile();
    if (this.crossRunWarps === null) this.crossRunWarps = loadOscHistory(file);
    this.crossRunWarps.push(mapId);
    saveOscHistory(file, this.crossRunWarps);
    const v = assessOscillation(mapId, this.mapHistory, this.crossRunWarps);
    // wq#658: rising edge only — assessOscillation has no debounce of its own
    // and keeps tripping true every turn the condition holds (by design: the
    // LOOP NOTICE text is meant to persist). Escalate vision once per episode.
    const rising = v.trip && !this.lastOscTrip;
    this.lastOscTrip = v.trip;
    if (!v.trip) return "";
    // Distinct event kind so wq#515's detectors and lpp-stats can count trips
    // without parsing prose out of turn_summary.
    this.bus.emit("oscillation", {
      map: v.map, rule: v.rule,
      withinCount: v.withinCount, withinWindow: v.withinWindow,
      crossCount: v.crossCount, crossWindow: v.crossWindow,
      recent: v.recent,
    });
    // An oscillation TRIP is exactly the shape the vision valve's same-tile
    // stuck_dump streak structurally cannot see (the position changes every
    // call by definition). Feed it in on its own trigger path.
    if (rising) await this.maybeConsultVisionOnOscillation(this.nav.posChecked());
    return v.message;
  }

  /** S2 checkpoint writer: stability-guarded, sidecar-tagged, milestone-aware,
   *  self-pruning. Unique names per run: recycling names once resumed us
   *  straight back into a wedged state, forever. */
  maybeCheckpoint(before: GameState, after: GameState): void {
    // Stability guard: never snapshot mid-battle / mid-dialog / mid-script -
    // transition-frame RAM is not a resume target.
    if (this.bat.active() || this.dlg.open() || this.sync.textUp()) return;
    // wq#699: "mid-script" is exactly what the guard above could NOT see. A
    // map load in flight leaves wCurMap on the destination while the header,
    // warp table and coordinates still describe the map being left, and all
    // three flags read zero throughout the first dozen frames of it. Every
    // `auto-*-map88` checkpoint on disk was written in that window: map88 with
    // Route 25's (45,3) and onWarp computed off Route 25's warp list. That is
    // the literal case this guard's own comment promised to exclude.
    if (this.map.loadPending()) {
      this.bus.emit("tool_call", { tool: "checkpoint_skipped", reason: "map_load_pending",
        src: "harness", at: { map: after.map, x: after.x, y: after.y } });
      return;
    }
    const runTag = (this as any)._runTag ?? ((this as any)._runTag = Date.now().toString(36));

    // Milestone: badge gained, or a full heal just landed (Center / white-out
    // respawn) - exactly the safe states S2 wants ranked first.
    const b0 = before.party[0], a0 = after.party[0];
    const fullHeal = !!(b0 && a0 && b0.maxHp > 0 && a0.maxHp > 0 &&
      b0.hp < b0.maxHp && a0.hp === a0.maxHp);
    if (after.badgeCount > before.badgeCount || fullHeal) {
      this.writeCheckpoint(`milestone-${runTag}-map${after.map}-t${this.turn}`, after,
        after.badgeCount > before.badgeCount ? "badge" : "heal");
      return;
    }
    if (after.map !== before.map)
      this.writeCheckpoint(`auto-${runTag}-map${after.map}`, after, "map");
    else if (this.turn % 10 === 0) {
      this.writeCheckpoint(`auto-${runTag}-t${this.turn}`, after, "periodic");
      this.pruneAuto();
    }
  }

  private writeCheckpoint(stem: string, st: GameState, kind: string): void {
    const path = `${this.checkpointDir}/${stem}.state.gz`;
    saveSnapshotFile(this.emu, path);
    const lead = st.party[0];
    // wq#586: stamp the route leg + warp-tile mark so resume can rank Mt Moon
    // positions by route progress with ZERO boot cost, and prefer saves not
    // standing on a ladder. Failure to compute either simply omits it — a
    // legless sidecar ranks as earlier, never wrong.
    let leg: string | undefined; let onWarp = false;
    try {
      this.map.build();
      onWarp = this.map.isWarp(st.x, st.y);
      leg = mtMoonLeg(this.map, st.map, st.x, st.y)?.leg;
    } catch {}
    const sidecar = {
      v: 3, kind, map: st.map, x: st.x, y: st.y,
      badges: st.badgeCount, events: this.reader.eventCount(),
      storyScore: this.reader.storyScore(),  // wq#471: monotonic story flags
      // wq#477: campaign-level frontier, seeds regression detection on restart
      maxStoryScore: Math.max(this.reader.storyScore(), this.recovery?.maxStoryScore ?? 0),
      hpPct: lead && lead.maxHp > 0 ? +(lead.hp / lead.maxHp).toFixed(3) : 1,
      ppOk: !lead || lead.moves.some((mv, i) => mv !== 0 && lead.pp[i] > 0),
      money: st.money, ts: Date.now(),
      leg, onWarp,                          // wq#586 (v3)
      // wq#486: notepad snapshot (redundant recovery path if runtime/notepad.txt
      // is lost; primary restore is bind() from that file). Notes only, not the
      // derived guidance channel.
      notepad: this.pad.toJSON(),
    };
    try { writeFileSync(path.replace(/\.state\.gz$/, ".json"), JSON.stringify(sidecar)); } catch {}
    // wq#522: the sidecar's own `kind` ("periodic" | "map" | "milestone") is a
    // real distinction and is kept, but it must not travel under the name
    // `kind` or it collides with the event envelope. The on-disk sidecar file
    // written just above is UNCHANGED — lpp_frontier.py and resume selection
    // read `kind` out of that file and must keep seeing it.
    const { kind: ckptKind, ...sidecarRest } = sidecar;
    this.bus.emit("checkpoint", { file: stem, ckptKind, ...sidecarRest });
  }

  /** Keep the newest CKPT_KEEP_AUTO auto-* checkpoints; milestones and named
   *  saves are never pruned. */
  private pruneAuto(): void {
    try {
      const autos = readdirSync(this.checkpointDir)
        .filter(f => f.startsWith("auto-") && f.endsWith(".state.gz"))
        .map(f => ({ f, m: statSync(`${this.checkpointDir}/${f}`).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const { f } of autos.slice(CKPT_KEEP_AUTO)) {
        unlinkSync(`${this.checkpointDir}/${f}`);
        const sc = `${this.checkpointDir}/${f.replace(/\.state\.gz$/, ".json")}`;
        if (existsSync(sc)) unlinkSync(sc);
      }
    } catch {}
  }
}
