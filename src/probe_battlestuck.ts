// Diagnose the battle_move timeout: load current live checkpoint, inspect why
// the battle menu never appears.
import { Emulator, loadSnapshotFile, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { EventBus } from "./events";
import { Battle } from "./battle";
import { StateReader } from "./state";

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
const scr = new Screen(emu, sym);
const sync = new Sync(emu, sym);
const bus = new EventBus("/tmp", "probe-bstuck-" + Date.now());
const dlg = new Dialog(emu, scr, sync, bus, sym);
const bat = new Battle(emu, sym, scr, sync, dlg, bus);
const reader = new StateReader(emu, sym);
const M = () => emu.mem();

(async () => {
  await emu.framesAsync(60); await sync.settle();
  const s = reader.read();
  console.log("state: map", s.map, "inBattle", s.inBattle, "active()", bat.active());
  console.log("screen:\n" + scr.text());
  console.log("dlg.open:", dlg.open(), "awaitingPrompt:", scr.awaitingPrompt?.(), "atMainMenu:", bat.atMainMenu());
  // key battle RAM
  const rd = (n: string) => { try { return M()[sym.addr(n)]; } catch { return "?"; } };
  console.log("wIsInBattle:", rd("wIsInBattle"), "wBattleMenuID?:", rd("wCurrentMenuItem"), "wMenuJoypadPollCount:", rd("wMenuJoypadPollCount"));
  console.log("wTextBoxID:", rd("wTextBoxID"), "hJoyHeld:", rd("hJoyHeld"));
  // Try to drive the menu manually and watch what happens over frames
  console.log("\n=== stepping frames to see if menu appears on its own ===");
  for (let i = 0; i < 20; i++) {
    await emu.framesAsync(30);
    if (bat.atMainMenu()) { console.log(`atMainMenu TRUE at step ${i}`); break; }
    if (!bat.active()) { console.log(`battle ended at step ${i}`); break; }
  }
  console.log("after idle: atMainMenu:", bat.atMainMenu(), "active:", bat.active());
  console.log("screen after idle:\n" + scr.text());
  // Now try tapping A to advance any stuck text
  console.log("\n=== tapping A x5 to advance text ===");
  for (let i = 0; i < 5; i++) { await emu.tapAsync(KEYS.A, 8, 20); await sync.settle(200); console.log(`  after A#${i}: atMainMenu=${bat.atMainMenu()} active=${bat.active()} txt=${JSON.stringify(scr.text().slice(0,40))}`); }
})();
