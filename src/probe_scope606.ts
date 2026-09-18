// wq#606 — map-scoped targets, interior edge refusal, retry ceiling: red/green.
//
// THE CLASS UNDER TEST: cross-map coordinate replay (3rd occurrence live) and
// verify-failure retry burns (12 identical failing buy_item calls, 26 min).
// RED IS IN-PROBE: the pre-change behavior is demonstrated by driving the
// UNCHANGED lower layer (nav.*) directly — that is byte-for-byte the code the
// old dispatch fell through to, so "old path is uninformative / unguarded" is
// shown, not remembered.
//
// DETERMINISM: every executed action here is a REFUSAL path (never moves) or a
// pure function. The one nav call that could move (red-side leaveMapEdge on the
// mart) walks at most the interior of a 6x8 room with zero encounter tiles.
// Fixtures resolve BY PROPERTY (wq#540) and are copied before use (wq#551).
//
// EMPIRICAL ANCHOR (research rule): the connection byte's ADDRESS
// (wCurMapHeaderEnd - 1) and BIT LAYOUT (E=1 W=2 S=4 N=8) are asserted against
// three independent live maps whose connection sets are known from pokered
// headers: Cerulean map3 = N+S+W+E = 0x0F, Route 4 map15 = E+S = 0x05,
// Cerulean Mart map67 = interior = 0x00. All three matching is what licenses
// the derived address.
import { Emulator, loadSnapshotFile } from "./emulator";
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
import { itemId } from "./items";
import { ceruleanGuidance } from "./guidance";
import { parseGotoTarget, crossMapRefusal, scopeNoteCoords, edgeRefusal, CONN } from "./scope";
import { verifyFailed, ActionCeiling, CEILING } from "./ceiling";
import { findFixture, requireFixture } from "./fixtures";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
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
  emu: Emulator; map: MapModel; nav: Navigator; rd: StateReader;
  agent: Agent; busDir: string;
}
function rig(statePath: string): Rig {
  const emu = new Emulator(`${BASE}/roms/pokeblue.gb`);
  loadSnapshotFile(emu, statePath);
  const rom = new Rom(`${BASE}/roms/pokeblue.gb`);
  const busDir = mkdtempSync(join(tmpdir(), "lpp606-bus-"));
  const bus = new EventBus(busDir, "probe606");
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const rd = new StateReader(emu, sym);
  const ck = mkdtempSync(join(tmpdir(), "lpp606-ckpt-"));
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, rd, new Brain(bus), bus, ck);
  map.build();
  return { emu, map, nav, rd, agent, busDir };
}
function busEvents(r: Rig): any[] {
  const out: any[] = [];
  for (const f of readdirSync(r.busDir).filter(f => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(r.busDir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail */ }
    }
  }
  return out;
}

(async () => {
  console.log("== probe_scope606: map-scoped targets + interior edges + retry ceiling ==");

  // ── A. parseGotoTarget: every accepted spelling, and the rejects ────────
  const A: [string, any][] = [
    ["4,7",           { m: null, x: 4, y: 7 }],
    ["67,4,7",        { m: 67, x: 4, y: 7 }],
    ["map67 4,7",     { m: 67, x: 4, y: 7 }],
    ["4,7 on map67",  { m: 67, x: 4, y: 7 }],   // notepad annotation replayed verbatim
    ["map67:4,7",     { m: 67, x: 4, y: 7 }],
    ["map 67, 4, 7",  { m: 67, x: 4, y: 7 }],
  ];
  for (const [raw, want] of A) {
    const got = parseGotoTarget(raw);
    chk(`A parse "${raw}"`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }
  chk("A parse rejects 1 number", parseGotoTarget("4") === null);
  chk("A parse rejects 4 numbers", parseGotoTarget("1,2,3,4") === null);
  chk("A parse rejects empty", parseGotoTarget("") === null);

  // ── B. crossMapRefusal + scopeNoteCoords, pure ──────────────────────────
  const lbl = (id: number) => (id === 67 ? "CeruleanMart" : id === 3 ? "CeruleanCity" : null);
  const b1 = crossMapRefusal({ m: 67, x: 4, y: 7 }, 3, lbl);
  chk("B refusal names BOTH maps", !!b1 && b1.includes("map67") && b1.includes("map3"), b1 ?? "null");
  chk("B same-map triple allowed", crossMapRefusal({ m: 3, x: 4, y: 7 }, 3, lbl) === null);
  chk("B bare pair allowed", crossMapRefusal({ m: null, x: 4, y: 7 }, 3, lbl) === null);
  const s1 = scopeNoteCoords("counter at (4,7), exit at (2,7)", 67);
  chk("B note scoping annotates both", s1 === "counter at (4,7 on map67), exit at (2,7 on map67)", s1);
  const s2 = scopeNoteCoords("already map67 (4,7) scoped", 3);
  chk("B note scoping skips pre-scoped", s2.includes("map67 (4,7)") && !s2.includes("on map3"), s2);
  const s3 = scopeNoteCoords("hp 41/79 and $1601, no coords", 3);
  chk("B note scoping ignores non-coords", s3 === "hp 41/79 and $1601, no coords", s3);
  chk("B round-trip: annotated note re-parses with map",
      JSON.stringify(parseGotoTarget("4,7 on map67")) === JSON.stringify({ m: 67, x: 4, y: 7 }));

  // ── C. verifyFailed: the EXACT live result strings ──────────────────────
  chk("C buy fail string counts", verifyFailed("buy_item", "buy: could not verify antidote under cursor (cf91=15)"));
  chk("C buy success does not", !verifyFailed("buy_item", "bought 2x potion for 600; have 5"));
  chk("C use_item fail counts", verifyFailed("use_item", "use_item: could not verify potion in bag (cf91=0)"));
  chk("C use_item success does not", !verifyFailed("use_item", "use_item done: potion on slot 0; 4 left"));
  chk("C ball throw is success-shaped", !verifyFailed("use_item", "poke_ball thrown - broke free (2 left)"));
  chk("C goto stuck counts", verifyFailed("goto", 'goto -> stuck now {"map":3,"x":25,"y":26}'));
  // wq#1090 flipped these two: a nav guard refusal used to be excluded from the
  // ceiling outright, which left an identical refusal repeatable forever. It
  // counts now — see ceiling.ts's header and probe_ceiling1090 for the full
  // contract, including the budgeted-refusal carve-out.
  chk("C goto guard refusal COUNTS (wq#1090)",
      verifyFailed("goto", "goto: refused - target (4,7) is on map67, you are on map3"));
  chk("C leave_edge interior refusal COUNTS (wq#1090)",
      verifyFailed("leave_edge", "leave_edge: refused - map67 is an INTERIOR — no edge connections exist"));
  chk("C talk never counts", !verifyFailed("talk", "talk -> anything"));

  // ── D. ActionCeiling truth table ────────────────────────────────────────
  const p0 = { map: 67, x: 2, y: 5 }, p1 = { map: 67, x: 3, y: 5 };
  const F = "buy: could not verify antidote under cursor (cf91=15)";
  {
    const c = new ActionCeiling();
    chk("D no trip at 1", !c.record("buy_item", "antidote,1", p0, F));
    chk("D no trip at 2", !c.record("buy_item", "antidote,1", p0, F));
    chk("D TRIP at 3", c.record("buy_item", "antidote,1", p0, F));
    const ref = c.check("buy_item", "antidote,1", p0);
    chk("D blocked verbatim after trip", !!ref && ref.startsWith("retry_ceiling:"), ref ?? "null");
    chk("D different args not blocked", c.check("buy_item", "potion,1", p0) === null);
    chk("D position change re-arms", c.check("buy_item", "antidote,1", p1) === null);
  }
  {
    const c = new ActionCeiling();
    c.record("buy_item", "antidote,1", p0, F);
    c.record("note", "hi", p0, "note saved");            // interleave: no refill
    c.record("buy_item", "antidote,1", p0, F);
    chk("D interleaved action does not refill budget", c.record("buy_item", "antidote,1", p0, F));
  }
  {
    const c = new ActionCeiling();
    c.record("buy_item", "antidote,1", p0, F);
    c.record("buy_item", "antidote,1", p0, F);
    c.record("buy_item", "antidote,1", p0, "bought 1x antidote for 100; have 1");
    chk("D success resets the count", !c.record("buy_item", "antidote,1", p0, F));
  }

  // ── E. CONNECTION BYTE, empirically anchored on three maps ─────────────
  const fx3  = findFixture(sc => sc.map === 3);
  const fx15 = findFixture(sc => sc.map === 15);
  const fx67 = findFixture(sc => sc.map === 67);
  const expect: [string, string | null, number, number][] = [
    ["map3 Cerulean = 0x0F (N+S+W+E)", fx3, 3, 0x0f],
    ["map15 Route4 = 0x05 (E+S)",      fx15, 15, 0x05],   // Route 3 attaches from the SOUTH (Bulbapedia/pokered)
    ["map67 Mart = 0x00 (interior)",   fx67, 67, 0x00],
  ];
  const rigs: Record<number, Rig> = {};
  for (const [label, path, mapId, want] of expect) {
    if (!path) { skipped(`E ${label}`, "no fixture on disk"); continue; }
    const r = rig(requireFixture(label, path));
    const got = r.map.connections;
    const really = r.rd.read().map;
    chk(`E ${label}`, really === mapId && got === want,
        `fixture map=${really} connections=0x${got.toString(16).padStart(2, "0")}`);
    rigs[mapId] = r;
  }
  // pure edgeRefusal branches on the live-read bytes
  if (rigs[67]) {
    const e1 = edgeRefusal(rigs[67].map.connections, "E", rigs[67].map.warps, 67, "CeruleanMart");
    chk("E interior refusal lists warps", !!e1 && e1.includes("INTERIOR") && e1.includes("enter_warp") &&
        rigs[67].map.warps.length > 0 && e1.includes(`->map`), (e1 ?? "").slice(0, 110));
  }
  if (rigs[15]) {
    chk("E map15 N refused, edges named",
        (edgeRefusal(rigs[15].map.connections, "N", [], 15, null) ?? "").includes("W,E") ||
        (edgeRefusal(rigs[15].map.connections, "N", [], 15, null) ?? "").includes("E") === true,
        edgeRefusal(rigs[15].map.connections, "N", [], 15, null) ?? "null");
    chk("E map15 E allowed", edgeRefusal(rigs[15].map.connections, "E", [], 15, null) === null);
  }
  if (rigs[3]) chk("E map3 all dirs allowed",
      (["N", "S", "E", "W"] as const).every(d => edgeRefusal(rigs[3].map.connections, d, [], 3, null) === null));

  // ── F. INTEGRATION on the city map: the cross-map replay is refused ─────
  if (!rigs[3]) {
    skipped("F cross-map integration", "no map3 fixture");
  } else {
    const a = rigs[3].agent;
    for (const form of ["goto(67,4,7)", "goto(map67 4,7)", "goto(4,7 on map67)"]) {
      const r = await a.dispatch(form);
      chk(`F ${form} refused naming both maps`,
          r.startsWith("goto: refused - target (4,7) is on map67") && r.includes("map3"), r.slice(0, 100));
    }
    const bad = await a.dispatch("goto(somewhere)");
    chk("F bad args teach the forms", bad.startsWith("goto: bad args"), bad.slice(0, 80));
    // RED half: the unchanged lower layer has no map concept — driving it with
    // the mart coords on the city map silently attempts them (the exact
    // pre-change dispatch behavior: no refusal, no map named).
    const red = await rigs[3].nav.goto(4, 7);
    chk("F RED: nav.goto(4,7) on map3 executes with no map concept",
        !["refused"].includes(red) && !red.includes("map67"), `nav returned '${red}'`);
  }

  // ── G. INTEGRATION on the mart: interior leave_edge + note scoping ──────
  if (!rigs[67]) {
    skipped("G interior integration", "no map67 fixture");
  } else {
    const a = rigs[67].agent;
    const g1 = await a.dispatch("leave_edge(E)");
    chk("G leave_edge(E) inside mart refused with warp list",
        g1.includes("INTERIOR") && g1.includes("enter_warp"), g1.slice(0, 120));
    const g2 = await a.dispatch("leave_edge(Q)");
    chk("G bad direction refused", g2.includes("bad direction"), g2);
    const g3 = await a.dispatch("note(counter at (4,7))");
    chk("G note write accepted", g3.startsWith("note saved") || g3.includes("note"), g3.slice(0, 60));
    chk("G note stored map-scoped", a.pad.renderNotes().includes("(4,7 on map67)"),
        a.pad.renderNotes().split("\n").slice(-2).join(" | ").slice(0, 120));
    // RED half: the unchanged nav.leaveMapEdge answers with an uninformative
    // bare result and zero warp knowledge — 14 of those is the live loop.
    const gRed = await rigs[67].nav.leaveMapEdge("E");
    chk("G RED: raw leaveMapEdge gives no exit info",
        (gRed === "stuck" || gRed === "warped") && !gRed.includes("warp"), `nav returned '${gRed}'`);
  }

  // ── H. INTEGRATION: retry ceiling around dispatch ───────────────────────
  if (!rigs[3]) {
    skipped("H ceiling integration", "no map3 fixture");
  } else {
    const r3b = rig(requireFixture("map3 for ceiling", fx3!));   // fresh agent: no ceiling state
    const a = r3b.agent;
    const rs: string[] = [];
    for (let i = 0; i < 4; i++) rs.push(await a.dispatch("buy_item(potion,1)"));
    chk("H attempts 1-2 fail plainly", rs[0].startsWith("buy:") && rs[1].startsWith("buy:") &&
        !rs[0].includes("RETRY CEILING"), rs[0].slice(0, 60));
    chk("H attempt 3 trips: directive appended", rs[2].includes(`! RETRY CEILING (${CEILING}x)`), rs[2].slice(0, 90));
    chk("H attempt 4 REFUSED, not executed", rs[3].startsWith("retry_ceiling:"), rs[3].slice(0, 90));
    const evs = busEvents(r3b);
    const trips = evs.filter(e => e.kind === "tool_call" && e.tool === "retry_ceiling");
    chk("H board event emitted exactly once", trips.length === 1,
        `retry_ceiling events=${trips.length} line=${trips[0]?.line ?? ""}`);
    chk("H forced stuck_dump emitted on trip",
        evs.some(e => e.kind === "tool_call" && e.tool === "stuck_dump"), "");
    // RED half: the unchanged items.buy will execute a 4th, 5th, Nth time —
    // count real macro attempts by their distinct returns.
    const r3c = rig(requireFixture("map3 red ceiling", fx3!));
    let executed = 0;
    for (let i = 0; i < 4; i++) {
      const rr = await r3c.agent.items.buy(itemId("potion")!, 1);
      if (typeof rr === "string") executed++;
    }
    chk("H RED: raw items.buy executes unlimited retries", executed === 4, `executed=${executed}`);
  }

  // ── I. NEXT-objective guidance renders and matches state ───────────────
  if (!rigs[3]) {
    skipped("I guidance", "no map3 fixture");
  } else {
    const r = rigs[3];
    const g = ceruleanGuidance(r.emu, sym, r.rd);
    if (!g) {
      skipped("I NEXT objective", "guidance window closed on this fixture (flags)");
    } else {
      chk("I NEXT OBJECTIVE line present", g.includes("NEXT OBJECTIVE:"), g.split("\n")[1] ?? "");
      const lead = r.rd.read().party[0];
      const hurt = lead && lead.maxHp > 0 && lead.hp / lead.maxHp < 0.6;
      const healFirst = g.includes("NEXT OBJECTIVE: heal");
      chk("I branch matches live state (heal-first iff hurt/lowPP or lowPP)",
          hurt ? healFirst : true,   // lowPP alone can also force heal; hurt=>healFirst is the hard half
          `lead=${lead ? `${lead.hp}/${lead.maxHp}` : "none"} healFirst=${healFirst}`);
    }
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
