// Map the Gen 1 battle MOVE menu cursor empirically. Reach main menu, open
// FIGHT, then dump wCurrentMenuItem and neighbors while pressing each key.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { EventBus } from "./events";
import { Battle } from "./battle";

const sym = new SymbolTable("roms/pokeblue.sym");
const emu = new Emulator("roms/pokeblue.gb");
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const bus = new EventBus("/tmp", "probe-movemenu-" + Date.now());
const dlg = new Dialog(emu, scr, sync, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const M = () => emu.mem();
const rd = (n: string) => { try { return M()[sym.addr(n)]; } catch { return -1; } };
const dump = (tag: string) => {
  const c = scr.cursor();
  console.log(`[${tag}] inBattle=${rd("wIsInBattle")} curMenu=${rd("wCurrentMenuItem")} ` +
    `cc27=${M()[0xcc27]} cc28=${M()[0xcc28]} cc29=${M()[0xcc29]} cc2a=${M()[0xcc2a]} cursor=${JSON.stringify(c)} atMainMenu=${bat.atMainMenu()}`);
};

(async () => {
  loadSnapshotFile(emu, "saves/wild-battle-items.state.gz");
  await emu.framesAsync(120); await sync.settle();
  dump("loaded");
  // advance to main menu (press A until atMainMenu, up to 40)
  let reached = false;
  for (let i = 0; i < 40; i++) {
    if (bat.atMainMenu()) { reached = true; console.log(`main menu up at A#${i}`); break; }
    await emu.tapAsync(KEYS.A, 8, 16); await sync.settle(150);
  }
  if (!reached) { console.log("never reached main menu; screen:\n" + scr.text()); process.exit(1); }
  dump("mainMenu");
  // normalize to FIGHT (top-left) and press A to open the move menu
  await emu.tapAsync(KEYS.UP, 8, 10);
  await emu.tapAsync(KEYS.LEFT, 8, 10);
  await emu.tapAsync(KEYS.A, 8, 20);
  await sync.settle(300);
  console.log("=== opened FIGHT ==="); dump("moveMenu");
  console.log("screen:\n" + scr.text());
  // map key effects from here (expect move menu): press each key, dump
  for (const [label, key] of [["DOWN", KEYS.DOWN], ["RIGHT", KEYS.RIGHT], ["UP", KEYS.UP], ["LEFT", KEYS.LEFT]] as const) {
    await emu.tapAsync(key, 8, 10);
    await sync.settle(150);
    dump(`after ${label}`);
  }
  // verify UP+LEFT -> top-left, then 4x UP from top-left (the old normalize)
  await emu.tapAsync(KEYS.UP, 8, 10); await emu.tapAsync(KEYS.LEFT, 8, 10);
  await sync.settle(150); dump("after UP+LEFT (expect top-left slot 0)");
  console.log("screen at top-left:\n" + scr.text());
  for (let i = 1; i <= 4; i++) {
    await emu.tapAsync(KEYS.UP, 8, 10);
    await sync.settle(120);
    dump(`after ${i}x UP from top-left`);
  }
  console.log("final screen:\n" + scr.text());
})();
