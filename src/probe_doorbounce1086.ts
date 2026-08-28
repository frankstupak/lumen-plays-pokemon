// wq#1086 — Bills House(88)<->Route 25(36) doorway warp-bounce: red/green probe.
//
// THE STALL: live-agent-1787950112287.jsonl shows the agent oscillating
// map88<->map36 via repeated enter_warp calls. The wq#674 guard (agent.ts,
// "you just warped IN on this tile") only refuses re-firing a warp when the
// player stands EXACTLY on the warp's own (x,y). Ground truth from the same
// log: the map36 checkpoint the agent lands on after leaving Bills House
// carries `"onWarp":false` — the landing tile is NOT itself a registered warp
// tile on map36, so the tile-equality check can never fire there. The brain
// then re-issues enter_warp for the same doorway from that adjacent tile and
// nav.enterWarp() walks it onto the door and re-fires it, bouncing straight
// back.
//
// THE FIX (wq#1086, on top of wq#674's movedSinceWarp flag): track the
// IDENTITY of the door just taken — this.justWarpedBack = {map, index}, where
// index is w.destWarp, the exact partner-warp index the ROM itself names —
// instead of comparing player position to a tile. enter_warp now refuses when
// the requested index matches justWarpedBack, regardless of where the player
// is currently standing relative to the door.
//
// FIXTURE RESOLUTION BY PROPERTY (wq#540): any map88 (Bills House) checkpoint
// works; a missing fixture SKIPs loudly rather than failing red.
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

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

async function main() {
  const fixture = findFixture(sc => sc.map === 88, [CK, SAVES]);
  if (!fixture) {
    console.log("SKIP -- no map88 (Bills House) checkpoint on disk (corpus rotated).");
    console.log("     This is corpus rot, not a code defect (wq#643 shape).");
    console.log("\n0 passed, 0 failed (fixture unavailable, skipped)");
    return;
  }

  const snap = copyFixture(fixture);
  const sym = new SymbolTable(SYM);
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, snap);
  const rom = new Rom(ROM);
  const bus = new EventBus("/tmp", "probe-doorbounce1086-" + Date.now());
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const reader = new StateReader(emu, sym);
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader,
                          new Brain(bus), bus, "/tmp/doorbounce1086-ck");

  const st0 = reader.read();
  chk("fixture is really inside Bills House (map88)", st0.map === 88, JSON.stringify(st0));
  if (st0.map !== 88) return;

  map.build();
  // wq#1086 wrinkle found while writing this probe: an interior's exit warp
  // encodes destMap=255 (0xff), the Gen1 "back to whichever map I came from"
  // sentinel — not a literal 36. destWarp is still meaningful in that case:
  // it indexes into the RESOLVED destination map's own warp table, which is
  // exactly the identity our fix relies on (see agent.ts wq#1086 comment).
  const exitWarp = map.warps.find(w => w.destMap === 36 || w.destMap === 255);
  chk("Bills House has a warp back outside (to Route 25)", !!exitWarp, JSON.stringify(map.warps));
  if (!exitWarp) return;
  const exitIdx = map.warps.indexOf(exitWarp);

  // Leave Bills House through the real door, via the real enter_warp path —
  // this is the call that now populates justWarpedBack from w.destWarp.
  const rOut = await agent.dispatch(`enter_warp(${exitIdx})`);
  chk("enter_warp on the exit door leaves Bills House", /warped/.test(rOut) && reader.read().map === 36,
      rOut);
  if (reader.read().map !== 36) return;

  const landed = reader.read();
  map.build();
  const onWarpTile = map.warps.some(w => w.x === landed.x && w.y === landed.y);
  console.log(`     landing tile (${landed.x},${landed.y}) on map36 is ${onWarpTile ? "" : "NOT "}itself a warp tile` +
    ` (live corpus showed NOT, i.e. an adjacent landing — this is the case wq#674's tile-equality check misses)`);

  const jwb = (agent as any).justWarpedBack;
  chk("justWarpedBack was populated by the real warp we just fired",
      !!jwb && jwb.map === 36, JSON.stringify(jwb));
  if (!jwb) return;

  // The brain's mistake, live: fire enter_warp for the SAME doorway again,
  // straight back to Bills House, with zero real steps taken since arrival.
  const rBounce = await agent.dispatch(`enter_warp(${jwb.index})`);
  chk("firing the SAME door back is REFUSED even though the player is not on its exact tile",
      /refused/.test(rBounce) && /wq#1086/.test(rBounce), rBounce);

  map.build();
  const stillThere = reader.read();
  chk("the refused call left the player exactly where they were (still on map36)",
      stillThere.map === 36 && stillThere.x === landed.x && stillThere.y === landed.y,
      JSON.stringify(stillThere));

  // Prove the guard is scoped to THIS door, not a blanket freeze: a different
  // warp on map36 (if one exists) must not be caught by the same-door check.
  const other = map.warps.find((w, i) => i !== jwb.index && w.destMap !== 88);
  if (other) {
    const otherIdx = map.warps.indexOf(other);
    const rOther = await agent.dispatch(`enter_warp(${otherIdx})`);
    chk("a DIFFERENT warp on the same map is not caught by the same-door guard",
        !/wq#1086/.test(rOther), rOther);
  } else {
    console.log("(no other non-Bills-House warp on map36 to cross-check scoping against - skipping that assertion)");
  }

  // Prove the guard expires once the player actually moves: goto() one tile
  // in a walkable direction THROUGH agent.dispatch (not nav.goto() directly —
  // movedSinceWarp/justWarpedBack only update inside the dispatch handler,
  // so calling the Navigator directly would leave them stale and prove
  // nothing about the fix under test).
  map.build();
  const p = reader.read();
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  let moved = false;
  for (const [dx, dy] of dirs) {
    const rMove = await agent.dispatch(`goto(${p.x + dx},${p.y + dy})`);
    if (/^goto -> (arrived|moved)/.test(rMove)) { moved = true; break; }
  }
  if (moved) {
    const rAfterMove = await agent.dispatch(`enter_warp(${jwb.index})`);
    chk("after a real step, the same door is no longer refused by the wq#1086 guard",
        !/wq#1086/.test(rAfterMove), rAfterMove);
  } else {
    console.log("(could not find a free adjacent tile to step onto - skipping the guard-expiry assertion)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
