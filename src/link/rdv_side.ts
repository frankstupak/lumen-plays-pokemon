// wq#483 — one SIDE of a distributed rendezvous. Runs as its OWN process with
// its OWN core: no shared memory with the peer, exactly like a remote partner.
// Driven by env: RDV_ROLE=listen|connect RDV_PORT=.. RDV_ROOM=TRADE_CENTER|COLOSSEUM
//               RDV_DELAY_MS=.. (late join)  RDV_DROP_AFTER=<n bytes> (disconnect test)
// Prints one JSON line ("RESULT ...") so the orchestrator can assert on it.
//
// wq#510: exit codes are now semantic:
//   0 = success (both sides in the room)
//   3 = terminal failure (genuinely dead peer, timeout with no socket, etc.)
//   4 = STRANDED (retryable) — the slave could not progress because the master
//       entered the room and stopped clocking. The ORCHESTRATOR (rdv-soak or
//       production caller) should re-launch BOTH sides from their snapshots.
//       Retry inside the process is impossible because the master has already
//       exited — there is nobody to reconnect to. See rabbit15's analysis in
//       reports/510_rendezvous_retry_BLOCKED.md.
import { Emulator, loadSnapshotFile, KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { Dialog } from "../dialog";
import { SerialBridge } from "./bridge";
import { Rendezvous, CoreView, RoomName } from "./rendezvous";
import { offsetsFromSymbols, verifyTradeBlock, viewBlock } from "./invariants";
import { readLinkState } from "./linkstate";
import { runCycles, TRANSFER_CYCLES } from "./lockstep";   // wq#511: fine-slice block driver
import { ckptPath, linkEventsDir, romPath } from "../fixtures";

const PORT = Number(process.env.RDV_PORT ?? 9351);
const MODE = process.env.RDV_ROLE ?? "listen";
const ROOM = (process.env.RDV_ROOM ?? "TRADE_CENTER") as RoomName;
const DELAY = Number(process.env.RDV_DELAY_MS ?? 0);
const DROP_AFTER = Number(process.env.RDV_DROP_AFTER ?? 0);
const LINGER_MAX = Number(process.env.RDV_LINGER_MS ?? 90000);
const LINGER_IDLE = Number(process.env.RDV_LINGER_IDLE_MS ?? 25000);
const TAG = process.env.RDV_TAG ?? MODE;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const emu = new Emulator(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym"));
  const rom = new Rom(romPath("pokeblue.gb"));
  const ebus = new EventBus(linkEventsDir(), `rdv-${TAG}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom), scr = new Screen(emu, sym), sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync);
  const dlg = new Dialog(emu, scr, sync, ebus, sym);

  loadSnapshotFile(emu, ckptPath("center-m2b.state.gz"));
  emu.frames(6);
  await nav.goto(11, 3);                      // tile below the attendant

  const bridge = new SerialBridge(emu.core as any);
  const CYC = ((emu.core as any).CPUCyclesTotalBase | 0) >> 1;

  const core: CoreView = {
    map: () => emu.mem()[0xD35E] & 0xFF,
    linkState: () => readLinkState(emu.mem()).linkState,
    role: () => emu.mem()[0xFFAA] & 0xFF,
    onMenu: () => (scr.textGrid?.() ?? []).join("\n").includes("TRADE CENTER"),
    hasDialog: () => ((dlg.boxLines?.() ?? []).filter(Boolean).join("").length > 0),
    keyA: KEYS.A,
    step: async (n: number, key?: number) => {
      for (let i = 0; i < n; i++) {
        if (bridge.closed) break;
        if (bridge.pending) { try { await bridge.settled(15000); } catch { break; } }
        if (key !== undefined) (emu as any).gb.pressKey(key);
        (emu as any).gb.doFrame();
        bridge.advance(CYC);
      }
      await sleep(0);
    },
  };

  // face the attendant before any link traffic
  for (let i = 0; i < 20; i++) { (emu as any).gb.pressKey(KEYS.UP); (emu as any).gb.doFrame(); }
  for (let i = 0; i < 20; i++) (emu as any).gb.doFrame();

  if (DELAY > 0) { console.log(`[${TAG}] late join: sleeping ${DELAY}ms before touching the socket`); await sleep(DELAY); }

  if (MODE === "listen") await bridge.link.listen(PORT, "127.0.0.1");
  else await bridge.link.connect(PORT, "127.0.0.1");

  // disconnect scenario: kill the socket mid-handshake after N transfers
  if (DROP_AFTER > 0) {
    const timer = setInterval(() => {
      if (bridge.telemetry.sent >= DROP_AFTER) {
        clearInterval(timer);
        console.log(`[${TAG}] injecting DISCONNECT after ${bridge.telemetry.sent} transfers`);
        bridge.link.close("injected disconnect");
      }
    }, 20);
  }

  const rdv = new Rendezvous(core, bridge, {
    room: ROOM,
    onPhase: (p, note) => console.log(`[${TAG}] ${p} ${note}`),
  });
  const res = await rdv.run();
  console.log("RESULT " + JSON.stringify({ tag: TAG, ...res, telemetry: bridge.telemetry }));

  // ---- CONTINUATION: party-block exchange, then M5b invariants (wq#511) ----
  // The 415-byte party block needs FINE-GRAINED stepping + follower catch-up —
  // the cross-process port of trade.ts exchangeParties (fine-slice + peer
  // catch-up). Coarse doFrame() lets the master clock many transfers per frame
  // while the follower serves a stale byte => corrupt block. So: step in
  // ~TRANSFER_CYCLES (512) increments, settle each pending transfer before the
  // next clock, and arm bridge follower catch-up so every inbound sync1 is
  // answered with a freshly-staged byte. Drive by wLinkState exactly like
  // trade.ts: seat -> >=2 (session started) -> ==50 (trade menu = block done).
  if (res.ok && process.env.RDV_CONTINUE === "block") {
    const LINK_STATE_TRADE_MENU = 50;
    const ls = () => readLinkState(emu.mem()).linkState;
    const ex = () => bridge.telemetry.sent + bridge.telemetry.slaveServed;
    const pos = () => `(${emu.mem()[0xD362] & 0xFF},${emu.mem()[0xD361] & 0xFF})`;   // wXCoord,wYCoord
    // Seat by ROLE — matches the ROM's own spawn (verified 2026-08-28 run c2:
    // master/connect spawns at the LEFT seat (3,4), slave/listen at the RIGHT
    // seat (6,4); the table sits between at row 4, players face across). Keying
    // on mode navigates each player AWAY from its spawn to row 5 (wrong facing).
    const master = core.role() === 2;
    const seat = master ? { x: 3, y: 4, face: KEYS.RIGHT } : { x: 6, y: 4, face: KEYS.LEFT };
    console.log(`[${TAG}] continuation: mode=${MODE} role=${core.role()} seat(${seat.x},${seat.y}) player=${pos()} map=${core.map()} ls=${ls()}`);

    // Arm follower catch-up: run OUR core until it stages a fresh SB byte before
    // answering a peer sync1. $FFAC != $FE is the ROM main-loop-staged signal.
    bridge.enableFollowerCatchUp({
      run: (cyc: number) => runCycles((emu as any).core, cyc),
      ready: () => ((emu.mem()[0xFFAC] & 0xFF) !== 0xFE),
      cycles: 64, maxSteps: 8,
    });

    // Fine step: ~512 cyc/slice, settle pending transfers, yield often so inbound
    // sync1s + our catch-up interleave. Key pressed once per `pressEvery` slices
    // (0 = only on slice 0) to nudge dialog without disturbing the nybble sync.
    const fine = async (slices: number, key?: number, pressEvery = 0) => {
      for (let s = 0; s < slices; s++) {
        if (bridge.closed) break;
        if (bridge.pending) { try { await bridge.settled(15000); } catch { break; } }
        if (key !== undefined && (pressEvery === 0 ? s === 0 : s % pressEvery === 0)) (emu as any).gb.pressKey(key);
        runCycles((emu as any).core, TRANSFER_CYCLES);
        bridge.advance(TRANSFER_CYCLES);
        if (s % 8 === 0) await sleep(0);
      }
    };

    try {
      await nav.goto(seat.x, seat.y);          // coarse nav — no serial traffic yet
      console.log(`[${TAG}] seat-nav: after goto player=${pos()} map=${core.map()} ls=${ls()}`);
      await fine(40, seat.face);               // face the table across the seat
      await fine(40);
      let reached2 = false, reached50 = false;
      let lastEx = ex(), stall = 0;
      const BUDGET = 2500;                      // block-phase burst ceiling
      for (let r = 0; r < BUDGET && !bridge.closed; r++) {
        await fine(8, KEYS.A, 8);               // one A per burst for "Just a moment"/"PLEASE WAIT!"
        await fine(24);                         // then let the block run undisturbed
        const l = ls(), e = ex();
        if (e !== lastEx) { lastEx = e; stall = 0; } else stall++;
        if (!reached2 && l >= 2) { reached2 = true; console.log(`[${TAG}] seat-nav OK: wLinkState>=2 (session started) burst~${r} player=${pos()} ex=${e}`); }
        if (l === LINK_STATE_TRADE_MENU) { reached50 = true; console.log(`[${TAG}] seat-nav OK: wLinkState==50 (TRADE MENU — block exchanged) burst~${r} ex=${e}`); break; }
        if (stall >= 300) { console.log(`[${TAG}] drive bail: no serial progress in 300 bursts (ex=${e} ls=${l} player=${pos()})`); break; }
      }
      console.log(`[${TAG}] continuation drive done: reached2=${reached2} reached50=${reached50} ls=${ls()} map=${core.map()} player=${pos()} ex=${ex()}`);
    } catch (e: any) {
      console.log(`[${TAG}] continuation error: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    bridge.disableFollowerCatchUp();
    const mem = emu.mem();
    const rd = (a: number, n: number) => Array.from({ length: n }, (_, i) => mem[a + i] & 0xFF);
    const received = [...rd(0xD887, 11), ...rd(0xD893, 404)];
    const O = offsetsFromSymbols(sym);
    const v = verifyTradeBlock(received, O);
    const view = viewBlock(received, O);
    console.log("BLOCKCHECK " + JSON.stringify({
      tag: TAG, ok: v.ok, checks: v.checked, failures: v.failures,
      peerCount: view.count,
      peerSlot0: { species: view.mons[0].species, level: view.mons[0].level,
        hp: view.mons[0].hp, maxHp: view.mons[0].maxHp, moves: view.mons[0].moves },
      exchanges: bridge.telemetry.sent + bridge.telemetry.slaveServed,
      catchUpSteps: bridge.telemetry.catchUpSteps, catchUpTimeouts: bridge.telemetry.catchUpTimeouts,
    }));
  }

  // LINGER — keep the core alive so the peer can finish its exchange.
  if (res.ok && LINGER_MAX > 0) {
    const hard = Date.now() + LINGER_MAX;
    let lastActivity = Date.now();
    let seen = bridge.telemetry.slaveServed + bridge.telemetry.received;
    while (Date.now() < hard) {
      if (bridge.closed) { console.log(`[${TAG}] peer closed; linger ends`); break; }
      await core.step(30);
      const now = bridge.telemetry.slaveServed + bridge.telemetry.received;
      if (now !== seen) { seen = now; lastActivity = Date.now(); }
      else if (Date.now() - lastActivity > LINGER_IDLE) {
        console.log(`[${TAG}] link idle ${LINGER_IDLE}ms after ${seen} exchanges; linger ends`);
        break;
      }
    }
  }

  // Clean exit with semantic exit code:
  //   0 = success, 3 = terminal failure, 4 = stranded (retryable by orchestrator)
  bridge.uninstall();
  try { bridge.link.close("side done"); } catch {}
  if (res.ok) process.exit(0);
  process.exit(res.retryable ? 4 : 3);
})();
