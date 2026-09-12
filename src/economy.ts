// wq#516: the economy directive — make DESTITUTION LOUD instead of silent.
//
// Diagnosis this module answers (measured 2026-08-13, see the wq#516 board
// note and reports/516_economy_diagnosis.md): the campaign sat at exactly $71
// for ~81 hours of play with itemsBought=0 and catchesAttempted=0 for its
// entire recorded history. Not one bug — three fail-closed guards that are each
// correct in isolation and compose into a deadlock:
//
//   a. agent.ts mart TIP is gated `money >= 100`  -> at $71, silent in a mart
//   b. catchAdvice() returns null when balls <= 0 -> the CATCH line never renders
//   c. transit `wanted:` is gated `balls > 0`     -> every wild is auto-fled,
//                                                    so the brain never even
//                                                    sees an encounter
//
// Each guard says "nothing useful to say here". NOTHING said "you are broke, go
// earn money", so the run degraded silently instead of escalating. This module
// is the missing escalation: a single prioritised directive that names the
// binding constraint and the one action that relieves it.
//
// PURE BY DESIGN: no emulator, no RAM, no I/O — the only import is the ITEM id
// table. Everything else is passed in, so probe_economy runs in milliseconds
// and every branch is red/green testable in both directions.

// Item ids come from src/items.ts — the single source of truth. An earlier
// draft of this module duplicated them from memory and got POTION and ANTIDOTE
// backwards; probe_economy caught it on the first run. Do not re-duplicate.
import { ITEM, MART_ORDER, MART_CITY } from "./items";

export const BALL = ITEM.POKE_BALL;

// Gen 1 Red/Blue mart prices. Sources: GameFAQs "PokeMart Item Prices" (Red)
// cross-checked against the three prices guidance.ts already verified against
// Bulbapedia (POTION 300, ANTIDOTE 100, PARLYZ_HEAL 200). Every corridor mart
// (Viridian 42, Pewter 56, Cerulean 67, Vermilion 91) sells Poke Ball at 200.
export const PRICE: Record<number, number> = {
  [ITEM.POKE_BALL]: 200,
  [ITEM.GREAT_BALL]: 600,
  [ITEM.ULTRA_BALL]: 1200,
  [ITEM.POTION]: 300,
  [ITEM.SUPER_POTION]: 700,
  [ITEM.REPEL]: 350,
  [ITEM.ANTIDOTE]: 100,
  [ITEM.BURN_HEAL]: 250,
  [ITEM.PARLYZ_HEAL]: 200,
  [ITEM.AWAKENING]: 200,
  [ITEM.ESCAPE_ROPE]: 550,
};

export const BALL_PRICE = PRICE[BALL];
/** Party size below which a single whiteout is a total campaign reset. */
export const MIN_SAFE_PARTY = 3;
/** Keep enough to re-buy one ball after a whiteout halves the purse. */
export const PURSE_RESERVE = 0;

/** wq#1829: every mart whose stock list contains a Poke Ball, as
 *  "City (mapNN)". DERIVED from MART_ORDER so adding a mart there cannot leave
 *  this list stale — the hand-written version named Pewter and Cerulean only,
 *  which is how a prompt could tell a broke agent to "route through a mart"
 *  without mentioning the two nearest ones. Sorted by map id for a stable
 *  string, not by distance: nothing in this pure module knows where the player
 *  is, and an invented "nearest" is exactly the kind of confident guess the
 *  corridor pack bans. */
export function ballMarts(): string[] {
  return Object.keys(MART_ORDER).map(Number).sort((a, b) => a - b)
    .filter(map => MART_ORDER[map].includes(BALL))
    .map(map => `${MART_CITY[map] ?? "mart"} (map${map})`);
}

/** Cheapest priced item in a mart's stock list, or Infinity if none priced. */
export function cheapestInStock(stock: readonly number[] | undefined): number {
  if (!stock || stock.length === 0) return Infinity;
  let best = Infinity;
  for (const id of stock) {
    const p = PRICE[id];
    if (typeof p === "number" && p < best) best = p;
  }
  return best;
}

/** How many of `id` this purse can buy, keeping PURSE_RESERVE back. */
export function affordable(money: number, id: number): number {
  const p = PRICE[id];
  if (!p) return 0;
  return Math.max(0, Math.floor((money - PURSE_RESERVE) / p));
}

export interface EconomyCtx {
  money: number;
  balls: number;          // POKE + GREAT + ULTRA
  partyCount: number;
  leadLevel: number;
  inMart: boolean;
  martStock?: readonly number[];   // MART_ORDER[map] when inMart
  /** Level the campaign wants before the next gym (guidance.MISTY_MIN_LEVEL). */
  gymMinLevel: number;
}

/**
 * ONE prioritised economy/party directive, or null when the campaign is
 * adequately resourced. Ordered by binding constraint, not by nicety: the
 * first line that fires is the only thing standing between the run and
 * progress, so exactly one is returned.
 */
export function economyAdvice(c: EconomyCtx): string | null {
  const canBuyBall = c.money >= BALL_PRICE;

  // 1. BROKE. The condition that has held for ~81 hours of play. Nothing else
  //    matters until it changes, so say so in the loudest slot and name the
  //    ONLY mechanism that changes it. Wild battles pay nothing in Gen 1 —
  //    trainers are the entire economy.
  if (!canBuyBall && c.balls <= 0) {
    return `! BROKE: $${c.money}. A Poke Ball costs $${BALL_PRICE} and a Potion $${PRICE[ITEM.POTION]},` +
      ` so you can buy NOTHING and cannot catch anything. In this game money comes ONLY from` +
      ` beating TRAINERS — wild Pokemon pay zero. STOP routing around trainers and fight the` +
      ` ones on your path; each one is income AND experience. Do not plan any purchase until` +
      ` the purse is above $${BALL_PRICE}.`;
  }

  // 2. Can afford balls, standing in a mart that stocks them: buy, now.
  if (canBuyBall && c.balls < MIN_SAFE_PARTY && c.inMart && c.martStock?.includes(BALL)) {
    const n = Math.min(affordable(c.money, BALL), MIN_SAFE_PARTY - c.balls);
    return `! IN A MART with $${c.money} and ${c.balls} ball(s): buy_item(poke_ball, ${n})` +
      ` right now ($${BALL_PRICE} each). Balls are the precondition for a second party member;` +
      ` every turn spent with a party of ${c.partyCount} is one whiteout away from a full reset.`;
  }

  // 3. Can afford balls but nowhere to buy: name the constraint, not the wish.
  if (canBuyBall && c.balls <= 0) {
    return `! You have $${c.money} and ZERO balls. Catching is impossible until you buy some` +
      ` ($${BALL_PRICE} each) — the marts that stock them are ${ballMarts().join(", ")}.` +
      ` Route through one before expecting to grow the party.`;
  }

  // 4. Balls in hand, party still fragile: spend them.
  if (c.balls > 0 && c.partyCount < MIN_SAFE_PARTY) {
    return `! PARTY OF ${c.partyCount} with ${c.balls} ball(s): catching is now possible and it is` +
      ` the priority. A one-Pokemon party makes every whiteout a total reset. Weaken a wild` +
      ` target below half HP (do NOT KO it), then use_item(poke_ball). Target ${MIN_SAFE_PARTY}.`;
  }

  // 5. Resourced but under-levelled for the next gym.
  if (c.partyCount >= MIN_SAFE_PARTY && c.leadLevel > 0 && c.leadLevel < c.gymMinLevel) {
    return `TIP: lead is L${c.leadLevel} and the next gym wants L${c.gymMinLevel}+.` +
      ` Trainer battles on your path give the best experience per turn and pay money too.`;
  }

  return null;
}
