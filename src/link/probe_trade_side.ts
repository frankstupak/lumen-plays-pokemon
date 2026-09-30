// wq#484 probe — the one-sided trade layer, with no emulator and no sockets.
//
//   npx tsx src/link/probe_trade_side.ts
//
// Everything here is pure: the menu decode, the expected-difference set for an
// asymmetric pair, the uncapped section diff, and the confirm driver against a
// scripted fake side. The RED half is the point — a probe whose inputs all come
// from the population the code was written around cannot falsify anything
// (wq#2630). So it also asserts that a byte lost OUTSIDE the patched sections is
// caught, that an unpatched pair is REJECTED rather than silently passed, and
// that a peer which never converges produces `swapped: false` instead of a hang.
import { KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { romPath } from "../fixtures";
import { MENU, phaseOf, cursorOf, maxItemOf, cursorKeyFor, Phase } from "./trade_menu";
import { ASYM_PATCHES, assertPatchInBlock, expectedAsymSections, driveTradeConfirm } from "./trade_side";
import { offsetsFromSymbols, diffSections, diffBlocks, BLOCK, sectionOf } from "./invariants";
import { ADDR } from "./identity";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, note = "") => {
  c ? (pass++, console.log(`PASS ${n} :: ${note}`)) : (fail++, console.log(`FAIL ${n} :: ${note}`));
};

const sym = new SymbolTable(romPath("pokeblue.sym"));
const O = offsetsFromSymbols(sym);
const base = sym.addr("wPartyMon1");

// ---------------------------------------------------------------- menu decode
{
  const mem = new Array(0x10000).fill(0);
  const at = (v: number) => { mem[MENU.watchedKeys] = v; return phaseOf(mem, ""); };
  ok("phase: $A1 is the enemy party list", at(0xA1) === "enemyList", at(0xA1));
  ok("phase: $91 is the player party list", at(0x91) === "playerList", at(0x91));
  ok("phase: $13 is the horizontal STATS|TRADE submenu", at(0x13) === "submenu", at(0x13));
  ok("phase: $23 is the cancel box", at(0x23) === "cancelbox", at(0x23));
  ok("phase: an unknown mask is 'other', never a guess", at(0x00) === "other", at(0x00));
  mem[MENU.watchedKeys] = 0x91;
  ok("phase: the stats page beats the menu bytes", phaseOf(mem, "  STATUS/OK  ") === "stats",
     phaseOf(mem, "STATUS/OK"));

  mem[MENU.maxItem] = 4; mem[MENU.currentItem] = 2;
  ok("cursor: on target presses A", cursorKeyFor(mem, 2) === KEYS.A, `${cursorKeyFor(mem, 2)}`);
  ok("cursor: off target presses DOWN (no UP in either watch mask)",
     cursorKeyFor(mem, 3) === KEYS.DOWN, `${cursorKeyFor(mem, 3)}`);
  // The last menu entry is CANCEL, which aborts the session; a want past it must
  // clamp short of it, not walk onto it.
  mem[MENU.currentItem] = 3;
  ok("cursor: a want past wMaxMenuItem clamps below CANCEL", cursorKeyFor(mem, 9) === KEYS.A,
     `cursor=${cursorOf(mem)} max=${maxItemOf(mem)}`);
  mem[MENU.currentItem] = 0;
  ok("cursor: clamped want still walks from 0", cursorKeyFor(mem, 9) === KEYS.DOWN, "");
}

// ------------------------------------------- hardcoded ADDR vs symbol offsets
// identity.ts carries absolute addresses and invariants.ts derives offsets from
// the symbol table. If a rename ever moves one and not the other, the expected
// section set silently points at the wrong byte — so cross-check them here.
{
  ok("ADDR.mon1Level agrees with the symbol-derived level offset",
     ADDR.mon1Level - base === O.level, `${ADDR.mon1Level - base} vs ${O.level}`);
  ok("ADDR.mon1OTID lies inside the party struct", ADDR.mon1OTID - base > 0 && ADDR.mon1OTID - base < O.stride,
     `${ADDR.mon1OTID - base} of ${O.stride}`);
  let threw = "";
  try { assertPatchInBlock(sym, O); } catch (e: any) { threw = String(e?.message ?? e); }
  ok("assertPatchInBlock accepts the real symbol table", threw === "", threw);
  threw = "";
  try { assertPatchInBlock(sym, { ...O, stride: 4 }); } catch (e: any) { threw = String(e?.message ?? e); }
  ok("assertPatchInBlock REJECTS a struct too small to hold the patch", threw !== "", threw.slice(0, 80));
}

// ------------------------------------------------- expected asymmetric sections
{
  const patch = ASYM_PATCHES.bob;
  const exp = new Set(expectedAsymSections(sym, patch));
  ok("expected: the trainer name may differ", exp.has("name+0") && exp.has(`name+${BLOCK.nameLen - 1}`), "");
  ok("expected: mon0's OT follows the trainer name", exp.has("ot0+0"), "");
  ok("expected: mon0's nickname may differ", exp.has("nick0+5"), "");
  ok("expected: mon0's level may differ", exp.has(`mon0+${O.level}`), `mon0+${O.level}`);
  ok("expected: mon0's OTID follows the player ID", exp.has(`mon0+${ADDR.mon1OTID - base}`), "");
  // The patch touches slot 0 only, so nothing about slot 1+, the count, or the
  // species list is allowed to move. These are the labels a lost byte produces.
  ok("expected: slot 1 is NOT allowed to differ", !exp.has("mon1+0") && !exp.has("nick1+0"), "");
  ok("expected: the count and species list are NOT allowed to differ",
     !exp.has("count") && !exp.has("species[0]"), "");
  ok("expected: mon0's species is NOT allowed to differ (a trade preserves it)",
     !exp.has(`mon0+${O.species}`), `mon0+${O.species}`);
  const empty = expectedAsymSections(sym, {});
  ok("expected: an empty patch allows NOTHING", empty.length === 0, `${empty.length}`);
}

// --------------------------------------------------------------- diffSections
{
  const mk = () => new Array(BLOCK.total).fill(0x50);
  const a = mk(), b = mk();
  ok("diffSections: identical blocks differ nowhere", diffSections(a, b, O).length === 0, "");

  // The patched pair: name, mon0 level, mon0 OTID, ot0, nick0.
  const nicks = BLOCK.nameLen + 1 + BLOCK.speciesListLen + BLOCK.maxSlots * O.stride + BLOCK.maxSlots * BLOCK.nameLen;
  const mons = BLOCK.nameLen + 1 + BLOCK.speciesListLen;
  b[3] = 0x81;                                 // name+3
  b[mons + O.level] = 25;                      // mon0+level
  b[nicks + 2] = 0x82;                         // nick0+2
  const expected = new Set(expectedAsymSections(sym, ASYM_PATCHES.bob));
  const moved = diffSections(a, b, O);
  ok("diffSections: labels every moved section", moved.length === 3, moved.join(","));
  ok("diffSections: a patched pair is CONFINED to the expected set",
     moved.every(s => expected.has(s)), moved.filter(s => !expected.has(s)).join(",") || "none outside");

  // RED: one extra byte in slot 2 — a lost byte's signature. The gate must fail.
  const c = b.slice();
  c[mons + 2 * O.stride + 1] = 0x99;
  const movedC = diffSections(a, c, O);
  const outside = movedC.filter(s => !expected.has(s));
  ok("diffSections RED: a byte moved in slot 2 lands OUTSIDE the expected set",
     outside.length === 1 && outside[0].startsWith("mon2+"), outside.join(",") || "nothing outside — GATE IS BLIND");

  // RED: an unpatched pair. Nothing differs, so the patch never crossed, and
  // "no differences" must NOT read as a healthy asymmetric trade.
  ok("diffSections RED: an unpatched pair produces an EMPTY set (patch never crossed)",
     diffSections(a, a.slice(), O).length === 0, "");

  // Uncapped, unlike diffBlocks().where: 20 differing sections must all appear.
  const d = mk();
  for (let s = 0; s < 5; s++) for (let f = 0; f < 4; f++) d[mons + s * O.stride + f] = 0x11 + f;
  const many = diffSections(a, d, O);
  const capped = diffBlocks(a, d, O).where ?? [];
  ok("diffSections: uncapped where diffBlocks stops at 12", many.length === 20 && capped.length === 12,
     `sections=${many.length} diffBlocks.where=${capped.length}`);
  ok("diffSections: count filters slots the block never claimed",
     diffSections(a, d, O, 1).every(s => !s.startsWith("mon1+")), diffSections(a, d, O, 1).join(","));
  ok("diffSections: a length mismatch is labelled, not ignored",
     diffSections(a, d.slice(0, 400), O).some(s => s.startsWith("length:")), "");
  ok("sectionOf: the first byte is the trainer name", sectionOf(0, O) === "name+0", sectionOf(0, O));
}

// --------------------------------------------------- the confirm driver itself
/**
 * A scripted side: it answers keypresses the way TradeCenter_SelectMon does, and
 * nothing else. The point is to exercise the driver's decisions (which key in
 * which phase, when it goes quiet) without an emulator — an 80-iteration bug here
 * costs a second, not a two-process session.
 */
class FakeSide {
  mem = new Array(0x10000).fill(0);
  phase: Phase = "other";
  swapped = false;
  closed = false;
  keys: Array<{ phase: Phase; key?: number }> = [];
  quiet = 0;
  chose: Record<string, number> = {};
  rightSeen = false;
  constructor(
    private readonly count = 4,
    private readonly converge: "swap" | "never" | "close" = "swap",
    private readonly quietNeeded = 3,
  ) { this.set("other"); }

  private set(p: Phase) {
    this.phase = p;
    const mask: Record<string, number> = { enemyList: 0xA1, playerList: 0x91, submenu: 0x13, cancelbox: 0x23, other: 0x00, stats: 0x00 };
    this.mem[MENU.watchedKeys] = mask[p];
    this.mem[MENU.maxItem] = p === "submenu" ? 0 : this.count;
    if (p === "enemyList" || p === "playerList") this.mem[MENU.currentItem] = 0;
  }
  grid() { return this.phase === "stats" ? "STATUS/OK" : ""; }

  async step(_n: number, key?: number) {
    this.keys.push({ phase: this.phase, key });
    if (key === undefined) {
      this.quiet++;
      if (this.phase === "submenu" && this.rightSeen && this.quiet >= this.quietNeeded) {
        if (this.converge === "swap") this.swapped = true;
        if (this.converge === "close") this.closed = true;
      }
      return;
    }
    this.quiet = 0;
    switch (this.phase) {
      case "other": if (key === KEYS.A) this.set("enemyList"); break;
      case "stats": if (key === KEYS.B) this.set("enemyList"); break;
      case "cancelbox": if (key === KEYS.B) this.set("playerList"); break;
      case "enemyList":
        if (key === KEYS.DOWN) this.mem[MENU.currentItem] = (this.mem[MENU.currentItem] + 1) % this.count;
        else if (key === KEYS.A) { this.chose.enemy = this.mem[MENU.currentItem]; this.set("playerList"); }
        break;
      case "playerList":
        if (key === KEYS.DOWN) this.mem[MENU.currentItem] = (this.mem[MENU.currentItem] + 1) % this.count;
        else if (key === KEYS.A) { this.chose.player = this.mem[MENU.currentItem]; this.set("submenu"); }
        break;
      case "submenu":
        if (key === KEYS.RIGHT) this.rightSeen = true;
        break;
    }
  }
  deps(offer: number, want: number) {
    return {
      mem: () => this.mem, grid: () => this.grid(),
      step: (n: number, k?: number) => this.step(n, k),
      swapped: () => this.swapped, closed: () => this.closed,
      fine: 1, offer, want, quietRounds: 6,
    };
  }
}

(async () => {
  {
    const f = new FakeSide(4, "swap");
    const out = await driveTradeConfirm(f.deps(2, 1));
    ok("driver: reaches the swap through its own menus", out.swapped, out.note);
    ok("driver: asked for the peer slot it was told to want", f.chose.enemy === 1, `enemy=${f.chose.enemy}`);
    ok("driver: offered the slot it was told to offer", f.chose.player === 2, `player=${f.chose.player}`);
    ok("driver: selected TRADE in the submenu exactly once", out.confirms === 1, `confirms=${out.confirms}`);
    ok("driver: went QUIET inside the sync (no key while converging)",
       f.keys.some(k => k.phase === "submenu" && k.key === undefined), "");
    ok("driver: reports which phase the swap landed from", out.swappedFrom === "submenu", `${out.swappedFrom}`);
  }
  {
    // RED: the peer never agrees. The driver must give up and SAY so.
    const f = new FakeSide(4, "never");
    const out = await driveTradeConfirm({ ...f.deps(0, 0), maxIterations: 6 });
    ok("driver RED: a peer that never converges yields swapped=false", !out.swapped, out.note);
    ok("driver RED: it retried the confirm rather than pressing once and hoping",
       out.confirms >= 1 && out.iterations === 6, `confirms=${out.confirms} iters=${out.iterations}`);
  }
  {
    // RED: the peer drops the link mid-confirm.
    const f = new FakeSide(4, "close");
    const out = await driveTradeConfirm(f.deps(0, 0));
    ok("driver RED: a closed link stops the driver and is named", !out.swapped && /closed/.test(out.note), out.note);
  }
  {
    // A side that starts on the stats page must back out, not press A into it.
    const f = new FakeSide(4, "swap");
    (f as any).set("stats");
    const out = await driveTradeConfirm(f.deps(0, 0));
    ok("driver: backs out of the stats page with B", f.keys[0]?.key === KEYS.B, `first key=${f.keys[0]?.key}`);
    ok("driver: still completes after the detour", out.swapped, out.note);
  }
  {
    // A cancel box must be dismissed with B: pressing A there ends the session.
    const f = new FakeSide(4, "swap");
    (f as any).set("cancelbox");
    await driveTradeConfirm(f.deps(0, 0));
    ok("driver: dismisses the cancel box with B, never A", f.keys[0]?.key === KEYS.B, `first key=${f.keys[0]?.key}`);
  }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
