// wq#478 probe: ceruleanGuidance against real checkpoints.
// Expect: ACTIVE (with live money/potion numbers) on post-Brock Route 4
// states; EMPTY on pre-Misty states outside the region (Mt Moon interiors)
// and on pre-Brock archive states.
// Usage: npx tsx src/probe_cerulean.ts
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";
import { ceruleanGuidance, ceruleanBuyPlan } from "./guidance";
import { Rom } from "./rom";
import { ITEM } from "./items";
import { PRICE, MIN_SAFE_PARTY } from "./economy";
// wq#540: TWO OF THIS PROBE'S THREE CASES NAMED CHECKPOINTS THAT HAVE ROTATED
// OFF DISK, so it died with an ENOENT stack trace on the FIRST case and never
// reached the third — which does still exist. What each case needs is a map,
// not a filename: "a Route 4 state", "a Mt Moon 1F state", "a pre-Brock
// museum state". Resolved by property, and a case whose map is no longer
// represented is reported and skipped rather than killing the run.
import { findFixture } from "./fixtures";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const WANTED: [string, number, string][] = [
  ["Route4 live", 15, "guidance ACTIVE: post-Brock, inside the Cerulean approach"],
  ["MtMoon 1F", 59, "guidance EMPTY: pre-Misty, inside the cave"],
  ["preBrock museum", 52, "guidance EMPTY: pre-Brock archive state"],
];
const CASES: [string, string][] = [];
for (const [label, map, why] of WANTED) {
  const f = findFixture(sc => sc.map === map,
    [`${"/home/lumen/pokemon"}/checkpoints`, `${"/home/lumen/pokemon"}/saves`,
     `${"/home/lumen/pokemon"}/checkpoints/archive-regressed-20260812`,
     `${"/home/lumen/pokemon"}/checkpoints/archive-pre-s2`]);
  if (f) CASES.push([label, f]);
  else console.log(`SKIP ${label} (map ${map}) — no such state on disk. ` +
                   `Expected ${why}. This is corpus rot, not a code defect.`);
}
if (!CASES.length) {
  console.log("FAIL FIXTURE MISSING: not one of this probe's map cases is represented on disk.");
  process.exit(1);
}
for (const [label, file] of CASES) {
  const e = new Emulator(ROM);
  loadSnapshotFile(e, file);
  const rd = new StateReader(e, sym);
  const s = rd.read();
  const g = ceruleanGuidance(e, sym, rd);
  console.log(`\n--- ${label} (map ${s.map}, $${s.money}, lead L${s.party[0]?.level}) ---`);
  console.log(g ? g : "(empty - guidance inactive here)");
}
// wq#559: the plan is now BALLS-FIRST with a balls parameter, renders only the
// REAL tool name buy_item, and prices flow from economy.PRICE. The table below
// covers both ball states; section P then verifies economy.PRICE against the
// ROM's own ItemPrices table so no rendered price is a recalled one.
let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

console.log("\n--- buy-plan table (potions=0, balls=0) ---");
for (const money of [0, 250, 600, 1200, 3000])
  console.log(`$${money}: ${ceruleanBuyPlan(money, 0, 0)}`);
console.log("--- buy-plan (money 3000, potions 5, balls 0) ---");
console.log(ceruleanBuyPlan(3000, 5, 0));
console.log("--- buy-plan (money 3000, potions 5, balls 3) ---");
console.log(ceruleanBuyPlan(3000, 5, 3));

// wq#559 assertions: ordering, tool-name reality, and budget discipline.
const p911 = ceruleanBuyPlan(911, 0, 0);          // the live purse tonight
chk("plan at $911 leads with poke_ball", p911.startsWith("buy_item(poke_ball,"), p911);
chk("plan renders no nonexistent buy( tool", !/(?<!_)buy\(/.test(p911), p911);
const p3000 = ceruleanBuyPlan(3000, 0, 0);
chk("rich plan still leads with balls to MIN_SAFE_PARTY",
    p3000.startsWith(`buy_item(poke_ball, ${MIN_SAFE_PARTY})`), p3000);
// Total spend never exceeds money-RESERVE: parse quantities * PRICE.
const spend = (plan: string) => {
  let t = 0;
  for (const m of plan.matchAll(/buy_item\((\w+), (\d+)\)/g)) {
    const id = (ITEM as any)[m[1].toUpperCase()];
    t += PRICE[id] * Number(m[2]);
  }
  return t;
};
for (const money of [250, 600, 911, 1200, 3000]) {
  const s = spend(ceruleanBuyPlan(money, 0, 0));
  chk(`spend $${s} at purse $${money} respects the $200 reserve`, s <= Math.max(0, money - 200));
}
chk("balls-satisfied plan buys no balls", !ceruleanBuyPlan(3000, 0, 3).includes("poke_ball"));

// ── P. economy.PRICE vs the ROM's ItemPrices table ──────────────────────
// Gen 1 stores every item's price as 3 BCD bytes at ItemPrices (bank 01:4608
// in pokeblue.sym), indexed by item id from 1. Decode straight from the ROM
// file and require PRICE to match — "ROM-read prices, not recalled ones".
const rom = new Rom(ROM);
const priceBank = 0x01, priceAddr = 0x4608;
const bcd = (b: number) => (b >> 4) * 10 + (b & 0xf);
const romPrice = (id: number) => {
  const b = rom.bytes(priceBank, priceAddr + (id - 1) * 3, 3);
  return bcd(b[0]) * 10000 + bcd(b[1]) * 100 + bcd(b[2]);
};
for (const [name, id] of Object.entries({ POKE_BALL: ITEM.POKE_BALL, GREAT_BALL: ITEM.GREAT_BALL,
    ULTRA_BALL: ITEM.ULTRA_BALL, POTION: ITEM.POTION, ANTIDOTE: ITEM.ANTIDOTE,
    PARLYZ_HEAL: ITEM.PARLYZ_HEAL, REPEL: ITEM.REPEL })) {
  chk(`PRICE[${name}]=$${PRICE[id]} matches ROM ItemPrices`, PRICE[id] === romPrice(id),
      `ROM says $${romPrice(id)}`);
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
