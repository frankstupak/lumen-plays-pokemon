// Trigger a real wild battle and trace battle_move step-by-step to find the timeout.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { Navigator } from "./nav";
import { EventBus } from "./events";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { Battle } from "./battle";
import { StateReader } from "./state";

const sym = new SymbolTable("roms/pokeblue.sym");
const emu = new Emulator("roms/pokeblue.gb");
loadSnapshotFile(emu, "checkpoints/auto-msjdams8-t230.state.gz");  // map 51 forest overworld
const rom = new Rom("roms/pokeblue.gb");
const bus = new EventBus("/tmp", "probe-wild-" + Date.now());
const map = new MapModel(emu, sym, rom);
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const nav = new Navigator(emu, sym, map, bus, sync);
const dlg = new Dialog(emu, scr, sync, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();
const rd = (n: string) => { try { return M()[sym.addr(n)]; } catch { return -1; } };

(async () => {
  await emu.framesAsync(60); await sync.settle();
  console.log("start: map", reader.read().map, "inBattle", reader.read().inBattle);
  // walk around in grass to trigger an encounter
  let triggered = false;
  const dirs = [KEYS.UP, KEYS.DOWN, KEYS.LEFT, KEYS.RIGHT];
  for (let i = 0; i < 80 && !triggered; i++) {
    await emu.tapAsync(dirs[i % 4], 8, 12); await sync.settle(60);
    if (bat.active()) triggered = true;
  }
  console.log("battle triggered:", triggered, "inBattle:", rd("wIsInBattle"));
  if (!triggered) { console.log("no encounter in 80 steps"); process.exit(0); }
  // now trace waitForMenu manually
  console.log("=== waiting for menu (trace) ===");
  for (let i = 0; i < 60; i++) {
    const mm = bat.atMainMenu(), act = bat.active(), c = scr.cursor();
    if (i % 5 === 0 || mm) console.log(`  f${i*10}: active=${act} atMainMenu=${mm} cursor=${JSON.stringify(c)} textBox=${rd("wTextBoxID")} txt=${JSON.stringify(scr.text().slice(0,30))}`);
    if (mm) { console.log("MENU REACHED"); break; }
    if (!act) { console.log("battle ended before menu"); break; }
    if (dlg.open() || scr.awaitingPrompt()) await emu.tapAsync(KEYS.A, 8, 12);
    await emu.framesAsync(10);
  }
  // try a move
  const w = await bat.waitForMenu();
  console.log("waitForMenu ->", w);
  if (w === "menu") {
    const b = bat.state();
    console.log("battle state: my", b.myHp + "/" + b.myMaxHp, "foe", b.foeHp + "/" + b.foeMaxHp, "PP", b.pp);
    // pick first move with PP
    const slot = b.pp.findIndex((p: number, i: number) => b.moves[i] && (p & 0x3f) > 0);
    console.log("picking slot", slot);
    await bat.useMove(slot < 0 ? 0 : slot);
    const w2 = await bat.waitForMenu();
    const b2 = bat.state();
    console.log("after move: waitForMenu ->", w2, "foe", b2.foeHp + "/" + b2.foeMaxHp, "(was", b.foeHp + ")");
    console.log(b2.foeHp < b.foeHp || !bat.active() ? "MOVE LANDED (dmg or battle over)" : "MOVE DID NOT LAND - BUG CONFIRMED");
  }
})();
