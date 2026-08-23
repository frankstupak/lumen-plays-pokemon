// wq#487: TRANSIT policy — deterministic wild-encounter handling and goto
// resume while a MOVEMENT GOAL is in flight.
//
// Problem (observed live, Mt Moon 1F map59 around 5-6,21): the brain issues
// goto(17,11); a wild battle interrupts the walk; the harness returns "goto
// interrupted by a wild battle"; the brain burns 1-3 turns on the encounter,
// then a FRESH brain turn re-plans the SAME goto. Cave encounter rates are
// high enough that the loop never terminates — hours of turns, near-zero net
// displacement. That is the "playing the same thing over and over".
//
// Fix, two halves, both in the DET layer (zero brain calls — the wq#472
// framing, but budget-INDEPENDENT: transit is a targeted policy, not a rate
// lever, so it fires even at LPP_AUTO_TURN_RATIO=0):
//   1. TRANSIT: while a goto goal is live, a WILD battle is a tax, not a
//      decision — FLEE it. Fight only when flee has already failed twice in
//      this battle, when an XP grind is explicitly requested (CFG.xpGrind),
//      or when the wq#422 catch policy wants the species.
//   2. RESUME: when the battle ends, walk the SAME goto again deterministically
//      instead of paying a brain turn to re-plan it. Capped at
//      TRANSIT_RESUME_CAP attempts per target; past the cap the brain gets the
//      goal back WITH an explicit "this target is not working" line so it
//      picks a different one instead of re-issuing the same goto.
//
// Safety gates are the wq#472 gates, unchanged and non-negotiable: HP <= 25%
// and TRAINER battles always go back to the brain; item and catch decisions
// stay judgment calls.
//
// PURE decision logic — no emulator, no I/O — so src/probe_transit.ts can
// assert the entire truth table offline.

/** A movement goal the harness owns until it arrives, is capped out, or the
 *  map changes underneath it. Coordinates are map-local: same space as goto. */
export interface TransitGoal {
  // "goto" = walk to a tile on this map. "warp" = traverse the warp at that
  // tile (ladders/doors). Mt Moon floor changes are warps, and enterWarp is a
  // goto plus an outward push, so it is interrupted by encounters exactly the
  // same way — both are transit.
  kind: "goto" | "warp";
  map: number; x: number; y: number;
  destMap?: number;    // warp goals only: guards against a rebuilt warp table
  attempts: number;    // deterministic resumes spent on this target
  fleeFails: number;   // failed RUN attempts in the CURRENT battle
}

export type TransitAction = "flee" | "fight" | "catch" | "resume" | "brain";
export interface TransitDecision { action: TransitAction; why: string; noWeaken?: boolean; }

export const HP_FLOOR = 0.25;                 // same gate as wq#472 plannedAuto
export const FLEE_FAILS_BEFORE_FIGHT = 2;     // ticket: "fight only if flee fails twice"
export const TRANSIT_RESUME_CAP = 5;          // ticket: cap resumes per target

export interface BattleCtx {
  wild: boolean;          // inBattle === 1 (trainer battles are never ours)
  // CALLER CONTRACT: read HP only AFTER the battle main menu is up. During the
  // intro frames wBattleMonHP is still 0, and feeding that here makes every
  // fresh encounter look HP-critical and hand back to the brain (live 02:49Z).
  hpFrac: number;         // lead HP fraction; 1 when maxHp is unknown
  hasUsableMove: boolean; // at least one move with PP > 0
  wanted: boolean;        // catch policy wants this foe AND a catch is possible
  grind: boolean;         // XP grind explicitly requested (CFG.xpGrind)
  noWeaken?: boolean;     // wq#696: catch policy says throw immediately (e.g. ABRA)
  catchSticky?: boolean;  // wq#696: harness owns catch encounters, not the brain
  foeHpFrac?: number;     // wq#696: foe HP fraction for weaken-before-throw gating
}

/** What to do about the battle currently on screen. */
export function decideBattle(goal: TransitGoal | null, c: BattleCtx): TransitDecision {
  if (!goal) return { action: "brain", why: "no transit goal in flight" };
  if (!c.wild) return { action: "brain", why: "trainer battle - no escape, brain owns it" };
  if (c.hpFrac <= HP_FLOOR) return { action: "brain", why: "HP critical - healing/items are a judgment call" };
  if (c.grind) return { action: "brain", why: "XP grind requested - encounters are the point" };
  // wq#696: catch-sticky mode — when the harness owns the catch objective, a
  // WANTED encounter is caught deterministically instead of handing back to the
  // brain (which, absent an explicit catch objective, flees or ignores it).
  // The noWeaken flag (ABRA: throw immediately) skips the weaken phase.
  if (c.wanted && c.catchSticky) {
    if (c.noWeaken) return { action: "catch", noWeaken: true, why: "catch-sticky: WANTED species (noWeaken - throw immediately)" };
    if (c.foeHpFrac !== undefined && c.foeHpFrac <= 0.5) return { action: "catch", why: "catch-sticky: WANTED species, HP low enough - throw ball" };
    if (c.hasUsableMove) return { action: "fight", why: "catch-sticky: WANTED species, weaken first (do not KO)" };
    return { action: "catch", why: "catch-sticky: WANTED species, no usable move - throw ball as-is" };
  }
  if (c.wanted) return { action: "brain", why: "catch policy wants this species" };
  if (goal.fleeFails >= FLEE_FAILS_BEFORE_FIGHT)
    return c.hasUsableMove
      ? { action: "fight", why: `flee failed ${goal.fleeFails}x - fight through it` }
      : { action: "brain", why: "flee failed and no move has PP - brain decides (Struggle/item)" };
  return { action: "flee", why: "wild encounter during transit - fleeing is free progress" };
}

export interface Pos { map: number; x: number; y: number; }

/** What to do in the overworld while a goal is still in flight. */
export function decideOverworld(goal: TransitGoal | null, p: Pos,
                                cap = TRANSIT_RESUME_CAP): TransitDecision {
  if (!goal) return { action: "brain", why: "no transit goal in flight" };
  if (goal.map !== p.map) return { action: "brain", why: `map changed (${goal.map} -> ${p.map}) - goal is stale` };
  // Standing ON a warp tile means the warp did not fire (enterWarp pushes
  // outward from there), so a warp goal is NOT complete just because we
  // arrived — only a goto goal is.
  if (goal.kind === "goto" && goal.x === p.x && goal.y === p.y)
    return { action: "brain", why: "already at the goal" };
  if (goal.attempts >= cap) return { action: "brain", why: `resume cap ${cap} reached` };
  return { action: "resume", why: `resume goto(${goal.x},${goal.y}) - attempt ${goal.attempts + 1}/${cap}` };
}

/**
 * Bookkeeping around the pure deciders. One instance per Agent; goals do NOT
 * survive an agent reboot on purpose — after a continue, a fresh brain turn is
 * the right way to re-establish intent.
 */
export class TransitTracker {
  goal: TransitGoal | null = null;
  readonly stats = { flees: 0, fleeFailures: 0, fights: 0, catches: 0, catchAttempts: 0, resumes: 0, arrivals: 0, capped: 0 };
  private handback: string | null = null;
  /** wq#696: when true, WANTED encounters are caught deterministically by the
   *  harness instead of handing back to the brain. Set by the catch leg in
   *  guidance/cerulean when the active objective is a catch. */
  catchSticky = false;

  /** Record the outcome of every goto (brain-issued OR resume-issued).
   *  "battle" is the only result that puts a target under harness ownership:
   *  the walk was interrupted, so there is something to resume. Any other
   *  result means the goto concluded and the brain owns what happens next. */
  onGoto(tx: number, ty: number, result: string, map: number): void {
    this.record("goto", tx, ty, undefined, result, map);
  }

  /** Same contract for warp traversal (ladders, doors): enterWarp walks to the
   *  tile first, so it is interrupted by wild encounters identically. destMap
   *  is remembered so a resume can re-find the warp after map.build(). */
  onWarp(w: { x: number; y: number; destMap: number }, result: string, map: number): void {
    this.record("warp", w.x, w.y, w.destMap, result, map);
  }

  private record(kind: "goto" | "warp", tx: number, ty: number,
                 destMap: number | undefined, result: string, map: number): void {
    if (result === "battle") {
      if (this.goal && this.goal.kind === kind && this.goal.map === map &&
          this.goal.x === tx && this.goal.y === ty) return;   // same target: keep attempts
      this.goal = { kind, map, x: tx, y: ty, destMap, attempts: 0, fleeFails: 0 };
      this.handback = null;
      return;
    }
    if (this.goal && this.goal.x === tx && this.goal.y === ty) {
      if (result === "arrived" || result === "warped" || result === "adjacent_npc") { this.stats.arrivals++; this.handback = null; }
      this.goal = null;   // concluded one way or another: the brain owns what's next
    }
  }

  /** Battle decision (pure; bookkeeping happens in noteFlee/noteFight). */
  battleStep(c: BattleCtx): TransitDecision { return decideBattle(this.goal, c); }

  /** Overworld decision + bookkeeping: counts attempts, retires dead goals,
   *  and produces the brain-facing handback line when the cap is hit. */
  overworldStep(p: Pos, cap = TRANSIT_RESUME_CAP): TransitDecision {
    const d = decideOverworld(this.goal, p, cap);
    if (d.action === "resume") { this.goal!.attempts++; this.stats.resumes++; return d; }
    if (this.goal) {
      if (d.why.startsWith("resume cap")) {
        this.stats.capped++;
        this.handback = `! TRANSIT: goto(${this.goal.x},${this.goal.y}) was resumed ${cap} times and still has not arrived.` +
          ` That target is not working — pick a DIFFERENT target (nearest ladder/exit warp from the WARPS list)` +
          ` or enter_warp instead. Do NOT re-issue the same goto.`;
      }
      this.goal = null;   // arrived / stale / capped: the brain owns it again
    }
    return d;
  }

  noteFlee(result: string): void {
    if (result === "fled") { this.stats.flees++; if (this.goal) this.goal.fleeFails = 0; return; }
    this.stats.fleeFailures++;
    if (this.goal) this.goal.fleeFails++;
  }
  noteFight(): void { this.stats.fights++; }
  /** wq#696: catch attempt bookkeeping. */
  noteCatchAttempt(): void { this.stats.catchAttempts++; }
  noteCatchSuccess(): void { this.stats.catches++; }
  /** Called whenever we observe the overworld: the next battle starts fresh. */
  battleEnded(): void { if (this.goal) this.goal.fleeFails = 0; }

  /** One brain-facing line for observe(), or null. Only the CAP handback is
   *  surfaced — routine handbacks (trainer, HP, catch) are already visible in
   *  the state block and would just be noise. */
  advice(): string | null { return this.handback; }
  active(): boolean { return this.goal !== null; }
  clear(): void { this.goal = null; }
}

/**
 * Repel advisory for cave / transit maps. ROM-verified against this run's own
 * pokeblue.gb (bank 03: ItemUseRepel `ld b,$64` = 100 steps, ItemUseSuperRepel
 * $c8 = 200, ItemUseMaxRepel $fa = 250), and gated on wRepelRemainingSteps
 * (0xd0db, pokeblue.sym) so we never advise burning a second repel over a live
 * one. Silence when there is no repel in the bag: the advisory must never ask
 * for an item the player does not have.
 */
export function repelAdvice(map: number, repels: number, remainingSteps: number,
                            transitMaps: number[]): string | null {
  if (repels <= 0 || !transitMaps.includes(map)) return null;
  if (remainingSteps > 0) return null;
  return `TIP: REPEL x${repels} in bag — use_item(repel) NOW: it blocks weak wild encounters for 100 steps,` +
    ` the single biggest turn saver while crossing this cave.`;
}
