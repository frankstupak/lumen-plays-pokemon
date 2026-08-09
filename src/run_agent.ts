// Bounded live agent run from a checkpoint.
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

const SNAP = process.env.SNAP ?? "/home/lumen/pokemon/saves/rival1-won.state.gz";
const TURNS = Number(process.env.TURNS ?? 12);

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
loadSnapshotFile(emu, SNAP);
const rom = new Rom("/home/lumen/pokemon/roms/pokeblue.gb");
const map = new MapModel(emu, sym, rom);
const bus = new EventBus("/home/lumen/pokemon/events", "agent-" + Date.now());
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const act = new Actions(emu, nav, dlg, sync, scr, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const brain = new Brain(bus);
const agent = new Agent(emu, sym, rom, map, nav, scr, sync, dlg, act, bat, reader, brain, bus, "/home/lumen/pokemon/checkpoints");

bus.on(e => {
  const x = e as any;
  if (x.kind === "think_chunk" && x.think) console.log(`  THINK: ${x.think}`);
  if (x.kind === "turn_summary") console.log(`  ${x.line}`);
});

(async () => {
  for (let i = 0; i < TURNS; i++) {
    await agent.runTurn();
    const st = reader.read();
    if (st.map === 12) { console.log("*** ROUTE 1 REACHED ***"); break; }
    if (st.map === 1) { console.log("*** VIRIDIAN REACHED ***"); break; }
  }
  console.log(`tokens: prompt=${brain.totalPrompt} completion=${brain.totalCompletion}`);
})();
