// wq#620 — menu/dialog font-tile decode: red/green.
//
// RED IS IN-PROBE AND IT IS THE TICKET'S OWN BURN: with the mart list scrolled
// (the exact position class of the 03:51Z desync), cf91/wCurItem — the register
// the OLD buy verify gated on — is shown DISAGREEING with the label displayed
// under the arrow, while the new tilemap read matches the display. The old gate
// checked a lying register; that is demonstrated, not remembered.
//
// DETERMINISM: everything runs indoors (map67 mart / map64 center) — zero
// encounter tiles. Fixtures by property (wq#540), copied before use (wq#551).
import { Emulator, KEYS, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Actions } from "./actions";
import { Battle } from "./battle";
import { StateReader } from "./state";
import { Brain } from "./brain";
import { Agent } from "./agent";
import { readMenu, labelMatches, renderMenuLine } from "./menu";
import { decodeGen1, GEN1_CHAR } from "./names";
import { ITEM, ITEM_NAME, MART_ORDER, backfillItemNames } from "./items";
import { PRICE } from "./economy";
import { findFixture, requireFixture } from "./fixtures";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BASE = "/home/lumen/pokemon";
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);

let pass = 0, fail = 0, skip = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};
const skipped = (n: string, why: string) => { skip++; console.log(`SKIP ${n} :: ${why}`); };

interface Rig {
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader; scr: Screen;
  sync: Sync; agent: Agent;
}
function rig(statePath: string): Rig {
  const emu = new Emulator(`${BASE}/roms/pokeblue.gb`);
  loadSnapshotFile(emu, statePath);
  const rom = new Rom(`${BASE}/roms/pokeblue.gb`);
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp620-bus-")), "probe620");
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const rd = new StateReader(emu, sym);
  const ck = mkdtempSync(join(tmpdir(), "lpp620-ckpt-"));
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, rd, new Brain(bus), bus, ck);
  map.build();
  return { emu, map, nav, rd, scr, sync, agent };
}
const tapMk = (r: Rig) => async (k: number, s = 220) => { await r.emu.tapAsync(k, 8, 16); await r.sync.settle(s); };

/** Drive the mart BUY list open (recon620 flow). Returns false on any miss. */
async function openBuyList(r: Rig): Promise<boolean> {
  const tap = tapMk(r);
  const g = await r.nav.goto(2, 5);
  if (g !== "arrived") return false;
  await tap(KEYS.LEFT, 200); await tap(KEYS.A, 300);
  for (let i = 0; i < 6 && !r.scr.text().includes("BUY"); i++) await tap(KEYS.A, 250);
  if (!r.scr.text().includes("BUY")) return false;
  await tap(KEYS.A, 300);
  for (let i = 0; i < 4 && r.scr.cursor() === null; i++) await tap(KEYS.A, 250);
  await r.sync.settle(400);
  return r.scr.cursor() !== null;
}

// Baked ground-truth grids, captured LIVE off a map67 fixture (recon620,
// 2026-08-15) — the pure parser must read these exact frames correctly.
const pad = (s: string) => (s + " ".repeat(20)).slice(0, 20);
const GRID_TOP = [
  "             MONEY  ", "  BUY           401 ", "", "  SE                ",
  "      POKe BALL     ", "  QU           200  ", "      POTION        ", "               300  ",
  "      REPEL         ", "               350  ", "      ANTIDOTE      ", "               100  ",
  "", "", " Take your time.    ", "", "", "",
].map(pad);
const GRID_SCROLLED = [
  "             MONEY  ", "  BUY           401 ", "", "  SE                ",
  "      POTION        ", "  QU           300  ", "      REPEL         ", "               350  ",
  "      ANTIDOTE      ", "               100  ", "      BURN HEAL     ", "               250  ",
  "", "", " Take your time.    ", "", "", "",
].map(pad);

(async () => {
  console.log("== probe_menu620: font-tile decode + read-verified buy/heal ==");

  // ── A. one charmap, ROM-verified ────────────────────────────────────────
  const rom = new Rom(`${BASE}/roms/pokeblue.gb`);
  let threw = "";
  try { backfillItemNames(rom, sym); } catch (e: any) { threw = String(e?.message ?? e); }
  chk("A backfillItemNames decodes EVERY ItemNames byte via the shared map", threw === "", threw.slice(0, 90));
  const itemNames = sym.sym("ItemNames");
  // id 4 = POKé BALL: walk to the 4th 0x50-terminated entry and decode it.
  let addr = itemNames.addr;
  for (let i = 0; i < 3; i++) { while (rom.byte(itemNames.bank, addr++) !== 0x50); }
  const buf: number[] = [];
  for (let i = 0; i < 12; i++) { const b = rom.byte(itemNames.bank, addr + i); if (b === 0x50) break; buf.push(b); }
  const ball = decodeGen1(buf);
  chk("A ItemNames id4 decodes with the accent", ball === "POK\u00e9 BALL", JSON.stringify(ball));
  chk("A labelMatches bridges spellings", labelMatches("POK\u00e9 BALL", "poke_ball") &&
      labelMatches("POKe BALL", "poke_ball") && !labelMatches("POTION", "poke_ball"));
  chk("A tilemap chars route through GEN1_CHAR (0xBA is é now, not bare e)", GEN1_CHAR[0xba] === "\u00e9");

  // ── B. PURE parser on baked live-captured frames ────────────────────────
  {
    const v = readMenu(GRID_TOP, { x: 5, y: 4 }, false, false);
    chk("B top frame: selected POKe BALL $200", v.selectedLabel === "POKe BALL" && v.selectedPrice === 200,
        `${v.selectedLabel} $${v.selectedPrice}`);
    chk("B top frame: 4 entries with prices",
        v.entries.length === 4 && v.entries.map(e => e.label).join("|") === "POKe BALL|POTION|REPEL|ANTIDOTE" &&
        v.entries.map(e => e.price).join(",") === "200,300,350,100",
        v.entries.map(e => `${e.label} $${e.price}`).join(" | "));
    chk("B top frame: dialog decoded", v.dialog === "Take your time.", v.dialog);
    const line = renderMenuLine(v, 0, 0, 7);
    chk("B render names row 1/7 + visible list", !!line && line.includes('cursor on "POKe BALL"') &&
        line.includes("[row 1/7]") && line.includes("ANTIDOTE $100"), (line ?? "").slice(0, 110));
    const s = readMenu(GRID_SCROLLED, { x: 5, y: 8 }, false, false);
    chk("B scrolled frame: selected ANTIDOTE $100", s.selectedLabel === "ANTIDOTE" && s.selectedPrice === 100,
        `${s.selectedLabel} $${s.selectedPrice}`);
    const closed = readMenu(GRID_TOP.map(() => pad("")), null, false, false);
    chk("B no window -> open:false, NO rendered line (no dead prose)",
        !closed.open && renderMenuLine(closed, 0, 0, 0) === null);
  }

  // ── C. LIVE window on a map67 fixture + THE RED ─────────────────────────
  const fx67 = findFixture(sc => sc.map === 67);
  if (!fx67) { skipped("C live mart window", "no map67 fixture on disk"); }
  else {
    const r = rig(requireFixture("map67 mart", fx67));
    await r.emu.framesAsync(120); await r.sync.settle();
    if (!await openBuyList(r)) {
      skipped("C live mart window", "BUY list did not open on this fixture");
    } else {
      const items = r.agent.items;
      const v0 = (items as any).menuView ? items.menuView() : null;
      const stock = MART_ORDER[67].map(id => ITEM_NAME[id]);
      chk("C live entries match known Cerulean stock+prices (visible window)",
          !!v0 && v0.entries.length >= 4 &&
          v0.entries.every((e: any, i: number) => labelMatches(e.label, stock[i]) && e.price === PRICE[MART_ORDER[67][i]]),
          v0 ? v0.entries.map((e: any) => `${e.label} $${e.price}`).join(" | ") : "no view");
      const tap = tapMk(r);
      await tap(KEYS.DOWN, 180);
      const v1 = items.menuView();
      chk("C DOWN reads back: cursor now on POTION", !!v1.selectedLabel && labelMatches(v1.selectedLabel!, "potion"),
          v1.selectedLabel ?? "null");
      await tap(KEYS.DOWN, 180); await tap(KEYS.DOWN, 180);
      const v3 = items.menuView();
      const m = r.emu.mem();
      const cf91 = m[sym.addr("wCurItem")];
      chk("C scrolled: tilemap reads ANTIDOTE under the arrow",
          !!v3.selectedLabel && labelMatches(v3.selectedLabel!, "antidote"), v3.selectedLabel ?? "null");
      chk("C RED: cf91 (the OLD verify register) disagrees with the display here",
          cf91 !== ITEM.ANTIDOTE,
          `cf91=${cf91} (${ITEM_NAME[cf91] ?? "?"}) while the arrow shows ${v3.selectedLabel}`);
    }
  }

  // ── D. scripted FULL buy: first attempt, read-gated ─────────────────────
  if (!fx67) { skipped("D scripted buy", "no map67 fixture"); }
  else {
    const r = rig(requireFixture("map67 buy", fx67));
    await r.emu.framesAsync(120); await r.sync.settle();
    const items = r.agent.items;
    const moneyA = sym.addr("wPlayerMoney");
    const money = () => { const m = r.emu.mem(); return [m[moneyA], m[moneyA + 1], m[moneyA + 2]].reduce((a, b) => a * 100 + ((b >> 4) * 10 + (b & 0xf)), 0); };
    // wq#1835: fund the purse first (probe owns its environment, same as the
    // heal block below hurts the lead). This block has been skipping since the
    // corpus lost its map67 states; the mart fixture probe_sell1835 builds is
    // the BROKE run — $96, one antidote short of $100 — so the buy reached YES
    // and came back "no charge registered", which reads exactly like a broken
    // purchase path and is really an honest refusal. 999 in BCD.
    const m = r.emu.mem();
    m[moneyA] = 0x00; m[moneyA + 1] = 0x09; m[moneyA + 2] = 0x99;
    const m0 = money(), have0 = items.has(ITEM.ANTIDOTE);
    const res = await items.buy(ITEM.ANTIDOTE, 1);
    chk("D buy(antidote,1) completes FIRST attempt", res.startsWith("bought 1x antidote"), res.slice(0, 80));
    chk("D money delta matches PRICE", money() === m0 - PRICE[ITEM.ANTIDOTE], `${m0} -> ${money()}`);
    chk("D bag delta +1", items.has(ITEM.ANTIDOTE) === have0 + 1, `${have0} -> ${items.has(ITEM.ANTIDOTE)}`);
  }

  // ── E. heal: read-gated nurse dialog still completes ────────────────────
  const fx64 = findFixture(sc => sc.map === 64);
  if (!fx64) { skipped("E heal", "no map64 fixture"); }
  else {
    const r = rig(requireFixture("map64 center", fx64));
    await r.emu.framesAsync(120); await r.sync.settle();
    // hurt the lead so the heal has something to do (probe-owns-environment)
    const hpA = sym.addr("wPartyMon1HP");
    r.emu.mem()[hpA] = 0; r.emu.mem()[hpA + 1] = 5;   // BE16: 5 hp
    const res = await r.agent.heal.atCenter();
    chk("E heal_at_center completes through the read-gated dialog",
        res.startsWith("healed:"), res.slice(0, 70));
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
