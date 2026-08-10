// PROMOTED FROM SANDBOX (wq#431 M3) — Cable Club -> TRADE CENTER driver.
// RESULT 2026-08-08: BOTH cores reach map 239 ($EF), the Trade Center room.
// Two emulated Game Boys linked over our from-scratch SerialBus, in the same
// multiplayer room, via the ROM's own link code.
// USAGE: SKEW=0 TAP=both npx tsx src/link/drive_cableclub_menu.ts
// DRIVES emulators — standalone only, never inside the live service.
// M3 (wq#431) — SANDBOX. State-driven Cable Club menu driver.
//
// Prior finding (wq#434): blind-tapping A on BOTH cores establishes the link but
// desyncs them — the skewed core runs past the room-select menu (blank screen,
// nybble send=0x00 = no choice) while the peer sits on the menu waiting for a
// selection that never comes.
// Fix: after the handshake, drive each core by ITS OWN screen state — only press
// A on a core that is actually showing the menu. Deterministic, same discipline
// as heal_at_center.
//
// Menu (observed): "TRADE CENTER" / "COLOSSEUM" / "CANCEL", cursor at (6,7) on
// TRADE CENTER. Selection is exchanged over the link
// (Serial_ExchangeLinkMenuSelection @ $2247; nybble send $CC42 / recv $CC3E).

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
  const ebus = new EventBus("events", `m3-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom); const scr = new Screen(emu, sym); const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync); const dlg = new Dialog(emu, scr, sync, ebus, sym);
  return { emu, nav, dlg, scr, tag };
}
const A = stack("A"), B = stack("B");
let LINKREF: any = null;

const grid = (s: any) => (s.scr.textGrid?.() ?? []).join("\n");
const onMenu = (s: any) => grid(s).includes("TRADE CENTER");
const info = (s: any) => ({
  // $FFAA = connection status / ROLE: 2 = MASTER (drives clock), 1 = SLAVE.
  // Set by the Serial ISR to the RECEIVED byte during establishConnectionLoop.
  role: s.emu.mem()[0xFFAA] & 0xFF,
  done: s.emu.mem()[0xFFA9] & 0xFF,   // transfer-complete flag set by ISR
  next: s.emu.mem()[0xFFAC] & 0xFF,   // byte the ISR will stage next
  last: s.emu.mem()[0xFFAD] & 0xFF,   // last received byte
  ls: readLinkState(s.emu.mem()).linkState,
  map: s.emu.mem()[0xD35E] & 0xFF,
  send: s.emu.mem()[0xCC42] & 0xFF,
  recv: s.emu.mem()[0xCC3E] & 0xFF,
  menu: onMenu(s),
  txt: (s.dlg.boxLines?.() ?? []).filter(Boolean).join(" ").slice(0, 26),
});
const show = (t: string) => {
  const a = info(A), b = info(B);
  console.log(`[${t}] ex=${LINKREF?LINKREF.exchanges:0} A role=${a.role.toString(16)} done=${a.done} nxt=${a.next.toString(16)} lst=${a.last.toString(16)} ls=${a.ls} map=${a.map} menu=${a.menu?1:0} s/r=${a.send.toString(16)}/${a.recv.toString(16)} "${a.txt}" | B role=${b.role.toString(16)} done=${b.done} nxt=${b.next.toString(16)} lst=${b.last.toString(16)} ls=${b.ls} map=${b.map} menu=${b.menu?1:0} s/r=${b.send.toString(16)}/${b.recv.toString(16)} "${b.txt}"`);
  return { a, b };
};

/** step both together; key may be applied per-core (null = none) */
function step(n: number, keyA?: number, keyB?: number) {
  for (let i = 0; i < n; i++) {
    if (keyA !== undefined) (A.emu as any).gb.pressKey(keyA);
    if (keyB !== undefined) (B.emu as any).gb.pressKey(keyB);
    (A.emu as any).gb.doFrame(); (B.emu as any).gb.doFrame();
    if (LINKREF) LINKREF.tick();
  }
}

(async () => {
  loadSnapshotFile(A.emu, "checkpoints/center-m2b.state.gz");
  loadSnapshotFile(B.emu, "checkpoints/center-m2b.state.gz");
  A.emu.frames(6); B.emu.frames(6);
  await A.nav.goto(11, 3); await B.nav.goto(11, 3);
  step(20, KEYS.UP, KEYS.UP); step(20);

  const SKEW = Number(process.env.SKEW ?? 27);
  A.emu.frames(SKEW);                       // symmetry break (wq#434 finding)
  const link = new SerialBus(); LINKREF = link;
  installSerialHook(A.emu.core, link, 0);
  installSerialHook(B.emu.core, link, 1);
  console.log("bus attached, skew:", SKEW);

  // PHASE 1: blind-tap both to drive the attendant dialog + handshake, but STOP
  // as soon as either side reaches the menu.
  console.log("=== phase 1: handshake ===");
  for (let r = 0; r < 60; r++) {
    step(8, KEYS.A, KEYS.A); step(22);
    const { a, b } = show(`p1r${r}`);
    if (a.menu || b.menu) { console.log("   menu reached — stopping blind taps"); break; }
  }

  // PHASE 2: state-driven. Only press A on a core that is showing the menu.
  console.log("=== phase 2: state-driven menu select (TRADE CENTER) ===");
  for (let r = 0; r < 50; r++) {
    const a = info(A), b = info(B);
    // Tap a core when it is on the menu OR has a dialog box open (the slave sits
    // on "Please wait." and still needs input to advance). TAP=menu restricts to
    // menu-only (previous behaviour) for comparison.
    const TAPMODE = process.env.TAP ?? "both";
    const wants = (x: any) => TAPMODE === "menu" ? x.menu : (x.menu || x.txt.length > 0);
    const ka = wants(a) ? KEYS.A : undefined;
    const kb = wants(b) ? KEYS.A : undefined;
    step(6, ka, kb); step(24);
    const st = show(`p2r${r}`);
    if (st.a.map === 0xEF || st.b.map === 0xEF) { console.log("   *** TRADE CENTER MAP (0xEF) REACHED ***"); break; }
    if (st.a.ls >= 2 && st.b.ls >= 2) { console.log("   *** BOTH SIDES ADVANCED PAST CABLE CLUB ***"); break; }
  }

  console.log(`\n=== final exchanges=${link.exchanges} ===`);
  show("end");
  console.log("--- A ---"); console.log(grid(A));
  console.log("--- B ---"); console.log(grid(B));
})();
