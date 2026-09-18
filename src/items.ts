// S3 item & economy layer. Conforms to the interface agent.ts already wires:
//   new Items(emu, sym, scr, sync, dlg, nav, map, bat)
//   itemId(name) -> id|null ; ITEM_NAME ; bagLine()
//   useInBattle(id,slot) ; useOverworld(id,slot) ; buy(id,qty)
// Probe-verified invariants:
//   - menu taps get eaten -> every cursor move verified vs wCurrentMenuItem
//   - text lags RAM -> gate money/inventory changes on RAM (wTwoOptionMenuID
//     for YES/NO, wNumBagItems + money deltas for effect), never screen text
//   - never trust inherited menu state; counter clerks faced across the tile
import { Emulator, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { EventBus } from "./events";
import { decodeGen1Bytes } from "./names";
import { readMenu, labelMatches, MenuView } from "./menu";  // wq#620

/** Structural, so items.ts does not depend on the concrete Rom class (and so
 *  probes can hand in a stub). Matches Rom.byte(bank, addr). */
export interface RomLike { byte(bank: number, addr: number): number }

export const ITEM = {
  MASTER_BALL: 1, ULTRA_BALL: 2, GREAT_BALL: 3, POKE_BALL: 4,
  MOON_STONE: 0x0a, ANTIDOTE: 0x0b, BURN_HEAL: 0x0c, ICE_HEAL: 0x0d,
  AWAKENING: 0x0e, PARLYZ_HEAL: 0x0f, FULL_RESTORE: 0x10, MAX_POTION: 0x11,
  HYPER_POTION: 0x12, SUPER_POTION: 0x13, POTION: 0x14, ESCAPE_ROPE: 0x1d, REPEL: 0x1e,
  // wq#519: quest items the agent can CLAIM to hold. Without these, ITEM_NAME
  // could not name a fossil, so the corridor pack's "acquisition is TRUE only
  // if a state read shows it" rule was unenforceable by our own tooling and a
  // false "Dome Fossil confirmed in inventory" pin survived seven writes.
  // Ids read out of THIS ROM's ItemNames table (01:472b), not recalled -- the
  // ticket itself said HELIX was 0x28 and the ROM says 0x2a. probe_claims
  // asserts all three against the ROM so a recalled id fails a test.
  OLD_AMBER: 0x1f, DOME_FOSSIL: 0x29, HELIX_FOSSIL: 0x2a,
} as const;
export const ITEM_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(ITEM).map(([k, v]) => [v, k.toLowerCase()]));

/** wq#519: backfill ITEM_NAME from THIS ROM's ItemNames table (01:472b, a
 *  0x50-terminated list, index = id-1) so an inventory read can name what it
 *  sees instead of printing "id234" -- which is what probe_bag487 printed for
 *  the one item the agent actually owns.
 *
 *  GAPS ONLY, never overwrite. The hand-written names are load-bearing beyond
 *  display: buy() derives its mart-cursor match from ITEM_NAME[id] (the
 *  toUpperCase/underscore/"POKe" transform below), so replacing "poke_ball"
 *  with the ROM's "POKe BALL" would silently break purchasing. Verified
 *  against the ROM: all 17 pre-existing ids already agree with ItemNames.
 *
 *  Table LENGTH is derived, not assumed (wq#503 precedent): ItemNames and
 *  ItemPrices must agree on the entry count or we throw rather than read past
 *  the end of a table on a ROM whose layout moved. */
export function backfillItemNames(rom: RomLike, sym: SymbolTable): { added: number; total: number; placeholders: number } {
  const t = sym.sym("ItemNames");
  const end = sym.nextAddr(t.bank, t.addr);
  const prices = sym.sym("ItemPrices");
  const priceCount = (sym.nextAddr(prices.bank, prices.addr) - prices.addr) / 3;  // 3-byte BCD each
  let addr = t.addr, id = 1, added = 0, placeholders = 0, total = 0;
  while (addr < end && id < 512) {
    const buf: number[] = [];
    let b = -1;
    while (addr < end) { b = rom.byte(t.bank, addr++); if (b === 0x50) break; buf.push(b); }
    if (b !== 0x50) break;                       // truncated entry: stop, do not guess
    const { text, unmapped } = decodeGen1Bytes(buf);
    if (!text) break;
    total++;
    // Detect a broken decode from the INPUT BYTES, never from a "?" in the
    // output: 0xE6 is a real question mark and ids 7 and 44 are genuinely named
    // "?????" in this ROM. An output-based check would have thrown on a
    // correctly-decoded name -- it did, on the first run of probe_claims.
    if (unmapped.length)
      throw new Error(`ItemNames id ${id} has unmapped byte(s) ${unmapped.map(x => "0x" + x.toString(16)).join(",")} -> "${text}"; extend decodeGen1Bytes before trusting this table`);
    if (/^\?+$/.test(text)) { placeholders++; id++; continue; }   // unused Gen 1 slot
    if (ITEM_NAME[id] === undefined) { ITEM_NAME[id] = text.toLowerCase().replace(/\s+/g, "_"); added++; }
    id++;
  }
  if (total !== priceCount)
    throw new Error(`item table mismatch: ItemNames=${total} entries but ItemPrices=${priceCount} -- ROM layout moved`);
  return { added, total, placeholders };
}

/** wq#1835: what a Gen 1 clerk pays for an id, read from THIS ROM's ItemPrices
 *  table (01:4608) — 3 BCD bytes per entry, index = id-1, the same table
 *  backfillItemNames already derives its length check from.
 *
 *  WHY NOT economy.PRICE. That table prices what a corridor mart STOCKS, and on
 *  2026-09-12 the run's single most valuable possession was a NUGGET (id 49),
 *  which no mart sells: PRICE cannot price it, and a number recalled into PRICE
 *  by hand is exactly the shape of mistake wq#519 caught (the ticket said the
 *  Helix fossil was 0x28; the ROM said 0x2a). The ROM says 01 00 00 = 10000 for
 *  id 49, and Gen 1 pays half.
 *
 *  BOUNDED BY THE TABLE, never past it. The entry count is derived from the
 *  symbol table (97 on this ROM) and ids above it are Gen 1 machines, whose
 *  prices live in a separate table (pokered GetItemPrice special-cases TM ids).
 *  An unbounded read of id 201 returns 919495 — that is the ItemNames text that
 *  follows the table decoding as BCD, i.e. an invented six-figure price for a
 *  TM. Nibbles are BCD-checked for the same reason the lengths are: if this
 *  table ever moves we want a throw, not a plausible number. */
export const ITEM_PRICE: Record<number, number> = {};
export function backfillItemPrices(rom: RomLike, sym: SymbolTable): { priced: number; total: number } {
  const t = sym.sym("ItemPrices");
  const total = (sym.nextAddr(t.bank, t.addr) - t.addr) / 3;
  if (!Number.isInteger(total) || total <= 0)
    throw new Error(`ItemPrices is ${total} 3-byte entries -- ROM layout moved`);
  let priced = 0;
  for (let id = 1; id <= total; id++) {
    const a = t.addr + (id - 1) * 3;
    let v = 0;
    for (let k = 0; k < 3; k++) {
      const b = rom.byte(t.bank, a + k);
      const hi = b >> 4, lo = b & 0xf;
      if (hi > 9 || lo > 9)
        throw new Error(`ItemPrices id ${id} byte ${k} = 0x${b.toString(16)} is not BCD -- ROM layout moved`);
      v = v * 100 + hi * 10 + lo;
    }
    ITEM_PRICE[id] = v;
    if (v > 0) priced++;
  }
  return { priced, total };
}

/** Half the mart price, Gen 1's sell rate. null means "no clerk will buy it":
 *  either the ROM prices it at 0 (key items, fossils, the Master Ball) or the
 *  id is outside the priced table entirely (machines). Never 0-as-a-price —
 *  a caller must not be able to confuse "free" with "unsellable". */
export function sellPrice(id: number): number | null {
  const buy = ITEM_PRICE[id];
  if (typeof buy !== "number" || buy <= 0) return null;
  return Math.floor(buy / 2);
}

/** Human label for ANY id, including ones no table can name. Returns an
 *  explicitly-unknown string rather than undefined, because the failure this
 *  ticket exists to stop is a confident claim about an item nobody checked.
 *  Ids above the named table are Gen 1 machines (TM/HM); their base is a ROM
 *  CONSTANT, not a symbol, so it is not derivable from pokeblue.sym and this
 *  deliberately does NOT guess a TM number -- see the wq#519 report. */
export function itemLabel(id: number): string {
  const n = ITEM_NAME[id];
  if (n) return n;
  return `unknown_item_${id}`;
}

const BALLS: number[] = [ITEM.MASTER_BALL, ITEM.ULTRA_BALL, ITEM.GREAT_BALL, ITEM.POKE_BALL];
const HP_HEAL: number[] = [ITEM.POTION, ITEM.SUPER_POTION, ITEM.HYPER_POTION, ITEM.MAX_POTION, ITEM.FULL_RESTORE];

const ALIAS: Record<string, number> = {
  ball: ITEM.POKE_BALL, pokeball: ITEM.POKE_BALL, poke_ball: ITEM.POKE_BALL,
  greatball: ITEM.GREAT_BALL, great_ball: ITEM.GREAT_BALL,
  ultraball: ITEM.ULTRA_BALL, ultra_ball: ITEM.ULTRA_BALL,
  masterball: ITEM.MASTER_BALL, master_ball: ITEM.MASTER_BALL,
  potion: ITEM.POTION, superpotion: ITEM.SUPER_POTION, super_potion: ITEM.SUPER_POTION,
  hyperpotion: ITEM.HYPER_POTION, hyper_potion: ITEM.HYPER_POTION,
  maxpotion: ITEM.MAX_POTION, max_potion: ITEM.MAX_POTION,
  fullrestore: ITEM.FULL_RESTORE, full_restore: ITEM.FULL_RESTORE,
  antidote: ITEM.ANTIDOTE, burnheal: ITEM.BURN_HEAL, burn_heal: ITEM.BURN_HEAL,
  iceheal: ITEM.ICE_HEAL, ice_heal: ITEM.ICE_HEAL, awakening: ITEM.AWAKENING,
  parlyzheal: ITEM.PARLYZ_HEAL, parlyz_heal: ITEM.PARLYZ_HEAL, paralyzeheal: ITEM.PARLYZ_HEAL,
};
export function itemId(name: string): number | null {
  const k = String(name).toLowerCase().replace(/[\s-]+/g, "_");
  if (ALIAS[k] !== undefined) return ALIAS[k];
  if (ALIAS[k.replace(/_/g, "")] !== undefined) return ALIAS[k.replace(/_/g, "")];
  const direct = Object.entries(ITEM).find(([n]) => n.toLowerCase() === k);
  if (direct) return direct[1];
  // wq#1835: last resort, the ROM's own ItemNames (backfilled at boot). Without
  // this the bag RENDERS "nuggetx1" (wq#1829) while sell_item(nugget,1) answers
  // "unknown item" — the asset visible and still unreachable, which is the
  // whole of this ticket. Only names the ROM itself produced resolve here.
  const named = Object.entries(ITEM_NAME).find(([, n]) => n === k);
  return named ? Number(named[0]) : null;
}

export const MART_ORDER: Record<number, number[]> = {
  42: [ITEM.POKE_BALL, ITEM.ANTIDOTE, ITEM.PARLYZ_HEAL, ITEM.BURN_HEAL],   // Viridian (probe-verified)
  // wq#417 2026-08-08: menu order = ROM data order (Gen 1). Source: pokered mart data,
  // cross-checked vs GameFAQs RB mart list + Bulbapedia. Map IDs verified against
  // pokered map-header order + this run's own mapsSeen (56/58/59-61/68 all consistent).
  56: [ITEM.POKE_BALL, ITEM.POTION, ITEM.ESCAPE_ROPE, ITEM.ANTIDOTE,
       ITEM.BURN_HEAL, ITEM.AWAKENING, ITEM.PARLYZ_HEAL],                  // Pewter
  67: [ITEM.POKE_BALL, ITEM.POTION, ITEM.REPEL, ITEM.ANTIDOTE,
       ITEM.BURN_HEAL, ITEM.AWAKENING, ITEM.PARLYZ_HEAL],                  // Cerulean
  91: [ITEM.POKE_BALL, ITEM.SUPER_POTION, ITEM.ICE_HEAL, ITEM.AWAKENING,
       ITEM.PARLYZ_HEAL, ITEM.REPEL],                                      // Vermilion
};

/** wq#1829: the city behind each MART_ORDER map id. Kept beside the stock
 *  table so "which marts sell balls" can be DERIVED (economy.ballMarts())
 *  instead of re-listed from memory — economyAdvice used to name only two of
 *  the four, and the one the agent was standing next to (Cerulean) was not
 *  always among them. Every key here must exist in MART_ORDER; probe_economy
 *  asserts the two tables agree. */
export const MART_CITY: Record<number, string> = {
  42: "Viridian", 56: "Pewter", 67: "Cerulean", 91: "Vermilion",
};

/** wq#1835: what the sell ADVISOR may never point at. DERIVED, not recalled:
 *  anything a corridor mart stocks is something this campaign buys on purpose,
 *  so recommending its sale is recommending a round trip through the clerk at a
 *  50% loss. Balls and heals are listed again in case a mart table ever grows a
 *  row this set should still cover. It gates the ADVICE, not the tool — a brain
 *  that has a reason to sell four antidotes may still do it; sell() refuses
 *  only balls, which are the catching precondition the money exists to buy. */
const NEVER_ADVISE_SELL: Set<number> = new Set([
  ...Object.values(MART_ORDER).flat(), ...BALLS, ...HP_HEAL,
]);

export interface BagEntry { id: number; qty: number; name: string; }

/** A bag entry a clerk will pay for, with what it is actually worth. */
export interface Sellable { id: number; name: string; qty: number; unit: number; value: number }

export class Items {
  constructor(private emu: Emulator, private sym: SymbolTable, private scr: Screen,
              private sync: Sync, private dlg: Dialog, private nav: any,
              private map: any, private bat: any, private bus?: EventBus) {}

  private m() { return this.emu.mem(); }
  private r(name: string) { return this.m()[this.sym.addr(name)]; }
  private cur() { return this.r("wCurrentMenuItem"); }
  private money(): number {
    const a = this.sym.addr("wPlayerMoney"), m = this.m();
    return [m[a], m[a + 1], m[a + 2]].reduce((acc, b) => acc * 100 + ((b >> 4) * 10 + (b & 0xf)), 0);
  }
  private async tap(k: number, settle = 200) { await this.emu.tapAsync(k, 8, 16); await this.sync.settle(settle); }
  private async waitFor(p: () => boolean, mf = 900): Promise<boolean> {
    for (let i = 0; i < mf / 10; i++) { if (p()) return true; await this.emu.framesAsync(10); }
    return false;
  }
  private twoOptionUp(): boolean { return this.r("wTwoOptionMenuID") !== 0 && this.scr.cursor() !== null; }
  private async moveCur(target: number, maxTaps = 16): Promise<boolean> {
    for (let i = 0; i < maxTaps && this.cur() !== target; i++)
      await this.tap(this.cur() < target ? KEYS.DOWN : KEYS.UP, 130);
    return this.cur() === target;
  }
  /** wq#1663: scroll a bag list to an ABSOLUTE item position. wCurrentMenuItem
   *  only tracks the ROW within whatever page is currently drawn -
   *  wListScrollOffset is the page offset - so moveCur(idx) compares a
   *  0-3-ish row straight against an absolute list index and can never reach
   *  any item past the first page (it silently pins the highest visible
   *  row/cur() forever). This was already worked around once, inline, in
   *  useOverworld below; factored out so useInBattle gets the same fix and
   *  the two paths can't drift apart again like this did. */
  private async moveToBagIndex(idx: number): Promise<boolean> {
    for (let i = 0; i < idx + 6; i++) { if (this.scroll() === 0 && this.cur() === 0) break; await this.tap(KEYS.UP, 110); }
    let guard = 0;
    while (this.scroll() + this.cur() < idx && guard++ < 24) await this.tap(KEYS.DOWN, 130);
    return this.scroll() + this.cur() === idx;
  }
  // Research-probe-verified helpers (2026-08-06):
  // cf91/wCurItem is written with the selected item id on A-press in list menus.
  // wq#620 CORRECTION to the old "hover does NOT update it" note: in the MART
  // list cf91 also gets written during SCROLL (recon620 observed cf91=12 with
  // the arrow displayed on ANTIDOTE=11), so cf91 alone can disagree with what
  // the player sees. It remains a useful post-A corroboration; it is no longer
  // the selection GATE — the tilemap label under the arrow is (menuView below).
  private curItem() { return this.r("wCurItem"); }
  private maxMenu() { return this.r("wMaxMenuItem"); }
  private scroll() { return this.r("wListScrollOffset"); }
  /** wq#620: structured view of whatever window is on screen right now. */
  menuView(): MenuView {
    return readMenu(this.scr.textGrid(), this.scr.cursor(),
                    this.scr.awaitingPrompt(), this.twoOptionUp());
  }
  // First tap after a menu init gets eaten -> normalize to top with harmless UP
  // spam, then require a stable cur()==0 across two reads.
  private async normalizeTop(spins = 6): Promise<boolean> {
    for (let i = 0; i < spins; i++) await this.tap(KEYS.UP, 110);
    if (this.cur() !== 0) return false;
    await this.emu.framesAsync(12);
    return this.cur() === 0;
  }

  bag(): BagEntry[] {
    const n = this.r("wNumBagItems"), a = this.sym.addr("wBagItems"), m = this.m();
    const out: BagEntry[] = [];
    for (let i = 0; i < Math.min(n, 20); i++) {
      const id = m[a + i * 2];
      out.push({ id, qty: m[a + i * 2 + 1], name: itemLabel(id) });
    }
    return out;
  }
  has(id: number): number { return this.bag().find(e => e.id === id)?.qty ?? 0; }
  count(id: number): number { return this.has(id); }
  bagIndex(id: number): number { return this.bag().findIndex(e => e.id === id); }
  bagLine(): string {
    const b = this.bag();
    return b.length ? b.map(e => `${e.name}x${e.qty}`).join(" ") : "empty";
  }
  isBall(id: number) { return BALLS.includes(id); }
  isHpHeal(id: number) { return HP_HEAL.includes(id); }

  /** wq#1835: bag entries worth cash that the campaign does not otherwise need,
   *  richest first. Empty until backfillItemPrices() has read the ROM — an
   *  un-priced table must advise NOTHING rather than advise at a guessed rate. */
  sellables(): Sellable[] {
    const out: Sellable[] = [];
    for (const e of this.bag()) {
      const unit = sellPrice(e.id);
      if (unit === null || NEVER_ADVISE_SELL.has(e.id)) continue;
      out.push({ id: e.id, name: itemLabel(e.id), qty: e.qty, unit, value: unit * e.qty });
    }
    return out.sort((a, b) => b.value - a.value);
  }

  async buy(wantId: number, qty: number): Promise<string> {
    if (this.bat.active?.()) return "buy: not during battle";
    const map = this.r("wCurMap");
    const order = MART_ORDER[map];
    if (!order) return `buy: not in a known mart (map ${map})`;
    const listIdx = order.indexOf(wantId);
    if (listIdx < 0) return `buy: ${ITEM_NAME[wantId]} not sold here; stock: ${order.map(i => ITEM_NAME[i]).join(", ").toUpperCase()}`;
    const before = this.money();
    if (!await this.openClerk()) { await this.exitMart(); return "buy: mart menu never opened (could not reach the clerk)"; }
    if (!await this.moveCur(0)) { await this.exitMart(); return "buy: could not select BUY"; }
    // A on BUY gets eaten if the menu just re-inited (2nd purchase same visit) -> verified retry
    let listOpen = false;
    for (let i = 0; i < 3 && !listOpen; i++) {
      await this.tap(KEYS.A, 250);
      listOpen = await this.waitFor(() => this.scr.text().includes("BALL") && this.scr.cursor() !== null, 400);
    }
    if (!listOpen) { await this.exitMart(); return "buy: item list never opened"; }
    await this.sync.settle(300);          // let list init finish - first tap gets eaten mid-init
    // wq#620: SELECTION BY READING, not by counting. The old path stepped
    // wCurrentMenuItem to a target index and gated on cf91 after A — and both
    // registers can disagree with the display (cur pins while the list
    // scrolls; cf91 gets written on scroll-hover, recon620). The gate is now
    // the decoded tilemap label under the arrow — the thing the player sees —
    // with scroll+cur only steering the tap direction. cf91 is recorded as
    // corroboration, never the gate.
    const wantLabel = ITEM_NAME[wantId];
    let matched = false;
    let lastView = this.menuView();
    for (let t = 0; t < order.length * 2 + 8; t++) {
      lastView = this.menuView();
      if (lastView.selectedLabel && labelMatches(lastView.selectedLabel, wantLabel)) { matched = true; break; }
      const at = this.scroll() + this.cur();
      await this.tap(at < listIdx ? KEYS.DOWN : KEYS.UP, 160);
    }
    if (!matched) {
      const visible = lastView.entries.map(e => e.label + (e.price !== null ? ` $${e.price}` : "")).join(", ");
      await this.exitMart();
      return `buy: ${ITEM_NAME[wantId]} never came under the cursor; visible list: ${visible || "(unreadable)"}`;
    }
    await this.tap(KEYS.A, 250);
    const cfAfterA = this.curItem();      // corroboration only (see note above)
    if (!await this.waitFor(() => /x0?\d/.test(this.scr.text()))) { await this.exitMart(); return `buy: qty selector never opened (label matched "${lastView.selectedLabel}", cf91=${cfAfterA})`; }
    for (let i = 1; i < qty; i++) await this.tap(KEYS.UP, 120);
    await this.tap(KEYS.A, 250);
    // Confirm: multi-part dialog with a scroll prompt that WAITS for a press
    // (research-proven; textUp reads false at the wait). Advance with A while
    // no cursor is up - the cursor only appears with YES/NO, so A can't
    // accidentally confirm. Name-verify as the text prints, before YES.
    const confirmUp = () => this.twoOptionUp() || (this.scr.cursor() !== null && /YES/.test(this.scr.text()));
    // wq#620: the confirm-name check normalizes both sides (é -> e, case,
    // separators) — the shared charmap now decodes the real "POKé", so the old
    // hardcoded "POKe" fragment would never match a ball purchase again.
    const normTxt = (s: string) => s.toLowerCase().replace(/\u00e9/g, "e").replace(/[^a-z0-9]+/g, " ");
    const frag = normTxt(ITEM_NAME[wantId]).trim().slice(0, 6);
    const fragSeen = () => normTxt(this.scr.text()).includes(frag);
    let sawFrag = false;
    for (let i = 0; i < 14 && !confirmUp(); i++) {
      if (fragSeen()) sawFrag = true;
      if (this.scr.cursor() === null) await this.tap(KEYS.A, 250);
      else await this.emu.framesAsync(20);
    }
    if (!await this.waitFor(confirmUp, 600)) { await this.exitMart(); return "buy: confirm prompt never appeared"; }
    if (!sawFrag && !fragSeen()) {
      await this.tap(KEYS.B, 300);        // NO - abort the purchase
      await this.exitMart();
      return `buy: confirm text mismatch (wanted ${frag}) - aborted before paying`;
    }
    await this.tap(KEYS.A, 300);            // YES (cursor defaults top)
    const paid = await this.waitFor(() => this.money() < before, 2000);
    for (let i = 0; i < 8 && (this.sync.textUp() || this.dlg.open()); i++) await this.tap(KEYS.A, 250);
    const spent = before - this.money();
    await this.exitMart();
    this.bus?.emit("tool_call", { tool: "buy_item", args: { item: ITEM_NAME[wantId], qty, spent } });
    return paid ? `bought ${qty}x ${ITEM_NAME[wantId]} for ${spent}; have ${this.has(wantId)}` : "buy: no charge registered";
  }

  /** wq#1835: the other half of the counter. buy() has existed since S3 and
   *  SELL was a word in an exitMart comment, so the run on 2026-09-12 sat at $96
   *  for 318 turns carrying a NUGGET the clerk two maps away would have paid
   *  $5000 for — more than twenty Poke Balls, and the largest single income in
   *  the early game by an order of magnitude.
   *
   *  Mirrors buy(): same clerk, same read-gating discipline, money delta the
   *  other way. Three things are deliberately NOT like buy():
   *   - THE NAME GATE IS AT SELECTION, not at the confirm. buy() re-reads the
   *     item name out of the confirm text before paying; the sell confirm says
   *     "I can pay you 350 for that." and never names the item (observed live,
   *     map67), so the only place the identity can be checked is the tilemap
   *     label under the arrow — which is where wq#620 concluded it belonged.
   *   - THE QUANTITY IS READ BACK FROM RAM (wItemQuantity), not counted in taps,
   *     and the expected payout is computed from what the RAM says we are about
   *     to sell. A swallowed tap then sells less, never lies about more.
   *   - THE PRICE IS CROSS-CHECKED against the ROM's own table before YES. Not
   *     as the source of truth — that is always the money delta in RAM — but
   *     because a disagreement means the game has a different item selected
   *     than we think, and the next button press is irreversible. */
  async sell(wantId: number, qty: number): Promise<string> {
    if (this.bat.active?.()) return "sell: not during battle";
    const map = this.r("wCurMap");
    if (!MART_ORDER[map]) return `sell: not in a known mart (map ${map})`;
    // Balls are the precondition the whole purse exists to buy; no strategy
    // ends with selling them back at half price.
    if (this.isBall(wantId)) return `sell: never sell ${itemLabel(wantId)} - balls are what the money is FOR`;
    const idx = this.bagIndex(wantId);
    if (idx < 0) return `sell: no ${itemLabel(wantId)} in bag`;
    const unit = sellPrice(wantId);
    if (unit === null)
      return `sell: this ROM prices ${itemLabel(wantId)} at ` +
        `${ITEM_PRICE[wantId] === undefined ? "nothing (no ItemPrices entry - machines and key items have none)" : "0"}` +
        `; a Gen 1 clerk refuses it`;
    const want = itemLabel(wantId);
    const have0 = this.has(wantId);
    const before = this.money();
    if (!await this.openClerk()) { await this.exitMart(); return "sell: mart menu never opened (could not reach the clerk)"; }
    if (!await this.moveCur(1)) { await this.exitMart(); return "sell: could not select SELL"; }
    // A on SELL prints "What would you like to sell?" over several presses and
    // only then draws the PACK list. The clerk menu has a cursor of its own, so
    // "a cursor is up" cannot tell the two apart -- the column can: the clerk
    // menu draws its arrow at x=1 and the list at x=5 (observed live on map67,
    // the same structural fence wq#1663 used for the battle bag).
    const listUp = () => { const c = this.scr.cursor(); return c !== null && c.x >= 4; };
    // The prompt needs several presses and the list needs one, so the press
    // that opens the list can be followed by one more -- which SELECTS whatever
    // row the arrow starts on and opens its quantity selector. That press is
    // recoverable and must be recovered from, not just avoided: B backs out of
    // the selector to the list, and the loop then sees listUp and stops. Left
    // unhandled this is the path where a swallowed frame sells the wrong item.
    const selectorUp = () => this.scr.cursor() === null && /x0\d/.test(this.scr.text());
    let listOpen = listUp();
    for (let i = 0; i < 8 && !listOpen; i++) {
      if (selectorUp()) { await this.tap(KEYS.B, 250); listOpen = listUp(); continue; }
      await this.tap(KEYS.A, 250);
      listOpen = await this.waitFor(listUp, 400);
    }
    if (!listOpen) { await this.exitMart(); return "sell: sell list never opened"; }
    await this.sync.settle(300);          // list init - the first tap gets eaten
    let label: string | null = null, matched = false;
    for (let t = 0; t < 2 && !matched; t++) {
      if (!await this.moveToBagIndex(idx)) continue;
      await this.sync.settle(180);        // the tilemap lags the scroll
      label = this.menuView().selectedLabel;
      matched = !!label && labelMatches(label, want);
    }
    if (!matched) {
      await this.exitMart();
      return `sell: ${want} never came under the cursor (bag index ${idx}, arrow on "${label ?? "unreadable"}")`;
    }
    await this.tap(KEYS.A, 260);
    // Quantity selector: the list arrow disappears and the window prints "x01"
    // with the running total beside it. Bag ROWS render a count as "x 1" (Gen 1
    // right-justifies the field - the wq#1663 lesson), so "x0<digit>" cannot
    // match a row and is a safe open-gate for the selector.
    if (!await this.waitFor(selectorUp, 900)) {
      await this.exitMart();
      return `sell: quantity selector never opened (arrow read "${label}", cf91=${this.curItem()})`;
    }
    const cfAfterA = this.curItem();      // corroboration only (see buy())
    const wantN = Math.max(1, Math.min(qty, have0));
    for (let i = 0; i < wantN + 6 && this.r("wItemQuantity") < wantN; i++) await this.tap(KEYS.UP, 130);
    const sellN = this.r("wItemQuantity");     // what the GAME is about to sell
    const expect = unit * sellN;
    await this.tap(KEYS.A, 260);
    // Confirm is a slow-printing multi-part dialog ending in YES/NO. Note
    // wTwoOptionMenuID reads 0 here (observed live), so twoOptionUp() alone
    // never fires -- the cursor+YES fallback buy() already carries is what
    // catches it.
    const confirmUp = () => this.twoOptionUp() || (this.scr.cursor() !== null && /YES/.test(this.scr.text()));
    for (let i = 0; i < 14 && !confirmUp(); i++) {
      if (this.scr.cursor() === null) await this.tap(KEYS.A, 250);
      else await this.emu.framesAsync(20);
    }
    if (!await this.waitFor(confirmUp, 600)) { await this.exitMart(); return "sell: confirm prompt never appeared"; }
    const offer = this.menuView().dialog.match(/(\d+)/);
    if (offer && Number(offer[1]) !== expect) {
      await this.tap(KEYS.B, 300);        // NO - abort before the sale
      await this.exitMart();
      return `sell: the clerk offered ${offer[1]} for ${sellN}x ${want} but the ROM prices that at ${expect}` +
        ` - aborted rather than sell something else (cf91=${cfAfterA})`;
    }
    await this.tap(KEYS.A, 320);            // YES (cursor defaults top)
    const paid = await this.waitFor(() => this.money() > before, 2000);
    // The bag decrement lands one dialog-advance AFTER the money does. Advance
    // it - but never blind-A a cursored prompt: A on the finished sale reopens
    // the sell list and starts ANOTHER transaction (observed live), the same
    // wedge exitMart() documents for buy.
    for (let i = 0; i < 6 && this.has(wantId) === have0; i++) {
      if (this.scr.cursor() !== null || (!this.sync.textUp() && !this.dlg.open())) break;
      await this.tap(KEYS.A, 250);
    }
    const earned = this.money() - before;
    await this.exitMart();
    this.bus?.emit("tool_call", { tool: "sell_item", args: { item: want, qty: sellN, earned } });
    if (!paid) return `sell: no payment registered (${want} still ${this.has(wantId)} in bag)`;
    const caveat = earned === expect ? "" : ` (expected ${expect} - the purse may have hit the 999999 cap)`;
    return `sold ${sellN}x ${want} for ${earned}${caveat}; purse ${this.money()}, ${this.has(wantId)} left`;
  }

  /** Path to the counter, face the clerk, and get the BUY/SELL/QUIT menu up.
   *  Gen 1 marts: the clerk stands behind a counter and you talk ACROSS it, so
   *  the approach is the tile below-left of the clerk facing into the counter;
   *  a couple of approaches are tried because a customer NPC can occupy one.
   *
   *  wq#1835 factored this out of buy() so sell() reaches the same clerk by the
   *  same route. The two halves of a mart transaction drifting apart is the
   *  failure moveToBagIndex() above already documents happening once. */
  private async openClerk(): Promise<boolean> {
    const approaches: Array<[number, number, number]> = [[2, 5, KEYS.LEFT], [3, 6, KEYS.UP], [2, 6, KEYS.UP]];
    for (const [ax, ay, face] of approaches) {
      if (this.nav?.goto) { const g = await this.nav.goto(ax, ay).catch(() => "stuck"); if (g === "stuck" || g === "adjacent_npc") continue; }
      await this.tap(face, 200);
      await this.tap(KEYS.A, 250);
      if (await this.waitFor(() => this.scr.text().includes("BUY"), 500)) return true;
      // clear any greeting dialog that didn't reach the menu, then retry
      for (let i = 0; i < 4 && (this.sync.textUp() || this.dlg.open()); i++) await this.tap(KEYS.A, 250);
      if (await this.waitFor(() => this.scr.text().includes("BUY"), 400)) return true;
      for (let i = 0; i < 4 && (this.sync.textUp() || this.dlg.open() || this.scr.cursor()); i++) await this.tap(KEYS.B, 200);
    }
    return false;
  }

  private async exitMart(): Promise<void> {
    // State-verified close-out (probe-proven wedge: blind A facing the clerk
    // reopens the shop; B during slow-printing confirm does not cancel and a
    // pending YES/NO surfaces later, freezing the overworld -> nav stuck).
    for (let round = 0; round < 3; round++) {
      // pending YES/NO confirm? answer NO
      if (this.scr.cursor() !== null && /YES/.test(this.scr.text())) await this.tap(KEYS.B, 300);
      // advance any printing text with B (never A - A can re-engage the clerk)
      for (let i = 0; i < 6 && this.sync.textUp(); i++) await this.tap(KEYS.B, 250);
      // climb the menu stack to BUY/SELL/QUIT, then take QUIT
      for (let i = 0; i < 5 && !this.scr.text().includes("QUIT") && this.dlg.open(); i++) await this.tap(KEYS.B, 250);
      if (this.scr.text().includes("QUIT")) { await this.moveCur(2); await this.tap(KEYS.A, 300); }
      // clear the farewell: A only while text is provably printing, else B
      for (let i = 0; i < 10 && (this.sync.textUp() || this.dlg.open()); i++)
        await this.tap(this.sync.textUp() ? KEYS.A : KEYS.B, 250);
      if (!this.dlg.open() && !this.sync.textUp()) break;   // provably overworld
    }
    await this.sync.settle(300);
  }

  async useOverworld(itemId: number, slot = 0): Promise<string> {
    if (this.bat.active?.()) return "use_item: in battle - handled by battle flow";
    const idx = this.bagIndex(itemId);
    if (idx < 0) return `use_item: no ${ITEM_NAME[itemId]} in bag`;
    const before = this.has(itemId);
    // Menu draw lags the press -> all predicates below wait for drawn state.
    await this.tap(KEYS.START, 350);
    if (!await this.waitFor(() => this.dlg.open() || this.scr.cursor() !== null, 900)) {
      await this.tap(KEYS.START, 350);   // first press can get eaten
      if (!await this.waitFor(() => this.dlg.open() || this.scr.cursor() !== null, 900)) {
        await this.closeMenus(); return "use_item: START menu didn't open";
      }
    }
    // START menu text IS visible once drawn (research2; earlier "invisible"
    // finding was a pre-draw timing artifact). Menu rows map 1:1 to indices
    // (row i == index i), so find the ITEM row directly. wMaxMenuItem here
    // reads entry COUNT (7 with dex+party), not count-1 -> formula fallback
    // is max-5 (4 entries always sit below ITEM). probe-proven: max-4 opened
    // the trainer card.
    if (!await this.waitFor(() => this.maxMenu() >= 5, 900)) {
      // START likely eaten by a leftover textbox -> clear everything, retry once
      await this.closeMenus();
      await this.tap(KEYS.START, 350);
      if (!await this.waitFor(() => this.maxMenu() >= 5, 900)) { await this.closeMenus(); return `use_item: START menu bad shape (max=${this.maxMenu()})`; }
    }
    await this.sync.settle(250);         // let the menu finish drawing before reading rows
    const rowIdx = this.scr.text().split("\n").findIndex(row => row.trim() === "ITEM");
    const itemMenuIdx = rowIdx >= 0 ? rowIdx : Math.max(0, this.maxMenu() - 5);
    if (!await this.moveCur(itemMenuIdx)) { await this.closeMenus(); return "use_item: cursor lost on START"; }
    await this.tap(KEYS.A, 350);
    await this.sync.settle(300);         // bag list init - first tap gets eaten
    // Bag row = wListScrollOffset + wCurrentMenuItem; cf91 after A is the verify.
    let selected = false;
    for (let attempt = 0; attempt < 2 && !selected; attempt++) {
      if (!await this.moveToBagIndex(idx)) continue;
      await this.tap(KEYS.A, 300);
      if (await this.waitFor(() => this.curItem() === itemId, 600)) { selected = true; break; }
      await this.tap(KEYS.B, 300);
    }
    if (!selected) { await this.closeMenus(); return `use_item: could not verify ${ITEM_NAME[itemId]} in bag (cf91=${this.curItem()})`; }
    // USE/TOSS submenu is also invisible outdoors; USE is the default top row.
    await this.sync.settle(300);
    if (this.scr.cursor() !== null) await this.moveCur(0);
    await this.tap(KEYS.A, 350);
    // Party screen is a full-screen UI (font loaded) -> :L text usually visible.
    await this.waitFor(() => /:L\d/.test(this.scr.text()), 900);
    if (/:L\d/.test(this.scr.text())) { await this.moveCur(slot); }
    await this.tap(KEYS.A, 400);
    // Adjudicate actively: text waits for presses (standing lesson). Advance
    // with A only while NO cursor is up - a stable cursored menu means the game
    // has already answered (e.g. back at party after "no effect"); blind A
    // there re-selects the mon and loops the refusal.
    let used = false;
    for (let i = 0; i < 16; i++) {
      if (this.has(itemId) < before) { used = true; break; }
      if (this.scr.cursor() === null && (this.sync.textUp() || this.dlg.open())) await this.tap(KEYS.A, 220);
      else break;
    }
    used = this.has(itemId) < before;
    await this.closeMenus();
    this.bus?.emit("tool_call", { tool: "use_item", args: { item: ITEM_NAME[itemId], slot, used } });
    return used ? `use_item done: ${ITEM_NAME[itemId]} on slot ${slot}; ${this.has(itemId)} left` : `use_item: no effect (${ITEM_NAME[itemId]})`;
  }

  async useInBattle(itemId: number, slot = 0): Promise<string> {
    if (!this.bat.active?.()) return "use_item: not in battle";
    if (this.bat.state?.().inBattle === 2 && this.isBall(itemId)) return "catch: cannot catch in a trainer battle";
    const idx = this.bagIndex(itemId);
    if (idx < 0) return `use_item: no ${ITEM_NAME[itemId]} in bag`;
    const before = this.has(itemId);
    const ball = this.isBall(itemId);
    const w = await this.bat.waitForMenu?.();
    if (w && w !== "menu") return `use_item: battle not at menu (${w})`;
    await this.tap(KEYS.DOWN, 120); await this.tap(KEYS.LEFT, 120);   // -> ITEM (bottom-left)
    await this.tap(KEYS.A, 300);
    // wq#1663: the bag list is one page of a potentially long, scrollable Pack
    // (TMs/key items share the list, in pickup order) and this check never
    // scrolls, so it must not depend on which page happens to be showing.
    // CANCEL only renders at the bottom of the list; BALL only once POKe
    // BALL's row is in view - neither is guaranteed on page 1. The old /x\d/
    // fallback was itself broken: Gen 1 right-justifies the count field, so a
    // single-digit qty renders "x 1" (space before the digit), not "x1" -
    // /x\d/ only ever matched a 10-99 stack, i.e. never in the common case.
    // Root cause of the 1200x "didn't open" run: page 1 showed TM34/DOME
    // FOSSIL/ANTIDOTE/NUGGET, all single-digit qty - CANCEL absent, BALL
    // absent, /x\d/ never matching - so the OR was permanently false and the
    // 800ms budget always burned out, even though the bag opened correctly.
    // Primary signal is now structural, not textual: the bag list draws its
    // cursor in a completely different screen region from the main FIGHT/
    // ITEM/RUN/PKMN quadrant Battle.atMainMenu() already fences off (verified
    // live: main menu ~{x:9,y:14-16}; bag list ~{x:5,y:4+}). "cursor visible
    // and outside the main-menu quadrant" is true from the first frame the
    // list is drawn, regardless of scroll position or item ordering. The old
    // text checks stay as a cheap OR fallback (regex fixed to allow the
    // padding space) in case of a genuine one-frame cursor/tile draw race.
    if (!await this.waitFor(() => {
      const inSubmenu = this.scr.cursor() !== null && !this.bat.atMainMenu?.();
      return inSubmenu || this.scr.text().includes("CANCEL") || this.scr.text().includes("BALL") || /x\s*\d/.test(this.scr.text());
    }, 800)) {
      await this.closeBattleMenus(); return "use_item: battle bag didn't open";
    }
    if (!await this.moveToBagIndex(idx)) { await this.closeBattleMenus(); return "use_item: cursor lost on battle bag"; }
    // A gets eaten on fresh menus (standing lesson) -> cf91-verified retry;
    // without it a missed press leaves the bag open and the drive loop B's out.
    let thrown = false;
    for (let t = 0; t < 3 && !thrown; t++) {
      await this.tap(KEYS.A, 300);
      thrown = await this.waitFor(() => this.curItem() === itemId, 300);
    }
    if (!thrown) { await this.closeBattleMenus(); return `use_item: battle bag select unverified (cf91=${this.curItem()})`; }
    if (ball) {
      // Catch sequence text WAITS for presses (same scroll-prompt behavior as
      // the mart confirm) - drive it actively. Cursor up = nickname YES/NO -> B (NO).
      const party0 = this.r("wPartyCount");
      let done = false;
      for (let i = 0; i < 70; i++) {   // catch + dex-entry text is LONG - 40 was not enough
        if (this.r("wIsInBattle") === 0 && !this.sync.textUp() && !this.dlg.open()) { done = true; break; }
        await this.tap(this.scr.cursor() !== null ? KEYS.B : KEYS.A, 250);
      }
      // Ground truth = party growth; wIsInBattle==0 alone also matches KO/flee.
      const caught = done && this.r("wPartyCount") > party0;
      this.bus?.emit("tool_call", { tool: "catch", args: { ball: ITEM_NAME[itemId], caught } });
      if (caught) return `caught it with ${ITEM_NAME[itemId]}! (${this.has(itemId)} left)`;
      if (this.r("wIsInBattle") === 0) return `${ITEM_NAME[itemId]} thrown - battle ended, not caught (${this.has(itemId)} left)`;
      return `${ITEM_NAME[itemId]} thrown - broke free (${this.has(itemId)} left)`;
    }
    await this.waitFor(() => /:L\d/.test(this.scr.text()) || this.has(itemId) < before, 800);
    if (/:L\d/.test(this.scr.text())) { await this.moveCur(slot); await this.tap(KEYS.A, 400); }
    const used = await this.waitFor(() => this.has(itemId) < before, 1200);
    for (let i = 0; i < 6 && (this.sync.textUp() || this.dlg.open()); i++) await this.tap(KEYS.A, 250);
    this.bus?.emit("tool_call", { tool: "use_item", args: { item: ITEM_NAME[itemId], slot, used, inBattle: true } });
    return used ? `used ${ITEM_NAME[itemId]} in battle on slot ${slot}` : "use_item: no effect";
  }

  private async closeMenus(): Promise<void> {
    // cursor/dlg/textUp carry the detection; text regexes false-positive on
    // map tiles. End with a verified-closed wait + escalation.
    for (let i = 0; i < 14 && (this.sync.textUp() || this.dlg.open() || this.scr.cursor() !== null); i++)
      await this.tap(KEYS.B, 230);
    await this.tap(KEYS.B, 200); await this.tap(KEYS.B, 200);
    if (!await this.waitFor(() => !this.dlg.open() && !this.sync.textUp() && this.scr.cursor() === null, 300))
      for (let i = 0; i < 6; i++) await this.tap(KEYS.B, 230);
  }
  private async closeBattleMenus(): Promise<void> {
    for (let i = 0; i < 6 && (this.scr.cursor() || /CANCEL/.test(this.scr.text())); i++) await this.tap(KEYS.B, 200);
  }
}
