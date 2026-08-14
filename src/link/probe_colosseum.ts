// M3-BATTLE PROBE (wq#431, 2026-08-10) — reach the COLOSSEUM and observe.
//
// The trade path selects entry 0 of the Cable Club room menu ("TRADE CENTER").
// This probe selects entry 1 ("COLOSSEUM") and reports what the ROM does, so
// the battle session is written against measured values instead of assumed
// LINK_STATE_* constants.
//
// ROM-VERIFIED (LoadSpecialWarpData, bank 1 $62FE-$6334, warp specs $6428-$6447):
//   cp $EF -> TRADE CENTER, cp $F0 -> COLOSSEUM.
//   7 bytes are copied to wCurMap($D35E)..wXBlockCoord($D364):
//     colosseum, $FFAA==2 (master): f0 0b c7 04 03 00 01  -> map $F0 at (x3,y4)
//     colosseum, friend:            f0 0d c7 04 06 00 00  -> map $F0 at (x6,y4)
//   Identical coordinates to the trade tables, so both sides spawn already
//   standing on their spots; they only have to face each other.
//
//   npx tsx src/link/probe_colosseum.ts

import { Emulator, loadSnapshotFile, KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { SerialBus } from "./serialbus";
import { installSerialHook } from "./hook";
import { runCycles, setSlice } from "./lockstep";
import { writeIdentity } from "./identity";
import { ckptPath, linkEventsDir, romPath } from "../fixtures";

const COLOSSEUM = 0xF0;
const MENU = { cursor: 0xCC26, max: 0xCC28, watched: 0xCC29 };

function side(tag: string) {
  const emu = new Emulator(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym"));
  const rom = new Rom(romPath("pokeblue.gb"));
  const ebus = new EventBus(linkEventsDir(), `col-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync);
  return { tag, emu, nav, scr };
}

(async () => {
  const A = side("A"), B = side("B");
  const bus = new SerialBus();
  const snap = process.env.SNAP ?? ckptPath("center-m2b.state.gz");
  loadSnapshotFile(A.emu, snap); loadSnapshotFile(B.emu, snap);
  A.emu.frames(6); B.emu.frames(6);
  writeIdentity(B.emu.mem(), { playerName: "BOB", playerID: 0x1122, mon1Level: 25, mon1Nick: "BOBMON" });

  // Same shape as TradeSession.step: keys are re-pressed every frame and the
  // bus is ticked between frames, which is what makes byte delivery land.
  const step = (n: number, ka?: number, kb?: number) => {
    for (let i = 0; i < n; i++) {
      if (ka !== undefined) (A.emu as any).gb.pressKey(ka);
      if (kb !== undefined) (B.emu as any).gb.pressKey(kb);
      (A.emu as any).gb.doFrame();
      (B.emu as any).gb.doFrame();
      bus.tick();
    }
  };
  const grid = (s: any) => (s.scr.textGrid?.() ?? []).join("\n");
  const m = (s: any, a: number) => s.emu.mem()[a] & 0xFF;
  const snapshot = (s: any) =>
    `${s.tag}[map=$${m(s, 0xD35E).toString(16)} ls=${m(s, 0xD12B)} ` +
    `cur=${m(s, MENU.cursor)}/${m(s, MENU.max)} keys=$${m(s, MENU.watched).toString(16)} ` +
    `inBattle=${m(s, 0xD057)}]`;

  // ---- attendant + handshake (identical to the verified trade path) ----
  await A.nav.goto(11, 3); await B.nav.goto(11, 3);
  step(20, KEYS.UP, KEYS.UP); step(20);
  installSerialHook(A.emu.core, bus, 0);
  installSerialHook(B.emu.core, bus, 1);

  // ---- room menu: press A only while a side is NOT yet showing the menu,
  //      then DOWN to entry 1 with cursor read-back, then A on both.
  let chosen = false;
  for (let r = 0; r < 90; r++) {
    const onMenuA = grid(A).includes("TRADE CENTER"), onMenuB = grid(B).includes("TRADE CENTER");
    if (onMenuA && onMenuB) {
      const ca = m(A, MENU.cursor), cb = m(B, MENU.cursor);
      if (!chosen) console.log(`  room menu reached: ${snapshot(A)} ${snapshot(B)}`);
      if (ca === 1 && cb === 1) { step(8, KEYS.A, KEYS.A); step(24); chosen = true; }
      else { step(8, ca === 1 ? undefined : KEYS.DOWN, cb === 1 ? undefined : KEYS.DOWN); step(24); }
    } else {
      step(8, onMenuA ? undefined : KEYS.A, onMenuB ? undefined : KEYS.A);
      step(22);
    }
    if (m(A, 0xD35E) === COLOSSEUM && m(B, 0xD35E) === COLOSSEUM) break;
  }
  step(180);
  console.log(`  after room select: ${snapshot(A)} ${snapshot(B)} exchanges=${bus.exchanges}`);
  if (m(A, 0xD35E) !== COLOSSEUM || m(B, 0xD35E) !== COLOSSEUM) {
    console.log("  NOT IN COLOSSEUM — stopping"); process.exit(1);
  }

  // ---- face each other and open the link battle ----
  const fine = Number(process.env.FINE ?? 64);
  setSlice(A.emu.core, fine); setSlice(B.emu.core, fine);
  bus.deferTicks = 1;
  const cores = [A.emu.core, B.emu.core];
  bus.peerRunner = (p: 0 | 1, c: number) => runCycles(cores[p], c);
  bus.catchUpCycles = 64; bus.catchUpMaxSteps = 256;

  await A.nav.goto(3, 4); await B.nav.goto(6, 4);
  step(16 * fine, KEYS.RIGHT, KEYS.LEFT); step(16 * fine);
  for (let k = 0; k < 20; k++) {
    step(8, KEYS.A, KEYS.A); step(24);
    if (m(A, 0xD12B) >= 2 && m(B, 0xD12B) >= 2) break;
  }
  console.log(`  initiated: ${snapshot(A)} ${snapshot(B)} exchanges=${bus.exchanges}`);

  for (let k = 0; k < 60; k++) {
    step(8 * fine, KEYS.A, KEYS.A); step(24 * fine);
    if (k % 5 === 0) console.log(`    k=${k} ${snapshot(A)} ${snapshot(B)} ex=${bus.exchanges}`);
    if (m(A, 0xD057) !== 0 && m(B, 0xD057) !== 0) break;
  }
  console.log("\n================ COLOSSEUM PROBE RESULT ================");
  console.log(`${snapshot(A)}\n${snapshot(B)}\nexchanges=${bus.exchanges} cuTimeouts=${bus.catchUpTimeouts}`);
  console.log("--- A screen ---\n" + grid(A));
  console.log("--- B screen ---\n" + grid(B));
  process.exit(0);
})();
