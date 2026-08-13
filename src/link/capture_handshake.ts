// wq#481 — capture the Cable Club handshake BYTE TAPE from the in-process M3
// rig (two real cores over SerialBus). The tape is the ground truth the mock
// peer replays over TCP. Read-only tap on masterExchange; drive logic is the
// proven drive_cableclub_menu sequence. Standalone — never in the live service.
import { writeFileSync } from "fs";
import { Emulator, loadSnapshotFile, KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { Dialog } from "../dialog";
import { readLinkState } from "./linkstate";
import { SerialBus } from "./serialbus";
import { installSerialHook } from "./hook";
import { ckptPath, eventsDir, romPath } from "../fixtures";

function stack(tag: string) {
  const emu = new Emulator(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym")); const rom = new Rom(romPath("pokeblue.gb"));
  const ebus = new EventBus(eventsDir(), `m5a-cap-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom); const scr = new Screen(emu, sym); const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync); const dlg = new Dialog(emu, scr, sync, ebus, sym);
  return { emu, nav, dlg, scr, tag };
}
const A = stack("A"), B = stack("B");
let LINKREF: any = null;
const grid = (s: any) => (s.scr.textGrid?.() ?? []).join("\n");
const onMenu = (s: any) => grid(s).includes("TRADE CENTER");
const info = (s: any) => ({
  role: s.emu.mem()[0xFFAA] & 0xFF, ls: readLinkState(s.emu.mem()).linkState,
  map: s.emu.mem()[0xD35E] & 0xFF, menu: onMenu(s),
  txt: (s.dlg.boxLines?.() ?? []).filter(Boolean).join(" ").slice(0, 26),
});
function step(n: number, keyA?: number, keyB?: number) {
  for (let i = 0; i < n; i++) {
    if (keyA !== undefined) (A.emu as any).gb.pressKey(keyA);
    if (keyB !== undefined) (B.emu as any).gb.pressKey(keyB);
    (A.emu as any).gb.doFrame(); (B.emu as any).gb.doFrame();
    if (LINKREF) LINKREF.tick();
  }
}

(async () => {
  loadSnapshotFile(A.emu, ckptPath("center-m2b.state.gz"));
  loadSnapshotFile(B.emu, ckptPath("center-m2b.state.gz"));
  A.emu.frames(6); B.emu.frames(6);
  await A.nav.goto(11, 3); await B.nav.goto(11, 3);
  step(20, KEYS.UP, KEYS.UP); step(20);
  A.emu.frames(Number(process.env.SKEW ?? 27));   // wq#434 symmetry break

  const link = new SerialBus(); LINKREF = link;
  installSerialHook(A.emu.core, link, 0);
  installSerialHook(B.emu.core, link, 1);

  // THE TAP: record every exchange (who mastered, what went out, what came back)
  type Rec = { n: number; master: 0 | 1; out: number; in: number; phase: string };
  const tape: Rec[] = [];
  let phase = "connect";
  const orig = link.masterExchange.bind(link);
  link.masterExchange = (mp: 0 | 1, mo: number) => {
    const r = orig(mp, mo);
    tape.push({ n: tape.length, master: mp, out: mo & 0xFF, in: r & 0xFF, phase });
    return r;
  };

  console.log("=== phase 1: handshake (blind taps) ===");
  for (let r = 0; r < 60; r++) {
    step(8, KEYS.A, KEYS.A); step(22);
    const a = info(A), b = info(B);
    if (r % 5 === 0) console.log(`p1r${r} ex=${link.exchanges} A role=${a.role} ls=${a.ls} menu=${a.menu?1:0} "${a.txt}" | B role=${b.role} ls=${b.ls} menu=${b.menu?1:0} "${b.txt}"`);
    if (a.menu || b.menu) { console.log("menu reached at r" + r); break; }
  }
  phase = "menu";
  console.log("=== phase 2: state-driven TRADE CENTER select ===");
  for (let r = 0; r < 50; r++) {
    const a = info(A), b = info(B);
    const wants = (x: any) => x.menu || x.txt.length > 0;
    step(6, wants(a) ? KEYS.A : undefined, wants(b) ? KEYS.A : undefined); step(24);
    const s2 = { a: info(A), b: info(B) };
    if (r % 5 === 0) console.log(`p2r${r} ex=${link.exchanges} A ls=${s2.a.ls} map=${s2.a.map} | B ls=${s2.b.ls} map=${s2.b.map}`);
    if (s2.a.map === 0xEF || s2.b.map === 0xEF) { console.log("*** TRADE CENTER (0xEF) at r" + r + " ***"); break; }
  }

  const a = info(A), b = info(B);
  console.log(`FINAL: exchanges=${link.exchanges} A role=${a.role} ls=${a.ls} map=${a.map} | B role=${b.role} ls=${b.ls} map=${b.map}`);
  // annotate which port ended MASTER (role $FFAA: received byte; 2=got waiting=IS master)
  writeFileSync("docs/multiplayer/evidence/m5a-handshake-tape.json",
    JSON.stringify({ captured: new Date().toISOString(), skew: Number(process.env.SKEW ?? 27),
      finalA: a, finalB: b, tape }, null, 1));
  console.log(`tape: ${tape.length} exchanges -> docs/multiplayer/evidence/m5a-handshake-tape.json`);
  // compact console view of the tape
  console.log(tape.map(t => `${t.n}:${t.master}>${t.out.toString(16)}<${t.in.toString(16)}[${t.phase[0]}]`).join(" "));
})();
