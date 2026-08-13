// Map the MOVE menu cursor for a FOUR-move mon: patch wBattleMonMoves to 4
// moves, open FIGHT, then walk the cursor with UP/DOWN/LEFT/RIGHT.
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
const bus = new EventBus("/tmp", "probe-movemenu4-" + Date.now());
const dlg = new Dialog(emu, scr, sync, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const M = () => emu.mem();
const rd = (n: string) => { try { return M()[sym.addr(n)]; } catch { return -1; } };
const dump = (tag: string) => {
  const c = scr.cursor();
  console.log(`[${tag}] curMenu=${rd("wCurrentMenuItem")} cc2a=${M()[0xcc2a]} cursor=${JSON.stringify(c)}`);
};

(async () => {
  loadSnapshotFile(emu, "/home/lumen/pokemon/saves/wild-battle-items.state.gz");
  await emu.framesAsync(120); await sync.settle();
  // reach main menu
  for (let i = 0; i < 40; i++) {
    if (bat.atMainMenu()) break;
    await emu.tapAsync(KEYS.A, 8, 16); await sync.settle(150);
  }
  // patch battle mon to 4 moves: SCRATCH, GROWL, EMBER, LEER
  const mv = sym.addr("wBattleMonMoves"), pp = sym.addr("wBattleMonPP");
  [0x0a, 0x2d, 0x34, 0x2b].forEach((m, i) => { M()[mv + i] = m; M()[pp + i] = 35; });
  await emu.tapAsync(KEYS.UP, 8, 10); await emu.tapAsync(KEYS.LEFT, 8, 10);
  await emu.tapAsync(KEYS.A, 8, 20); await sync.settle(300);
  console.log("=== 4-move menu ==="); dump("open");
  console.log("screen:\n" + scr.text());
  // Second element is the actual KEYS value. It previously held single letters
  // ("d","u","r","l") looked up as KEYS[k], which are not members of KEYS — so
  // every tap in this probe was passing `undefined` and pressing nothing, on top
  // of not type-checking. Declared [string, number][] and now genuinely is one.
  const seq: [string, number][] = [
    ["DOWN", KEYS.DOWN], ["DOWN", KEYS.DOWN], ["DOWN", KEYS.DOWN],
    ["UP", KEYS.UP], ["UP", KEYS.UP], ["UP", KEYS.UP],
    ["RIGHT", KEYS.RIGHT], ["LEFT", KEYS.LEFT],
  ];
  for (const [label, k] of seq) {
    await emu.tapAsync(k, 8, 10); await sync.settle(120);
    dump(`after ${label}`);
  }
})();
