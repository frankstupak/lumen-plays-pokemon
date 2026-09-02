// wq#1181 acceptance probe (PURE — no ROM, no emulator, no model call):
//   item 5  a known-unwinnable matchup verdicts "flee"; a known-winnable one "fight"
//   item 6  the engagement gate arms on repeated losses AND EXPIRES three ways
//
// The matchups below are the campaign's real ones, with stats in the range the
// live run actually carries (a solo Charmeleon against Misty is the fight that
// produced FIGHT_LOSS_LOOP in the first place).

import {
  GEN1_MATCHUPS, SideStats, combatant, damageRange, effectiveness, moveInfos,
  setTypeChart, winnability,
} from "./calc";
import {
  DEFAULT_GATE, GateConfig, LossLedger, engagementKey, grindStatus,
  progressSig, startGrind,
} from "./ledger";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const MOVE = { EMBER: 52, SCRATCH: 10, WATER_GUN: 55, BUBBLEBEAM: 61, ABSORB: 71, TACKLE: 33 };
const T = { NORMAL: 0x00, FLYING: 0x02, POISON: 0x03, FIRE: 0x14, WATER: 0x15, GRASS: 0x16, PSYCHIC: 0x18 };
const NONE = 0xff;   // Gen 1 repeats type1 in type2 for single-typed mons; an
                     // unmapped byte decodes to null, i.e. neutral.

const stats = (attack: number, defense: number, speed: number, special: number,
               type1: number, type2 = type1): SideStats => ({ attack, defense, speed, special, type1, type2 });

// ---------------------------------------------------------------- type chart
chk("WATER is 2x into FIRE", effectiveness("WATER", "FIRE", "FIRE") === 2);
chk("FIRE is 0.5x into WATER", effectiveness("FIRE", "WATER", "WATER") === 0.5);
chk("dual type multiplies (GRASS into WATER/FLYING = 1x)",
  effectiveness("GRASS", "WATER", "FLYING") === 1, String(effectiveness("GRASS", "WATER", "FLYING")));
chk("Gen 1 quirk: GHOST does nothing to PSYCHIC", effectiveness("GHOST", "PSYCHIC", "PSYCHIC") === 0);
chk("Gen 1 quirk: POISON is 2x into BUG", effectiveness("POISON", "BUG", "BUG") === 2);
chk("unknown attacking type is neutral, never an invented immunity",
  effectiveness(null, "GHOST", "GHOST") === 1);
setTypeChart(GEN1_MATCHUPS);   // the item-4 seam round-trips

// ------------------------------------------------------------------ item 5 --
// UNWINNABLE: solo L30 Charmeleon (Fire) vs Misty's L21 STARMIE (Water/Psychic).
// Ember is resisted, Scratch is neutral off a mediocre Attack, and Bubblebeam
// off Starmie's high Special two-shots us. This is the exact live matchup.
const charmeleon = combatant(30, 88, 88, stats(63, 60, 72, 68, T.FIRE));
const starmie = combatant(21, 63, 63, stats(50, 55, 85, 70, T.WATER, T.PSYCHIC));
const vsStarmie = winnability({
  me: charmeleon, foe: starmie,
  myMoves: moveInfos([MOVE.EMBER, MOVE.SCRATCH, 0, 0], [25, 35, 0, 0]),
  foeMoves: moveInfos([MOVE.WATER_GUN, MOVE.BUBBLEBEAM, 0, 0]),
  wild: false, healHp: 0,
});
chk("known-unwinnable (Fire vs Water/Psychic) verdict=flee",
  vsStarmie.verdict === "flee", vsStarmie.line);
chk("  ...and it is high confidence (both movesets known)",
  vsStarmie.confidence === "high", vsStarmie.confidence);

// WINNABLE: the same Charmeleon against a L10 wild PIDGEY. Nothing it has can
// out-race us; we KO it well inside its clock.
const pidgey = combatant(10, 29, 29, stats(20, 19, 24, 18, T.NORMAL, T.FLYING));
const vsPidgey = winnability({
  me: charmeleon, foe: pidgey,
  myMoves: moveInfos([MOVE.EMBER, MOVE.SCRATCH, 0, 0], [25, 35, 0, 0]),
  foeMoves: moveInfos([MOVE.TACKLE, 0, 0, 0]),
  wild: true, healHp: 0,
});
chk("known-winnable (L30 vs L10 wild) verdict=fight", vsPidgey.verdict === "fight", vsPidgey.line);

// The one verdict that does not need the foe's numbers: nothing we own damages
// it. GEODUDE (Rock/Ground) is immune to nothing here, so use the real case —
// a party whose only moves are status.
const statusOnly = winnability({
  me: charmeleon, foe: starmie,
  myMoves: moveInfos([45 /* GROWL */, 43 /* LEER */, 0, 0], [40, 30, 0, 0]),
  foeMoves: [],
  wild: true, healHp: 0,
});
chk("no damaging move -> flee at high confidence even with an unknown foe moveset",
  statusOnly.verdict === "flee" && statusOnly.confidence === "high", statusOnly.line);

// An unknown foe moveset must never produce a FORCING verdict.
const unknownFoe = winnability({
  me: charmeleon, foe: starmie,
  myMoves: moveInfos([MOVE.EMBER, 0, 0, 0], [25, 0, 0, 0]),
  foeMoves: [], wild: true, healHp: 0,
});
chk("unknown foe moveset -> confidence low (cannot force)",
  unknownFoe.confidence === "low", unknownFoe.line);

// Bag heals are counted, so a fight that is only winnable through potions reads
// as winnable rather than being fled.
const thin = combatant(30, 20, 88, stats(63, 60, 90, 68, T.FIRE));
const noHeals = winnability({ me: thin, foe: pidgey, myMoves: moveInfos([MOVE.EMBER], [25]), foeMoves: moveInfos([MOVE.TACKLE]), wild: true, healHp: 0 });
const withHeals = winnability({ me: thin, foe: pidgey, myMoves: moveInfos([MOVE.EMBER], [25]), foeMoves: moveInfos([MOVE.TACKLE]), wild: true, healHp: 200 });
chk("bag heals extend the survivable turn count",
  withHeals.turnsToKOMe > noHeals.turnsToKOMe, `${noHeals.turnsToKOMe} -> ${withHeals.turnsToKOMe}`);

// Arithmetic sanity: STAB and effectiveness both land, and a 0x matchup is 0.
const ember = moveInfos([MOVE.EMBER])[0];
const stabbed = damageRange(charmeleon, pidgey, ember);
chk("STAB is detected on a same-type move", stabbed.stab === true);
chk("resisted move still does >= 1 damage", damageRange(charmeleon, starmie, ember).min >= 1);
chk("a 0x matchup does 0", damageRange(
  combatant(20, 40, 40, stats(40, 40, 40, 40, T.NORMAL)),
  combatant(20, 40, 40, stats(40, 40, 40, 40, 0x08 /* GHOST */)),
  moveInfos([MOVE.TACKLE])[0]).avg === 0);

// PP filtering and the unknown-move stand-in.
chk("moves with no PP are excluded", moveInfos([MOVE.EMBER, MOVE.SCRATCH], [0, 20]).length === 1);
chk("PP-Up bits are masked off, not read as PP", moveInfos([MOVE.EMBER], [0xc0]).length === 0);
const standIn = moveInfos([250])[0];
chk("an unknown move becomes a neutral stand-in, flagged assumed",
  standIn.assumed === true && standIn.type === null && standIn.power === 30);

// Unsettled battle RAM (the intro frames) must read "unknown", never "flee".
const settling = winnability({
  me: combatant(30, 0, 0, stats(0, 0, 0, 0, NONE)), foe: pidgey,
  myMoves: moveInfos([MOVE.EMBER], [25]), foeMoves: [], wild: true,
});
chk("unsettled battle stats -> verdict=unknown (never forces)",
  settling.verdict === "unknown", settling.line);

// ------------------------------------------------------------------ item 6 --
const CFG: GateConfig = { after: 2, ttlMs: 60_000, maxArms: 2, windowMs: 600_000 };
const KEY = engagementKey.trainerMap(65);
const SIG_A = progressSig({ level: 30, partyCount: 1, badges: 1, events: 40 });
const SIG_B = progressSig({ level: 31, partyCount: 1, badges: 1, events: 40 });
const t0 = 1_000_000;

const led = new LossLedger();
led.noteLoss(KEY, t0, SIG_A, CFG);
chk("one loss does not gate", !led.gate(KEY, t0, SIG_A, CFG).blocked);
led.noteLoss(KEY, t0 + 1000, SIG_A, CFG);
chk("two losses arm the gate", led.gate(KEY, t0 + 1000, SIG_A, CFG).blocked);
chk("the refusal names its own release conditions",
  /level up|times? out|holds/i.test(led.gate(KEY, t0 + 1000, SIG_A, CFG).reason),
  led.gate(KEY, t0 + 1000, SIG_A, CFG).reason);

// EXPIRY 1 — time. This is the wq#517 lesson: a gate is a deadline, not a wall.
const byTime = LossLedger.fromJSON(led.toJSON());
const gTime = byTime.gate(KEY, t0 + 61_000, SIG_A, CFG);
chk("EXPIRY(time): the gate lifts once its TTL passes", !gTime.blocked && gTime.lifted === "expired", gTime.reason);
chk("  ...and stays lifted afterwards", !byTime.gate(KEY, t0 + 62_000, SIG_A, CFG).blocked);

// EXPIRY 2 — progress. Leveling up is what the gate asked for; it releases now.
const byProgress = LossLedger.fromJSON(led.toJSON());
const gProg = byProgress.gate(KEY, t0 + 2000, SIG_B, CFG);
chk("EXPIRY(progress): a changed progress signature lifts the gate immediately",
  !gProg.blocked && gProg.lifted === "progress", gProg.reason);

// EXPIRY 3 — arm cap. After maxArms cycles, gating is not the remedy; stop.
const byCap = LossLedger.fromJSON(led.toJSON());
byCap.gate(KEY, t0 + 61_000, SIG_A, CFG);                 // let gate 1 expire
byCap.noteLoss(KEY, t0 + 62_000, SIG_A, CFG);
byCap.noteLoss(KEY, t0 + 63_000, SIG_A, CFG);             // arms gate 2 (== maxArms)
chk("gate 2 arms at the cap", byCap.gate(KEY, t0 + 63_000, SIG_A, CFG).blocked);
byCap.gate(KEY, t0 + 130_000, SIG_A, CFG);                // let gate 2 expire
byCap.noteLoss(KEY, t0 + 131_000, SIG_A, CFG);
byCap.noteLoss(KEY, t0 + 132_000, SIG_A, CFG);
chk("EXPIRY(arm cap): past maxArms the key never gates again",
  !byCap.gate(KEY, t0 + 132_000, SIG_A, CFG).blocked);

// A win clears the run and the gate outright.
const byWin = LossLedger.fromJSON(led.toJSON());
byWin.noteWin(KEY, t0 + 2000);
chk("a win clears the gate", !byWin.gate(KEY, t0 + 2000, SIG_A, CFG).blocked);

// Losses that fall outside the window do not accumulate into a gate.
const stale = new LossLedger();
stale.noteLoss(KEY, t0, SIG_A, CFG);
stale.noteLoss(KEY, t0 + CFG.windowMs + 1, SIG_A, CFG);
chk("losses outside the window do not arm a gate",
  !stale.gate(KEY, t0 + CFG.windowMs + 1, SIG_A, CFG).blocked);

// Keys are independent: losing in the gym must not gate the route.
chk("a gate on one key does not block another",
  !led.gate(engagementKey.wildMap(35), t0 + 1000, SIG_A, CFG).blocked);

chk("DEFAULT_GATE ships with a finite TTL and arm cap",
  DEFAULT_GATE.ttlMs > 0 && Number.isFinite(DEFAULT_GATE.ttlMs) && DEFAULT_GATE.maxArms > 0);

// ------------------------------------------------- grind governor (item 6) --
const GRIND = { levels: 2, maxMs: 60_000 };
const g = startGrind(KEY, t0, 30, 1);
chk("grind is not done at the start", !grindStatus(g, t0, 30, 1, GRIND).done);
chk("grind ends on the level target", grindStatus(g, t0 + 1000, 32, 1, GRIND).done);
chk("grind ends on a new party member", grindStatus(g, t0 + 1000, 30, 2, GRIND).done);
chk("grind ends on its own deadline even with no progress",
  grindStatus(g, t0 + 61_000, 30, 1, GRIND).done, grindStatus(g, t0 + 61_000, 30, 1, GRIND).line);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
