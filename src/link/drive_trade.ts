// PROMOTED (wq#436) — full Cable Club TRADE driver with PEER-EXECUTION fix.
// RESULT 2026-08-08: BOTH cores advance through the 415-byte party-block exchange
// to the trade menu (LINK_STATE 50), parties intact — the slave clears
// "PLEASE WAIT!" for the first time. Uses SerialBus peer catch-up (runCycles):
// the follower core is advanced in small bursts until it commits its next real
// SB byte before each delivery, closing the one-instruction race the PC trace
// exposed ($FFA9=0 throughout — the follower is running, not blocked).
// USAGE: FINE=64 DEFER=1 CATCHUP=1 ROUNDS=60 npx tsx src/link/drive_trade.ts
// DRIVES emulators — standalone only, never inside the live service.
// M3b (wq#431) — SANDBOX. Inside the Trade Center: positions, room layout, and
// whether the two cores keep syncing (Gen1 mirrors the partner's movement over
// the link, so an idle bus here means the session is not actually running).
//
// Reuses the working connection sequence (SKEW=0 + TAP=both + both hook fixes)
// that lands BOTH cores in map 239.

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
import { runCycles } from "./lockstep";
import { ckptPath, linkEventsDir, romPath } from "../fixtures";

function stack(tag: string) {
  const emu = new Emulator(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym")); const rom = new Rom(romPath("pokeblue.gb"));
  const ebus = new EventBus(linkEventsDir(), `m3b-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom); const scr = new Screen(emu, sym); const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync); const dlg = new Dialog(emu, scr, sync, ebus, sym);
  return { emu, nav, dlg, scr, map, tag };
}
const A = stack("A"), B = stack("B");
let LINK: any = null;
const grid = (s: any) => (s.scr.textGrid?.() ?? []).join("\n");
const P = (s: any) => { const p = s.nav.pos(); return `${p.map}:${p.x},${p.y}`; };
const LS = (s: any) => readLinkState(s.emu.mem()).linkState;
/** Shrink each doFrame() so the two cores interleave at ~one serial transfer.
 *  A real DMG transfer is ~512 cycles; a full frame is ~70k. Running A for a
 *  whole frame freezes B, so during a 415-byte block the master clocks hundreds
 *  of bytes while the slave cannot stage a single fresh reply (it just resends
 *  its last byte -> corrupted party block). */
const SLICE_BASE = new WeakMap<any, number>();
function setSlice(emu: any, div: number) {
  const c = emu.core;
  if (!SLICE_BASE.has(c)) SLICE_BASE.set(c, c.CPUCyclesTotalBase);
  const base = SLICE_BASE.get(c)!;
  c.CPUCyclesTotalBase = c.CPUCyclesTotal = Math.max(4, (base / div) & ~3);
  return c.CPUCyclesTotal;
}
function step(n: number, ka?: number, kb?: number) {
  for (let i = 0; i < n; i++) {
    if (ka !== undefined) (A.emu as any).gb.pressKey(ka);
    if (kb !== undefined) (B.emu as any).gb.pressKey(kb);
    (A.emu as any).gb.doFrame(); (B.emu as any).gb.doFrame();
    if (LINK) LINK.tick();
  }
}
/** TRUE simultaneity: alternate the two cores at instruction scale (tens of
 *  cycles) instead of 524-cycle slices, so the follower's ISR + main loop
 *  genuinely run between the master's clocks — which is the hardware condition
 *  that makes its staged SB correct by construction. */
function microStep(totalCycles: number, ka?: number, kb?: number) {
  const CH = Number(process.env.CYCLE ?? 32);
  const ca = (A.emu as any).core, cb = (B.emu as any).core;
  let done = 0;
  while (done < totalCycles) {
    if (ka !== undefined) (A.emu as any).gb.pressKey(ka);
    if (kb !== undefined) (B.emu as any).gb.pressKey(kb);
    runCycles(ca, CH); runCycles(cb, CH);
    if (LINK) LINK.tick();
    done += CH;
  }
}

(async () => {
  loadSnapshotFile(A.emu, ckptPath("center-m2b.state.gz"));
  loadSnapshotFile(B.emu, ckptPath("center-m2b.state.gz"));
  A.emu.frames(6); B.emu.frames(6);
  await A.nav.goto(11, 3); await B.nav.goto(11, 3);
  step(20, KEYS.UP, KEYS.UP); step(20);
  // Coarse (full-frame) for navigation + handshake = fast wall clock.
  // FINE slice is enabled later, only for the 415-byte party block transfer,
  // where the master would otherwise clock hundreds of bytes while the frozen
  // slave resends one stale byte.
  const FINE = Number(process.env.FINE ?? 64);
  const DEFER = Number(process.env.DEFER ?? 1);
  const link = new SerialBus(); LINK = link;
  installSerialHook(A.emu.core, link, 0);
  installSerialHook(B.emu.core, link, 1);

  // handshake + menu (the proven sequence)
  for (let r = 0; r < 60; r++) {
    step(8, KEYS.A, KEYS.A); step(22);
    if ((A.emu.mem()[0xD35E] & 0xFF) === 0xEF && (B.emu.mem()[0xD35E] & 0xFF) === 0xEF) break;
    const ga = grid(A), gb = grid(B);
    // keep tapping while dialogs/menus are up
    if (!ga.includes("TRADE CENTER") && !gb.includes("TRADE CENTER")) continue;
  }
  console.log(`both in trade center? A=${P(A)} B=${P(B)}  ex=${link.exchanges}`);

  // Trace SC/SB writes in the trade room: is the ROM still trying to clock?
  const scA: number[] = [], scB: number[] = [];
  for (const [s, arr] of [[A, scA], [B, scB]] as any[]) {
    const c = s.emu.core; const o = c.memoryHighWriter[0x2];
    const w = (p2: any, a: number, d: number) => { arr.push(d & 0xFF); return o(p2, a, d); };
    c.memoryHighWriter[0x2] = c.memoryWriter[0xFF02] = w;
  }
  // Observe: does the session keep exchanging while idle?
  const e0 = link.exchanges;
  step(180);
  console.log(`idle 180 frames -> exchanges ${e0} -> ${link.exchanges} (delta ${link.exchanges - e0})`);
  console.log(`A ls=${LS(A)} pos=${P(A)} | B ls=${LS(B)} pos=${P(B)}`);
  console.log(`SC writes in trade room: A=${scA.length} [${[...new Set(scA)].map(x=>"0x"+x.toString(16)).join(",")}] B=${scB.length} [${[...new Set(scB)].map(x=>"0x"+x.toString(16)).join(",")}]`);


  // INITIATE TRADE: A at (3,4) and B at (6,4) face each other across the table.
  // A faces RIGHT, B faces LEFT, both press A.
  // FINE interleaving must cover the SYNC phase too, not just the block: the
  // ROM aligns both sides with Serial_SyncAndExchangeNybble immediately before
  // the 415-byte exchange. Aligning coarsely lets the initiator enter the block
  // earlier, so it finishes and stops clocking while the follower still waits
  // for bytes (observed: exchanges freeze at 826, slave stuck on "PLEASE WAIT!").
  console.log(`FINE slice: A=${setSlice(A.emu, FINE)} B=${setSlice(B.emu, FINE)} cycles/step, deferTicks=${DEFER}`);
  link.deferTicks = DEFER;
  link.requireFollowerReady = process.env.GATE === "1";
  if (process.env.TRACE === "1") {
    const cores = [A.emu.core, B.emu.core];
    const orig = link.masterExchange.bind(link);
    const rows: string[] = [];
    (link as any).masterExchange = (mp: 0|1, out: number) => {
      const f = cores[mp ^ 1];
      const pc = f.programCounter & 0xFFFF;
      const site = pc >= 0x216F && pc < 0x219A ? "ExchBytes" : pc >= 0x219A && pc < 0x2247 ? "ExchByte" : pc >= 0x2247 && pc < 0x2284 ? "MenuSel" : pc >= 0x2284 && pc < 0x22c3 ? "SyncNyb" : pc >= 0x2125 && pc < 0x216F ? "ISR" : "0x"+pc.toString(16);
      const r = orig(mp, out);
      if (rows.length < 60) rows.push(`m${mp} out=${out.toString(16)} in=${r.toString(16)} | fPC=${site} FFA9=${f.memory[0xFFA9]&0xFF} FFAC=${(f.memory[0xFFAC]&0xFF).toString(16)} SB=${(f.memory[0xFF01]&0xFF).toString(16)} IME=${f.IME?1:0} IF=${f.interruptsRequested&0xff}`);
      if (rows.length === 60) { console.log("=== EXCHANGE TRACE ==="); console.log(rows.join("\n")); rows.push("done"); }
      return r;
    };
  }
  // PEER CATCH-UP: let the bus advance whichever core needs to run so its ISR +
  // main loop complete before the next clock.
  if (process.env.CATCHUP !== "0") {
    const cores = [A.emu.core, B.emu.core];
    link.peerRunner = (port, cycles) => runCycles(cores[port], cycles);
    link.catchUpCycles = Number(process.env.CUCYCLES ?? 64);
    link.catchUpMaxSteps = Number(process.env.CUSTEPS ?? 256);
    link.holdOnCatchupMiss = process.env.HOLD !== "0";
    console.log("  peerRunner armed");
  }
  link.readyWaitLimit = Number(process.env.GATELIMIT ?? 64);
  console.log(`  followerReadyGate=${link.requireFollowerReady} limit=${link.readyWaitLimit}`);
  console.log("=== attempt trade initiation (face table, press A) ===");
  const e2 = link.exchanges;
  // ensure both are on their table tiles first (no drift), then face the table
  await A.nav.goto(3, 4); await B.nav.goto(6, 4);
  console.log(`  positioned: A=${P(A)} B=${P(B)}`);
  step(16 * FINE, KEYS.RIGHT, KEYS.LEFT); step(16 * FINE);
  // FOLLOWER-FIRST INITIATION: the master's received block arrived garbled with
  // FE ("no data") filler, and FE is EXCLUDED from the 415-byte block by the
  // patch list — so its presence proves the sender was not yet staged. The
  // master began clocking before the follower had set up its block. Give the
  // follower a head start so it is ready before the master clocks.
  const LEAD = Number(process.env.LEAD ?? 0);
  if (LEAD > 0) { console.log(`  follower-first: B leads by ${LEAD} steps`); step(8 * FINE, undefined, KEYS.A); step(LEAD * FINE); }
  for (let k = 0; k < 20; k++) {
    step(8*Number(process.env.SLICE ?? 1), KEYS.A, KEYS.A); step(24*Number(process.env.SLICE ?? 1));
    const ga = grid(A), gb = grid(B);
    const ta = ga.trim().replace(/\s+/g, " ").slice(0, 46);
    const tb = gb.trim().replace(/\s+/g, " ").slice(0, 46);
    console.log(`  t${k} ex=${link.exchanges} A=${P(A)} ls=${LS(A)} "${ta}" | B=${P(B)} ls=${LS(B)} "${tb}"`);
    if (LS(A) >= 2 && LS(B) >= 2) { console.log("   *** BOTH SIDES ADVANCED — TRADE STARTING ***"); break; }
  }
  console.log(`trade-attempt exchanges delta=${link.exchanges - e2}`);

  // DRIVE THE TRADE: both sides now at LINK_STATE_START_TRADE. Continue stepping
  // and tapping; TradeCenter_SelectMon should present the party menus. Track
  // party species on both cores (wPartySpecies $D164) to detect an actual swap.
  const party = (s: any) => Array.from({length:6},(_,i)=> s.emu.mem()[0xD164+i]&0xFF).filter(x=>x&&x!==0xFF);
  console.log(`  party BEFORE: A=[${party(A)}] B=[${party(B)}]`);
  const ROUNDS = Number(process.env.ROUNDS ?? 40);
  for (let k = 0; k < ROUNDS; k++) {
    if (process.env.MICRO === "1") { microStep(8 * 33552 / FINE * 4, KEYS.A, KEYS.A); microStep(24 * 33552 / FINE * 4); }
    else { step(8 * FINE, KEYS.A, KEYS.A); step(24 * FINE); }
    const ta = grid(A).trim().replace(/\s+/g," ").slice(0,44);
    const tb = grid(B).trim().replace(/\s+/g," ").slice(0,44);
    if (k % 10 === 0 || ta || tb)
      console.log(`  T${k} ex=${link.exchanges} A ls=${LS(A)} p=[${party(A)}] "${ta}" | B ls=${LS(B)} p=[${party(B)}] "${tb}"`);
  }
  console.log(`  party AFTER: A=[${party(A)}] B=[${party(B)}]  exchanges=${link.exchanges} gateWaits=${link.gateWaits} catchUpSteps=${link.catchUpSteps} catchUpTimeouts=${link.catchUpTimeouts}`);
  // How much of the 415-byte enemy data block did each side actually receive?
  // wSerialEnemyDataBlock = $D893 (R4). $FFAB = "still skipping FD preamble" flag.
  const blk = (s: any, n = 415) => Array.from({length:n},(_,i)=> s.emu.mem()[0xD893+i]&0xFF);
  for (const [tag, s] of [["A", A], ["B", B]] as any[]) {
    const b = blk(s);
    const nz = b.filter((x: number) => x !== 0 && x !== 0xFF).length;
    console.log(`  ${tag} enemyBlock: nonzero=${nz}/415 head=[${b.slice(0,14).map((x:number)=>x.toString(16)).join(" ")}]`);
    console.log(`  ${tag} $FFAB(preamble-flag)=${s.emu.mem()[0xFFAB]&0xFF} $FFAC(next)=${(s.emu.mem()[0xFFAC]&0xFF).toString(16)} $FFAD(last)=${(s.emu.mem()[0xFFAD]&0xFF).toString(16)}`);
  }

})();
