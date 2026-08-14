// wq#478: Cerulean / Misty prep guidance — DYNAMIC stage guidance computed
// from live RAM each turn (money, potion stock, lead level, storyScore),
// injected into the notepad by live_agent.ts inside a tagged section.
// Complements wq#476 corridorNotepad (static per-boot corridor packs): this
// module carries only the state-dependent Cerulean-stage advice.
//
// Map IDs verified against pret/pokered constants/map_constants.asm
// (map_const expansion, 2026-08-13): CERULEAN_CITY=3, CERULEAN_POKECENTER=64,
// CERULEAN_GYM=65, CERULEAN_MART=67, ROUTE_24=35, ROUTE_25=36, ROUTE_4=15.
// Prices: economy.PRICE is the single source (wq#559) — ROM-verified against
// the ItemPrices table (bank 01:4608) by probe_cerulean section P.
//
// COUNTER-MON HOOK (deliverable 4, wq#478): catching a Grass counter for
// Misty is ALREADY covered by the wq#422 catch layer — src/catch_policy.ts
// WANTED lists BELLSPROUT (id 188, urgent) as "the counter for Misty's water
// gym (Routes 24/25 grass)", and the ball/useInBattle mechanism ships with
// it. No new catch logic here by design; this module only reminds the brain
// to walk Route 24/25 grass while grinding (see GRIND block below), which
// gives the existing catch advisory its encounter opportunities.
import { Emulator } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";
import { ITEM } from "./items";
import { PRICE, BALL, MIN_SAFE_PARTY } from "./economy";
import { MOVES } from "./moves";

// Story flag bit indices (see src/state.ts STORY_FLAGS for derivation)
const F_BEAT_BROCK = 0x077;
const F_BEAT_MISTY = 0x0bf;

const MAP = { CERULEAN: 3, ROUTE_4: 15, ROUTE_24: 35, ROUTE_25: 36,
              CENTER: 64, GYM: 65, MART: 67 } as const;

// Misty gates (ticket-specified): never enter the gym under-leveled or
// under-stocked — Charmeleon vs Water is the campaign's worst matchup.
export const MISTY_MIN_LEVEL = 30;
export const MISTY_MIN_POTIONS = 3;
const POTION_TARGET = 5;           // buy up to this many before the gym

/** wq#587: the old ready-branch line said "your best damage is your strongest
 *  non-Fire move" — which, for CHARMELEON's Rage/Growl/Ember/Leer, resolves to
 *  RAGE, the one move the harness must never volunteer (Gen 1 locks the user
 *  in until the battle ends). Compute the recommendation from the ACTUAL
 *  moveset instead: strongest non-lock damaging move, with an explicit RAGE
 *  warning whenever the set contains a lock-in move. Exported for the probe. */
export function mistyDamageLine(moves: number[]): string {
  let name = "", pow = -1, fire = false, hasLock = false;
  for (const id of moves) {
    const m = MOVES[id];
    if (!m) continue;
    if (m.lockIn) { hasLock = true; continue; }
    if (m.power > pow) { pow = m.power; name = m.name; fire = m.type === "FIRE"; }
  }
  const lead = name && pow > 0
    ? `lead with ${name}${fire ? " (resisted here, still your safest damage)" : ""};`
    : "lead with your strongest usable move;";
  return hasLock ? `${lead} NEVER pick RAGE - Gen 1 locks you in until the battle ends;` : lead;
}

/** Count HP-restoring items in the bag (POTION family). RAM layout identical
 *  to Items.bag(): wNumBagItems entries of [id, qty] pairs at wBagItems. */
function potionCount(emu: Emulator, sym: SymbolTable): number {
  const m = emu.mem();
  const n = m[sym.addr("wNumBagItems")];
  const a = sym.addr("wBagItems");
  const HEALS: number[] = [ITEM.POTION, ITEM.SUPER_POTION, ITEM.HYPER_POTION,
                           ITEM.MAX_POTION, ITEM.FULL_RESTORE];
  let total = 0;
  for (let i = 0; i < Math.min(n, 20); i++)
    if (HEALS.includes(m[a + i * 2])) total += m[a + i * 2 + 1];
  return total;
}

/** Count throwable balls in the bag (POKE/GREAT/ULTRA), same RAM layout. */
function ballCount(emu: Emulator, sym: SymbolTable): number {
  const m = emu.mem();
  const n = m[sym.addr("wNumBagItems")];
  const a = sym.addr("wBagItems");
  const BALLS: number[] = [ITEM.POKE_BALL, ITEM.GREAT_BALL, ITEM.ULTRA_BALL];
  let total = 0;
  for (let i = 0; i < Math.min(n, 20); i++)
    if (BALLS.includes(m[a + i * 2])) total += m[a + i * 2 + 1];
  return total;
}

/** Affordable Cerulean-mart shopping list for the current purse — ONE ordered
 *  plan, BALLS FIRST (wq#559/#585): a party of one is the root risk in the
 *  blackout->half-money loop, so ball capacity to MIN_SAFE_PARTY outranks
 *  every heal. Then potions to POTION_TARGET, 1 antidote, 1 parlyz heal,
 *  repels last. Prices come from economy.PRICE (single source, ROM-verified
 *  by probe_cerulean's ItemPrices section) and every rendered call is the
 *  REAL tool name buy_item — the old text rendered a nonexistent `buy(...)`
 *  tool, teaching the brain a hallucinated call in our own guidance. Keeps a
 *  small reserve so a whiteout (half money) never zeroes the purse. */
export function ceruleanBuyPlan(money: number, potions: number, balls: number): string {
  const RESERVE = 200;
  let budget = Math.max(0, money - RESERVE);
  const buys: string[] = [];
  // BALLS FIRST — the one purchase that changes the party-of-one root risk.
  const wantBalls = Math.max(0, MIN_SAFE_PARTY - balls);
  const nBall = Math.min(wantBalls, Math.floor(budget / PRICE[BALL]));
  if (nBall > 0) { buys.push(`buy_item(poke_ball, ${nBall})`); budget -= nBall * PRICE[BALL]; }
  const wantPotions = Math.max(0, POTION_TARGET - potions);
  const nPot = Math.min(wantPotions, Math.floor(budget / PRICE[ITEM.POTION]));
  if (nPot > 0) { buys.push(`buy_item(potion, ${nPot})`); budget -= nPot * PRICE[ITEM.POTION]; }
  if (budget >= PRICE[ITEM.ANTIDOTE]) { buys.push("buy_item(antidote, 1)"); budget -= PRICE[ITEM.ANTIDOTE]; }
  if (budget >= PRICE[ITEM.PARLYZ_HEAL]) { buys.push("buy_item(parlyz_heal, 1)"); budget -= PRICE[ITEM.PARLYZ_HEAL]; }
  // wq#487: repels are the cheapest turn-saver in the game for cave transits
  // (ROM-verified 100 steps of no weak wild encounters — pokeblue bank 03
  // ItemUseRepel `ld b,$64`). $350 each; Cerulean is the FIRST mart that
  // stocks them, and Rock Tunnel is the next cave after Mt Moon. Lowest
  // priority: healing and the Misty gate come first.
  const nRep = Math.min(2, Math.floor(budget / PRICE[ITEM.REPEL]));
  if (nRep > 0) { buys.push(`buy_item(repel, ${nRep})`); budget -= nRep * PRICE[ITEM.REPEL]; }
  if (!buys.length)
    return potions >= MISTY_MIN_POTIONS && balls >= MIN_SAFE_PARTY
      ? "stock is fine - no purchases needed"
      : "money too low to shop - grind Route 24/25 trainer payouts first, then return to the MART";
  return buys.join(" then ");
}

/** Stage guidance string for the notepad, or "" outside the Cerulean stage.
 *  Active window: BEAT_BROCK set, BEAT_MISTY unset (storyScore flags — the
 *  wq#471 monotonic signals), player in the Cerulean region. Cheap: pure RAM
 *  reads, safe to call every turn. */
export function ceruleanGuidance(emu: Emulator, sym: SymbolTable, reader: StateReader): string {
  if (!reader.eventFlag(F_BEAT_BROCK) || reader.eventFlag(F_BEAT_MISTY)) return "";
  const s = reader.read();
  const inRegion = ([MAP.CERULEAN, MAP.ROUTE_4, MAP.ROUTE_24, MAP.ROUTE_25,
                     MAP.CENTER, MAP.GYM, MAP.MART] as number[]).includes(s.map);
  if (!inRegion) return "";
  const lead = s.party[0];
  const level = lead?.level ?? 0;
  const potions = potionCount(emu, sym);
  const balls = ballCount(emu, sym);
  const ready = level >= MISTY_MIN_LEVEL && potions >= MISTY_MIN_POTIONS;
  const lines = [
    `CERULEAN STAGE (live: L${level} lead, ${potions} potions, $${s.money}):`,
    "HEAL LOOP: heal at the CERULEAN POKEMON CENTER (map64, in the city)",
    "  BEFORE the gym and AFTER EVERY gym loss - it also resets your respawn",
    "  here. Never re-enter the gym at partial HP/PP.",
    `MART (map67): ${ceruleanBuyPlan(s.money, potions, balls)}.`,
  ];
  if (ready) {
    lines.push(
      `MISTY - YOU ARE READY (L${level} >= ${MISTY_MIN_LEVEL}, ${potions} potions >= ${MISTY_MIN_POTIONS}):`,
      "  heal first, then enter CERULEAN GYM (map65). STARYU L18 then",
      `  STARMIE L21. Water/Psychic - ${mistyDamageLine(lead?.moves ?? [])}`,
      "  use_item(potion) whenever HP drops below half.",
      "  BUBBLEBEAM hits hard: never let HP sink under 1/3 without healing.");
  } else {
    const why = [
      level < MISTY_MIN_LEVEL ? `lead L${level} < ${MISTY_MIN_LEVEL}` : "",
      potions < MISTY_MIN_POTIONS ? `${potions} potions < ${MISTY_MIN_POTIONS}` : "",
    ].filter(Boolean).join(" and ");
    lines.push(
      `MISTY GATE - DO NOT ENTER THE GYM (map65) YET: ${why}.`,
      "  GRIND FIRST: Route 24 NUGGET BRIDGE (map35) + Route 25 (map36),",
      "  north of Cerulean. Beat the bridge trainers in sequence - that is",
      "  ALSO the story path (Bill's house at the end of Route 25) and pays",
      "  money for the mart. Walk the grass there: a caught BELLSPROUT or",
      "  ODDISH is your Misty counter (the catch advisor will prompt you).",
      "  Heal at the center between grind loops. Return when the gate lifts.");
  }
  return lines.join("\n");
}
