// wq#483 — one SIDE of a distributed rendezvous. Runs as its OWN process with
// its OWN core: no shared memory with the peer, exactly like a remote partner.
// Driven by env: RDV_ROLE=listen|connect RDV_PORT=.. RDV_ROOM=TRADE_CENTER|COLOSSEUM
//               RDV_DELAY_MS=.. (late join)  RDV_DROP_AFTER=<n bytes> (disconnect test)
// Prints one JSON line ("RESULT ...") so the orchestrator can assert on it.
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
import { offsetsFromSymbols, verifyTradeBlock, viewBlock } from "./invariants";   // wq#483: M5b check on the received block
import { readLinkState } from "./linkstate";
import { ckptPath, linkEventsDir, romPath } from "../fixtures";

const PORT = Number(process.env.RDV_PORT ?? 9351);
const MODE = process.env.RDV_ROLE ?? "listen";
const ROOM = (process.env.RDV_ROOM ?? "TRADE_CENTER") as RoomName;
const DELAY = Number(process.env.RDV_DELAY_MS ?? 0);
const DROP_AFTER = Number(process.env.RDV_DROP_AFTER ?? 0);
const LINGER_MAX = Number(process.env.RDV_LINGER_MS ?? 90000);   // hard cap
// Silence window. Must exceed the longest legitimate GAP in selection traffic,
// not just the mean: once the master warps into the room it stops clocking, so
// a slave still finishing its own exchange produces no traffic for a while and
// a short window reads that as "partner done" (soak: 6/8 with 6s, the two
// failures both being the slave aborting after the master left).
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
        if (bridge.closed) break;         // wq#483: dead link, stop stepping into it
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

  // ---- CONTINUATION: party-block exchange, then M5b invariants ------------
  // RDV_CONTINUE=block -> after landing in the room, walk to the trade table
  // and run the ROM's 415-byte party exchange, then validate what the PEER
  // sent using the wq#482 one-sided invariants. Seat is chosen from LOCAL RAM
  // only (the role byte), the same deterministic principle as the yield rule:
  // master takes the left seat, slave the right, so the two sides cannot
  // collide or both wait for the other to move.
  if (res.ok && process.env.RDV_CONTINUE === "block") {
    const master = core.role() === 2;
    const seat = master ? { x: 3, y: 4, face: KEYS.RIGHT } : { x: 6, y: 4, face: KEYS.LEFT };
    console.log(`[${TAG}] continuation: ${master ? "MASTER->left" : "SLAVE->right"} seat (${seat.x},${seat.y})`);
    try {
      await nav.goto(seat.x, seat.y);
      await core.step(20, seat.face);
      await core.step(20);
      for (let r = 0; r < 60 && !bridge.closed; r++) {   // ROM runs its own exchange; bridge carries it
        await core.step(6, KEYS.A);
        await core.step(24);
      }
    } catch (e: any) {
      console.log(`[${TAG}] continuation error: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    // Reconstruct the 415-byte block the PEER sent, from our own RAM:
    // wLinkEnemyTrainerName $D887 (11 bytes) then wSerialEnemyDataBlock $D893
    // (404 = count + species list + 6 mons + OT names + nicknames).
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
    }));
  }

  // LINGER. Whoever lands in the room first must keep its core running and its
  // socket open: the partner is still exchanging selection bytes and needs a
  // live peer to answer. Exiting immediately drops the socket and aborts the
  // other side — measured in vivo (A reached $EF, B then reported "peer
  // disconnected during room select").
  //
  // wq#483 soak finding: a FIXED linger is the wrong shape. Under load the
  // slower side took 29.5s to finish room-select while the winner's 20s timer
  // expired, killing it (soak run 1/6). The correct signal is one-sided and
  // traffic-driven: keep serving while the LINK IS BUSY, and stop only after
  // it has been idle — once both sides are in the room the ROM stops clocking
  // selection bytes, so silence IS the "partner is done" signal. A real
  // session continues into the trade/battle here instead of exiting.
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

  // leave the core in a sane state either way (never wedged mid-transfer)
  bridge.uninstall();
  try { bridge.link.close("side done"); } catch {}
  process.exit(res.ok ? 0 : 3);
})();
