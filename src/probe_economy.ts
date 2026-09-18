// wq#516: red/green probe for the economy directive. Pure — no emulator, no
// ROM, no service. Every branch of economyAdvice() is asserted in BOTH
// directions (fires when it should, stays silent when it should not), because
// the defect this module exists to fix was three guards silently returning
// null in exactly the state where they most needed to speak.
//
// wq#1835 added branch 0 (broke while carrying a sellable). Its red/green lives
// in probe_sell1835 section C, next to the ROM price table the branch's numbers
// come from — asserting the directive apart from the prices that feed it would
// pin the sentence and not the claim.
import { economyAdvice, cheapestInStock, affordable, PRICE, BALL, BALL_PRICE,
         MIN_SAFE_PARTY, ballMarts, EconomyCtx } from "./economy";
import { ITEM, MART_ORDER, MART_CITY } from "./items";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
const base: EconomyCtx = {
  money: 3000, balls: 5, partyCount: 6, leadLevel: 40,
  inMart: false, martStock: undefined, gymMinLevel: 30,
};
const ctx = (o: Partial<EconomyCtx>): EconomyCtx => ({ ...base, ...o });

// --- price table integrity -------------------------------------------------
ok("BALL id agrees with items.ts ITEM.POKE_BALL", BALL === ITEM.POKE_BALL, `${BALL} vs ${ITEM.POKE_BALL}`);
ok("ball price is the verified Gen 1 200", BALL_PRICE === 200, String(BALL_PRICE));
ok("potion price is the verified Gen 1 300", PRICE[ITEM.POTION] === 300, String(PRICE[ITEM.POTION]));
ok("antidote price is the verified Gen 1 100", PRICE[ITEM.ANTIDOTE] === 100, String(PRICE[ITEM.ANTIDOTE]));
ok("every corridor mart that stocks balls is priced",
   [42, 56, 67, 91].every(m => (MART_ORDER[m] ?? []).includes(ITEM.POKE_BALL) && PRICE[ITEM.POKE_BALL] > 0));

// --- wq#1829: ballMarts() is derived, so it cannot go stale -----------------
ok("MART_CITY names every MART_ORDER map (no mart renders as a bare id)",
   Object.keys(MART_ORDER).every(m => typeof MART_CITY[Number(m)] === "string"),
   Object.keys(MART_ORDER).filter(m => !MART_CITY[Number(m)]).join(","));
ok("MART_CITY has no key MART_ORDER does not stock",
   Object.keys(MART_CITY).every(m => Array.isArray(MART_ORDER[Number(m)])),
   Object.keys(MART_CITY).filter(m => !MART_ORDER[Number(m)]).join(","));
ok("ballMarts() lists all four corridor marts, map-id ordered",
   ballMarts().join(" | ") === "Viridian (map42) | Pewter (map56) | Cerulean (map67) | Vermilion (map91)",
   ballMarts().join(" | "));
ok("ballMarts() skips a mart that does not stock balls",
   !ballMarts().some(m => m.includes("map99")));

// --- cheapestInStock / affordable ------------------------------------------
ok("cheapest of the Cerulean stock is the antidote", cheapestInStock(MART_ORDER[67]) === 100, String(cheapestInStock(MART_ORDER[67])));
ok("cheapest of an empty stock is Infinity", cheapestInStock([]) === Infinity);
ok("cheapest of undefined stock is Infinity", cheapestInStock(undefined) === Infinity);
ok("$71 affords zero balls", affordable(71, BALL) === 0, String(affordable(71, BALL)));
ok("$200 affords exactly one ball", affordable(200, BALL) === 1, String(affordable(200, BALL)));
ok("$650 affords three balls", affordable(650, BALL) === 3, String(affordable(650, BALL)));
ok("an unpriced id affords zero", affordable(9999, 0xff) === 0);

// --- 1. BROKE (the live state: $71, 0 balls, party of 1) --------------------
const broke = economyAdvice(ctx({ money: 71, balls: 0, partyCount: 1, leadLevel: 27 }));
ok("BROKE fires on the live state", !!broke && broke.startsWith("! BROKE"), String(broke));
ok("BROKE names the actual purse", !!broke && broke.includes("$71"), String(broke));
ok("BROKE names the ball price", !!broke && broke.includes("$200"), String(broke));
ok("BROKE names trainers as the only income", !!broke && /TRAINERS/.test(broke), String(broke));
ok("BROKE does NOT fire once a ball is affordable",
   !(economyAdvice(ctx({ money: 200, balls: 0, partyCount: 1 })) ?? "").startsWith("! BROKE"));
ok("BROKE does NOT fire while balls are in hand",
   !(economyAdvice(ctx({ money: 0, balls: 2, partyCount: 1 })) ?? "").startsWith("! BROKE"));

// --- 2. in a mart, can afford ----------------------------------------------
const inMart = economyAdvice(ctx({ money: 650, balls: 0, partyCount: 1, inMart: true, martStock: MART_ORDER[67] }));
ok("mart directive fires", !!inMart && inMart.includes("buy_item(poke_ball"), String(inMart));
ok("mart directive buys up to the safe-party target", !!inMart && inMart.includes(`poke_ball, ${MIN_SAFE_PARTY})`), String(inMart));
ok("mart directive silent when the mart does not stock balls",
   !(economyAdvice(ctx({ money: 650, balls: 0, inMart: true, martStock: [ITEM.POTION] })) ?? "").includes("IN A MART"));
ok("mart directive silent when already stocked",
   !(economyAdvice(ctx({ money: 650, balls: 3, inMart: true, martStock: MART_ORDER[67] })) ?? "").includes("IN A MART"));

// --- 3. funded but no balls and not in a mart ------------------------------
const funded = economyAdvice(ctx({ money: 650, balls: 0, partyCount: 1 }));
ok("funded-but-ball-less directive fires", !!funded && funded.includes("ZERO balls"), String(funded));
ok("funded directive names a mart to route to", !!funded && /map56|map67/.test(funded), String(funded));
// wq#1829: it used to name Pewter and Cerulean only, from memory. Now derived.
ok("funded directive names EVERY mart that stocks balls",
   !!funded && ballMarts().every(m => funded.includes(m)), String(funded));

// --- 4. balls in hand, fragile party ---------------------------------------
const grow = economyAdvice(ctx({ money: 50, balls: 2, partyCount: 1, leadLevel: 27 }));
ok("grow-the-party directive fires", !!grow && grow.includes("PARTY OF 1"), String(grow));
ok("grow directive teaches the weaken-then-throw order", !!grow && /do NOT KO it/.test(grow), String(grow));
ok("grow directive silent at a safe party size",
   !(economyAdvice(ctx({ money: 50, balls: 2, partyCount: MIN_SAFE_PARTY })) ?? "").includes("PARTY OF"));

// --- 5. under-levelled, and the fully-resourced silence --------------------
const lvl = economyAdvice(ctx({ partyCount: 4, leadLevel: 27, gymMinLevel: 30 }));
ok("under-level tip fires", !!lvl && lvl.includes("L27") && lvl.includes("L30+"), String(lvl));
ok("silent when resourced and levelled", economyAdvice(ctx({})) === null, String(economyAdvice(ctx({}))));
ok("silent when lead level is unknown (0)", economyAdvice(ctx({ partyCount: 4, leadLevel: 0 })) === null);

// --- exactly one directive at a time ---------------------------------------
ok("returns a single line, never a stack",
   (broke ?? "").split("\n").length === 1 && (grow ?? "").split("\n").length === 1);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
