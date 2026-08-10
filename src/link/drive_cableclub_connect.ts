// PROMOTED FROM SANDBOX (wq#434) — Cable Club connection driver.
// Establishes a real Gen1 link between two cores over our SerialBus.
// USAGE: SKEW=27 ARB=0 npx tsx src/link/drive_cableclub_connect.ts
// Requires checkpoints/center-m2b.state.gz (a Pokemon Center checkpoint).
// This DRIVES emulators — run it standalone, never inside the live service.
// M2b step 5 (wq#434) — SANDBOX. TRUE simultaneous handshake.
//
// FINDING that drives this (scratch/m2b_scseq.ts): the ROM alternates
// SC=$80/$81 (73 writes) DURING the attendant dialog phase — that IS the
// connection window — and issues ZERO SC writes after the save-YES. So both
// cores must be inside that dialog/probe window AT THE SAME TIME with the bus
// attached. Sequential `interactAt` can't do that (it runs one core's frames to
// completion while the other is frozen), so we drive the dialog MANUALLY in
// lockstep: tap A on both cores, step both one frame at a time, repeat.

import { Emulator, loadSnapshotFile, KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { Dialog } from "../dialog";
import { readLinkState, LINK_ADDR } from "../link/linkstate";
import { SerialBus } from "../link/serialbus";
import { installSerialHook } from "../link/hook";

function stack(tag: string) {
  const emu = new Emulator("roms/pokeblue.gb");
  const sym = new SymbolTable("roms/pokeblue.sym"); const rom = new Rom("roms/pokeblue.gb");
  const ebus = new EventBus("events", `m2b5-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom); const scr = new Screen(emu, sym); const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync); const dlg = new Dialog(emu, scr, sync, ebus, sym);
  return { emu, nav, dlg, scr, tag };
}

const A = stack("A"), B = stack("B");
const st = (s: any) => ({
  ls: readLinkState(s.emu.mem()).linkState,
  sc: s.emu.mem()[0xFF02] & 0xFF,
  to: s.emu.mem()[LINK_ADDR.wLinkTimeoutCounter] & 0xFF,
  txt: (s.dlg.boxLines?.() ?? []).filter(Boolean).join(" ").slice(0, 34),
});
const show = (t: string) => {
  const a = st(A), b = st(B);
  console.log(`[${t}] A ls=${a.ls} sc=0x${a.sc.toString(16)} to=${a.to} "${a.txt}" | B ls=${b.ls} sc=0x${b.sc.toString(16)} to=${b.to} "${b.txt}"`);
  return { a, b };
};

/** step both cores together, n frames, optionally holding a key on both */
let LINKREF: any = null;
/** Shrink each doFrame() to 1/N of a frame so two cores interleave finely.
 *  serverboy runs until CPUCyclesTotal is consumed per doFrame(); lowering it
 *  gives sub-frame lockstep, which is what a real cable's ~512-cycle transfer
 *  window needs (a full 70k-cycle frame is far too coarse). */
function setSlice(emu: any, div: number) {
  const c = emu.core;
  const base = c.CPUCyclesTotalBase;
  c.CPUCyclesTotalBase = c.CPUCyclesTotal = Math.max(4, (base / div) & ~3);
  return { base, now: c.CPUCyclesTotal };
}
function lockstep(n: number, key?: number) {
  for (let i = 0; i < n; i++) {
    if (key !== undefined) { (A.emu as any).gb.pressKey(key); (B.emu as any).gb.pressKey(key); }
    (A.emu as any).gb.doFrame(); (B.emu as any).gb.doFrame();
    if (LINKREF) LINKREF.tick();      // advance deferred serial completion
  }
}

(async () => {
  loadSnapshotFile(A.emu, "checkpoints/center-m2b.state.gz");
  loadSnapshotFile(B.emu, "checkpoints/center-m2b.state.gz");
  A.emu.frames(6); B.emu.frames(6);

  // 1. Walk both to the tile below the attendant, facing UP — NO dialog yet.
  console.log("=== 1. both walk adjacent to attendant (no dialog) ===");
  await A.nav.goto(11, 3); await B.nav.goto(11, 3);
  lockstep(20, KEYS.UP);      // face the attendant on both
  lockstep(20);
  show("adjacent, facing up");

  // 2. Attach the wire BEFORE any dialog/probing starts.
  console.log("=== 2. attach bus ===");
  // SYMMETRY BREAK: two real players never press simultaneously. Identical
  // checkpoints in perfect lockstep make both ROMs stage the SAME handshake byte
  // at the same instant (both send 2, or both send 1), so neither gets the
  // complementary value it needs. A small phase offset reproduces reality: one
  // side is waiting (SB=2) while the other probes (SB=1).
  const SKEW = Number(process.env.SKEW ?? 0);
  if (SKEW > 0) { A.emu.frames(SKEW); console.log(`   skew: A advanced ${SKEW} frames`); }
  const SLICE = Number(process.env.SLICE ?? 1);
  if (SLICE > 1) { const r = setSlice(A.emu, SLICE); setSlice(B.emu, SLICE); console.log(`   cycle slice: ${r.base} -> ${r.now} (1/${SLICE} frame)`); }
  const link = new SerialBus();
  link.deferTicks = Number(process.env.DEFER ?? 0);
  LINKREF = link;
  link.arbitrate = process.env.ARB !== "0";
  console.log("   deferTicks =", link.deferTicks, "arbitrate =", link.arbitrate);
  installSerialHook(A.emu.core, link, 0);
  installSerialHook(B.emu.core, link, 1);
  console.log("   attached:", link.attached);

  // 3. Drive the dialog on BOTH in lockstep: tap A, step together, repeat.
  console.log("=== 3. lockstep dialog + probe window ===");
  let lastEx = link.exchanges, lastA = st(A).ls, lastB = st(B).ls;
  for (let r = 0; r < 60; r++) {
    lockstep(8 * SLICE, KEYS.A);   // A pressed on both simultaneously
    lockstep(22 * SLICE);          // release + settle, both stepping together
    const { a, b } = show(`r${r}`);
    if (link.exchanges !== lastEx) { console.log(`   *** EXCHANGES ${lastEx} -> ${link.exchanges} ***`); lastEx = link.exchanges; }
    if (a.ls !== lastA || b.ls !== lastB) { console.log(`   *** LINK STATE A:${lastA}->${a.ls} B:${lastB}->${b.ls} ***`); lastA = a.ls; lastB = b.ls; }
    if (a.ls !== 0 && b.ls !== 0) { console.log("   *** BOTH IN LINK STATE — CONNECTED ***"); break; }
  }
  console.log(`\n=== final: exchanges=${link.exchanges} masterLock=${link.masterPortLock} demoted=${link.demotedProbes} ===`);
  show("end");
})();
