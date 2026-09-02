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
import { StateReader, PartyMon } from "./state";
import { ITEM } from "./items";
import { PRICE, BALL, MIN_SAFE_PARTY } from "./economy";
import { MOVES } from "./moves";
import { GateConfig, GrindState, GrindConfig, LossLedger, grindStatus } from "./ledger";

// Story flag bit indices (see src/state.ts STORY_FLAGS for derivation)
const F_BEAT_BROCK = 0x077;
const F_BEAT_MISTY = 0x0bf;

const MAP = { CERULEAN: 3, ROUTE_4: 15, ROUTE_24: 35, ROUTE_25: 36,
              CENTER: 64, GYM: 65, MART: 67 } as const;

// Misty gates (ticket-specified): never enter the gym under-leveled or
// under-stocked — Charmeleon vs Water is the campaign's worst matchup.
export const MISTY_MIN_LEVEL = 30;
export const MISTY_MIN_POTIONS = 3;
// wq#674: the live agent hit L30+/3+ potions with a SOLO Charmeleon (moveset
// Rage/Growl/Ember/Leer — Ember is its only damaging move and Water resists
// it) and "ready" flipped true purely on level/potions, so the "GRIND FIRST"
// text was replaced by "YOU ARE READY, enter the gym" every single turn even
// though level was never the wall. Three whiteouts, partyCount stuck at 1 for
// 30+ hours (events/live-agent-1786998394993.jsonl). Same threshold
// catch_policy.ts already uses for its own "solo = insurance-worthy" signal
// (partyCount < 2) — a second body is the minimum bar, not a new number.
export const MISTY_MIN_ROSTER = 2;
const POTION_TARGET = 5;           // buy up to this many before the gym

// wq#677: even partyCount>=2 with level/potions cleared is not enough —
// two Charmeleons still can't beat an all-Water gym (Ember resisted on both).
// At least one party member must be type-effective against Water.
//
// Gen 1 internal species IDs, verified from the ROM via SpeciesNames:
//   Grass: ODDISH=185 (0xB9), BELLSPROUT=188 (0xBC), PARAS=109 (0x6D)
//   Rock:  GEODUDE=169 (0xA9)
// IDs confirmed by: npx tsx -e "import {SpeciesNames} from './src/link/species'..." 2026-08-18
export const MISTY_TYPE_COUNTER_SPECIES = new Set<number>([185, 188, 109, 169]);

/** True if at least one party member is a type-effective counter against
 *  Misty's Water-type gym (Grass or Rock type). */
export function hasTypeCounter(party: Pick<PartyMon, "species">[]): boolean {
  return party.some(m => MISTY_TYPE_COUNTER_SPECIES.has(m.species));
}

/** Shared readiness predicate — the ONE place "ready for Misty" is decided,
 *  used both by the prose guidance below and by agent.ts's hard entry gate
 *  (mistyGymEntryRefusal). Level/potions/roster alone is not enough (wq#674,
 *  wq#677): also requires a Grass/Rock type counter vs her Water gym. */
export function misty_ready(level: number, potions: number, partyCount: number, hasCounter: boolean): boolean {
  return level >= MISTY_MIN_LEVEL && potions >= MISTY_MIN_POTIONS
      && partyCount >= MISTY_MIN_ROSTER && hasCounter;
}

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
  // wq#606 deliverable 3: ONE ordered NEXT objective, so finishing a goal
  // (the 01:41Z ball purchase) never leaves the brain goal-less. The old
  // heal line only fired at the 25% CRITICAL threshold or around gym visits;
  // the live party wandered hurt at 52% HP with PP 9 on a core move for two
  // hours. Heal urgency here is broader: under 60% HP, or any damaging move
  // low on PP, and healing outranks everything else in the region.
  const hasCounter = hasTypeCounter(s.party);
  const ready = misty_ready(level, potions, s.partyCount, hasCounter);
  const hpFrac = lead && lead.maxHp > 0 ? lead.hp / lead.maxHp : 1;
  const lowPP = lead ? lead.moves.some((mv, i) =>
    mv && MOVES[mv] && MOVES[mv].power > 0 && lead.pp[i] <= 5) : false;
  const needHeal = hpFrac < 0.6 || lowPP;
  const thenLine = ready
    ? "enter CERULEAN GYM (map3 building, map65 inside) and fight MISTY."
    : "ROUTE 24 (map35), NORTH exit of Cerulean: fight the Nugget Bridge trainers" +
      " for money/XP and walk the grass to catch BELLSPROUT/ODDISH (Misty counter).";
  const next = needHeal
    ? `NEXT OBJECTIVE: heal at the CERULEAN POKEMON CENTER (map64, in the city) FIRST` +
      ` — lead ${lead ? `${lead.hp}/${lead.maxHp}` : "?"}${lowPP ? ", low PP on a damaging move" : ""}.` +
      ` THEN: ${thenLine}`
    : `NEXT OBJECTIVE: ${thenLine}`;
  const lines = [
    `CERULEAN STAGE (live: L${level} lead, ${potions} potions, $${s.money}):`,
    next,
    "HEAL LOOP: heal at the CERULEAN POKEMON CENTER (map64, in the city)",
    "  BEFORE the gym and AFTER EVERY gym loss - it also resets your respawn",
    "  here. Never re-enter the gym at partial HP/PP.",
    `MART (map67): ${ceruleanBuyPlan(s.money, potions, balls)}.`,
  ];
  if (ready) {
    lines.push(
      `MISTY - YOU ARE READY (L${level} >= ${MISTY_MIN_LEVEL}, ${potions} potions >= ${MISTY_MIN_POTIONS}, ` +
      `party ${s.partyCount} >= ${MISTY_MIN_ROSTER}, Grass/Rock counter present):`,
      "  heal first, then enter CERULEAN GYM (map65). STARYU L18 then",
      `  STARMIE L21. Water/Psychic - ${mistyDamageLine(lead?.moves ?? [])}`,
      "  use_item(potion) whenever HP drops below half.",
      "  BUBBLEBEAM hits hard: never let HP sink under 1/3 without healing.");
  } else {
    const why = [
      level < MISTY_MIN_LEVEL ? `lead L${level} < ${MISTY_MIN_LEVEL}` : "",
      potions < MISTY_MIN_POTIONS ? `${potions} potions < ${MISTY_MIN_POTIONS}` : "",
      s.partyCount < MISTY_MIN_ROSTER
        ? `party of ${s.partyCount} < ${MISTY_MIN_ROSTER} - no backup body/Water counter (wq#674)` : "",
      !hasCounter
        ? "no Grass/Rock type counter in party (BELLSPROUT/ODDISH/PARAS=Grass, GEODUDE=Rock)" : "",
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

/** wq#674 HARD gate — the "MISTY GATE" text above is prose, and prose alone
 *  was proven not to work here: the live agent read it every turn and kept
 *  re-entering the gym solo anyway the moment level/potions cleared, because
 *  nothing actually stopped the enter_warp call (wq#532 lesson — a rule that
 *  exists only as prose is not a rule, same shape as agent.ts's own
 *  mtMoonReentryRefusal / movedSinceWarp refusals). Called from agent.ts at
 *  the enter_warp call site, only when the target warp leads into the gym
 *  (map65); returns the refusal line, or null if entry is fine (ready, or
 *  this campaign stage doesn't apply). Cheap RAM reads only, same convention
 *  as ceruleanGuidance. */
export function mistyGymEntryRefusal(emu: Emulator, sym: SymbolTable, reader: StateReader): string | null {
  if (!reader.eventFlag(F_BEAT_BROCK) || reader.eventFlag(F_BEAT_MISTY)) return null;
  const s = reader.read();
  const lead = s.party[0];
  const level = lead?.level ?? 0;
  const potions = potionCount(emu, sym);
  const hasCounter = hasTypeCounter(s.party);
  if (misty_ready(level, potions, s.partyCount, hasCounter)) return null;
  const why = [
    level < MISTY_MIN_LEVEL ? `lead L${level} < ${MISTY_MIN_LEVEL}` : "",
    potions < MISTY_MIN_POTIONS ? `${potions} potions < ${MISTY_MIN_POTIONS}` : "",
    s.partyCount < MISTY_MIN_ROSTER
      ? `party of ${s.partyCount} < ${MISTY_MIN_ROSTER} - no backup body/Water counter` : "",
    !hasCounter
      ? "no Grass/Rock type counter (need BELLSPROUT, ODDISH, PARAS, or GEODUDE)" : "",
  ].filter(Boolean).join(" and ");
  return `refused - not ready for MISTY (${why}). A Fire-type party has no winning line against an ` +
    `all-Water gym regardless of level (Ember is resisted; Rage locks you in for 20 base power). ` +
    `GRIND Route 24 (map35) + Route 25 (map36) first and catch a BELLSPROUT/ODDISH (Grass counter) ` +
    `or GEODUDE (Rock counter) in the grass there before trying Misty again (wq#674/#677).`;
}

/** wq#1181 (roadmap item 6): the GENERALIZED gate. mistyGymEntryRefusal above is
 *  one leader with hardcoded thresholds; this one refuses re-entry into ANY
 *  engagement the loss ledger says we keep losing, keyed by a caller-chosen
 *  string. Returns the refusal line, or null when entry is fine.
 *
 *  It cannot become permanent: LossLedger.gate() expires on time, on progress,
 *  and on the arm cap (see ledger.ts). This function only renders the verdict. */
export function engagementRefusal(ledger: LossLedger, key: string, label: string,
                                  now: number, sig: string, cfg: GateConfig): string | null {
  const g = ledger.gate(key, now, sig, cfg);
  if (!g.blocked) return null;
  return `refused - ENGAGEMENT GATE on ${label}: ${g.reason}. Walking back in loses again and ` +
    `costs the whiteout tax (half your money, a walk back from the center). GRIND instead: ` +
    `beat route trainers, walk the grass for a second body, then return. The gate lifts by ` +
    `itself when you level up, add a party member, or when it times out (wq#1181).`;
}

/** wq#1181: the notepad line for an active grind. The grind governor is the
 *  bounded remedy a gate prescribes — this is how the brain sees its finish
 *  line and its deadline. */
export function grindGuidance(g: GrindState | null, now: number, level: number,
                              partyCount: number, cfg: GrindConfig): string {
  if (!g) return "";
  return grindStatus(g, now, level, partyCount, cfg).line;
}
