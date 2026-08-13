// Find the RAM signature of the battle main menu vs narration, using a known
// wild-battle checkpoint (rival1-battle is a trainer battle at the menu).
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { EventBus } from "./events";
import { Battle } from "./battle";

const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");
const emu = new Emulator("/home/lumen/pokemon/roms/pokeblue.gb");
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const bus = new EventBus("/tmp", "probe-menuram-" + Date.now());
const dlg = new Dialog(emu, scr, sync, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const M = () => emu.mem();
const rd = (n: string) => { try { return M()[sym.addr(n)]; } catch { return -1; } };
const dump = (tag: string) => console.log(`[${tag}] inBattle=${rd("wIsInBattle")} textBox=${rd("wTextBoxID")} curMenu=${rd("wCurrentMenuItem")} lowAlarm=${rd("wLowHealthAlarm")} watchedKeys=${rd("wMenuWatchedKeys")} savedMenu=${rd("wBattleAndStartSavedMenuItem")} cursor=${JSON.stringify(scr.cursor())} atMainMenu=${bat.atMainMenu()}`);

(async () => {
  loadSnapshotFile(emu, "/home/lumen/pokemon/saves/rival1-battle.state.gz");
  await emu.framesAsync(120); await sync.settle();
  console.log("=== rival1-battle (trainer, should reach menu) ===");
  dump("loaded");
  // advance intro text until menu
  for (let i = 0; i < 15; i++) {
    if (bat.atMainMenu()) { console.log(`atMainMenu at A#${i}`); break; }
    await emu.tapAsync(KEYS.A, 8, 16); await sync.settle(250);
    dump(`A#${i}`);
    if (bat.atMainMenu()) break;
  }
  console.log("\nscreen at menu:\n" + scr.text());
})();
