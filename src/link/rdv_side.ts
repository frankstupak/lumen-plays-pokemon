// wq#483 — one SIDE of a distributed rendezvous. Runs as its OWN process with
// its OWN core: no shared memory with the peer, exactly like a remote partner.
// Driven by env: RDV_ROLE=listen|connect RDV_PORT=.. RDV_ROOM=TRADE_CENTER|COLOSSEUM
//               RDV_DELAY_MS=.. (late join)  RDV_DROP_AFTER=<n bytes> (disconnect test)
//               RDV_BIND=<listen addr> RDV_HOST=<dial addr> (wq#484, cross-node)
//               RDV_LAT_OUT=<path> (wq#484, per-transfer latency samples)
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
import { Rendezvous, CoreView, RoomName, ROOM_MAP, ROOM as ROOM_ID } from "./rendezvous";
import { setSlice, clearSlice, transferSliceDivisor } from "./lockstep";
import { offsetsFromSymbols, verifyTradeBlock, viewBlock, readPartyBlock, diffBlocks } from "./invariants";
import { readLinkState } from "./linkstate";
import { ckptPath, linkEventsDir, romPath } from "../fixtures";
import { summarise, LatencyDump } from "./latency";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

const PORT = Number(process.env.RDV_PORT ?? 9351);
const MODE = process.env.RDV_ROLE ?? "listen";
const ROOM = (process.env.RDV_ROOM ?? "TRADE_CENTER") as RoomName;
const DELAY = Number(process.env.RDV_DELAY_MS ?? 0);
const DROP_AFTER = Number(process.env.RDV_DROP_AFTER ?? 0);
const LINGER_MAX = Number(process.env.RDV_LINGER_MS ?? 90000);
const LINGER_IDLE = Number(process.env.RDV_LINGER_IDLE_MS ?? 25000);
const TAG = process.env.RDV_TAG ?? MODE;
// wq#484 (M5d): the addresses were hardcoded to 127.0.0.1, which is the one
// thing that made this side un-runnable across the tailnet. Defaults are
// unchanged so every M5c caller behaves exactly as before.
//   RDV_BIND  — listen address. 127.0.0.1 keeps a local pair off the network;
//               a tailnet address (or 0.0.0.0) exposes the side to a peer node.
//   RDV_HOST  — the address a connecting side dials.
// Kept as two variables rather than one: a side that listens on a tailnet
// address and a side that dials one are different decisions, and collapsing
// them is how you end up binding 0.0.0.0 by accident.
const BIND = process.env.RDV_BIND ?? "127.0.0.1";
const HOST = process.env.RDV_HOST ?? "127.0.0.1";
const LAT_OUT = process.env.RDV_LAT_OUT ?? "";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** wLinkState values CONFIRMED in vivo by the M3 in-process trade (trade.ts):
 *  the ROM leaves the idle link state when the table sequence starts, and lands
 *  on 50 once the 415-byte block is in and the trade menu is up. */
const LS_ENGAGED = 2;
const LS_TRADE_MENU = 50;

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

  // wq#511: the bridge needs to see the ROM take a byte out of the serial ISR's
  // one-deep slot before it hands over the next one. Symbol, not a remembered
  // address — a rename fails here instead of corrupting a block 400 bytes later.
  const bridge = new SerialBridge(emu.core as any, { takenSignal: sym.addr("hSerialReceiveData") });
  // BGB timestamps are 2 MiHz ticks; the core counts at 4 MiHz. Read the budget
  // EVERY step, never once at startup: under fine slicing a step is ~524 cycles,
  // not a frame, and a bridge told otherwise both skews the link clock (spec
  // rule 5) and burns the gate's patience 60x too fast.
  const linkTicks = () => ((emu.core as any).CPUCyclesTotalBase | 0) >> 1;

  // wq#511 PACING. Every executed step ends in setImmediate — the CHECK phase,
  // which runs AFTER poll, so any packet that arrived during the frame has been
  // read before the next one starts. Installed on the Emulator (not just our own
  // loop) because nav and dialog step the core themselves: the walk to the trade
  // table is precisely where the ROM clocks the partner's position every frame,
  // and a link that goes deaf there strands the peer.
  let linkStalled = "";
  const yieldToPoll = () => new Promise<void>(r => setImmediate(r));
  emu.framePacer = async () => {
    bridge.advance(linkTicks());               // advance the link clock, hand over at most one byte
    await yieldToPoll();
    if (bridge.pending && !bridge.closed) {
      try { await bridge.settled(15000); } catch (e: any) { linkStalled = String(e?.message ?? e); }
    }
  };

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
        if (key !== undefined) (emu as any).gb.pressKey(key);
        await emu.framesAsync(1);              // framePacer paces, advances and pumps
      }
    },
  };

  // face the attendant before any link traffic
  for (let i = 0; i < 20; i++) { (emu as any).gb.pressKey(KEYS.UP); (emu as any).gb.doFrame(); }
  for (let i = 0; i < 20; i++) (emu as any).gb.doFrame();

  if (DELAY > 0) { console.log(`[${TAG}] late join: sleeping ${DELAY}ms before touching the socket`); await sleep(DELAY); }

  if (MODE === "listen") {
    console.log(`[${TAG}] listen ${BIND}:${PORT}`);
    await bridge.link.listen(PORT, BIND);
  } else {
    console.log(`[${TAG}] connect ${HOST}:${PORT}`);
    await bridge.link.connect(PORT, HOST);
  }

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

  // ---- CONTINUATION: drive the 415-byte party exchange, then M5b invariants -
  //
  // wq#483 reached the room and stopped; this is the driving it was missing.
  // The sequence is the M3 in-process one (trade.ts), re-expressed ONE-SIDED:
  // take a seat, face across the table, and press A until OUR OWN wLinkState
  // says the ROM finished the exchange and put the trade menu up. We never read
  // the peer — the ROM's own state is the completion signal.
  //
  // COARSE for the walk and the wait (cheap, and the peer may still be walking),
  // FINE around the block itself: a full frame freezes us for ~70k cycles, so a
  // block clocked at one byte per frame is 400 frames of a partner sitting in a
  // serial wait loop. One slice ~= one transfer window (lockstep.ts).
  if (res.ok && process.env.RDV_CONTINUE === "block") {
    const master = core.role() === 2;
    const seat = master ? { x: 3, y: 4, face: KEYS.RIGHT } : { x: 6, y: 4, face: KEYS.LEFT };
    // The room we actually resolved to, not the one we asked for: room select
    // can yield to the peer's choice, and a seat checked against the wrong map
    // would pass in the one case worth catching.
    const seatMap = ROOM_MAP[res.room ?? ROOM_ID[ROOM]];
    console.log(`[${TAG}] continuation: ${master ? "MASTER->left" : "SLAVE->right"} seat (${seat.x},${seat.y})`);
    const FINE = transferSliceDivisor(emu.core);
    let reached = 0;
    let seated: { map: number; x: number; y: number } | null = null;
    // Forces before the block are expected and harmless: they land while the ROM
    // is rendering text or copying BG rows (measured PCs: $390A
    // PrintLetterDelay, $1DD7 TransferBgRows), where the only traffic is
    // position sync. A force DURING the block is a lost byte, so count that
    // separately instead of pretending the two are the same event.
    let forcedBefore = 0;
    // wq#511 deliverable (2): seat navigation inside $EF is VERIFIED, not
    // assumed. The exchange completing is strong evidence we sat down, but it
    // is indirect — record where the walk actually left us so a probe can fail
    // on the seat itself, and so a future map change names the seat as the
    // culprit instead of surfacing as a mysterious dead handshake.
    try {
      await nav.goto(seat.x, seat.y);
      await core.step(16, seat.face);
      await core.step(16);
      seated = nav.pos();
      // engage: A at the table until the ROM leaves the idle link state
      for (let r = 0; r < 60 && !bridge.closed && core.linkState() < LS_ENGAGED; r++) {
        await core.step(6, KEYS.A);
        await core.step(24);
      }
      reached = core.linkState();
      // the block itself
      forcedBefore = bridge.telemetry.forced;
      setSlice(emu.core, FINE);
      try {
        for (let r = 0; r < 40 && !bridge.closed && core.linkState() !== LS_TRADE_MENU; r++) {
          await core.step(8 * FINE, KEYS.A);
          await core.step(24 * FINE);
        }
      } finally { clearSlice(emu.core); }
    } catch (e: any) {
      console.log(`[${TAG}] continuation error: ${String(e?.message ?? e).slice(0, 120)}`);
    }

    const mem = emu.mem();
    const O = offsetsFromSymbols(sym);
    const received = readPartyBlock(mem, sym, "enemy");
    const v = verifyTradeBlock(received, O);
    const view = viewBlock(received, O);
    // Both sides boot the same snapshot, so the peer's party IS ours: the block
    // that arrived must equal the block we would have sent, byte for byte. This
    // is the check that sees a single lost byte — structural validation cannot,
    // because a shifted tail is still structurally plausible.
    const own = readPartyBlock(mem, sym, "own");
    const mirror = diffBlocks(own, received, O, view.count);   // the slots the block claims
    const mirrorAll = diffBlocks(own, received, O);            // including never-filled slots
    const t = bridge.telemetry;
    console.log("BLOCKCHECK " + JSON.stringify({
      tag: TAG, ok: v.ok, checks: v.checked, failures: v.failures,
      linkState: core.linkState(), engagedAt: reached,
      seat: { want: { map: seatMap, x: seat.x, y: seat.y }, at: seated,
        ok: !!seated && seated.map === seatMap && seated.x === seat.x && seated.y === seat.y },
      exchangeDone: core.linkState() === LS_TRADE_MENU,
      mirror: { ok: mirror.ok, diffs: mirror.diffs, first: mirror.first, where: mirror.where },
      mirrorAll: { ok: mirrorAll.ok, diffs: mirrorAll.diffs, where: mirrorAll.where },
      peerCount: view.count,
      peerSlot0: { species: view.mons[0].species, level: view.mons[0].level,
        hp: view.mons[0].hp, maxHp: view.mons[0].maxHp, moves: view.mons[0].moves },
      exchanges: t.sent + t.slaveServed,
      pacing: { queuedIn: t.queuedIn, served: t.slaveServed, blocked: t.blocked,
        forced: t.forced, forcedDuringBlock: t.forced - forcedBefore,
        collisions: t.collisions, stillQueued: bridge.queued, gate: t.gate,
        forcedAt: t.forcedAt.map(pc => `$${pc.toString(16)}`) },
      stalled: linkStalled || undefined,
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

  // ---- wq#484: per-transfer latency, dumped before the socket goes away -----
  //
  // Emitted on EVERY exit path, success or not: a side that stranded is the one
  // whose tail you most want to see, so a dump gated on res.ok would withhold
  // the interesting case. The `LATENCY` line is the summary; the file (if asked
  // for) carries every sample so a histogram can be rebuilt without re-running.
  const lat: LatencyDump = {
    tag: TAG, role: core.role(),
    bind: MODE === "listen" ? `${BIND}:${PORT}` : undefined,
    peerHost: MODE === "connect" ? `${HOST}:${PORT}` : undefined,
    rtt: bridge.link.latency, serve: bridge.link.serve,
  };
  const sum = summarise(lat);
  console.log("LATENCY " + JSON.stringify({
    tag: TAG, rtt: sum.rtt, serve: sum.serve, buckets: sum.hist.counts,
  }));
  if (LAT_OUT) {
    mkdirSync(dirname(LAT_OUT), { recursive: true });
    writeFileSync(LAT_OUT, JSON.stringify(lat));
    console.log(`[${TAG}] latency samples -> ${LAT_OUT} (${lat.rtt.length} rtt, ${lat.serve.length} serve)`);
  }

  // Clean exit with semantic exit code:
  //   0 = success, 3 = terminal failure, 4 = stranded (retryable by orchestrator)
  bridge.uninstall();
  try { bridge.link.close("side done"); } catch {}
  if (res.ok) process.exit(0);
  process.exit(res.retryable ? 4 : 3);
})();
