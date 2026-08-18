// wq#674 — Misty gym hard-entry-gate probe: red/green.
//
// THE STALL (current, live: events/live-agent-1786998394993.jsonl, run
// started 2026-08-17T20:26Z, still open as of this ticket): the agent's OWN
// party never grew past ONE Pokemon (CHARMELEON #178) the entire campaign.
// Moveset RAGE/GROWL/EMBER/LEER — EMBER is the only damaging move and Water
// resists it. Money halves exactly three times over the run (888->444->
// 444->222->222->111 in runtime state_read events), each halving lined up
// with an inBattle window at Cerulean Gym (map65) — three whiteouts. Level
// (30-31) and potions were both already above guidance.ts's MISTY_MIN_LEVEL/
// MISTY_MIN_POTIONS the whole time: the existing "MISTY GATE" prose in
// ceruleanGuidance() flips to "YOU ARE READY, enter the gym" the moment
// those two numbers clear, with no check on roster composition at all, so it
// spent the run actively telling the brain to keep re-attempting a fight a
// solo Fire-type cannot win regardless of level.
//
// THE FIX: guidance.ts's misty_ready() now also requires partyCount >=
// MISTY_MIN_ROSTER (2) — the same "solo = insurance-worthy" threshold
// catch_policy.ts already uses. agent.ts enforces it as a HARD refusal (not
// just prose) at BOTH warp-entry call sites: goto() stepping onto the
// outside gym door (the live path — Gen 1 outside gym doors auto-warp the
// instant you step on the tile, no explicit enter_warp needed) and
// enter_warp() (defense in depth / re-entry from inside). Prose-only was
// proven insufficient by the live incident itself (wq#532 lesson, same shape
// as mtMoonReentryRefusal / the wq#674 door-bounce fix this probe sits next
// to).
//
// FIXTURE RESOLUTION BY PROPERTY (wq#540): reuses probe_gymdoor674's own
// anchor (any map3 checkpoint within the door's approach radius) — same
// property, so this probe and probe_gymdoor674 rise and fall together with
// the corpus, never independently rotting.
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
import { misty_ready, hasTypeCounter, MISTY_TYPE_COUNTER_SPECIES,
         MISTY_MIN_LEVEL, MISTY_MIN_POTIONS, MISTY_MIN_ROSTER } from "./guidance";

CFG.visionValve.enabled = false;

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CK = "/home/lumen/pokemon/checkpoints";
const SAVES = "/home/lumen/pokemon/saves";

const DOOR = { map: 3, x: 30, y: 19 };
const near = (sc: { map: number; x: number; y: number }) =>
  sc.map === DOOR.map && Math.abs(sc.x - DOOR.x) <= 1 && Math.abs(sc.y - DOOR.y) <= 2;

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++;
};

// ---- A. pure predicate (no ROM needed) ------------------------------------
console.log("=== A. misty_ready() pure predicate ===");
chk("A1 level+potions ok but solo (party 1) -> NOT ready",
    misty_ready(MISTY_MIN_LEVEL, MISTY_MIN_POTIONS, 1, false) === false);
chk("A2 level+potions+party(2)+counter all clear -> ready",
    misty_ready(MISTY_MIN_LEVEL, MISTY_MIN_POTIONS, MISTY_MIN_ROSTER, true) === true);
chk("A3 under-level alone still blocks even with a full roster + counter",
    misty_ready(MISTY_MIN_LEVEL - 1, MISTY_MIN_POTIONS, 6, true) === false);
chk("A4 under-potions alone still blocks even with a full roster + counter",
    misty_ready(MISTY_MIN_LEVEL, MISTY_MIN_POTIONS - 1, 6, true) === false);
chk("A5 roster+level+potions ok but NO type counter -> NOT ready (wq#677)",
    misty_ready(MISTY_MIN_LEVEL, MISTY_MIN_POTIONS, MISTY_MIN_ROSTER, false) === false);

console.log("=== A2. hasTypeCounter() ===");
chk("A2.1 BELLSPROUT (188) is a counter", hasTypeCounter([{ species: 188 }]));
chk("A2.2 ODDISH (185) is a counter",     hasTypeCounter([{ species: 185 }]));
chk("A2.3 PARAS (109) is a counter",      hasTypeCounter([{ species: 109 }]));
chk("A2.4 GEODUDE (169) is a counter",    hasTypeCounter([{ species: 169 }]));
chk("A2.5 CHARMELEON (178) is NOT a counter", !hasTypeCounter([{ species: 178 }]));
chk("A2.6 empty party is NOT a counter",  !hasTypeCounter([]));
chk("A2.7 counter anywhere in party suffices",
    hasTypeCounter([{ species: 178 }, { species: 188 }]));
chk("A2.8 MISTY_TYPE_COUNTER_SPECIES has exactly 4 entries",
    MISTY_TYPE_COUNTER_SPECIES.size === 4);

// ---- B. live fixture: the actual goto()-onto-the-door path ----------------
async function main() {
  const fixture = findFixture(near, [CK, SAVES]);
  if (!fixture) {
    console.log("\nSKIP B -- no map3 checkpoint near the Cerulean Gym door on disk (corpus rotated).");
    console.log("     This is corpus rot, not a code defect (wq#643 shape).");
    console.log(`\n${pass} passed, ${fail} failed (fixture unavailable for section B)`);
    process.exit(fail ? 1 : 0);
  }

  console.log("\n=== B. live fixture — goto() onto the gym door is refused while solo ===");
  const snap = copyFixture(fixture);
  const sym = new SymbolTable(SYM);
  const emu = new Emulator(ROM);
  loadSnapshotFile(emu, snap);
  const rom = new Rom(ROM);
  const bus = new EventBus("/tmp", "probe-mistygate674-" + Date.now());
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, bus, sync);
  const dlg = new Dialog(emu, scr, sync, bus, sym);
  const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
  const bat = new Battle(emu, sym, scr, sync, dlg, bus);
  const reader = new StateReader(emu, sym);
  const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader,
                          new Brain(bus), bus, "/tmp/mistygate674-ck");

  const st0 = reader.read();
  chk("B0 fixture is really near the gym door", near(st0), JSON.stringify(st0));
  chk("B0 fixture is genuinely solo/under-prepped (the scenario this gate targets)",
      st0.partyCount < MISTY_MIN_ROSTER, `partyCount=${st0.partyCount}`);

  const r = await agent.dispatch(`goto(${DOOR.x},${DOOR.y})`);
  chk("B1 stepping onto the gym door is REFUSED, not warped",
      /refused/.test(r) && /wq#674/.test(r) && !/warped/.test(r), r);

  map.build();
  const after = reader.read();
  chk("B2 refused goto left the player OUTSIDE the gym (still map3)",
      after.map === 3, JSON.stringify(after));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
