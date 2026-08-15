// wq#622 — hidden items: ROM table decode + itemfinder-style perception.
//
// THE CLASS UNDER TEST: research/vision_research_brief.md's own example of a
// perception gap no pixel pipeline can ever close — a hidden item has no
// sprite, so only a table read can see it.
//
// HONESTY NOTE, stated up front rather than glossed over: this probe verifies
// the DECODE (section A), the PERCEPTION line + its obtained-suppression
// (sections B-D), and the ground-truth CONFIRMATION PLUMBING (section E) by
// directly flipping the obtained-flag bit under test control. It does NOT
// claim to have found the live in-game trigger sequence that flips that bit
// for real — this session tried direct A-on-tile, stepping onto the tile
// from all 4 cardinal directions, and the existing interact() tool against
// the verified Route 4 entry (map15, y=3, x=40), and none of them flipped it
// in a synthetic position-injection test. That is reported, not hidden, in
// reports/622_hidden_items.md. Section E tests "if the flag flips, is it
// detected and reported correctly" — a real question this code answers —
// not "does pressing A on this tile flip the flag", which remains open.
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
import { flippedBits } from "./objects";
import { hiddenItemTable, hiddenItemObtained, hiddenItemFlags, nearbyHiddenItems, hiddenItemLine } from "./hidden_items";
import { findFixture, requireFixture } from "./fixtures";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BASE = "/home/lumen/pokemon";
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);
const rom = new Rom(`${BASE}/roms/pokeblue.gb`);

let pass = 0, fail = 0, skip = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};
const skipped = (n: string, why: string) => { skip++; console.log(`SKIP ${n} :: ${why}`); };

interface Rig { emu: Emulator; map: MapModel; agent: Agent; rd: StateReader; }
function rig(statePath: string): Rig {
  const emu = new Emulator(`${BASE}/roms/pokeblue.gb`);
  loadSnapshotFile(emu, statePath);
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp622-bus-")), "probe622");
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const rd = new StateReader(emu, sym);
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, rd, new Brain(bus),
                          bus, mkdtempSync(join(tmpdir(), "lpp622-ckpt-")));
  map.build();
  return { emu, map, agent, rd };
}
function setPos(r: Rig, x: number, y: number) {
  r.emu.mem()[sym.addr("wXCoord")] = x;
  r.emu.mem()[sym.addr("wYCoord")] = y;
}
function setObtained(r: Rig, idx: number, val: boolean) {
  const a = sym.addr("wObtainedHiddenItemsFlags");
  const byte = idx >> 3, bit = idx & 7;
  if (val) r.emu.mem()[a + byte] |= (1 << bit);
  else r.emu.mem()[a + byte] &= ~(1 << bit);
}

(async () => {
  console.log("== probe_hidden622: hidden-item table decode + perception ==");

  // ── A. table decode: 54 entries, FF-terminated, Route 4 named example ──
  const table = hiddenItemTable(rom, sym);
  chk("A table decodes exactly 54 entries (163 bytes: 54*3 + 1 terminator)", table.length === 54,
      `${table.length}`);
  chk("A no entry reads the 0xFF terminator as data", table.every(h => h.map !== 0xff));
  const route4 = table.find(h => h.map === 15);
  chk("A Route 4 (map 15) is in the documented list at (40,3) — the ticket's own named example",
      !!route4 && route4.x === 40 && route4.y === 3, JSON.stringify(route4));
  // spot-check three more against known Gen1 hidden-item locations by map name
  chk("A Viridian Forest (map 51) entry present", table.some(h => h.map === 51));
  chk("A Mt Moon B2F (map 61) entry present (rare candy / fossil floor)", table.some(h => h.map === 61));
  chk("A Cerulean Cave 1F (map 228) entry present", table.some(h => h.map === 228));
  chk("A table is cached (repeat call returns the identical array instance)",
      hiddenItemTable(rom, sym) === table);

  // ── B. absent case: a map with zero hidden-item entries -> no line ──
  const fx67 = findFixture(sc => sc.map === 67);
  if (!fx67) { skipped("B absent case", "no map67 fixture"); }
  else {
    chk("B map67 (Cerulean Mart) has no entries in the table at all", !table.some(h => h.map === 67));
    const r = rig(requireFixture("map67", fx67));
    const nearby = nearbyHiddenItems(rom, sym, r.emu.mem(), 67, r.rd.read().x, r.rd.read().y);
    chk("B nearbyHiddenItems returns [] on a clean map", nearby.length === 0);
    chk("B hiddenItemLine renders null on empty", hiddenItemLine([]) === null);
    const block = await r.agent.observe();
    chk("B observe() has NO hidden-item line on a clean map (no dead prose)",
        !block.includes("HIDDEN ITEM"), "");
  }

  // ── C. presence: real map15 checkpoint, position injected next to the ──
  //      verified Route 4 entry (same RAM-poke technique probe_items607's
  //      armRepel() already uses — the map/tiles/ROM stay real, only the
  //      player's own coordinate is moved to exercise a specific entry).
  const fx15 = findFixture(sc => sc.map === 15);
  if (!fx15 || !route4) { skipped("C presence on Route 4", `fixture=${!!fx15} route4=${!!route4}`); }
  else {
    const r = rig(requireFixture("map15 presence", fx15));
    setPos(r, route4.x, route4.y);   // stand exactly on it (adjacency=0)
    const st = r.rd.read();
    chk("C position injection landed on the real entry's tile", st.x === route4.x && st.y === route4.y);
    const nearby = nearbyHiddenItems(rom, sym, r.emu.mem(), 15, st.x, st.y);
    chk("C nearbyHiddenItems finds the Route 4 entry standing on it", nearby.length === 1 && nearby[0].idx === route4.idx,
        JSON.stringify(nearby));
    const block = await r.agent.observe();
    chk("C observe() renders the HIDDEN ITEM line naming the real coords",
        block.includes(`HIDDEN ITEM HERE`) && block.includes(`(${route4.x},${route4.y})`),
        block.split("\n").find(l => l.includes("HIDDEN ITEM")) ?? "no line");
    // one tile away (Chebyshev 1) still counts as adjacent
    setPos(r, route4.x + 1, route4.y);
    const nearbyAdj = nearbyHiddenItems(rom, sym, r.emu.mem(), 15, route4.x + 1, route4.y);
    chk("C adjacent (1 tile away) still triggers the perception line", nearbyAdj.length === 1);
    // two tiles away does not
    setPos(r, route4.x + 2, route4.y);
    const nearbyFar = nearbyHiddenItems(rom, sym, r.emu.mem(), 15, route4.x + 2, route4.y);
    chk("C two tiles away is honestly OUT of range (itemfinder-style, not full-map ranging)",
        nearbyFar.length === 0);
  }

  // ── D. obtained-suppression: setting the real flag bit hides the line ──
  if (!fx15 || !route4) { skipped("D obtained suppression", "no map15 fixture / route4 entry"); }
  else {
    const r = rig(requireFixture("map15 suppression", fx15));
    setPos(r, route4.x, route4.y);
    chk("D starts undiscovered (fixture's own flag byte)", !hiddenItemObtained(r.emu.mem(), sym, route4.idx));
    chk("D nearby while undiscovered", nearbyHiddenItems(rom, sym, r.emu.mem(), 15, route4.x, route4.y).length === 1);
    setObtained(r, route4.idx, true);
    chk("D hiddenItemObtained reads the flipped bit", hiddenItemObtained(r.emu.mem(), sym, route4.idx));
    chk("D nearbyHiddenItems now excludes it (already found)",
        nearbyHiddenItems(rom, sym, r.emu.mem(), 15, route4.x, route4.y).length === 0);
    const block = await r.agent.observe();
    chk("D observe() has NO hidden-item line once obtained (no re-offering a found item)",
        !block.includes("HIDDEN ITEM"), "");
    setObtained(r, route4.idx, false);   // leave the fixture's own copy untouched conceptually
  }

  // ── E. confirmation plumbing: does a flag flip get detected + reported ──
  //      correctly? (NOT a claim that a specific in-game action causes the
  //      flip — see the file header and reports/622_hidden_items.md.)
  if (!fx15 || !route4) { skipped("E confirmation plumbing", "no map15 fixture / route4 entry"); }
  else {
    const r = rig(requireFixture("map15 confirm", fx15));
    setPos(r, route4.x, route4.y);
    const before = hiddenItemFlags(r.emu.mem(), sym);
    setObtained(r, route4.idx, true);   // simulate the engine's own pickup write
    const after = hiddenItemFlags(r.emu.mem(), sym);
    const flips = flippedBits(before, after);
    chk("E flippedBits reports exactly one bit, matching the entry's own idx",
        flips.length === 1 && flips[0] === route4.idx, `flips=${flips.join(",")} want=${route4.idx}`);
    // the SAME agent.ts wiring interact() uses: nearbyHiddenItems() called
    // BEFORE the flip must still find it (pre-check), confirming the flag
    // check in agent.ts's press()/interact() cases is checking the RIGHT bit.
    const r2 = rig(requireFixture("map15 confirm pre", fx15));
    setPos(r2, route4.x, route4.y);
    const preFlip = nearbyHiddenItems(rom, sym, r2.emu.mem(), 15, route4.x, route4.y);
    chk("E pre-flip: the entry that WILL be confirmed is the one nearbyHiddenItems names",
        preFlip.length === 1 && preFlip[0].idx === route4.idx);
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
