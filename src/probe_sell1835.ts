// wq#1835 — the mart counter's other half: red/green on Items.sell().
//
// THE BURN. Live run live-agent-1789183317445 (2026-09-12, 318 turns, 6.7h)
// held $96 and zero balls for its entire recorded history while carrying item
// id 49 — a NUGGET, which the clerk in Cerulean pays $5000 for. wq#1829 made
// that asset VISIBLE (the bag renders "nuggetx1" now). It was still not
// REACHABLE: items.ts implemented buy() and the word SELL appeared exactly once
// in the file, in a comment inside exitMart().
//
// WHAT IS ASSERTED, AND FROM WHERE. Money is read from wPlayerMoney, never from
// the screen: the clerk's "I can pay you 5000 for that." is used only as a
// pre-YES cross-check against the ROM, and section E proves the delta in RAM.
// Prices are read from THIS ROM's ItemPrices table, never recalled and never
// derived from economy.PRICE, which only knows what a mart stocks.
//
// DETERMINISM: everything runs inside a mart — zero encounter tiles. The
// fixture is resolved BY PROPERTY (wq#540) and copied before use (wq#551); if
// the corpus holds no mart state, one is BUILT by walking a city fixture
// through its mart door, because "skipped forever" is how a probe reports
// nothing while looking green.
import { Emulator, loadSnapshotFile, saveSnapshotFile } from "./emulator";
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
import { ITEM, ITEM_PRICE, MART_ORDER, backfillItemNames, backfillItemPrices,
         sellPrice, itemId, itemLabel } from "./items";
import { PRICE, BALL_PRICE, economyAdvice, EconomyCtx } from "./economy";
import { verifyFailed } from "./ceiling";
import { fixtureIndex, findFixture, copyFixture, ckptPath } from "./fixtures";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BASE = "/home/lumen/pokemon";
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const NUGGET = 0x31;          // verified against ItemNames in section A

let pass = 0, fail = 0, skip = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};
const skipped = (n: string, why: string) => { skip++; console.log(`SKIP ${n} :: ${why}`); };

interface Rig { emu: Emulator; map: MapModel; nav: Navigator; sync: Sync; scr: Screen; agent: Agent }
function rig(statePath: string): Rig {
  const emu = new Emulator(`${BASE}/roms/pokeblue.gb`);
  loadSnapshotFile(emu, statePath);
  const rom = new Rom(`${BASE}/roms/pokeblue.gb`);
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp1835-bus-")), "probe1835");
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const rd = new StateReader(emu, sym);
  const ck = mkdtempSync(join(tmpdir(), "lpp1835-ckpt-"));
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, rd, new Brain(bus), bus, ck);
  map.build();
  return { emu, map, nav, sync, scr, agent };
}
const moneyOf = (r: Rig) => {
  const a = sym.addr("wPlayerMoney"), m = r.emu.mem();
  return [m[a], m[a + 1], m[a + 2]].reduce((acc, b) => acc * 100 + ((b >> 4) * 10 + (b & 0xf)), 0);
};

/** A state standing inside a mart. Resolved by property first; BUILT from a
 *  city fixture's mart door when the corpus has none, which is the normal case
 *  — the campaign checkpoints where it is walking, and it walks past marts. */
async function martFixture(): Promise<string | null> {
  const direct = findFixture(sc => !!MART_ORDER[sc.map]);
  if (direct) return copyFixture(direct);
  let tried = 0;
  for (const f of fixtureIndex()) {
    if (tried >= 6) break;
    const r = rig(copyFixture(f.path));
    await r.emu.framesAsync(120); await r.sync.settle();
    r.map.build();
    const w = r.map.warps.find(x => !!MART_ORDER[x.destMap]);
    if (!w) continue;
    tried++;
    await r.nav.enterWarp(w).catch(() => "stuck");
    const cur = r.emu.mem()[sym.addr("wCurMap")];
    if (!MART_ORDER[cur]) continue;
    const p = r.nav.posChecked();
    const dest = ckptPath(`seed-mart${cur}.state.gz`);
    saveSnapshotFile(r.emu, dest);
    writeFileSync(dest.replace(/\.state\.gz$/, ".json"), JSON.stringify(
      { v: 3, kind: "seed", map: cur, x: p.x, y: p.y, note: "mart fixture built by probe_sell1835" }));
    console.log(`     built a mart fixture: map${cur} (${p.x},${p.y}) from ${f.path.split("/").pop()}`);
    return copyFixture(dest);
  }
  return null;
}

(async () => {
  console.log("== probe_sell1835: ROM-priced selling, RAM-gated ==");
  const rom = new Rom(`${BASE}/roms/pokeblue.gb`);

  // ── A. PRICES COME FROM THIS ROM ────────────────────────────────────────
  backfillItemNames(rom, sym);
  const bp = backfillItemPrices(rom, sym);
  // Both numbers are facts about THIS ROM, pinned deliberately: 97 entries is
  // the length backfillItemNames already cross-checks against ItemNames, and 45
  // of them carry a non-zero price — the other 52 are key items, machines' empty
  // slots and the unsellable balls. A shift in either means the table moved.
  chk("A ItemPrices loads, length derived from the symbol table", bp.total === 97 && bp.priced === 45,
      `${bp.priced} priced of ${bp.total} entries`);
  chk("A the ROM prices a NUGGET at 10000, so it sells for 5000",
      ITEM_PRICE[NUGGET] === 10000 && sellPrice(NUGGET) === 5000,
      `buy=${ITEM_PRICE[NUGGET]} sell=${sellPrice(NUGGET)}`);
  chk("A ROM prices agree with the hand-verified economy.PRICE table where they overlap",
      Object.keys(PRICE).every(k => ITEM_PRICE[Number(k)] === PRICE[Number(k)]),
      Object.keys(PRICE).map(k => `${itemLabel(Number(k))} rom=${ITEM_PRICE[Number(k)]} PRICE=${PRICE[Number(k)]}`)
        .filter((_, i) => i < 2).join(" | "));
  chk("A sell price is half, floored (REPEL 350 -> 175)", sellPrice(ITEM.REPEL) === 175, String(sellPrice(ITEM.REPEL)));
  chk("A a 0-priced item is unsellable, not free (dome_fossil, master_ball)",
      sellPrice(ITEM.DOME_FOSSIL) === null && sellPrice(ITEM.MASTER_BALL) === null,
      `fossil=${sellPrice(ITEM.DOME_FOSSIL)} master=${sellPrice(ITEM.MASTER_BALL)}`);
  // RED: reading past the table is not a missing feature, it is a WRONG NUMBER.
  // Id 201 is a TM; three bytes of the ItemNames text that follows ItemPrices
  // decode as BCD 919495, which would have offered to sell a TM for 459747.
  chk("A RED: ids past the table are refused, not priced from whatever follows it",
      ITEM_PRICE[201] === undefined && sellPrice(201) === null,
      `raw-decode of those bytes would be 919495`);

  // ── B. THE NAME THE BAG PRINTS IS THE NAME THE TOOL TAKES ───────────────
  chk("B itemId resolves a ROM-only name (nugget) after the backfill",
      itemId("nugget") === NUGGET, String(itemId("nugget")));
  chk("B itemId still resolves the hand-written aliases", itemId("ball") === ITEM.POKE_BALL);
  chk("B an id the ROM cannot name stays unresolvable (no invented reverse match)",
      itemId("unknown_item_245") === null && itemLabel(245).startsWith("unknown_item_"), itemLabel(245));

  // ── C. THE DIRECTIVE, BOTH DIRECTIONS (pure) ────────────────────────────
  const base: EconomyCtx = { money: 96, balls: 0, partyCount: 1, leadLevel: 20,
                             inMart: false, gymMinLevel: 30 };
  const nug = [{ id: NUGGET, name: "nugget", qty: 1, unit: 5000, value: 5000 }];
  const rich = economyAdvice({ ...base, sellables: nug });
  chk("C broke + carrying a nugget -> the SELL directive, not the grind directive",
      !!rich && rich.includes("sell_item(nugget, 1)") && rich.includes("5000") && !rich.includes("BROKE:"),
      (rich ?? "null").slice(0, 120));
  chk("C it outranks BROKE, whose 'money comes ONLY from trainers' is false here",
      !!rich && rich.startsWith("! BROKE AT $96 BUT CARRYING $5000"), (rich ?? "null").slice(0, 60));
  const inMart = economyAdvice({ ...base, inMart: true, martStock: MART_ORDER[67], sellables: nug });
  chk("C standing in the mart -> sell RIGHT NOW", !!inMart && inMart.includes("STANDING IN ONE"),
      (inMart ?? "null").slice(-60));
  chk("C no sellables -> the old BROKE line is unchanged",
      (economyAdvice({ ...base }) ?? "").startsWith("! BROKE: $96"),
      (economyAdvice({ ...base }) ?? "null").slice(0, 40));
  chk("C junk under one ball's price does NOT fire it (a $50 sale relieves nothing)",
      (economyAdvice({ ...base, sellables: [{ id: ITEM.ANTIDOTE, name: "antidote", qty: 1, unit: 50, value: 50 }] }) ?? "")
        .startsWith("! BROKE: $96"));
  chk("C a purse that can already buy a ball does not get told to sell",
      !(economyAdvice({ ...base, money: BALL_PRICE, sellables: nug }) ?? "").includes("sell_item"));

  // ── D. retry ceiling knows a sale from a refusal ────────────────────────
  chk("D a sale is success-shaped", !verifyFailed("sell_item", "sold 1x nugget for 5000; purse 5096, 0 left"));
  chk("D a refusal counts as a verify failure", verifyFailed("sell_item", "sell: not in a known mart (map 36)"));

  // ── E. LIVE: the money delta, read from RAM ─────────────────────────────
  const fx = await martFixture();
  if (!fx) { skipped("E live sell", "no mart fixture and none buildable from the corpus"); }
  else {
    const r = rig(fx);
    await r.emu.framesAsync(120); await r.sync.settle();
    const items = r.agent.items;
    const m = r.emu.mem();
    const mapId = m[sym.addr("wCurMap")];
    // Probe owns its environment (probe_menu620 E precedent): plant the nugget
    // only if this state does not already carry one. The 2026-09-12 corpus
    // does — id 49 sits at bag index 3 of the run this ticket is about.
    const nA = sym.addr("wNumBagItems"), bagA = sym.addr("wBagItems");
    const planted = items.has(NUGGET) === 0;
    if (planted) {
      const n0 = m[nA];
      m[bagA + n0 * 2] = NUGGET; m[bagA + n0 * 2 + 1] = 1;
      m[bagA + (n0 + 1) * 2] = 0xff; m[nA] = n0 + 1;
    }
    chk("E standing in a mart with a nugget in the bag",
        !!MART_ORDER[mapId] && items.has(NUGGET) === 1,
        `map${mapId}, ${planted ? "planted" : "the campaign's own"} nugget, bag: ${items.bagLine()}`);

    const top = items.sellables()[0];
    chk("E sellables ranks the nugget first and lists no ball/heal/mart stock",
        !!top && top.id === NUGGET && top.value === 5000 &&
        items.sellables().every(s => !items.isBall(s.id) && !items.isHpHeal(s.id) && s.id !== ITEM.REPEL),
        items.sellables().map(s => `${s.name} $${s.value}`).join(", ") || "(none)");

    const m0 = moneyOf(r), had = items.has(NUGGET);
    const res = await items.sell(NUGGET, 1);
    const m1 = moneyOf(r);
    chk("E sell(nugget,1) completes on the first attempt", res.startsWith("sold 1x nugget"), res.slice(0, 90));
    chk("E MONEY IN RAM rose by exactly the ROM-derived price", m1 - m0 === 5000, `${m0} -> ${m1}`);
    chk("E the nugget left the bag", items.has(NUGGET) === had - 1, `${had} -> ${items.has(NUGGET)}`);
    chk("E and the run is back on the overworld, not wedged in the shop",
        r.scr.cursor() === null && m[sym.addr("wCurMap")] === mapId,
        `cursor=${JSON.stringify(r.scr.cursor())} map=${m[sym.addr("wCurMap")]}`);
    chk("E $5000 is more than 20 Poke Balls — the point of the ticket",
        Math.floor((m1 - m0) / PRICE[ITEM.POKE_BALL]) >= 20, `${Math.floor((m1 - m0) / PRICE[ITEM.POKE_BALL])} balls`);

    // ── F. LIVE refusals never move money ─────────────────────────────────
    const m2 = moneyOf(r);
    const noFossil = await items.sell(ITEM.DOME_FOSSIL, 1);
    chk("F a 0-priced quest item is refused before any button is pressed",
        noFossil.startsWith("sell: this ROM prices dome_fossil at 0") && moneyOf(r) === m2, noFossil.slice(0, 80));
    const noBall = await items.sell(ITEM.POKE_BALL, 1);
    chk("F balls are refused outright", noBall.startsWith("sell: never sell"), noBall.slice(0, 60));
    const noneLeft = await items.sell(NUGGET, 1);
    chk("F selling what the bag no longer holds is refused, not attempted",
        noneLeft === "sell: no nugget in bag" && moneyOf(r) === m2, noneLeft.slice(0, 60));
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
