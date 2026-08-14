// Live demo: continuous replay of the P1 route with streamed frames + mechanics events
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { StateReader } from "./state";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { StreamServer } from "./stream";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SNAP = "/home/lumen/pokemon/saves/boot-overworld.state.gz";
const ROUTE = [38, 37, 0, 40];

const stream = new StreamServer(8871);
const bus = new EventBus("/home/lumen/pokemon/events", "live-" + Date.now());
bus.on(e => stream.broadcast(e));

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator(ROM);
const reader = new StateReader(emu, sym);
const rom = new Rom(ROM);
const map = new MapModel(emu, sym, rom);
const nav = new Navigator(emu, sym, map, bus);

emu.onFrame = png => stream.broadcastFrame(png);
emu.paceMs = 50; // 2x realtime

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  for (;;) {
    loadSnapshotFile(emu, SNAP);
    bus.emit("boot", { demo: "P1 route replay", route: ROUTE.join("->") });
    let ok = true;
    for (let leg = 0; leg < ROUTE.length - 1 && ok; leg++) {
      const next = ROUTE[leg + 1];
      map.build(); nav.clearLearned();
      bus.emit("state_read", reader.read() as unknown as object);
      const warp = map.warps.find(w => w.destMap === next || (next === 0 && w.destMap === 0xff));
      if (!warp) { ok = false; break; }
      const r = await nav.goto(warp.x, warp.y);
      if (r === "stuck" || r === "adjacent_npc") ok = false;
    }
    bus.emit("state_read", reader.read() as unknown as object);
    bus.emit("turn_summary", { line: ok ? "route complete: Oak's lab reached — restarting demo" : "demo error — restarting" });
    await sleep(4000);
  }
})();
