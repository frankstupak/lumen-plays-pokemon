// wq#478: Cerulean / Misty prep guidance — DYNAMIC stage guidance computed
// from live RAM each turn (money, potion stock, lead level, storyScore),
// injected into the notepad by live_agent.ts inside a tagged section.
// Complements wq#476 corridorNotepad (static per-boot corridor packs): this
// module carries only the state-dependent Cerulean-stage advice.
//
// Map IDs verified against pret/pokered constants/map_constants.asm
// (map_const expansion, 2026-08-13): CERULEAN_CITY=3, CERULEAN_POKECENTER=64,
// CERULEAN_GYM=65, CERULEAN_MART=67, ROUTE_24=35, ROUTE_25=36, ROUTE_4=15.
// Gen1 mart prices (Bulbapedia, cross-checked vs pokered mart data):
// POTION 300, ANTIDOTE 100, PARLYZ_HEAL 200.
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

/** Affordable Cerulean-mart shopping list for the current purse. Priority:
 *  potions to POTION_TARGET, then 1 antidote, then 1 parlyz heal; keeps a
 *  small reserve so a whiteout (half money) never zeroes the purse. */
export function ceruleanBuyPlan(money: number, potions: number): string {
  const RESERVE = 200;
  let budget = Math.max(0, money - RESERVE);
  const buys: string[] = [];
  const wantPotions = Math.max(0, POTION_TARGET - potions);
  const nPot = Math.min(wantPotions, Math.floor(budget / 300));
  if (nPot > 0) { buys.push(`buy(potion, ${nPot})`); budget -= nPot * 300; }
  if (budget >= 100) { buys.push("buy(antidote, 1)"); budget -= 100; }
  if (budget >= 200) { buys.push("buy(parlyz_heal, 1)"); budget -= 200; }
  if (!buys.length)
    return potions >= MISTY_MIN_POTIONS
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
  const ready = level >= MISTY_MIN_LEVEL && potions >= MISTY_MIN_POTIONS;
  const lines = [
    `CERULEAN STAGE (live: L${level} lead, ${potions} potions, $${s.money}):`,
    "HEAL LOOP: heal at the CERULEAN POKEMON CENTER (map64, in the city)",
    "  BEFORE the gym and AFTER EVERY gym loss - it also resets your respawn",
    "  here. Never re-enter the gym at partial HP/PP.",
    `MART (map67): ${ceruleanBuyPlan(s.money, potions)}.`,
  ];
  if (ready) {
    lines.push(
      `MISTY - YOU ARE READY (L${level} >= ${MISTY_MIN_LEVEL}, ${potions} potions >= ${MISTY_MIN_POTIONS}):`,
      "  heal first, then enter CERULEAN GYM (map65). STARYU L18 then",
      "  STARMIE L21. Water/Psychic - your best damage is your strongest",
      "  non-Fire move; use_item(potion) whenever HP drops below half.",
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
