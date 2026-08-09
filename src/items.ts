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

export const ITEM = {
  MASTER_BALL: 1, ULTRA_BALL: 2, GREAT_BALL: 3, POKE_BALL: 4,
  MOON_STONE: 0x0a, ANTIDOTE: 0x0b, BURN_HEAL: 0x0c, ICE_HEAL: 0x0d,
  AWAKENING: 0x0e, PARLYZ_HEAL: 0x0f, FULL_RESTORE: 0x10, MAX_POTION: 0x11,
  HYPER_POTION: 0x12, SUPER_POTION: 0x13, POTION: 0x14, ESCAPE_ROPE: 0x1d, REPEL: 0x1e,
} as const;
export const ITEM_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(ITEM).map(([k, v]) => [v, k.toLowerCase()]));

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
  return direct ? direct[1] : null;
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

export interface BagEntry { id: number; qty: number; name: string; }

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
  // Research-probe-verified helpers (2026-08-06):
  // cf91/wCurItem is written with the selected item id on A-press in list menus
  // (hover does NOT update it) -> the deterministic post-select verify.
  private curItem() { return this.r("wCurItem"); }
  private maxMenu() { return this.r("wMaxMenuItem"); }
  private scroll() { return this.r("wListScrollOffset"); }
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
      out.push({ id, qty: m[a + i * 2 + 1], name: ITEM_NAME[id] ?? `item${id}` });
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

  async buy(wantId: number, qty: number): Promise<string> {
    if (this.bat.active?.()) return "buy: not during battle";
    const map = this.r("wCurMap");
    const order = MART_ORDER[map];
    if (!order) return `buy: not in a known mart (map ${map})`;
    const listIdx = order.indexOf(wantId);
    if (listIdx < 0) return `buy: ${ITEM_NAME[wantId]} not sold here; stock: ${order.map(i => ITEM_NAME[i]).join(", ").toUpperCase()}`;
    const before = this.money();
    // Path to the counter and face the clerk. Gen 1 marts: clerk stands behind
    // a counter; you talk ACROSS it. Approach the tile below-left of the clerk
    // and face into the counter. Try a couple of approaches if the first misses.
    const approaches: Array<[number, number, number]> = [[2, 5, KEYS.LEFT], [3, 6, KEYS.UP], [2, 6, KEYS.UP]];
    let opened = false;
    for (const [ax, ay, face] of approaches) {
      if (this.nav?.goto) { const g = await this.nav.goto(ax, ay).catch(() => "stuck"); if (g === "stuck") continue; }
      await this.tap(face, 200);
      await this.tap(KEYS.A, 250);
      if (await this.waitFor(() => this.scr.text().includes("BUY"), 500)) { opened = true; break; }
      // clear any greeting dialog that didn't reach the menu, then retry
      for (let i = 0; i < 4 && (this.sync.textUp() || this.dlg.open()); i++) await this.tap(KEYS.A, 250);
      if (await this.waitFor(() => this.scr.text().includes("BUY"), 400)) { opened = true; break; }
      for (let i = 0; i < 4 && (this.sync.textUp() || this.dlg.open() || this.scr.cursor()); i++) await this.tap(KEYS.B, 200);
    }
    if (!opened) { await this.exitMart(); return "buy: mart menu never opened (could not reach the clerk)"; }
    if (!await this.moveCur(0)) { await this.exitMart(); return "buy: could not select BUY"; }
    // A on BUY gets eaten if the menu just re-inited (2nd purchase same visit) -> verified retry
    let listOpen = false;
    for (let i = 0; i < 3 && !listOpen; i++) {
      await this.tap(KEYS.A, 250);
      listOpen = await this.waitFor(() => this.scr.text().includes("BALL") && this.scr.cursor() !== null, 400);
    }
    if (!listOpen) { await this.exitMart(); return "buy: item list never opened"; }
    await this.sync.settle(300);          // let list init finish - first tap gets eaten mid-init
    // Three-layer selection (probe-proven failure: stale cur() bought the wrong row):
    // 1) normalize to top, 2) step to row with cur() verify, 3) cf91 must hold wantId after A.
    let selected = false;
    for (let attempt = 0; attempt < 2 && !selected; attempt++) {
      if (!await this.normalizeTop()) continue;
      if (!await this.moveCur(listIdx)) continue;
      await this.tap(KEYS.A, 250);
      if (await this.waitFor(() => this.curItem() === wantId, 600)) { selected = true; break; }
      await this.tap(KEYS.B, 300);        // qty selector -> back to list, retry
    }
    if (!selected) { await this.exitMart(); return `buy: could not verify ${ITEM_NAME[wantId]} under cursor (cf91=${this.curItem()})`; }
    if (!await this.waitFor(() => /x0?\d/.test(this.scr.text()))) { await this.exitMart(); return "buy: qty selector never opened"; }
    for (let i = 1; i < qty; i++) await this.tap(KEYS.UP, 120);
    await this.tap(KEYS.A, 250);
    // Confirm: multi-part dialog with a scroll prompt that WAITS for a press
    // (research-proven; textUp reads false at the wait). Advance with A while
    // no cursor is up - the cursor only appears with YES/NO, so A can't
    // accidentally confirm. Name-verify as the text prints, before YES.
    const confirmUp = () => this.twoOptionUp() || (this.scr.cursor() !== null && /YES/.test(this.scr.text()));
    const frag = ITEM_NAME[wantId].toUpperCase().replace(/_/g, " ").replace("POKE", "POKe").slice(0, 6);
    let sawFrag = false;
    for (let i = 0; i < 14 && !confirmUp(); i++) {
      if (this.scr.text().includes(frag)) sawFrag = true;
      if (this.scr.cursor() === null) await this.tap(KEYS.A, 250);
      else await this.emu.framesAsync(20);
    }
    if (!await this.waitFor(confirmUp, 600)) { await this.exitMart(); return "buy: confirm prompt never appeared"; }
    if (!sawFrag && !this.scr.text().includes(frag)) {
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
      for (let i = 0; i < idx + 6; i++) { if (this.scroll() === 0 && this.cur() === 0) break; await this.tap(KEYS.UP, 110); }
      let guard = 0;
      while (this.scroll() + this.cur() < idx && guard++ < 24) await this.tap(KEYS.DOWN, 130);
      if (this.scroll() + this.cur() !== idx) continue;
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
    if (!await this.waitFor(() => this.scr.text().includes("CANCEL") || this.scr.text().includes("BALL") || /x\d/.test(this.scr.text()), 800)) {
      await this.closeBattleMenus(); return "use_item: battle bag didn't open";
    }
    if (!await this.moveCur(idx)) { await this.closeBattleMenus(); return "use_item: cursor lost on battle bag"; }
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
