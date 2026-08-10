// Battle-menu RECON (wq#431, 2026-08-10). The first turn-driver guess cycled
// wPlayerSelectedMove through all four move ids and never resolved a turn, so
// stop guessing: open a real link battle, then watch what the ROM does with NO
// input at all, then with A only, logging the menu RAM and both screens.
//
//   npx tsx src/link/probe_linkbattle_menu.ts          (idle 24, then A 24)
//   KEYS=none npx tsx src/link/probe_linkbattle_menu.ts

import { Emulator, loadSnapshotFile, KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { writeIdentity } from "./identity";
import { LinkBattleSession, BattleSide } from "./battle";

function side(tag: string): BattleSide {
  const emu = new Emulator("roms/pokeblue.gb");
  const sym = new SymbolTable("roms/pokeblue.sym");
  const rom = new Rom("roms/pokeblue.gb");
  const ebus = new EventBus("events", `rec-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync);
  return { tag, emu, sym, nav, scr };
}

(async () => {
  const A = side("A"), B = side("B");
  const snap = process.env.SNAP ?? "checkpoints/center-m2b.state.gz";
  loadSnapshotFile(A.emu, snap); loadSnapshotFile(B.emu, snap);
  A.emu.frames(6); B.emu.frames(6);
  writeIdentity(B.emu.mem(), { playerName: "BOB", playerID: 0x1122, mon1Level: 25, mon1Nick: "BOBMON" });

  const s = new LinkBattleSession(A, B, { fineDiv: Number(process.env.FINE ?? 64) });
  await s.connect();
  const open = await s.openBattle();
  console.log(`battle open=${open}`);
  console.log(`A moves=[${s.probeMoves("A").join(",")}] B moves=[${s.probeMoves("B").join(",")}]`);
  const fine = Number(process.env.FINE ?? 64);

  console.log("\n===== PHASE 1: NO INPUT =====");
  for (let i = 0; i < 24; i++) {
    s.probeStep(16 * fine);
    console.log(`  i=${i} ${s.probeLine()}`);
  }
  console.log(s.probeScreens());

  if (process.env.KEYS !== "none") {
    console.log("\n===== PHASE 2: A ON BOTH =====");
    for (let i = 0; i < 24; i++) {
      s.probeStep(6 * fine, KEYS.A, KEYS.A);
      s.probeStep(10 * fine);
      console.log(`  i=${i} ${s.probeLine()}`);
    }
    console.log(s.probeScreens());
  }
  process.exit(0);
})();
