// wq#606 deliverable 7: RETRY CEILING — the wq#568 stop-means-stop shape,
// applied to game actions.
//
// THE BURN THIS ENDS (measured, events/live-agent-1786756376060.jsonl): after
// a compound buy desynced the mart menu at 03:51Z, the brain issued TWELVE
// identical buy_item(antidote,1) calls 04:00-04:26Z. Every one failed its own
// verify ("buy: could not verify antidote under cursor (cf91=15)"); money sat
// at 401 throughout, so the verify was HONEST — the retries were pure waste,
// 26 minutes of it. Buys are blind scripted presses; once the menu desyncs
// the macro cannot recover because it cannot SEE the menu (that decode is
// wq#620). The ceiling must not wait for it: any tool action failing its own
// verify CEILING times consecutively at the same position stops being
// retried verbatim — forced stuck_dump + goal reconsideration.
//
// SEMANTICS, precise:
//  * The key is (tool, args, position). Position is where the actor STOOD
//    when it issued the action — items.buy exits the mart menu itself on
//    every failure, so same key = the byte-identical macro rerun from the
//    byte-identical start state; twelve live runs prove that rerun is
//    deterministic waste. A goto that moved partway before sticking lands on
//    a NEW tile, keys fresh, and is not throttled — partial progress is not
//    a verbatim retry.
//  * Interleaved DIFFERENT actions do not refill the budget: the count for a
//    key persists until that key SUCCEEDS or the position changes.
//    (buy/note/buy/note/... is the same burn at half speed.)
//  * Once tripped, the exact key is REFUSED (not executed) until the
//    position changes — moving one tile re-arms it, which is also the
//    cheapest world-state change that alters a menu macro's start
//    conditions. The refusal line says so.
//
// PURE: no emulator, no I/O. agent.ts wires it around dispatch and emits the
// board-visible event + forced stuck_dump on the trip.
//
// wq#1090 — GUARD REFUSALS COUNT NOW. This file used to exclude them outright:
// "a guard refusal is NOT a verify failure and never counts". That held while
// the nav guards fired rarely (wq#674's door guard needed exact-tile re-entry).
// wq#1086 widened that one to match the WARP'S IDENTITY, so it also catches the
// doors that land you adjacent — and it started firing constantly for a
// confused brain. Measured (events/live-agent-1787956303157.jsonl, turns 17-45,
// mistral-small fallback): enter_warp on the just-arrived door at four
// different locations in ~8 minutes, every one correctly refused, and the
// counter never moved once, because REFUSED was not FAILED-VERIFY. That run
// kept landing somewhere new so the ceiling would not have tripped anyway, but
// a tile whose only legal move IS the door back repeats one key forever with
// the ceiling blind to it. A refusal IS the tool failing to do what was asked;
// it just fails before the button presses instead of after them.
//
// THRESHOLD, re-verified for refusals: CEILING stays 3. A refusal is cheaper
// than a failed verify (no presses, no game time), which argues for a looser
// bound — but it is also perfectly DETERMINISTIC, so attempts 2 and 3 carry no
// information attempt 1 did not, where a stuck walk can genuinely differ run to
// run (a sprite steps aside, wq#1662). Three is already generous for a reply
// that cannot change, and one threshold for all tools keeps the rule the brain
// is told (agent.ts's trip line) honest.

export const CEILING = 3;

/** The phrase a SELF-LIMITING guard uses to show the brain what is left of its
 *  own refusal budget ("...or after 7 more refusals"). Those guards — the
 *  exploration exclusion (exclusion.ts, EXCLUSION_MAX_FIRES) and the loss gate
 *  (ledger.ts, GATE_MAX_FIRES) — LIFT BY BEING REFUSED: the budget is the
 *  escape hatch that stops a wrong gate from wedging the run. Ceiling-ing them
 *  at 3 would starve the hatch and make the harness contradict a countdown it
 *  printed one line earlier. Exported so both builders spell it one way and
 *  this carve-out is a contract rather than a coincidence of prose. */
export const REFUSAL_BUDGET_PHRASE = "more refusals";

/** Did a nav guard refuse this action outright? Every one of them answers with
 *  a line starting "refused - " (scope.ts's cross-map and edge refusals,
 *  exclusion.ts, guidance.ts's Misty and loss gates, agent.ts's Mt Moon,
 *  supervisor-ban and just-arrived-door gates), so the word is the signal.
 *  Budgeted refusals are exempt — see REFUSAL_BUDGET_PHRASE. */
function navGuardRefused(result: string): boolean {
  return /\brefused\b/.test(result) && !result.includes(REFUSAL_BUDGET_PHRASE);
}

/** Did this result string report the action failing its OWN verify?
 *  Signatures are the exact strings the executors return today. Covered tools
 *  only; dialog/battle tools (talk, press, choose, battle_move, flee)
 *  legitimately repeat. */
export function verifyFailed(tool: string, result: string): boolean {
  switch (tool) {
    case "buy_item":
      // successes: "bought 2x potion for 600; have 5". Everything items.buy
      // returns otherwise is a "buy: <reason>" failure, and the dispatch-level
      // guards ("buy_item: not during a battle" / unknown item) are equally
      // pointless to retry verbatim.
      return !result.startsWith("bought");
    case "sell_item":
      // successes: "sold 1x nugget for 5000; purse 5096, 0 left". Everything
      // items.sell returns otherwise is a "sell: <reason>" failure, including
      // the two refusals that are permanent for that item (unpriced, or a ball)
      // and so are the most pointless of all to retry.
      return !result.startsWith("sold");
    case "use_item":
      // failures are prefixed "use_item:"; successes read "use_item done:",
      // "used ... in battle", "caught it...", "... thrown - ...".
      return /^use_item:/.test(result) || result.startsWith("catch: cannot");
    case "goto":
    case "enter_warp":
    case "leave_edge":
      return / -> stuck\b/.test(result) || result.includes("bad index") ||
             result.includes("bad direction") || navGuardRefused(result);
    default:
      return false;
  }
}

export interface CeilPos { map: number; x: number; y: number }

export class ActionCeiling {
  private key = "";
  private fails = 0;
  private blockedKey: string | null = null;
  private blockedAt: CeilPos | null = null;

  private k(tool: string, args: string, p: CeilPos): string {
    return `${tool}(${args})@${p.map},${p.x},${p.y}`;
  }

  /** Refusal line if this exact action is ceilinged at this position, else
   *  null. A position change re-arms everything. */
  check(tool: string, args: string, p: CeilPos): string | null {
    if (!this.blockedKey) return null;
    if (this.blockedAt &&
        (this.blockedAt.map !== p.map || this.blockedAt.x !== p.x || this.blockedAt.y !== p.y)) {
      this.reset();
      return null;
    }
    if (this.k(tool, args, p) !== this.blockedKey) return null;
    return `retry_ceiling: ${tool}(${args}) has already failed its verify ${CEILING}x from ` +
      `map${p.map} (${p.x},${p.y}) and is REFUSED verbatim. Move at least one tile, or pick a ` +
      `different action/goal — the same macro from the same tile will fail the same way.`;
  }

  /** Record an EXECUTED action's outcome. Returns true when this record just
   *  tripped the ceiling (caller emits the board event + stuck_dump once). */
  record(tool: string, args: string, p: CeilPos, result: string): boolean {
    const k = this.k(tool, args, p);
    if (!verifyFailed(tool, result)) {
      if (k === this.key) { this.key = ""; this.fails = 0; }   // that key succeeded
      return false;
    }
    if (k === this.key) this.fails++;
    else { this.key = k; this.fails = 1; }
    if (this.fails >= CEILING && this.blockedKey !== k) {
      this.blockedKey = k;
      this.blockedAt = { ...p };
      return true;
    }
    return false;
  }

  reset(): void { this.key = ""; this.fails = 0; this.blockedKey = null; this.blockedAt = null; }
}
