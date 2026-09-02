// wq#1181 acceptance (roadmap item 5): the damage calc reproduces Gen 1's
// arithmetic, the winnability verdict calls a known-unwinnable matchup
// UNWINNABLE and a known-winnable one WINNABLE, and the forced flee stays
// WITHHELD until it is explicitly enabled — the soak-week requirement the
// roadmap attaches to this item ("Medium risk: advisory for a soak week before
// it forces") is a property of the code here, not a deployment note.
//
// PURE PROBE. calc.ts and softlock.ts touch no emulator, no ROM and no disk, so
// this runs in CI alongside the other pure probes (scripts/probes-pure.sh).
import {
  TYPE, TYPE_EFFECTS, DEFAULT_CHART, DEFAULT_MOVES, chartFromTriples, effectiveness,
  damage, winnability, moveEstimates, isPhysical, Combatant, MoveSource,
  ROLL_MIN, ROLL_MAX, UNKNOWN_POWER, STATUS,
} from "./calc";
import { assessWinnability } from "./softlock";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

/** A combatant with sane defaults; every test states only what it varies. */
const mon = (o: Partial<Combatant> & { moves: { id: number; pp: number }[] }): Combatant => ({
  species: 1, level: 20, hp: 60, maxHp: 60,
  atk: 40, def: 40, spc: 40, speed: 40,
  type1: TYPE.NORMAL, type2: TYPE.NORMAL, status: 0,
  ...o,
});

// Move ids from the hand-typed table in moves.ts (retired by item 4's ROM
// decode, at which point these ids stay valid — they are the ROM's own).
const EMBER = 52, WATER_GUN = 55, TACKLE = 33, ABSORB = 71, GROWL = 45, SCRATCH = 10;

// ------------------------------------------------- A. the type chart
console.log("=== A. type chart: Gen 1 semantics, including its quirks ===");
{
  const e = (a: number, d1: number, d2 = d1) => effectiveness(DEFAULT_CHART, a, d1, d2);
  chk("A1 water beats fire", e(TYPE.WATER, TYPE.FIRE) === 2);
  chk("A2 fire is resisted by water", e(TYPE.FIRE, TYPE.WATER) === 0.5);
  chk("A3 ground does nothing to flying", e(TYPE.GROUND, TYPE.FLYING) === 0);
  chk("A4 normal does nothing to ghost", e(TYPE.NORMAL, TYPE.GHOST) === 0);
  // The two Gen-1-only entries. Getting these wrong is how a "modern" type
  // chart silently mis-scores half the early campaign.
  chk("A5 gen1: ghost does nothing to psychic", e(TYPE.GHOST, TYPE.PSYCHIC) === 0);
  chk("A6 gen1: poison beats bug and bug beats poison",
      e(TYPE.POISON, TYPE.BUG) === 2 && e(TYPE.BUG, TYPE.POISON) === 2);
  chk("A7 dual types multiply", e(TYPE.ELECTRIC, TYPE.WATER, TYPE.FLYING) === 4);
  chk("A8 mono types do not double-apply", e(TYPE.WATER, TYPE.FIRE, TYPE.FIRE) === 2);
  chk("A9 unlisted pairs are neutral", e(TYPE.NORMAL, TYPE.WATER) === 1);
  // The chart is data in the ROM's own shape, so item 4's decode can replace it
  // wholesale. Prove the injection seam actually works rather than trusting it.
  const swapped = chartFromTriples([[TYPE.NORMAL, TYPE.WATER, 20]]);
  chk("A10 an injected chart replaces the built-in one",
      effectiveness(swapped, TYPE.NORMAL, TYPE.WATER, TYPE.WATER) === 2 &&
      effectiveness(swapped, TYPE.WATER, TYPE.FIRE, TYPE.FIRE) === 1);
  chk("A11 physical/special splits BY TYPE in gen 1",
      isPhysical(TYPE.NORMAL) && isPhysical(TYPE.GHOST) &&
      !isPhysical(TYPE.FIRE) && !isPhysical(TYPE.PSYCHIC));
  chk("A12 every chart entry is a legal multiplier",
      TYPE_EFFECTS.every(([, , x]) => x === 0 || x === 5 || x === 20));
}

// ------------------------------------------------- B. the damage formula
console.log("\n=== B. damage: hand-computed against the gen 1 formula ===");
{
  // base = ((2*L/5 + 2) * power * A / D) / 50 + 2, truncating at each division.
  // L100, 100 power, 100 atk vs 100 def:  42*100*100/100 = 4200; /50 = 84; +2 = 86.
  const base = { level: 100, power: 100, atk: 100, def: 100, stab: false,
                 eff1x10: 10, eff2x10: 10, roll: ROLL_MAX };
  chk("B1 neutral, top roll", damage(base) === 86, String(damage(base)));
  chk("B2 STAB is x1.5 truncated", damage({ ...base, stab: true }) === 129,
      String(damage({ ...base, stab: true })));
  chk("B3 2x doubles", damage({ ...base, eff1x10: 20 }) === 172);
  chk("B4 immunity is zero", damage({ ...base, eff1x10: 0 }) === 0);
  chk("B5 low roll is 217/255", damage({ ...base, roll: ROLL_MIN }) === 73,
      String(damage({ ...base, roll: ROLL_MIN })));
  chk("B6 status moves do nothing", damage({ ...base, power: 0 }) === 0);
  // The clamp: a connecting hit is never 0 damage in Gen 1.
  const tiny = { level: 5, power: 10, atk: 5, def: 100, stab: false,
                 eff1x10: 5, eff2x10: 10, roll: ROLL_MIN };
  chk("B7 a connecting hit always does at least 1", damage(tiny) === 1, String(damage(tiny)));
  chk("B8 a roll range exists at all", damage({ ...base, roll: ROLL_MIN }) < damage(base));
}

// ------------------------------------------------- C. known-unwinnable
console.log("\n=== C. a known-unwinnable wild matchup: verdict=flee ===");
{
  // The live shape: a Fire lead, nearly dead, in tall grass, against a healthy
  // Water foe that out-levels it. Ember is resisted, the foe is faster, and the
  // foe one-shots. This is the encounter the old code fought for 15 turns
  // before the stall counter noticed.
  const me = mon({ level: 10, hp: 4, maxHp: 31, atk: 20, def: 18, spc: 22, speed: 25,
                   type1: TYPE.FIRE, type2: TYPE.FIRE, moves: [{ id: EMBER, pp: 20 }] });
  const foe = mon({ level: 18, hp: 55, maxHp: 55, atk: 34, def: 30, spc: 32, speed: 33,
                    type1: TYPE.WATER, type2: TYPE.WATER, moves: [{ id: WATER_GUN, pp: 25 }] });
  const v = winnability(me, foe);
  chk("C1 verdict is UNWINNABLE", v.verdict === "UNWINNABLE", `${v.verdict} :: ${v.reason}`);
  chk("C2 confidence is high (both movesets known)", v.confidence === "high");
  chk("C3 the foe is faster", !v.faster);
  chk("C4 it takes me longer to KO than to be KO'd", v.myTurns > v.foeTurns,
      `${v.myTurns} vs ${v.foeTurns}`);
  chk("C5 the resisted multiplier is reported", v.eff === 0.5, String(v.eff));

  const advisory = assessWinnability(v, true, false);
  chk("C6 ADVISORY MODE FORCES NOTHING", advisory.force === null, String(advisory.force));
  chk("C7 advisory says what it withheld and why",
      advisory.withheld === "advisory mode (LPP_WINNABILITY_FORCE=0)", String(advisory.withheld));
  chk("C8 advisory still tells the brain to flee",
      !!advisory.directive && /flee\(\)/.test(advisory.directive!));

  const forcing = assessWinnability(v, true, true);
  chk("C9 with forcing enabled the harness flees", forcing.force === "flee");
  chk("C10 a trainer battle is never fled",
      assessWinnability(v, false, true).force === null &&
      assessWinnability(v, false, true).withheld === "trainer battles cannot be fled");
}

// ------------------------------------------------- D. known-winnable
console.log("\n=== D. a known-winnable matchup: verdict=fight ===");
{
  const me = mon({ level: 30, hp: 80, maxHp: 80, atk: 60, def: 50, spc: 65, speed: 62,
                   type1: TYPE.FIRE, type2: TYPE.FIRE, moves: [{ id: EMBER, pp: 20 }] });
  const foe = mon({ level: 5, hp: 20, maxHp: 20, atk: 10, def: 12, spc: 10, speed: 14,
                    type1: TYPE.NORMAL, type2: TYPE.NORMAL, moves: [{ id: TACKLE, pp: 35 }] });
  const v = winnability(me, foe);
  chk("D1 verdict is WINNABLE", v.verdict === "WINNABLE", `${v.verdict} :: ${v.reason}`);
  chk("D2 I am faster", v.faster);
  chk("D3 one turn to KO", v.myTurns === 1, String(v.myTurns));
  const a = assessWinnability(v, true, true);
  chk("D4 a winnable fight forces nothing even with forcing ON", a.force === null);
  chk("D5 and says nothing (no directive noise on a fight we win)", a.directive === null);

  // Type advantage is what separates this from the C block, not level: same
  // levels, opposite matchup. A Grass move into a Water foe.
  const grassy = mon({ level: 18, hp: 50, maxHp: 50, atk: 30, def: 28, spc: 40, speed: 32,
                       type1: TYPE.GRASS, type2: TYPE.GRASS, moves: [{ id: ABSORB, pp: 20 }] });
  const water = mon({ level: 18, hp: 55, maxHp: 55, atk: 34, def: 30, spc: 32, speed: 30,
                      type1: TYPE.WATER, type2: TYPE.WATER, moves: [{ id: WATER_GUN, pp: 25 }] });
  const g = winnability(grassy, water);
  chk("D6 STAB + 2x turns an even level fight winnable",
      g.verdict === "WINNABLE" && g.eff === 2, `${g.verdict} eff=${g.eff}`);
}

// ------------------------------------------------- E. the middle, and the seam
console.log("\n=== E. CLOSE is a real answer, and 0-damage is UNWINNABLE ===");
{
  // Evenly matched: both need a similar number of turns. The point of CLOSE is
  // that it forces nothing while still being said out loud, which is precisely
  // where a level-threshold gate would have said "you are ready".
  const a = mon({ level: 20, hp: 60, maxHp: 60, atk: 40, def: 40, spc: 40, speed: 40,
                  moves: [{ id: TACKLE, pp: 35 }] });
  const b = mon({ level: 20, hp: 60, maxHp: 60, atk: 40, def: 40, spc: 40, speed: 41,
                  moves: [{ id: TACKLE, pp: 35 }] });
  const v = winnability(a, b);
  chk("E1 an even fight is CLOSE", v.verdict === "CLOSE", `${v.verdict} :: ${v.reason}`);
  chk("E2 CLOSE forces nothing", assessWinnability(v, true, true).force === null);
  chk("E3 CLOSE is still rendered to the brain",
      !!assessWinnability(v, true, true).directive);

  // Normal into Ghost: the Gen 1 engine loop softlock.ts was built for. No
  // usable damage at all is UNWINNABLE with certainty, not CLOSE.
  const ghost = mon({ level: 20, hp: 60, maxHp: 60, type1: TYPE.GHOST, type2: TYPE.POISON,
                      moves: [{ id: TACKLE, pp: 35 }] });
  const normal = mon({ level: 30, hp: 90, maxHp: 90, atk: 70, speed: 80,
                       moves: [{ id: TACKLE, pp: 35 }] });
  const n = winnability(normal, ghost);
  chk("E4 a fully immune matchup is UNWINNABLE at any level",
      n.verdict === "UNWINNABLE" && n.myDmg === 0, `${n.verdict} dmg=${n.myDmg}`);
  chk("E5 turns-to-KO is reported as never", n.myTurns === Infinity);

  // All-status moveset: same conclusion by a different route.
  const statusOnly = mon({ level: 30, hp: 90, maxHp: 90, moves: [{ id: GROWL, pp: 40 }] });
  chk("E6 an all-status moveset can never end the fight",
      winnability(statusOnly, mon({ moves: [{ id: TACKLE, pp: 35 }] })).verdict === "UNWINNABLE");
}

// ------------------------------------------------- F. fail-closed on data
console.log("\n=== F. fail-closed: unknown move data never forces an action ===");
{
  // moves.ts covers ~34 of 165 moves until item 4's ROM decode lands, so this
  // is the COMMON case today, not an edge one: an unknown move might be the one
  // that wins the fight, so the verdict may not claim UNWINNABLE on it.
  const me = mon({ level: 10, hp: 4, maxHp: 31, atk: 20, def: 18, spc: 22, speed: 25,
                   type1: TYPE.FIRE, type2: TYPE.FIRE, moves: [{ id: 200, pp: 20 }] });
  const foe = mon({ level: 18, hp: 55, maxHp: 55, atk: 34, def: 30, spc: 32, speed: 33,
                    type1: TYPE.WATER, type2: TYPE.WATER, moves: [{ id: WATER_GUN, pp: 25 }] });
  const v = winnability(me, foe);
  chk("F1 confidence drops to low", v.confidence === "low");
  chk("F2 UNWINNABLE is downgraded to CLOSE", v.verdict === "CLOSE", v.verdict);
  chk("F3 the reason says the data was missing", /LOW confidence/.test(v.reason));
  chk("F4 a low-confidence verdict never forces, even with forcing ON",
      assessWinnability({ ...v, verdict: "UNWINNABLE" }, true, true).force === null);
  chk("F5 and says why it was withheld",
      assessWinnability({ ...v, verdict: "UNWINNABLE", confidence: "low" }, true, true)
        .withheld === "low confidence (move metadata missing)");
  chk("F6 an unknown move is still costed, not ignored",
      moveEstimates(me, foe, DEFAULT_MOVES, DEFAULT_CHART, ROLL_MAX)[0].dmg > 0);
  chk("F7 UNKNOWN_POWER is the documented stand-in", UNKNOWN_POWER === 40);

  // The item-4 seam again, from the move side: a fuller MoveSource restores
  // high confidence with no change to this file.
  const richer: MoveSource = {
    get: (id) => id === 200 ? { id, name: "TEST BEAM", type: TYPE.NORMAL, power: 10 }
                            : DEFAULT_MOVES.get(id),
  };
  const w = winnability(me, foe, { src: richer });
  chk("F8 a complete MoveSource restores high confidence and the verdict",
      w.confidence === "high" && w.verdict === "UNWINNABLE", `${w.confidence} ${w.verdict}`);
}

// ------------------------------------------------- G. the asymmetry rules
console.log("\n=== G. each claim is tested against the assumption that refutes it ===");
{
  // A fight decided by the damage roll must be CLOSE: I win it on my top roll
  // and lose it on my bottom one, so neither claim survives its own test.
  const me = mon({ level: 20, hp: 30, maxHp: 60, atk: 40, def: 40, spc: 40, speed: 50,
                   moves: [{ id: SCRATCH, pp: 35 }] });
  const foe = mon({ level: 20, hp: 30, maxHp: 60, atk: 40, def: 40, spc: 40, speed: 40,
                    moves: [{ id: SCRATCH, pp: 35 }] });
  const hi = moveEstimates(me, foe, DEFAULT_MOVES, DEFAULT_CHART, ROLL_MAX)[0].dmg;
  const lo = moveEstimates(me, foe, DEFAULT_MOVES, DEFAULT_CHART, ROLL_MIN)[0].dmg;
  chk("G1 the two rolls really differ for this matchup", hi > lo, `${hi} vs ${lo}`);
  const v = winnability(me, foe);
  chk("G2 the pessimistic pass drives the WINNABLE claim",
      v.myDmg === lo, `${v.myDmg} vs ${lo}`);
  chk("G3 the foe's damage is taken at ITS best roll", v.foeDmg >= lo);

  // A sleeping foe is credited exactly one free turn, and only where crediting
  // it argues AGAINST the UNWINNABLE claim.
  const sleepy = { ...foe, status: STATUS.SLP_MASK & 0x3 };
  const awake = winnability(me, foe).verdict;
  const asleep = winnability(me, sleepy).verdict;
  chk("G4 a sleeping foe never makes the verdict worse",
      !(awake !== "UNWINNABLE" && asleep === "UNWINNABLE"), `${awake} -> ${asleep}`);

  // A speed tie is a coin flip, so it must not be enough to claim WINNABLE.
  const tieMe = mon({ level: 20, hp: 60, maxHp: 60, speed: 40, moves: [{ id: TACKLE, pp: 35 }] });
  const tieFoe = mon({ level: 20, hp: 60, maxHp: 60, speed: 40, moves: [{ id: TACKLE, pp: 35 }] });
  const t = winnability(tieMe, tieFoe);
  chk("G5 a speed tie is not reported as being faster", !t.faster);
  chk("G6 a mirror match on a speed tie is not claimed WINNABLE",
      t.verdict !== "WINNABLE", t.verdict);
}

// ------------------------------------------------- H. multi-mon trainers
console.log("\n=== H. a trainer's remaining party widens the estimate ===");
{
  const me = mon({ level: 20, hp: 60, maxHp: 60, atk: 45, def: 40, spc: 40, speed: 45,
                   moves: [{ id: TACKLE, pp: 35 }] });
  const foe = mon({ level: 18, hp: 45, maxHp: 45, atk: 35, def: 35, spc: 35, speed: 35,
                    moves: [{ id: TACKLE, pp: 35 }] });
  const solo = winnability(me, foe, { foeRemaining: 1 });
  const six = winnability(me, foe, { foeRemaining: 6 });
  chk("H1 clearing six mons takes longer than clearing one",
      six.clearTurns > solo.clearTurns, `${six.clearTurns} vs ${solo.clearTurns}`);
  chk("H2 the per-foe turn count is unchanged", six.myTurns === solo.myTurns);
  chk("H3 a full roster can flip a winnable exchange out of WINNABLE",
      !(solo.verdict === "WINNABLE" && six.verdict === "WINNABLE") ||
      six.clearTurns < solo.foeTurns, `${solo.verdict} -> ${six.verdict}`);
  chk("H4 the reason names the roster size", /6 foes/.test(six.reason), six.reason);
}

console.log(`\nprobe_calc1181: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
