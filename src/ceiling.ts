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
// THRESHOLD, re-verified for wq#1090 now that refusals count: 3 stands. The
// only nav outcomes a brain can legitimately repeat from one tile — battle
// interrupt and open dialog — are excluded by verifyFailed() below, so nothing
// honest reaches 3. A false trip costs one goto, since a single tile of
// movement re-arms the key.
//
// ONE INTERACTION IS DELIBERATE. The wq#1181 fight gate has its own anti-wedge
// exit: it lifts after GATE_MAX_FIRES (10) refusals. Counting gate refusals
// here means a STATIONARY brain now hits the ceiling at 3 and stops feeding
// noteFire(), because check() refuses before dispatch. That is the trade we
// want: 3 wasted turns instead of 10, the gate still lifts on its other three
// paths (TTL, level rise, corroborated recovery), and the fire path still
// accrues for a brain that moves — which is the behaviour the gate is asking
// for in the first place.

export const CEILING = 3;

/** Did this result string report the action failing to do what was asked?
 *  Covered tools only; dialog/battle tools (talk, press, choose, battle_move,
 *  flee) legitimately repeat.
 *
 *  wq#1090: guard refusals on the nav tools USED to be excluded here, on the
 *  reasoning that a refusal is not a failed verify. That reasoning held only
 *  while the guards were rare. wq#1086 widened the wq#674 door-bounce guard
 *  from exact-tile re-entry to warp IDENTITY, and a confused brain promptly
 *  earned four refusals across four maps in eight minutes
 *  (events/live-agent-1787956303157.jsonl, turns 17-45) that the ceiling could
 *  not see: REFUSED is not FAILED-VERIFY, so record() never incremented and
 *  the ceiling could never trip on the pattern however long it ran. From the
 *  brain's side the distinction was always cosmetic — the tool did not do the
 *  thing, and the identical call from the identical tile will not do it next
 *  turn either. So it counts. */
export function verifyFailed(tool: string, result: string): boolean {
  switch (tool) {
    case "buy_item":
      // successes: "bought 2x potion for 600; have 5". Everything items.buy
      // returns otherwise is a "buy: <reason>" failure, and the dispatch-level
      // guards ("buy_item: not during a battle" / unknown item) are equally
      // pointless to retry verbatim.
      return !result.startsWith("bought");
    case "use_item":
      // failures are prefixed "use_item:"; successes read "use_item done:",
      // "used ... in battle", "caught it...", "... thrown - ...".
      return /^use_item:/.test(result) || result.startsWith("catch: cannot");
    case "goto":
    case "enter_warp":
    case "leave_edge": {
      // Every string agent.ts's dispatchInner returns for these three has one
      // of three shapes, so classify by SHAPE rather than by enumerating the
      // guards — enumerating is what let wq#1086's new refusal slip past.
      //   "<tool> -> <outcome> now {pos}"  the call actually ran. Of the
      //       outcomes nav can report (arrived/moved/warped/adjacent_npc/
      //       stuck) only "stuck" is the call failing.
      //   "<tool> interrupted ..." / "<tool> blocked: ..."  a wild battle or
      //       an open dialog got in the way. Transient world state, not the
      //       call failing — and wq#487 has the harness resume the
      //       interrupted one itself, so the brain isn't even retrying.
      //   "<tool>: <reason>"  a guard refusal, a bad arg, or a caught throw.
      //       The tool declined; repeating it verbatim from this tile gets
      //       the same refusal. Counts.
      // Default-true is the load-bearing half: a guard added to agent.ts
      // tomorrow counts without anyone remembering to edit this file.
      const ran = /^\w+ -> (\w+) now /.exec(result);
      if (ran) return ran[1] === "stuck";
      if (/^\w+ (?:interrupted|blocked)\b/.test(result)) return false;
      return true;
    }
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
    // wq#1090: "failed or been refused", not "failed its verify" — a refusal
    // now reaches this line too, and telling the brain its verify failed when
    // a guard turned it away sends it debugging the wrong thing.
    return `retry_ceiling: ${tool}(${args}) has already failed or been refused ${CEILING}x from ` +
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
