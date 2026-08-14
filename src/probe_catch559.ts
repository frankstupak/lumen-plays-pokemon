// wq#559 — the catch path, executed END TO END for the first time ever.
//
// Every surviving event log shows catch events = ZERO and buy_item = ZERO
// across the whole campaign: balls have never existed, so catch_policy has
// never spoken and Items.useInBattle's ball branch has never run. The ticket's
// deliverable 3: "verify end-to-end that with balls in the bag, catchAdvice
// renders, the brain can act on it, and a successful catch is detected (party
// growth) and counted. Do not assume it works because it compiles."
//
// METHOD (probe owns its environment, the wq#559/579 RAM-write technique):
//  B. Assert the MUTE half first: catchAdvice with balls=0 is null.
//  C. Inject POKE_BALL x5 into wBagItems (append stack, bump count, keep the
//     0xff terminator) and re-read through Items — the production reader.
//  D. Walk between two safe tiles until a REAL wild encounter fires (no Repel
//     here, obviously). Bounded; a miss is a SKIP, not a hang.
//  E. Once the battle menu is up, write wEnemyMonHP=1 (BE16) — max catch odds,
//     and a foe at 1 HP cannot be a whiteout risk for an L28 lead.
//  F. catchAdvice NOW renders (solo-insurance arm: party of one + >=2 balls).
//  G. items.useInBattle(POKE_BALL) — the REAL tool path the brain would take:
//     battle menu -> ITEM -> cf91-verified select -> drive the catch text.
//     Up to 5 throws; ball count must strictly decrease each throw.
//  H. Caught: wPartyCount 1 -> 2, and the "catch" tool_call event with
//     caught:true lands on the bus — the same event metrics.ts:103 counts.
//
// RED/GREEN NOTE: this probe VERIFIES existing machinery rather than gating a
// diff — there is no code change to be red against. Its value is executing a
// path that has never once run in production, before the campaign depends on
// it at Cerulean.
//
// ISOLATION: EventBus into mkdtemp (never events/ — wq#551 fence), loads
// checkpoints, saves nothing, touches no live service.
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
import { Items, ITEM, ITEM_NAME } from "./items";
import { catchAdvice } from "./catch_policy";
import { readdirSync, existsSync, readFileSync } from "fs";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(ROM);
const CK = `${BASE}/checkpoints`;
const CAVE_MAPS = new Set([59, 60, 61]);

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

interface Rig {
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader; items: Items;
  bat: Battle; bus: EventBus; events: any[];
  pos: () => { map: number; x: number; y: number };
  r: (s: string) => number;
}

function rig(statePath: string): Rig | null {
  const emu = new Emulator(ROM);
  try { loadSnapshotFile(emu, statePath); } catch { return null; }
  const map = new MapModel(emu, sym, rom); map.build();
  const dir = mkdtempSync(join(tmpdir(), "lpp559-"));
  const bus = new EventBus(dir, "probe559");
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
  return { emu, map, nav, rd, items, bat, bus, events, pos, r };
}

/** Cave fixture NOT standing on a warp (that shape belongs to probe_warp579),
 *  out of battle, party of exactly one — the campaign's real situation. */
function findFixture(): { path: string; r: Rig } | null {
  const names = readdirSync(CK).filter(f => f.endsWith(".state.gz")).sort();
  for (const f of names) {
    const side = `${CK}/${f.replace(/\.state\.gz$/, ".json")}`;
    if (existsSync(side)) {
      try { if (!CAVE_MAPS.has(JSON.parse(readFileSync(side, "utf8")).map)) continue; } catch {}
    }
    const r = rig(`${CK}/${f}`);
    if (!r) continue;
    const p = r.pos();
    if (!CAVE_MAPS.has(p.map)) continue;
    if (r.map.warps.some((w: Warp) => w.x === p.x && w.y === p.y)) continue;
    const st = r.rd.read();
    if (st.inBattle !== 0 || st.partyCount !== 1) continue;
    return { path: f, r };
  }
  return null;
}

/** Append a POKE_BALL stack to the bag in RAM, preserving the layout the
 *  production reader (Items.has / bagIndex) and the game itself expect. */
function injectBalls(r: Rig, qty: number) {
  const m = r.emu.mem();
  const n = m[sym.addr("wNumBagItems")];
  const a = sym.addr("wBagItems");
  m[a + n * 2] = ITEM.POKE_BALL;
  m[a + n * 2 + 1] = qty;
  m[a + (n + 1) * 2] = 0xff;                 // list terminator
  m[sym.addr("wNumBagItems")] = n + 1;
}

(async () => {
  console.log("== probe_catch559: balls -> advice -> throw -> party growth ==");

  const fx = findFixture();
  if (!fx) {
    chk("A1 cave fixture (off-warp, party of 1, out of battle) resolves", false, "none on disk");
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(1);
  }
  const { path, r } = fx;
  const p0 = r.pos();
  chk("A1 cave fixture (off-warp, party of 1, out of battle) resolves", true,
      `${path}: map${p0.map} (${p0.x},${p0.y})`);

  // ── B. the mute half ───────────────────────────────────────────────────
  chk("B1 catchAdvice is null with zero balls (the campaign's whole history)",
      catchAdvice(41, 10, 20, 1, 0, 1.0) === null);
  chk("B2 fixture bag really has zero balls (production reader)",
      r.items.has(ITEM.POKE_BALL) === 0);

  // ── C. inject ──────────────────────────────────────────────────────────
  injectBalls(r, 5);
  chk("C1 Items.has sees the injected stack", r.items.has(ITEM.POKE_BALL) === 5,
      `has=${r.items.has(ITEM.POKE_BALL)}`);

  // ── D. a real encounter ────────────────────────────────────────────────
  // Pace strictly between the fixture tile and ONE vetted neighbour (passable,
  // not a warp) until a wild fires. Position-checked every iteration so drift
  // from a blocked step can never wander us onto an unvetted warp tile.
  const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const safe = dirs.find(([dx, dy]) => {
    const nx = p0.x + dx, ny = p0.y + dy;
    return r.map.passable(nx, ny) &&
      !r.map.warps.some((w: Warp) => w.x === nx && w.y === ny);
  });
  if (!safe) {
    skipped("D1 wild encounter triggered", "no safe pacing neighbour at fixture");
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(fail ? 1 : 0);
  }
  const nb = { x: p0.x + safe[0], y: p0.y + safe[1] };
  let inBattle = false, lost = false;
  for (let i = 0; i < 80 && !inBattle && !lost; i++) {
    const here = r.pos();
    if (here.map === p0.map && here.x === p0.x && here.y === p0.y)
      await r.nav.step(safe[0], safe[1]);
    else if (here.map === p0.map && here.x === nb.x && here.y === nb.y)
      await r.nav.step(-safe[0], -safe[1]);
    else { lost = true; break; }               // drifted off the pacing pair
    inBattle = r.rd.read().inBattle === 1;
  }
  if (lost) {
    skipped("D1 wild encounter triggered", `pacing left the vetted pair at ${JSON.stringify(r.pos())}`);
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(fail ? 1 : 0);
  }
  if (!inBattle) {
    skipped("D1 wild encounter triggered", "no encounter in 80 cave steps (rare RNG) - rerun");
    console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(fail ? 1 : 0);
  }
  chk("D1 wild encounter triggered (inBattle=1)", true);

  // ── E. menu up, then pin foe HP to 1 ───────────────────────────────────
  const w = await r.bat.waitForMenu?.();
  chk("E1 battle reaches the menu", w === "menu", `waitForMenu -> ${w}`);
  const foe = r.r("wEnemyMonSpecies");
  const hpA = sym.addr("wEnemyMonHP");
  r.emu.mem()[hpA] = 0; r.emu.mem()[hpA + 1] = 1;
  chk("E2 foe HP pinned to 1 (BE16 readback)",
      r.emu.mem()[hpA] === 0 && r.emu.mem()[hpA + 1] === 1,
      `foe species=${foe}`);

  // ── F. the advice un-mutes ─────────────────────────────────────────────
  const maxHp = Math.max(1, r.r("wEnemyMonMaxHP") * 256 + r.emu.mem()[sym.addr("wEnemyMonMaxHP") + 1]);
  const adv = catchAdvice(foe, 1, maxHp, 1, r.items.has(ITEM.POKE_BALL), 1.0);
  chk("F1 catchAdvice renders with balls in the bag", adv !== null, String(adv).slice(0, 90));

  // ── G/H. throw through the real tool path ──────────────────────────────
  const party0 = r.r("wPartyCount");
  let caught = false, throws = 0;
  let ballsLeft = r.items.has(ITEM.POKE_BALL);
  for (let t = 0; t < 5 && !caught; t++) {
    if (r.rd.read().inBattle === 0) break;
    const res = await r.items.useInBattle(ITEM.POKE_BALL);
    throws++;
    const now = r.items.has(ITEM.POKE_BALL);
    chk(`G${throws} throw ${throws} consumed a ball`, now === ballsLeft - 1,
        `${ballsLeft} -> ${now} :: ${res.slice(0, 70)}`);
    ballsLeft = now;
    caught = r.r("wPartyCount") > party0;
  }
  chk("H1 caught: party grew 1 -> 2", caught && r.r("wPartyCount") === 2,
      `partyCount=${r.r("wPartyCount")} after ${throws} throw(s)`);
  const ev = r.events.find(e => e.kind === "tool_call" && e.tool === "catch" && e.args?.caught);
  chk("H2 the catch event metrics counts was emitted (caught:true)", !!ev,
      ev ? `ball=${ev.args.ball}` : "no catch event on the bus");
  if (caught) {
    const st = r.rd.read();
    console.log(`   caught: species=${st.party[1]?.species} L${st.party[1]?.level} ` +
                `(${ITEM_NAME[ITEM.POKE_BALL]} x${ballsLeft} left)`);
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
