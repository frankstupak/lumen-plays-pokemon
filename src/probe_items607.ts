// wq#607 — item-ball perception: red/green.
//
// THE BLINDNESS (red) is structural and shown in-probe: MapModel sprites
// carried coordinates only — strip the new pic field and a Poke Ball is
// bit-identical to an NPC; the state block had no item line at all, and the
// grid rendered both as "N". The green half: the same fixtures now decode
// name+id+position, the grid shows "B", the state line renders with real
// astar distances, and a full agent-dispatched interact() PICKS ONE UP with
// ground-truth confirmation (missable flag bit + bag delta + despawn).
//
// DETERMINISM: caves have encounters — probes own their environment
// (probe_warp579 precedent): Repel is armed via wRepelRemainingSteps and the
// map's Rocket sightlines are disarmed by setting their OWN defeat bits
// through trainerFlagAddr (the wq#528-verified per-map flag table).
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
import { decodeItemObjects, itemBallLine, toggleableFlags, flippedBits, BALL_PIC } from "./objects";
import { trainerFlagAddr } from "./trainers";
import { ITEM, backfillItemNames } from "./items";
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

interface Rig { emu: Emulator; map: MapModel; agent: Agent; rd: StateReader; }
function rig(statePath: string): Rig {
  const emu = new Emulator(`${BASE}/roms/pokeblue.gb`);
  loadSnapshotFile(emu, statePath);
  const rom = new Rom(`${BASE}/roms/pokeblue.gb`);
  backfillItemNames(rom, sym);
  const bus = new EventBus(mkdtempSync(join(tmpdir(), "lpp607-bus-")), "probe607");
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const rd = new StateReader(emu, sym);
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, rd, new Brain(bus),
                          bus, mkdtempSync(join(tmpdir(), "lpp607-ckpt-")));
  map.build();
  return { emu, map, agent, rd };
}
function armRepel(r: Rig, steps = 250) { r.emu.mem()[sym.addr("wRepelRemainingSteps")] = steps; }
function disarmTrainers(r: Rig, mapId: number) {
  const rom = new Rom(`${BASE}/roms/pokeblue.gb`);
  const hdr = trainerFlagAddr(rom, sym, mapId);
  if (!hdr) return;
  for (const b of hdr.bits) r.emu.mem()[hdr.addr] |= (1 << b);
}

(async () => {
  console.log("== probe_items607: item-ball perception + confirmed pickup ==");

  // ── A. decode on map59 (five plain balls + the TM12 ball, exact recon coords) ──
  const fx59 = findFixture(sc => sc.map === 59);
  if (!fx59) { skipped("A map59 decode", "no map59 fixture"); }
  else {
    const r = rig(requireFixture("map59", fx59));
    const objs = decodeItemObjects(r.emu.mem(), sym);
    const byName = Object.fromEntries(objs.map(o => [`${o.name}@${o.x},${o.y}`, o]));
    chk("A map59: six ball objects decoded", objs.length === 6,
        objs.map(o => `${o.name}(${o.x},${o.y})`).join(" "));
    chk("A exact identities+coords (recon607 ground truth)",
        !!byName["potion@2,20"] && !!byName["moon_stone@2,2"] && !!byName["rare_candy@35,31"] &&
        !!byName["escape_rope@36,23"] && !!byName["potion@20,33"]);
    chk("A TM ball: id 212 on Mt Moon 1F names tm12 (Bulbapedia cross-check)",
        !!byName["tm12@5,32"] && byName["tm12@5,32"].itemId === 212);
    // RED: strip the identity field and a ball is indistinguishable from an NPC
    const anon = r.map.sprites.map(({ x, y }) => ({ x, y }));
    const ball = r.map.sprites.find(s => s.pic === BALL_PIC)!;
    const npc = r.map.sprites.find(s => s.pic !== BALL_PIC)!;
    chk("A RED: without pic, ball and NPC entries have identical shape",
        JSON.stringify(Object.keys(anon[0])) === JSON.stringify(["x", "y"]) &&
        !!ball && !!npc, "coordinates-only sprites carry no identity");
    chk("A grid renders the ball tile as B (was anonymous N)",
        r.map.ascii(14, 35).split("\n")[33]?.[20] === "B",
        `char at (20,33) = '${r.map.ascii(14, 35).split("\n")[33]?.[20]}'`);
    const steps = new Map<number, number | null>([[byName["potion@20,33"].sprite, 9]]);
    const line = itemBallLine([byName["potion@20,33"]], steps);
    chk("A state line renders name+coords+steps+affordance",
        !!line && line.includes("potion at (20,33), 9 steps") && line.includes("interact"),
        (line ?? "").slice(0, 110));
  }

  // ── B. absent case: no balls -> no line, no B, decode [] ────────────────
  const fx67 = findFixture(sc => sc.map === 67);
  if (!fx67) { skipped("B absent case", "no map67 fixture"); }
  else {
    const r = rig(requireFixture("map67", fx67));
    chk("B mart decodes zero item objects", decodeItemObjects(r.emu.mem(), sym).length === 0);
    chk("B itemBallLine null on empty", itemBallLine([], new Map()) === null);
    const block = await r.agent.observe();
    chk("B observe block has NO item line on an empty map (no dead prose)",
        !block.includes("ITEM BALL"), "");
  }

  // ── C. observe() integration on map61: line present with astar steps ────
  const fx61 = findFixture(sc => sc.map === 61);
  if (!fx61) { skipped("C observe integration", "no map61 fixture"); }
  else {
    const r = rig(requireFixture("map61 observe", fx61));
    armRepel(r); disarmTrainers(r, 61);
    const block = await r.agent.observe();
    const m61 = block.match(/! ITEM BALLS? on this map: ([^\n]+)/);
    chk("C observe renders the item line", !!m61, (m61?.[1] ?? "no line").slice(0, 110));
    // The fixture stands in the B2F exit pocket, and B2F pockets genuinely do
    // not connect (the wq#564 map): astar to every tile around the hp_up is
    // null. The HONEST render is "unreachable from here" — a numeric step
    // count here would be the pack-promises-what-the-executor-cannot-do bug
    // this ticket exists to kill, pointed the other way.
    chk("C line tells the truth: hp_up is unreachable from this pocket",
        !!m61 && m61[1].includes("hp_up at (25,21), unreachable from here"), m61?.[1]?.slice(0, 90) ?? "");
    chk("C line names the tm01 ball too", !!m61 && m61[1].includes("tm01 at (29,5)"), "");
  }

  // ── D. PICKUP through the full agent dispatch, ground-truth confirmed ───
  // map59: the potion at (20,33) is 51 astar steps from the fixture's (14,35)
  // with open adjacents (20,32)/(21,33) — measured, not assumed. Repel armed,
  // 1F trainers disarmed via their own wq#528-verified defeat bits.
  if (!fx59) { skipped("D pickup", "no map59 fixture"); }
  else {
    const POTION = 20;  // ITEM.POTION
    const r = rig(requireFixture("map59 pickup", fx59));
    armRepel(r); disarmTrainers(r, 59);
    const st = r.rd.read();
    chk("D fixture stands at (14,35) as recon recorded", st.map === 59 && st.x === 14 && st.y === 35,
        `map${st.map} (${st.x},${st.y})`);
    const before = toggleableFlags(r.emu.mem(), sym);
    const had = r.agent.items.has(POTION);
    const res = await r.agent.dispatch("interact(20,33)");
    chk("D dispatch confirms the pickup by ground truth",
        res.includes("PICKED UP potion (bag +1, object flag bit"), res.slice(0, 150));
    const flips = flippedBits(before, toggleableFlags(r.emu.mem(), sym));
    chk("D exactly one missable-object flag bit flipped", flips.length === 1, `bits=${flips.join(",")}`);
    chk("D bag really grew", r.agent.items.has(POTION) === had + 1, `potion x${r.agent.items.has(POTION)}`);
    // Despawn is eventual, not instant (the flag flips first; the sprite is
    // drawn for a few more frames). Give the overworld a beat, then assert.
    await r.emu.framesAsync(90); await r.agent.sync.settle(300);
    chk("D the ball despawned from the sprite state (after settle)",
        !decodeItemObjects(r.emu.mem(), sym).some(o => o.x === 20 && o.y === 33), "");
    const again = await r.agent.dispatch("interact(20,33)");
    chk("D re-interact on the empty tile claims NO pickup", !again.includes("PICKED UP"), again.slice(0, 90));
  }

  console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
  process.exit(fail ? 1 : 0);
})();
