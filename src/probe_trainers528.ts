// wq#528 acceptance: prove the trainer model from ROM+RAM, and prove the
// selection gates in BOTH directions.
//
// Section A pins the ROM decode against the ONE ground truth this project has:
// the $360 that arrived at 2026-08-13T06:03:23Z. If TrainerPicAndMoneyPointers
// is ever re-read as 3-byte BCD, or the roster walker loses its place, A fails
// with a number instead of a shrug.
// Section B pins the defeat-flag mechanism, which is what stops the agent being
// sent to farm a corpse.
// Section C is the pure selection truth table -- no emulator, no ROM.
//
// Usage: npx tsx src/probe_trainers528.ts
import { readdirSync, statSync } from "fs";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { StateReader } from "./state";
import { MapModel } from "./map";
import { astar } from "./nav";
import {
  decodeTrainers, trainerFlagAddr, baseMoney, rosterLevels, trainerNames,
  pickEngageTarget, engageAdvice, engageBudget, LEVEL_MARGIN, ENGAGE_HP_FLOOR,
  MAP_TRAINER_HEADERS, TrainerObj, EngageCtx,
} from "./trainers";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CK = "/home/lumen/pokemon/checkpoints";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

/** Newest checkpoint sitting on `want`, so the probe tracks the live campaign
 *  rather than whichever file readdir happened to hand back first. */
function newestOn(want: number) {
  const files = readdirSync(CK).filter(f => f.endsWith(".state.gz"))
    .map(f => ({ f, m: statSync(`${CK}/${f}`).mtimeMs })).sort((a, b) => b.m - a.m);
  for (const { f } of files) {
    const emu = new Emulator(ROM);
    try { loadSnapshotFile(emu, `${CK}/${f}`); } catch { continue; }
    const st = new StateReader(emu, sym).read();
    if (st.map === want) return { emu, st, file: f };
  }
  return null;
}

console.log("=== A. the payout model, against the only income event on record ===");
const ROCKET = 230;
chk("ROCKET base money is 30 (2-byte BCD, not 3)", baseMoney(rom, sym, ROCKET) === 30,
    `got ${baseMoney(rom, sym, ROCKET)}`);
const rk3 = rosterLevels(rom, sym, ROCKET, 3);
chk("ROCKET roster 3 fields two L12", rk3.length === 2 && rk3.every(l => l === 12), `[${rk3}]`);
chk("ROCKET#3 pays exactly the $360 seen at 06:03:23Z",
    baseMoney(rom, sym, ROCKET) * rk3[rk3.length - 1] === 360,
    `${baseMoney(rom, sym, ROCKET)} x ${rk3[rk3.length - 1]}`);
chk("class 230 is named ROCKET", trainerNames(rom, sym)[ROCKET - 201] === "ROCKET",
    trainerNames(rom, sym)[ROCKET - 201]);
// A class whose money would be indistinguishable under the wrong BCD width.
chk("HIKER base money is 35", baseMoney(rom, sym, 209) === 35, `got ${baseMoney(rom, sym, 209)}`);

console.log("\n=== B. the defeat-flag mechanism, from RAM ===");
const h61 = trainerFlagAddr(rom, sym, 61);
chk("map61 headers resolve to 0xd7f6 bits 2..5", !!h61 && h61.addr === 0xd7f6 &&
    h61.bits.join(",") === "2,3,4,5", JSON.stringify(h61));
const h59 = trainerFlagAddr(rom, sym, 59);
chk("map59 headers resolve to 0xd7f5 bits 1..7", !!h59 && h59.addr === 0xd7f5 &&
    h59.bits.join(",") === "1,2,3,4,5,6,7", JSON.stringify(h59));
chk("an unlisted map decodes to nothing (fail-closed)", trainerFlagAddr(rom, sym, 60) === null);
chk("map60 is in no header table at all", MAP_TRAINER_HEADERS[60] === undefined);

const b2 = newestOn(61);
if (!b2) chk("a map61 checkpoint exists", false, "none found");
else {
  const t61 = decodeTrainers(b2.emu.mem(), rom, sym, 61);
  console.log(`  using ${b2.file} @(${b2.st.x},${b2.st.y}) $${b2.st.money}`);
  console.log("  " + t61.map(t => `${t.name}#${t.roster}(${t.x},${t.y}) $${t.payout} beaten=${t.beaten}`).join(" | "));
  // The SUPER NERD at (12,8) is a trainer OBJECT with no header entry -- the
  // fossil script owns him. He must not appear, or we read a flag that is not his.
  chk("map61 decodes exactly the 4 header-declared Rockets", t61.length === 4,
      `got ${t61.length}`);
  chk("no SUPER NERD leaks in from the fossil script", !t61.some(t => t.name.includes("NERD")));
  const rk3o = t61.find(t => t.x === 29 && t.y === 11);
  chk("ROCKET#3 at (29,11) is present and pays $360", !!rk3o && rk3o.payout === 360,
      JSON.stringify(rk3o && { p: rk3o.payout, s: rk3o.sprite }));
  chk("ROCKET#3 reads as BEATEN (bit 4 set since 06:03Z)", !!rk3o && rk3o.beaten === true);
  chk("the other three read as UNBEATEN", t61.filter(t => !t.beaten).length === 3,
      `unbeaten=${t61.filter(t => !t.beaten).length}`);
  chk("map61's unclaimed payout is $1200 after ROCKET#3",
      t61.filter(t => !t.beaten).reduce((a, t) => a + t.payout, 0) === 1200,
      String(t61.filter(t => !t.beaten).reduce((a, t) => a + t.payout, 0)));
  // The TM01 lying on B2F is sprite data too; it must never read as a trainer.
  chk("the ground TM is not mistaken for a trainer", !t61.some(t => t.roster === 0));
}

const f1 = newestOn(59);
if (f1) {
  const t59 = decodeTrainers(f1.emu.mem(), rom, sym, 59);
  chk("map59 decodes 7 trainers totalling $1360", t59.length === 7 &&
      t59.reduce((a, t) => a + t.payout, 0) === 1360,
      `${t59.length} / $${t59.reduce((a, t) => a + t.payout, 0)}`);
}

console.log("\n=== C. the selection gates, both directions, no emulator ===");
const T = (o: Partial<TrainerObj>): TrainerObj => ({
  sprite: 4, x: 29, y: 17, cls: 230, roster: 4, name: "ROCKET",
  levels: [16], baseMoney: 30, payout: 480, beaten: false, ...o,
});
const C = (o: Partial<EngageCtx>): EngageCtx => ({
  leadLevel: 27, hpFrac: 1, money: 431, ballPrice: 200, gymMinLevel: 30,
  resumeCap: 5, steps: new Map([[4, 8]]), ...o,
});

chk("engage budget is cap x3 (5 -> 15)", engageBudget(5) === 15, String(engageBudget(5)));

const live = pickEngageTarget([T({})], C({}));
chk("FIRES: L27 lead, L16 foe, 8 steps, under gym level", live.target?.payout === 480, live.why);
chk("  and the advice names the tile and the goto",
    (engageAdvice(live, 27, true) ?? "").includes("goto(29,17)"), String(engageAdvice(live, 27, true)));
chk("  and it says the reason is EXPERIENCE, not cash",
    (engageAdvice(live, 27, true) ?? "").includes("EXPERIENCE"));

chk("SILENT on a beaten trainer", pickEngageTarget([T({ beaten: true })], C({})).target === null);
chk("SILENT when the foe is inside the level margin",
    pickEngageTarget([T({ levels: [27 - LEVEL_MARGIN + 1] })], C({})).target === null);
chk("  and FIRES again one level lower",
    pickEngageTarget([T({ levels: [27 - LEVEL_MARGIN] })], C({})).target !== null);
chk("SILENT below the HP engage floor",
    pickEngageTarget([T({})], C({ hpFrac: ENGAGE_HP_FLOOR - 0.01 })).target === null);
chk("  and FIRES at the floor exactly",
    pickEngageTarget([T({})], C({ hpFrac: ENGAGE_HP_FLOOR })).target !== null);
chk("SILENT when unreachable",
    pickEngageTarget([T({})], C({ steps: new Map([[4, null]]) })).target === null);
chk("SILENT beyond the step budget (16 > 15) - this is the wq#521 guard",
    pickEngageTarget([T({})], C({ steps: new Map([[4, 16]]) })).target === null);
chk("  and FIRES at the budget exactly (15)",
    pickEngageTarget([T({})], C({ steps: new Map([[4, 15]]) })).target !== null);
chk("SILENT when levelled AND funded (nothing binding)",
    pickEngageTarget([T({})], C({ leadLevel: 31, money: 5000 })).target === null);
chk("FIRES when broke even at gym level (money is binding)",
    pickEngageTarget([T({})], C({ leadLevel: 31, money: 10 })).target !== null);
chk("SILENT on an empty map (fail-closed)", pickEngageTarget([], C({})).target === null);
chk("richest qualifying target wins, not nearest",
    pickEngageTarget([T({ sprite: 2, payout: 390 }), T({ sprite: 4, payout: 480 })],
      C({ steps: new Map([[2, 3], [4, 9]]) })).target?.payout === 480);
chk("a far rich target loses to a near poor one when it is over budget",
    pickEngageTarget([T({ sprite: 2, payout: 390 }), T({ sprite: 4, payout: 480 })],
      C({ steps: new Map([[2, 3], [4, 40]]) })).target?.payout === 390);

console.log("\n=== D. end to end on a real checkpoint: decode + REAL astar + pick ===");
// This is the section that would have caught a hook that type-checks and then
// silently offers nothing, which is the failure mode a pure truth table cannot
// see. It mirrors agent.ts stateBlock() exactly: same decode, same astar, same
// gates, same advice call.
const e2e = newestOn(61);
if (!e2e) chk("a map61 checkpoint exists for the e2e", false);
else {
  const mm = new MapModel(e2e.emu, sym, rom); mm.build();
  const trs = decodeTrainers(e2e.emu.mem(), rom, sym, 61);
  const lead = e2e.st.party[0];
  const steps = new Map<number, number | null>();
  for (const t of trs)
    steps.set(t.sprite, t.beaten ? null
      : (astar(mm, e2e.st.x, e2e.st.y, t.x, t.y, new Set<string>())?.length ?? null));
  console.log(`  from (${e2e.st.x},${e2e.st.y}) steps=` +
    trs.map(t => `${t.name}#${t.roster}:${steps.get(t.sprite) ?? "-"}`).join(" "));
  const leadLevel = lead?.level ?? 0;
  const ch = pickEngageTarget(trs, {
    leadLevel, hpFrac: lead && lead.maxHp > 0 ? lead.hp / lead.maxHp : 1,
    money: e2e.st.money, ballPrice: 200, gymMinLevel: 30, resumeCap: 5, steps,
  });
  const line = engageAdvice(ch, leadLevel, leadLevel > 0 && leadLevel < 30);
  console.log("  LINE: " + line);
  chk("the live floor yields exactly one target", ch.target !== null, ch.why);
  chk("it is ROCKET#4 at (29,17), the 8-step one",
      ch.target?.x === 29 && ch.target?.y === 17, JSON.stringify(ch.target && {x:ch.target.x,y:ch.target.y}));
  chk("it is NOT the beaten ROCKET#3", ch.target?.roster !== 3);
  chk("the 64+ step western Rockets are excluded by the budget", ch.steps <= 15, String(ch.steps));
  chk("the emitted line is a single line", (line ?? "").split("\n").length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
