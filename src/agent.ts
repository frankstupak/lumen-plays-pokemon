// The agent loop: state -> prompt -> brain -> tool dispatch -> repeat.
// Every capability the harness owns is exposed as one tool the brain can call.

import { writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from "fs";
import { Emulator, KEYS, saveSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp } from "./map";
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
import { moveLabel, MOVES, pickBestMove } from "./moves";
import { GameState } from "./state";
import { Items, itemId, ITEM_NAME, ITEM, MART_ORDER } from "./items";
import { Heal, knownCenter } from "./heal";
import { economyAdvice, BALL_PRICE } from "./economy";  // wq#516
import { decodeTrainers, pickEngageTarget, engageAdvice } from "./trainers";  // wq#528
import { MISTY_MIN_LEVEL } from "./guidance";        // wq#516: next-gym level target
import { catchAdvice, WANTED } from "./catch_policy";
import { assessBattleLock } from "./softlock";
import { RecoveryTracker } from "./recovery";
import { TransitTracker, repelAdvice } from "./transit";   // wq#487
import { assess as assessOscillation, historyFile as oscHistoryFile,
         loadHistory as loadOscHistory, saveHistory as saveOscHistory } from "./oscillation";  // wq#517
import { warpViews, renderWarps, stuckHint, WarpView } from "./reach";   // wq#538
import { GameNames } from "./names";
import { CFG } from "./config";

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

export class Agent {
  hist = new History();
  pad = new Notepad();               // wq#486: structured notes + guidance channel
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
  private mapHistory: number[] = [];   // recent map ids for oscillation detection (this run)
  // wq#517: the same list, but surviving restarts and continues. A new Agent
  // is constructed inside live_agent's outer `for (;;)` loop, so the field
  // above resets on every continue while the loop it is meant to catch spans
  // dozens of runs.
  private crossRunWarps: number[] | null = null;
  private unwedgeDirs = ["N", "S", "E", "W"];
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

  constructor(
    public emu: Emulator, public sym: SymbolTable, public rom: Rom,
    public map: MapModel, public nav: Navigator, public scr: Screen,
    public sync: Sync, public dlg: Dialog, public act: Actions,
    public bat: Battle, public reader: StateReader, public brain: Brain,
    public bus: EventBus, public checkpointDir: string,
    public items: Items = new Items(emu, sym, scr, sync, dlg, nav, map, bat),
    public heal: Heal = new Heal(emu, sym, scr, sync, dlg, nav, reader, bat, bus)) {}

  private mapLabel(id: number): string | null {
    if (!this.namesTried) {
      this.namesTried = true;
      try { this.names = new GameNames(this.rom, this.sym); } catch { this.names = null; }
    }
    return this.names ? this.names.mapName(id) : null;
  }

  /** wq#538: the warp list annotated with reachability from where the player is
   *  standing right now, resolved through the same astar that goto() uses. */
  private currentWarpViews(): WarpView[] {
    const p = this.nav.pos();
    let lastMap = 0;
    try { lastMap = this.emu.mem()[this.sym.addr("wLastMap")]; } catch { lastMap = 0; }
    return warpViews(this.map, p.x, p.y, lastMap, id => this.mapLabel(id));
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
      const lock = assessBattleLock(this.btTurns, this.btStall, !trainer);
      if (lock.directive) block += `\n${lock.directive}`;
      block += `\nBAG ${this.items.bagLine()}`;
      return block;
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
        balls: this.items.count(ITEM.POKE_BALL) + this.items.count(ITEM.GREAT_BALL)
             + this.items.count(ITEM.ULTRA_BALL),
        partyCount: st.party.length,
        leadLevel: st.party[0]?.level ?? 0,
        inMart: !!stock,
        martStock: stock,
        gymMinLevel: MISTY_MIN_LEVEL,
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
    const p = this.nav.pos();
    block += `\n${renderWarps(this.currentWarpViews())}`;
    block += `\nMAPGRID (P=you W=warp N=npc #=wall .=open)\n${this.map.ascii(p.x, p.y)}`;

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
    if (this.scr.cursor()) block += `\nCURSOR AT CHOICE (use choose(yes) / choose(no) / choose(<index>))`;
    return block;
  }

  /** Parse "ACT: tool(args)" and run it. Returns a one-line result summary. */
  async dispatch(actLine: string): Promise<string> {
    const m = actLine.match(/(\w+)\s*\(([^)]*)\)/);
    if (!m) return "parse_error: no tool call found";
    const tool = m[1].toLowerCase();
    const args = m[2].split(",").map(a => a.trim().replace(/^["']|["']$/g, ""));
    this.bus.emit("tool_call", { tool, args, src: "brain" });

    // S1 trainer-battle gate: movement is meaningless in any battle and the
    // brain must never believe it fled a trainer fight.
    if ((tool === "goto" || tool === "enter_warp" || tool === "leave_edge") && this.bat.active()) {
      return this.bat.state().inBattle === 2
        ? `${tool}: refused - TRAINER battle, there is no escape; you must fight (battle_move)`
        : `${tool}: refused - in a wild battle; fight it with battle_move`;
    }

    try {
      switch (tool) {
        case "goto": {
          const tx = Number(args[0]), ty = Number(args[1]);
          // wq#601: past the cave, the Mt Moon re-entry warp tile is refused
          // here, not in prose. reader.read() is fresh RAM; map15 is ranked on
          // every tile so corridorPhase needs no prev there.
          {
            const st = this.reader.read();
            if (st.map === 15) {
              this.map.build();
              const w = this.map.warps.find(w => w.x === tx && w.y === ty);
              const ref = mtMoonReentryRefusal(true, corridorPhase(st), w);
              if (ref) return `goto: ${ref}`;
            }
          }
          const r = await this.nav.goto(tx, ty);
          // wq#487: a goto cut short by a battle becomes a harness-owned goal;
          // any other outcome retires it. Must run before the returns below.
          this.transit.onGoto(tx, ty, r, this.nav.pos().map);
          if (r === "battle") return "goto interrupted by a wild battle - the harness will flee it and resume this goto automatically";
          if (r === "dialog") return "goto blocked: a dialog or sign text is open - use talk() to clear it first";
          if (r === "adjacent_npc") {
            const p = this.nav.pos();
            // wq#583: honest arrival-adjacent instead of 25 replans + a lying
            // "reachable" hint. The brain's next verb is the point.
            return `goto: (${tx},${ty}) is occupied by an NPC standing on it, so you cannot stand there.` +
              ` You are now ADJACENT at ${JSON.stringify(p)} - talk() or interact if you meant that NPC,` +
              ` or pick a different destination tile.`;
          }
          if (r === "stuck") {
            const p = this.nav.pos();
            this.bus.emit("tool_call", { tool: "stuck_dump", pos: p,
              sprites: this.map.sprites, grid: this.map.ascii(p.x, p.y) });
            // wq#538: a bare "stuck now {map,x,y}" carries no information the
            // brain can act on, so it re-picks from the same list and burns the
            // turn again. Say WHY it failed and name what would work instead.
            this.map.build();
            return `goto -> stuck now ${JSON.stringify(p)}` +
              stuckHint(this.map, p.x, p.y, tx, ty, this.currentWarpViews());
          }
          return `goto -> ${r} now ${JSON.stringify(this.nav.pos())}`;
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
          }
          const w = this.map.warps[Number(args[0])];
          if (!w) return "enter_warp: bad index";
          const r = await this.nav.enterWarp(w);
          // wq#487: enterWarp walks to the tile first, so a wild encounter
          // interrupts it exactly like a goto - same ownership rules.
          this.transit.onWarp(w, r, this.nav.pos().map);
          if (r === "battle") return "enter_warp interrupted by a wild battle - the harness will flee it and resume this warp automatically";
          if (r === "dialog") return "enter_warp blocked: a dialog or sign text is open - use talk() to clear it first";
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
            ? this.notePotentialOscillation(this.reader.read().map)
            : "";
          return `enter_warp -> ${r} now ${JSON.stringify(this.nav.pos())}${osc}`;
        }
        case "leave_edge": {
          const r = await this.nav.leaveMapEdge(args[0].toUpperCase() as any);
          if (r === "battle") return "leave_edge interrupted by a wild battle - fight it with battle_move";
          if (r === "dialog") return "leave_edge blocked: a dialog or sign text is open - use talk() to clear it first";
          return `leave_edge -> ${r} now ${JSON.stringify(this.nav.pos())}`;
        }
        case "interact": {
          const d = await this.act.interactAt(Number(args[0]), Number(args[1]));
          if (!d) return "interact -> no_response";
          return `interact -> ${d.stoppedAt}; text: ${d.lines.slice(-4).join(" / ").slice(0, 200)}`;
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
          await this.sync.settle();
          await this.emu.tapAsync(key, 8, 24);
          await this.sync.settle(300);
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
        case "heal_at_center": {
          return await this.heal.atCenter();
        }
        case "note": {
          return this.pad.note(args.join(","));
        }
        default: return `unknown tool: ${tool}`;
      }
    } catch (e: any) {
      return `tool error: ${String(e?.message ?? e).slice(0, 120)}`;
    }
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
      if (r === "warped") { this.notePotentialOscillation(this.reader.read().map); return `enter_warp->${w.destMap} auto`; }
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
    const p = this.nav.pos();
    const d = this.transit.overworldStep({ map: p.map, x: p.x, y: p.y }, CFG.transitResumeCap);
    if (d.action !== "resume") return null;

    if (goal.kind === "warp") {
      // Warp tables are rebuilt per map.build(); re-find OUR warp by tile (and
      // destination when known) rather than trusting a stale index.
      this.map.build();
      const w = this.map.warps.find(v => v.x === goal.x && v.y === goal.y &&
        (goal.destMap === undefined || v.destMap === goal.destMap));
      if (!w) { this.transit.clear(); return null; }   // warp gone: brain re-reads WARPS
      this.bus.emit("tool_call", { tool: "enter_warp", args: [`${goal.x},${goal.y}`], src: "transit" });
      const rw = await this.nav.enterWarp(w);
      this.transit.onWarp(w, rw, this.nav.pos().map);
      return { kind: "resume_warp", result: `enter_warp(${goal.x},${goal.y}->map${goal.destMap}) resumed [${goal.attempts}/${CFG.transitResumeCap}] -> ${rw} now ${JSON.stringify(this.nav.pos())}` };
    }

    this.bus.emit("tool_call", { tool: "goto", args: [String(goal.x), String(goal.y)], src: "transit" });
    const r = await this.nav.goto(goal.x, goal.y);
    this.transit.onGoto(goal.x, goal.y, r, this.nav.pos().map);
    return { kind: "resume", result: `goto(${goal.x},${goal.y}) resumed [${goal.attempts}/${CFG.transitResumeCap}] -> ${r} now ${JSON.stringify(this.nav.pos())}` };
  }

  /** wq#423: per-battle counters. HP-only signature: PP is deliberately
   *  excluded so a move that fires but never lands (Normal vs Ghost) still
   *  reads as a stall. Reset the moment the battle is over. */
  private trackBattleLock(): void {
    if (!this.bat.active()) { this.btTurns = 0; this.btStall = 0; this.btLastSig = ""; return; }
    const b = this.bat.state();
    this.btTurns++;
    const sig = `${b.mySpecies}:${b.myHp}|${b.foeSpecies}:${b.foeHp}`;
    if (sig === this.btLastSig) this.btStall++;
    else { this.btStall = 0; this.btLastSig = sig; }
  }

  /** wq#423: deterministic escalation. Returns a result line when the harness
   *  acted (skip the brain this turn), or null for the normal path. */
  private async battleLockForce(): Promise<string | null> {
    if (!this.bat.active()) return null;
    const b = this.bat.state();
    const wild = b.inBattle !== 2;
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
    // wq#487: transit turns (flee an interrupting encounter / resume the
    // interrupted goto). Checked BEFORE plannedAuto and independent of the
    // wq#472 budget: soft-lock escalation still outranks it.
    const transited = forced === null ? await this.transitAuto() : null;
    // wq#472: planned deterministic turn between brain calls (null = feature
    // off, budget spent, or state needs judgment -> brain path).
    const planned = (forced === null && transited === null && this.autoBudget > 0) ? await this.plannedAuto() : null;
    if (forced !== null) {
      result = forced;
      act = "AUTO:battle_lock";
      think = "[soft-lock escalation - harness action, no brain call]";
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
      const r0 = await this.brain.complete(buildMessages(this.hist, this.pad.renderNotes(), stateBlock, this.pad.renderGuidance()));
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
        const retry = await this.brain.complete(buildMessages(this.hist, this.pad.renderNotes(), nudge, this.pad.renderGuidance()), CFG.profiles.actRetry);
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
      // wq#472: a brain-driven turn just happened - refill the planned-auto
      // budget. ratio=0 keeps this at 0 -> plannedAuto never gates in.
      this.autoBudget = CFG.autoTurnRatio;
    }
    this.bus.emit("think_chunk", { turn: this.turn, think });
    await this.sync.settle();

    const after = this.reader.read();
    const progressed = after.map !== before.map || after.x !== before.x ||
      after.y !== before.y || after.partyCount !== before.partyCount ||
      after.badgeCount !== before.badgeCount || this.bat.active();
    // wq#472: planned harness turns don't count toward the brain's stall
    // escalation - stallTurns measures the BRAIN failing to progress, and no
    // brain call happened this turn. (No-op while ratio=0: plannedTurn never true.)
    if (!plannedTurn) this.brain.reportProgress(progressed);

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
  private notePotentialOscillation(mapId: number): string {
    this.mapHistory.push(mapId);
    if (this.mapHistory.length > 16) this.mapHistory.shift();
    const file = oscHistoryFile();
    if (this.crossRunWarps === null) this.crossRunWarps = loadOscHistory(file);
    this.crossRunWarps.push(mapId);
    saveOscHistory(file, this.crossRunWarps);
    const v = assessOscillation(mapId, this.mapHistory, this.crossRunWarps);
    if (!v.trip) return "";
    // Distinct event kind so wq#515's detectors and lpp-stats can count trips
    // without parsing prose out of turn_summary.
    this.bus.emit("oscillation", {
      map: v.map, rule: v.rule,
      withinCount: v.withinCount, withinWindow: v.withinWindow,
      crossCount: v.crossCount, crossWindow: v.crossWindow,
      recent: v.recent,
    });
    return v.message;
  }

  /** S2 checkpoint writer: stability-guarded, sidecar-tagged, milestone-aware,
   *  self-pruning. Unique names per run: recycling names once resumed us
   *  straight back into a wedged state, forever. */
  maybeCheckpoint(before: GameState, after: GameState): void {
    // Stability guard: never snapshot mid-battle / mid-dialog / mid-script -
    // transition-frame RAM is not a resume target.
    if (this.bat.active() || this.dlg.open() || this.sync.textUp()) return;
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
