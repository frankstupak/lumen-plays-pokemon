// S6 catch policy (wq#422): WANTED-species table + advisory rendering.
// The catch MECHANISM already exists (items.useInBattle ball path, caught
// detection via wPartyCount growth, metrics via the emitted "catch" event).
// This module supplies the missing POLICY: which wild foes are worth a ball
// and what to tell the brain. Deterministic facts here; strategy stays LLM.
//
// IDs are Gen 1 INTERNAL indices (NOT dex numbers). Ground truth = the loaded
// ROM's MonsterNames table (sym 07:421e, 10 bytes/name, index = id-1);
// probe_catch.ts asserts every WANTED id decodes to the expected name.
// Live anchor: Charmeleon = 178 (matches running party RAM).

export interface Wanted { name: string; why: string; urgent: boolean; noWeaken?: boolean; }

// Blue-version targets for the S6 campaign (Mt Moon -> Cerulean/Misty).
export const WANTED: Record<number, Wanted> = {
  185: { name: "ODDISH",     urgent: true,  why: "Grass type - counter for Misty's water gym (Routes 24/25 grass, Blue version)" },
  188: { name: "BELLSPROUT", urgent: true,  why: "Grass type - the counter for Misty's water gym (Routes 24/25 grass)" },
  148: { name: "ABRA",       urgent: true,  noWeaken: true,
         why: "Psychic, elite long-term - it TELEPORTS away fast, throw immediately" },
  4:   { name: "CLEFAIRY",   urgent: true,  why: "rare tanky body; evolves with the Moon Stone" },
  109: { name: "PARAS",      urgent: false, why: "Bug/Grass body, useful into water" },
  169: { name: "GEODUDE",    urgent: false, why: "Rock/Ground wall for trainer fights" },
  107: { name: "ZUBAT",      urgent: false, why: "extra body = whiteout insurance" },
  36:  { name: "PIDGEY",     urgent: false, why: "extra body = whiteout insurance" },
};

/**
 * One advisory line for the wild-battle observe() block, or null for silence.
 * Silence when: trainer battle handled upstream; no balls; party full; foe not
 * wanted (unless party is a fragile solo); own HP critical (upstream directive
 * takes precedence and healing/ending the fight matters more than catching).
 */
export function catchAdvice(
  foeSpecies: number, foeHp: number, foeMaxHp: number,
  partyCount: number, balls: number, myHpFrac: number,
): string | null {
  if (balls <= 0 || partyCount >= 6) return null;
  if (myHpFrac <= 0.25) return null;                       // HP-critical owns the turn
  const w = WANTED[foeSpecies];
  const soloInsurance = !w && partyCount < 2 && balls >= 2;
  if (!w && !soloInsurance) return null;
  if (w && !w.urgent && balls < 2) return null;            // save the last ball for real targets

  const name = w?.name ?? `#${foeSpecies}`;
  const why = w?.why ?? "you have ONE Pokemon - any second body prevents a whiteout";
  const weakEnough = foeMaxHp > 0 && foeHp / foeMaxHp <= 0.5;
  const how = w?.noWeaken
    ? `use_item(poke_ball) NOW, before it escapes`
    : weakEnough
      ? `its HP is low - use_item(poke_ball) now`
      : `weaken it below half HP first (do NOT KO it), then use_item(poke_ball)`;
  const prefix = w?.urgent ? "! CATCH TARGET" : "TIP: worth catching";
  return `${prefix} ${name} (${why}) - ${how} [balls: ${balls}]`;
}
