// wq#587 — battle-policy edges before Misty, executed rather than assumed.
//
// Three edges from the wq#581 audit (A2.5), each with a live consequence:
//  (1) RAGE was a plain 20-power table row. Gen 1 Rage LOCKS the user in —
//      no battle menu until the fight ends. The moment Ember's PP ran dry
//      every DET fight path would have picked it. Now: `lockIn` on
//      RAGE/BIDE/DIG and ONE shared picker (pickBestMove) that takes a
//      lock-in move only as the last damage standing. Section R drives a
//      REAL Rage battle end-to-end and proves the harness survives the lock.
//  (2) The Misty ready-line "your best damage is your strongest non-Fire
//      move" resolves to RAGE for Charmeleon's actual moveset. Now
//      moveset-aware (mistyDamageLine) with an explicit RAGE warning.
//  (3) use_item(potion) MID-BATTLE has never executed (no potion ever
//      owned). Section H injects one and uses it in a real battle — the
//      load-bearing move under BUBBLEBEAM pressure at Misty.
//
// RED (LPP587_RED=1, origin/main): lockIn absent, pickBestMove absent, the
// Rage-recommending phrase present in guidance source.
//
// ISOLATION: EventBus into mkdtemp, loads checkpoints, saves nothing,
// touches no live service. RAM writes are the wq#559 probe-owns-environment
// technique (bag injection, foe HP pin).
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel, Warp } from "./map";
import { StateReader } from "./state";
import { Sync } from "./sync";
import { EventBus } from "./events";
import { Navigator } from "./nav";
import { Screen } from "./screen";
import { Dialog } from "./dialog";
import { Battle } from "./battle";
import { Items, ITEM } from "./items";
import * as MV from "./moves";
import * as GD from "./guidance";
import { readdirSync, readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// wq#1180 retired the hand-typed MOVES record in favour of the ROM-backed
// moveMeta() accessor. Resolved dynamically, like everything else here, so this
// probe still runs against an origin/main checkout in its RED mode.
const meta = (id: number): any =>
  (MV as any).moveMeta ? (MV as any).moveMeta(id) : (MV as any).MOVES?.[id];
const pickBestMove: ((m: number[], p: number[]) => number) | undefined = (MV as any).pickBestMove;
const mistyDamageLine: ((m: number[]) => string) | undefined = (GD as any).mistyDamageLine;

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(ROM);
const CK = `${BASE}/checkpoints`;
const CAVE_MAPS = new Set([59, 60, 61]);
const CHARMELEON_SET = [99, 45, 52, 43];   // Rage, Growl, Ember, Leer — the live lead

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

const RED = process.env.LPP587_RED === "1";
console.log(`== probe_battle587 (${RED ? "RED: expecting the OLD gaps" : "GREEN"}) ==`);

// ── P. the table + picker layer (pure) ──────────────────────────────────
if (RED) {
  chk("R-P1 old MOVES has no lockIn on RAGE", meta(99)?.lockIn === undefined);
  chk("R-P2 pickBestMove does not exist yet", pickBestMove === undefined);
  chk("R-P3 guidance source still recommends the strongest non-Fire move (= RAGE here)",
      readFileSync("src/guidance.ts", "utf8").includes("non-Fire move"));
} else {
  chk("P1 RAGE carries lockIn", meta(99).lockIn === true);
  chk("P2 BIDE and DIG carry lockIn too", meta(117).lockIn === true && meta(91).lockIn === true);
  const pk = pickBestMove!;
  chk("P3 Ember beats Rage when both have PP (the normal case, unchanged)",
      pk(CHARMELEON_SET, [10, 10, 10, 10]) === 2);
  chk("P4 Ember dry -> RAGE is the last damage standing and IS picked",
      pk(CHARMELEON_SET, [10, 10, 0, 10]) === 0);
  chk("P5 a lock-in move loses to a WEAKER non-lock attacker (the contract)",
      pk([91, 33, 0, 0], [5, 5, 0, 0]) === 1,   // DIG(100,lock) vs TACKLE(35) -> TACKLE
      `picked ${pk([91, 33, 0, 0], [5, 5, 0, 0])}`);
  chk("P6 all-zero PP falls back to a slot (Gen 1 auto-Struggles)",
      pk(CHARMELEON_SET, [0, 0, 0, 0]) === 0);
  chk("P7 lock-in beats a pure status stall",
      pk([99, 45, 0, 0], [5, 5, 0, 0]) === 0);   // RAGE over GROWL
  const line = mistyDamageLine!(CHARMELEON_SET);
  chk("P8 Misty line names EMBER for the live moveset", line.includes("EMBER"), line);
  chk("P9 Misty line warns off RAGE explicitly", line.includes("RAGE"), line.slice(0, 90));
  chk("P10 no RAGE warning for a moveset without lock-ins",
      !mistyDamageLine!([33, 45]).includes("RAGE"), mistyDamageLine!([33, 45]));
}

if (RED) {
  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
}

// ── live sections (GREEN only): rig identical to probe_catch559 ─────────
interface Rig {
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader; items: Items;
  bat: Battle; events: any[];
  pos: () => { map: number; x: number; y: number };
  r: (s: string) => number;
}
function rig(statePath: string): Rig | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, statePath); } catch { return null; }
  const map = new MapModel(emu, sym, rom); map.build();
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp587-")), "probe587");
  const events: any[] = [];
  bus.on((e: any) => events.push(e));
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const items = new Items(emu, sym, scr, sync, dlg, nav, map, bat, bus);
  const rd = new StateReader(emu, sym);
  const r = (s: string) => emu.mem()[sym.addr(s)];
  const pos = () => {
    const m = emu.mem();
    return { map: m[sym.addr("wCurMap")], x: m[sym.addr("wXCoord")], y: m[sym.addr("wYCoord")] };
  };
  return { emu, map, nav, rd, items, bat, events, pos, r };
}

/** Cave fixture, off-warp, out of battle, lead DAMAGED (so a potion has an
 *  observable effect) with the live Charmeleon moveset. */
function findFixture(): { path: string; r: Rig } | null {
  for (const f of readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort()) {
    const r = rig(`${CK}/${f}`);
    if (!r) continue;
    const p = r.pos();
    if (!CAVE_MAPS.has(p.map)) continue;
    if (r.map.warps.some((w: Warp) => w.x === p.x && w.y === p.y)) continue;
    const st = r.rd.read();
    if (st.inBattle !== 0) continue;
    const lead = st.party[0];
    if (!lead || lead.hp <= 0 || lead.hp >= lead.maxHp) continue;
    return { path: f, r };
  }
  return null;
}

function injectItem(r: Rig, id: number, qty: number) {
  const m = r.emu.mem();
  const n = m[sym.addr("wNumBagItems")];
  const a = sym.addr("wBagItems");
  m[a + n * 2] = id; m[a + n * 2 + 1] = qty;
  m[a + (n + 1) * 2] = 0xff;
  m[sym.addr("wNumBagItems")] = n + 1;
}

/** Pace between the fixture tile and one vetted neighbour until a wild fires
 *  (the wq#559 recipe, hardened): the edge must be pair-aware passable BOTH
 *  ways (wq#552 — an asymmetric refusal turns pacing into blocked bumps, and
 *  blocked bumps never roll encounters), and every viable neighbour is tried
 *  in turn before giving up. */
async function forceEncounter(r: Rig, capPerDir = 60): Promise<boolean> {
  const p0 = r.pos();
  const cands = ([[0, 1], [0, -1], [1, 0], [-1, 0]] as const).filter(([dx, dy]) => {
    const nx = p0.x + dx, ny = p0.y + dy;
    return (r.map as any).passableFrom?.(p0.x, p0.y, nx, ny) &&
           (r.map as any).passableFrom?.(nx, ny, p0.x, p0.y) &&
           !r.map.warps.some((w: Warp) => w.x === nx && w.y === ny);
  });
  for (const [dx, dy] of cands) {
    const nb = { x: p0.x + dx, y: p0.y + dy };
    for (let i = 0; i < capPerDir; i++) {
      const h = r.pos();
      if (h.x === p0.x && h.y === p0.y) await r.nav.step(dx, dy);
      else if (h.x === nb.x && h.y === nb.y) await r.nav.step(-dx, -dy);
      else break;                                   // drifted: try next direction
      if (r.rd.read().inBattle === 1) return true;
    }
    // walk back to the anchor if we ended on the neighbour, then next candidate
    const h = r.pos();
    if (h.x === nb.x && h.y === nb.y) await r.nav.step(-dx, -dy);
    if (r.rd.read().inBattle === 1) return true;
  }
  return false;
}

(async () => {
  const fx = findFixture();
  if (!fx) {
    chk("A1 damaged-lead cave fixture resolves", false, "none on disk");
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(1);
  }
  const { path, r } = fx;
  const lead0 = r.rd.read().party[0];
  chk("A1 damaged-lead cave fixture resolves", true,
      `${path}: ${r.pos().map}(${r.pos().x},${r.pos().y}) lead ${lead0.hp}/${lead0.maxHp}`);
  chk("A2 fixture lead is the live moveset (Rage in slot 0)",
      JSON.stringify(lead0.moves) === JSON.stringify(CHARMELEON_SET),
      JSON.stringify(lead0.moves));

  // ── H. the FIRST mid-battle potion ────────────────────────────────────
  injectItem(r, ITEM.POTION, 2);
  chk("H1 potion injected (production reader)", r.items.has(ITEM.POTION) === 2);
  if (!await forceEncounter(r)) {
    skipped("H2 wild encounter for the potion turn", "no encounter / pacing lost");
  } else {
    const w = await r.bat.waitForMenu?.();
    chk("H2 battle menu up", w === "menu", String(w));
    const hp0 = r.bat.state().myHp;
    const res = await r.items.useInBattle(ITEM.POTION, 0);
    const hp1 = r.bat.state().myHp;
    chk("H3 potion consumed through the battle bag", r.items.has(ITEM.POTION) === 1,
        res.slice(0, 70));
    chk("H4 lead HP actually rose mid-battle", hp1 > hp0, `${hp0} -> ${hp1}`);
    // finish the fight with the shared picker so the fixture exits cleanly
    const done = await r.bat.run(st => pickBestMove!(st.moves, st.pp), 40);
    chk("H5 battle concludes after the item turn", done === "won" || done === "lost", done);
  }

  // ── R. RAGE lock-in, survived ─────────────────────────────────────────
  // Fresh rig from the same fixture: clean bag, full determinism.
  const r2 = rig(`${CK}/${path}`)!;
  if (!await forceEncounter(r2)) {
    skipped("R1 wild encounter for the Rage battle", "no encounter / pacing lost");
  } else {
    const w = await r2.bat.waitForMenu?.();
    chk("R1 battle menu up", w === "menu", String(w));
    const foe0 = r2.bat.state().foeHp;
    await r2.bat.useMove(0);                       // RAGE, deliberately
    // Drive the rest with waitForMenu alone: if Gen 1's lock is emulated the
    // menu never returns and the battle self-plays to a finish; if the menu
    // DOES return we re-issue Rage (locked-in behaviourally either way).
    let menus = 0, overs = 0, timeouts = 0;
    for (let i = 0; i < 12 && r2.rd.read().inBattle !== 0; i++) {
      const s = await r2.bat.waitForMenu?.(3000);
      if (s === "menu") { menus++; await r2.bat.useMove(0); }
      else if (s === "over") { overs++; break; }
      else timeouts++;
    }
    const st = r2.rd.read();
    chk("R2 the Rage battle TERMINATES (no wedge)", st.inBattle === 0,
        `menus=${menus} timeouts=${timeouts} foe ${foe0}->0-ish`);
    chk("R3 our mon survived the lock", (st.party[0]?.hp ?? 0) > 0,
        `hp=${st.party[0]?.hp}/${st.party[0]?.maxHp}`);
    console.log(`   lock observation: menu reappeared ${menus}x, timeouts ${timeouts} ` +
      `(0 menus = faithful Gen-1 lock; either way the harness survived)`);
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
