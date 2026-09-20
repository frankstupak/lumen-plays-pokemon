// wq#674 — gym-door-bounce refusal: red/green probe.
//
// THE STALL (observed live 43h straight, 2026-08-16 16:44Z through 2026-08-17
// 20:13Z, events/live-agent-1786898534540.jsonl): the mission brief assumed
// the agent was losing repeatedly TO Misty. Ground truth from the log says
// otherwise — grep '"inBattle":1' over the entire 7500-line file returns ZERO
// hits. The agent never once reached the fight. The party (CHARMELEON #178,
// level 30, full HP) is also nowhere near underleveled for Staryu L18 /
// Starmie L21 - a grind objective would have burned more turns without
// touching the real defect.
//
// ROOT CAUSE: Cerulean Gym's interior spawn tile (map65 30,19) is ALSO the
// exit warp back to map3 - true of every gym/building door in this ROM.
// Exact live sequence, T168-169:
//   T168 [map3 30,20] goto(30,19)   => goto -> warped now {map:65,x:30,y:19}
//   T169 [map65 30,19] enter_warp(3) => enter_warp -> warped now {map:3,x:30,y:20}
// The brain read "standing on a warp" as "must enter it" and re-fired the
// SAME warp it had just taken, bouncing itself straight back out. ~90 gym
// entries over the run, same one-turn round trip every time. The harness's
// own LOOP NOTICE said so every single time and was ignored - the wq#532
// lesson (a rule that exists only as prose is not a rule), same shape as the
// wq#601 Mt Moon re-entry fix this probe's structure borrows from
// (mtMoonReentryRefusal / probe_ledge601.ts / probe_warploop652.ts).
//
// THE FIX: agent.ts tracks `movedSinceWarp`, false the instant a warp lands
// and true again the moment a goto/leave_edge actually steps the player
// somewhere. enter_warp now refuses outright when movedSinceWarp is false AND
// the requested warp is the exact tile already stood on - that combination
// can only mean "replay my own arrival", never a real exit.
//
// FIXTURE RESOLUTION BY PROPERTY (wq#540): any map3 checkpoint standing
// within 2 tiles of the Cerulean Gym door satisfies the scenario (same
// property probe_warploop652 uses); a missing fixture SKIPs loudly rather
// than failing red.
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
import { CFG } from "./config";
import { findFixture, copyFixture } from "./fixtures";

CFG.visionValve.enabled = false;

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CK = "/home/lumen/pokemon/checkpoints";
const SAVES = "/home/lumen/pokemon/saves";

// The gym door: map3 (30,19), one step north of the (30,20) approach tile
// used by every live checkpoint that reached Cerulean's gym (same anchor as
// probe_warploop652.ts).
const DOOR = { map: 3, x: 30, y: 19 };
const near = (sc: { map: number; x: number; y: number }) =>
  sc.map === DOOR.map && Math.abs(sc.x - DOOR.x) <= 1 && Math.abs(sc.y - DOOR.y) <= 2;

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

async function main() {
  const fixture = findFixture(near, [CK, SAVES]);
  if (!fixture) {
    console.log("SKIP -- no map3 checkpoint near the Cerulean Gym door on disk (corpus rotated).");
    console.log("     This is corpus rot, not a code defect (wq#643 shape).");
    console.log("\n0 passed, 0 failed (fixture unavailable, skipped)");
    return;
  }

  const snap = copyFixture(fixture);
  const sym = new SymbolTable(SYM);
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, snap);
  const rom = new Rom(ROM);
  const bus = new EventBus("/tmp", "probe-gymdoor674-" + Date.now());
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const reader = new StateReader(emu, sym);
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader,
                          new Brain(bus), bus, "/tmp/gymdoor674-ck");

  const st0 = reader.read();
  chk("fixture is really near the gym door", near(st0), JSON.stringify(st0));

  // T168 equivalent: goto the door tile from map3 - this itself fires the
  // warp into the gym, exactly as it did live.
  //
  // wq#674 follow-up: this fixture is deliberately solo (the same live
  // corpus the mistyGymEntryRefusal gate targets - see probe_mistygate674),
  // so agent.dispatch("goto(...)") now REFUSES this exact step at the outer
  // gate before it ever reaches the door-bounce logic this probe exists to
  // cover. That gate has its own dedicated probe; here we go through
  // nav.goto() directly to reach "just warped in, standing on the exit"
  // the same way dispatch's goto case would, and replicate its one
  // observable side effect (movedSinceWarp) by hand so the enter_warp
  // refusal below is exercised under the exact state it fires from live.
  const rIn = await nav.goto(DOOR.x, DOOR.y);
  chk("goto onto the door warps into the gym", rIn === "warped" && reader.read().map !== 3,
      rIn);
  if (rIn !== "warped") return;
  (agent as any).movedSinceWarp = false;

  map.build();
  const inside = reader.read();
  const doorInside = map.warps.find(w => w.x === inside.x && w.y === inside.y);
  chk("arrival tile inside the gym is itself a warp (the exit)", !!doorInside,
      JSON.stringify({ inside, warps: map.warps }));
  if (!doorInside) return;
  const exitIdx = map.warps.indexOf(doorInside);

  // T169 equivalent: enter_warp on the SAME tile with zero steps taken since
  // arrival - this is the reflex bounce that stalled the run for 43 hours.
  const rBounce = await agent.dispatch(`enter_warp(${exitIdx})`);
  chk("replaying the just-arrived warp is REFUSED, not fired",
      /refused/.test(rBounce) && /wq#674/.test(rBounce), rBounce);

  map.build();
  const stillInside = reader.read();
  chk("refused call left the player exactly where they were (still inside the gym)",
      stillInside.map === inside.map && stillInside.x === inside.x && stillInside.y === inside.y,
      JSON.stringify(stillInside));

  // Prove the guard is scoped to "replay MY OWN just-taken warp", not a
  // blanket freeze on every warp in the building - a DIFFERENT warp on this
  // map (destined elsewhere, not back where we just came from) must not be
  // refused by this check.
  //
  // wq#2220: pick that warp by INDEX, never by object identity. map.build()
  // above rebuilds this.warps into FRESH object literals (map.ts:198-200), so
  // `doorInside` - captured before that rebuild - is a stale reference and
  // `w !== doorInside` matched the arrival door itself at index 0. The probe
  // was then asserting the arrival door must NOT be refused four lines after
  // asserting that it MUST be, and the contradiction read as the wq#674 guard
  // over-matching every warp on the map. It never did: the guard keys on the
  // arrival TILE and on justWarpedBack's {map,index} (agent.ts:1106-1124),
  // both of which are already specific to one door.
  //
  // Interior doorways in this ROM are two tiles wide (map65's table above is
  // exactly that: 4,13 and 5,13, same destMap/destWarp), so prefer a warp that
  // actually leads somewhere else; fall back to any other index when the map
  // only has the one doorway, which still exercises the scoping claim.
  const exit = map.warps[exitIdx];
  const elsewhere = map.warps.findIndex((w, i) => i !== exitIdx &&
    (w.destMap !== exit.destMap || w.destWarp !== exit.destWarp));
  const otherIdx = elsewhere >= 0
    ? elsewhere
    : map.warps.findIndex((_, i) => i !== exitIdx);
  if (otherIdx >= 0) {
    const rOther = await agent.dispatch(`enter_warp(${otherIdx})`);
    chk("a DIFFERENT warp on the same map is not caught by the guard",
        !/wq#674/.test(rOther), rOther);
  } else {
    console.log("(no second warp on this map to cross-check scoping against - skipping that assertion)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
