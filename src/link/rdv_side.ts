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
import { offsetsFromSymbols, verifyTradeBlock, viewBlock, readPartyBlock, diffBlocks,
  diffSections, verifyPostTrade } from "./invariants";
import { readLinkState } from "./linkstate";
import { ASYM_PATCHES, assertPatchInBlock, expectedAsymSections, driveTradeConfirm } from "./trade_side";
import { writeIdentity, readEnemyIdentity, monKey } from "./identity";
import { readParty, slotKey } from "./party";
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
// wq#484 (M5d trade): RDV_CONTINUE=trade carries on past the 415-byte block into
// selection -> confirm -> swap, driven one-sided (trade_side.ts).
//   RDV_IDENT=<patch>  — apply this named identity patch to OUR core before any
//                        link traffic. Set on exactly ONE side of a pair.
//   RDV_ASYM=<patch>   — the patch in play on the PAIR, set on BOTH sides. Each
//                        side needs it to know which block sections are allowed
//                        to differ; the difference is symmetric, so both sides
//                        compute the same expected set from the same name.
//   RDV_OFFER/RDV_WANT — our party slot to give away, and the peer slot to ask
//                        for. Gen1 exchanges ONE agreed pair, so the orchestrator
//                        must set offer(A)==want(B) and offer(B)==want(A); the
//                        sides cannot negotiate it over the wire.
const IDENT = process.env.RDV_IDENT ?? "";
const ASYM = process.env.RDV_ASYM ?? "";
const OFFER = Number(process.env.RDV_OFFER ?? 0);
const WANT = Number(process.env.RDV_WANT ?? 0);
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

  // The patch rides across the cable inside the party block, so it has to land
  // BEFORE the first byte: patching afterwards leaves the partner's received copy
  // stale and the pair inconsistent (identity.ts).
  if (IDENT) {
    const patch = ASYM_PATCHES[IDENT];
    if (!patch) throw new Error(`RDV_IDENT=${IDENT} is not a known patch (${Object.keys(ASYM_PATCHES).join(",")})`);
    writeIdentity(emu.mem(), patch);
    console.log(`[${TAG}] identity patched: ${IDENT} ${JSON.stringify(patch)}`);
  }

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
  const CONTINUE = process.env.RDV_CONTINUE ?? "";
  if (res.ok && (CONTINUE === "block" || CONTINUE === "trade")) {
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
    // wq#484: an ASYMMETRIC pair is supposed to differ — that is what makes a
    // swap visible at all — so the byte-for-byte mirror gate above cannot be the
    // desync check here. The replacement is stricter in the one way that matters:
    // the difference must be CONFINED to the sections the peer's known patch can
    // reach, and it must be non-empty. A lost or shifted byte lands outside that
    // set; a patch that never crossed leaves it empty. Neither can hide.
    let confined: any;
    if (ASYM) {
      const patch = ASYM_PATCHES[ASYM];
      if (!patch) throw new Error(`RDV_ASYM=${ASYM} is not a known patch (${Object.keys(ASYM_PATCHES).join(",")})`);
      assertPatchInBlock(sym, O);
      const expected = new Set(expectedAsymSections(sym, patch));
      const moved = diffSections(own, received, O, view.count);
      const unexpected = moved.filter(s => !expected.has(s));
      confined = {
        patch: ASYM, ok: unexpected.length === 0 && moved.length > 0,
        crossed: moved.length > 0, moved, unexpected, allowed: [...expected].length,
      };
    }
    const t = bridge.telemetry;
    console.log("BLOCKCHECK " + JSON.stringify({
      tag: TAG, ok: v.ok, checks: v.checked, failures: v.failures,
      linkState: core.linkState(), engagedAt: reached,
      seat: { want: { map: seatMap, x: seat.x, y: seat.y }, at: seated,
        ok: !!seated && seated.map === seatMap && seated.x === seat.x && seated.y === seat.y },
      exchangeDone: core.linkState() === LS_TRADE_MENU,
      mirror: { ok: mirror.ok, diffs: mirror.diffs, first: mirror.first, where: mirror.where },
      mirrorAll: { ok: mirrorAll.ok, diffs: mirrorAll.diffs, where: mirrorAll.where },
      confined,
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

    // ---- TRADE: selection -> confirm -> the swap itself (wq#484) ------------
    //
    // The block above is only the parties being shown to each other; the trade
    // is what happens next, and until now it existed only in-process (M3), with
    // one driver holding both cores. Here each side sees its own menu only —
    // see trade_side.ts for why the quiet phase is load-bearing.
    if (CONTINUE === "trade" && core.linkState() === LS_TRADE_MENU && !bridge.closed) {
      // Capture what the peer ADVERTISED before touching anything: the received
      // block is the only statement we will ever get about what should arrive,
      // and the swap overwrites our side of the comparison.
      const enemyBefore = readEnemyIdentity(emu.mem());
      const beforeView = viewBlock(readPartyBlock(emu.mem(), sym, "own"), O);
      const partyBefore = readParty(emu.mem());
      const offerBefore = partyBefore[OFFER] ? slotKey(partyBefore[OFFER]) : "";
      const hasSwapped = () => {
        const p = readParty(emu.mem());
        return !!p[OFFER] && slotKey(p[OFFER]) !== offerBefore;
      };
      console.log(`[${TAG}] trade: offering slot ${OFFER} (${offerBefore}), asking for peer slot ${WANT}`);

      setSlice(emu.core, FINE);
      let drive;
      try {
        drive = await driveTradeConfirm({
          mem: () => emu.mem(),
          grid: () => (scr.textGrid?.() ?? []).join("\n"),
          step: (n, key) => core.step(n, key),
          swapped: hasSwapped,
          closed: () => bridge.closed,
          fine: FINE, offer: OFFER, want: WANT,
          log: s => console.log(`[${TAG}]${s}`),
        });
      } finally { clearSlice(emu.core); }

      const afterView = viewBlock(readPartyBlock(emu.mem(), sym, "own"), O);
      const post = verifyPostTrade({
        before: beforeView.mons, after: afterView.mons, slot: OFFER,
        peerMon: view.mons[WANT], count: beforeView.count, countAfter: afterView.count,
      });
      // Stronger than verifyPostTrade's species+level: the mon we now hold must
      // be the exact identity the peer's block advertised, OT and nickname
      // included. Those two fields are what a trade carries and a clone pair
      // cannot fake. Only mon1 has receive-side mirrors in RAM, so a non-zero
      // `want` reports undefined rather than a vacuous pass.
      const got = readParty(emu.mem())[OFFER];
      const gotKey = got ? monKey({ species: got.species, otid: got.otid, level: got.level, ot: got.ot, nick: got.nick }) : "";
      const advertised = monKey(enemyBefore.mon1);
      console.log("TRADECHECK " + JSON.stringify({
        tag: TAG, role: core.role(), offer: OFFER, want: WANT,
        swapped: drive.swapped, note: drive.note,
        iterations: drive.iterations, confirms: drive.confirms,
        phases: drive.phases, swappedFrom: drive.swappedFrom,
        post: { ok: post.ok, checks: post.checked, failures: post.failures },
        identity: WANT === 0
          ? { ok: gotKey === advertised, got: gotKey, advertised }
          : { ok: undefined, got: gotKey, advertised: "n/a — only mon1 has a receive-side mirror" },
        gave: offerBefore,
        linkState: core.linkState(),
        exchanges: bridge.telemetry.sent + bridge.telemetry.slaveServed,
      }));
    }
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
