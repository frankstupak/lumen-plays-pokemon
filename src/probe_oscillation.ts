// Unit-test the anti-oscillation guard in isolation via a tiny Agent subclass
// that exposes the private method through a cast.
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

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
// wq#540: FIXTURE RESOLVED BY PROPERTY, NOT BY NAME. This probe used to load
// checkpoints/auto-msjdams8-t230.state.gz (map 51, Viridian Forest), which rotated off disk, so it died
// with an ENOENT stack trace before its first assertion. It only needs SOME
// loaded state to inspect, so it now takes the newest checkpoint on disk.
import { findFixture, requireFixture } from "./fixtures";
const ANY_FIXTURE = requireFixture("any checkpoint with a sidecar",
                                   findFixture(() => true));
loadSnapshotFile(emu, ANY_FIXTURE);
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-osc-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg2 = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg2, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg2, bus);
const reader = new StateReader(emu, sym);
const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg2, act, bat, reader, new Brain(bus), bus, "/tmp/osc-ck");

const note = (m: number): string => (agent as any).notePotentialOscillation(m);

// healthy linear progression -> no warning
let out = "";
for (const m of [51, 50, 13, 46]) out = note(m);
chk("linear progression: no warning", out === "", `last="${out}"`);

// oscillation 51<->50 repeated -> warning fires
out = "";
for (const m of [51, 50, 51, 50, 51, 50]) out = note(m);
chk("oscillation flagged", /OSCILLATION/.test(out), out.slice(0, 80));
chk("warning names the map", /map50/.test(out), out.slice(0, 60));

// after moving on to new maps, warning clears
out = "";
for (const m of [2, 54, 55]) out = note(m);
chk("clears after progress", out === "", `last="${out}"`);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
