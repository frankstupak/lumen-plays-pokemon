// The agent loop: state -> prompt -> brain -> tool dispatch -> repeat.
// Every capability the harness owns is exposed as one tool the brain can call.

import { writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from "fs";
import { Emulator, KEYS, saveSnapshotFile } from "./emulator";
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
import { History, buildMessages, renderState } from "./prompt";
import { Notepad } from "./notepad";
import { moveLabel, MOVES } from "./moves";
import { GameState } from "./state";
import { Items, itemId, ITEM_NAME, ITEM, MART_ORDER } from "./items";
import { Heal, knownCenter } from "./heal";
import { catchAdvice } from "./catch_policy";
import { assessBattleLock } from "./softlock";
import { RecoveryTracker } from "./recovery";
import { CFG } from "./config";

const CKPT_KEEP_AUTO = 40;   // rolling window of auto-* checkpoints kept on disk

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
  private mapHistory: number[] = [];   // recent map ids for oscillation detection
  private unwedgeDirs = ["N", "S", "E", "W"];
  // wq#423 battle soft-lock tracking (per battle, reset when it ends)
  private btTurns = 0;
  private btStall = 0;                 // consecutive turns with no HP change either side
  private btLastSig = "";

  constructor(
    public emu: Emulator, public sym: SymbolTable, public rom: Rom,
    public map: MapModel, public nav: Navigator, public scr: Screen,
    public sync: Sync, public dlg: Dialog, public act: Actions,
    public bat: Battle, public reader: StateReader, public brain: Brain,
    public bus: EventBus, public checkpointDir: string,
    public items: Items = new Items(emu, sym, scr, sync, dlg, nav, map, bat),
    public heal: Heal = new Heal(emu, sym, scr, sync, dlg, nav, reader, bat, bus)) {}

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
      if (wants.length)
        block += `\nTIP: in a Mart with $${st.money} - stock up via buy_item: ${wants.join(", ")}`;
    }
    block += `\nBAG ${this.items.bagLine()}`;

    this.map.build();
    const p = this.nav.pos();
    block += `\nWARPS ${this.map.warps.map((w, i) => `${i}:(${w.x},${w.y})->map${w.destMap}`).join(" ")}`;
    block += `\nMAPGRID (P=you W=warp N=npc #=wall .=open)\n${this.map.ascii(p.x, p.y)}`;

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
          const r = await this.nav.goto(Number(args[0]), Number(args[1]));
          if (r === "battle") return "goto interrupted by a wild battle - fight it with battle_move";
          if (r === "dialog") return "goto blocked: a dialog or sign text is open - use talk() to clear it first";
          if (r === "stuck") {
            const p = this.nav.pos();
            this.bus.emit("tool_call", { tool: "stuck_dump", pos: p,
              sprites: this.map.sprites, grid: this.map.ascii(p.x, p.y) });
          }
          return `goto -> ${r} now ${JSON.stringify(this.nav.pos())}`;
        }
        case "enter_warp": {
          const w = this.map.warps[Number(args[0])];
          if (!w) return "enter_warp: bad index";
          const r = await this.nav.enterWarp(w);
          if (r === "battle") return "enter_warp interrupted by a wild battle - fight it with battle_move";
          if (r === "dialog") return "enter_warp blocked: a dialog or sign text is open - use talk() to clear it first";
          const landed = this.reader.read().map;
          const osc = this.notePotentialOscillation(landed);
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
      // auto-fight picks the strongest damaging move with PP, not blind slot 0
      const b = this.bat.state();
      let best = 0, bestPow = -1;
      b.moves.forEach((m, i) => {
        if (!m || b.pp[i] <= 0) return;
        const pow = MOVES[m]?.power ?? 30;   // unknown moves assumed mid-power
        if (pow > bestPow) { bestPow = pow; best = i; }
      });
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
      let best = usable[0], bestPow = -1;
      for (const i of usable) {
        const pow = MOVES[b.moves[i]]?.power ?? 30;
        if (pow > bestPow) { bestPow = pow; best = i; }
      }
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
    // wq#472: planned deterministic turn between brain calls (null = feature
    // off, budget spent, or state needs judgment -> brain path).
    const planned = (forced === null && this.autoBudget > 0) ? await this.plannedAuto() : null;
    if (forced !== null) {
      result = forced;
      act = "AUTO:battle_lock";
      think = "[soft-lock escalation - harness action, no brain call]";
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

  /** Deterministic oscillation guard: track recent maps; if we keep bouncing
   *  between the same few maps, tell the brain plainly so it stops repeating
   *  the warp that sends it backward. Harness truth, not brain trust. */
  private notePotentialOscillation(mapId: number): string {
    this.mapHistory.push(mapId);
    if (this.mapHistory.length > 8) this.mapHistory.shift();
    const recent = this.mapHistory.slice(-6);
    const counts = new Map<number, number>();
    for (const m of recent) counts.set(m, (counts.get(m) ?? 0) + 1);
    const thisCount = counts.get(mapId) ?? 0;
    const distinct = counts.size;
    // bouncing = few distinct maps, this map seen 3+ times in the last 6 warps
    if (recent.length >= 5 && distinct <= 2 && thisCount >= 3)
      return `\n! OSCILLATION: you keep returning to map${mapId} (recent: ${recent.join("->")}). This warp goes BACKWARD. Pick a DIFFERENT warp index or use goto to a map edge - do NOT repeat this warp.`;
    return "";
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
    const sidecar = {
      v: 2, kind, map: st.map, x: st.x, y: st.y,
      badges: st.badgeCount, events: this.reader.eventCount(),
      storyScore: this.reader.storyScore(),  // wq#471: monotonic story flags
      // wq#477: campaign-level frontier, seeds regression detection on restart
      maxStoryScore: Math.max(this.reader.storyScore(), this.recovery?.maxStoryScore ?? 0),
      hpPct: lead && lead.maxHp > 0 ? +(lead.hp / lead.maxHp).toFixed(3) : 1,
      ppOk: !lead || lead.moves.some((mv, i) => mv !== 0 && lead.pp[i] > 0),
      money: st.money, ts: Date.now(),
      // wq#486: notepad snapshot (redundant recovery path if runtime/notepad.txt
      // is lost; primary restore is bind() from that file). Notes only, not the
      // derived guidance channel.
      notepad: this.pad.toJSON(),
    };
    try { writeFileSync(path.replace(/\.state\.gz$/, ".json"), JSON.stringify(sidecar)); } catch {}
    this.bus.emit("checkpoint", { file: stem, ...sidecar });
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
