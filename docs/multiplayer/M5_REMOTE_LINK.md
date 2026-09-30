# M5 — Remote link over BGB TCP

**Status 2026-08-13: transport layer VERIFIED; the ROM<->TCP bridge is BUILT
and VERIFIED through the Cable Club room-select handshake against a scripted
mock peer over a real localhost socket (M5a, wq#481).** A remote battle/trade
between two full game instances has still not happened — that is M5b+.

This document doubles as the **spec for the other side**: if you want to
challenge our agent, this is what your end has to speak.

## The protocol is not ours

We speak the **BGB 1.4 link protocol**, the de-facto standard for emulated link
cables over a network: <https://bgb.bircd.org/bgblink.html>. Field-level notes
are in `research/link/R5_bgb_link_over_tcp.md`; implementation is
`src/link/bgblink.ts`.

Speaking a standard rather than inventing one means the other end can be another
agent, a plain BGB instance with a human at the controls, or any of the existing
third-party implementations. We are not asking anyone to adopt a Lumen protocol.

### What your side must do

1. **TCP.** One side listens, the other connects. Set `TCP_NODELAY`.
2. **Handshake.** Send a `version` packet (`b1=1 b2=1 b3=4 b4=0 i1=0`), verify
   the one you receive, and drop the connection on a mismatch. Answer a received
   `version` with a `status` packet. Never answer a `status` with a `status`.
3. **Framing.** Packets are 8 bytes: `b1 b2 b3 b4` then a little-endian 32-bit
   `i1`. **Do not assume one TCP read is one packet.** The spec is explicit that
   several packets can arrive together and one packet can be split across reads.
   Buffer bytes and cut on 8-byte boundaries — our `PacketReader` does exactly
   this and is tested against a one-byte-at-a-time dribble.
4. **Transfers.** As master, send `sync1` (`104`) with `b2`=your data byte and
   `b3`=SC|`$80`. As slave, answer a received `sync1` with `sync2` (`105`,
   `b3=$80`) carrying your staged byte. If you have no passive transfer staged,
   answer `sync3` (`106`) with `b2=1` instead.
5. **Timestamps.** 2 MiHz clocks (2^21/s), low 31 bits only, top bit always 0,
   wrapping. Advance yours with **emulated** cycles, not wall time. Ours is
   advanced by the stepping loop for exactly this reason: our cores run many
   times faster than a real Game Boy, and a wall-clock timestamp would tell you
   to wait for the wrong things.
6. **Reserved bits.** Anything not assigned a purpose MUST be zero on send and
   MUST be ignored on receive.

### Game-side expectations

The link itself is game-agnostic, but if you want to actually trade or battle
with our agent, your side runs Pokémon Red/Blue and the sequence is the one
documented in `M3_TRADE.md` and `M3_BATTLE.md`: Cable Club attendant → room
select (`TRADE CENTER` / `COLOSSEUM`) → the 415-byte party block → menus. Two
facts from those documents will save you a week:

- **Do not send input during a selection exchange.** The nybble sync and the
  battle move exchange both require an undisturbed side; a keypress knocks a
  waiting side out of the loop and it never converges.
- **The battle move list is one-indexed** (cursor 1..4), and DOWN on a party
  list walks onto CANCEL, which aborts the whole session.

## What is verified today

`npx tsx src/link/probe_bgblink.ts` — 16 checks, all passing:

- **Codec** — 8-byte layout, little-endian `i1`, 31-bit timestamp clamp,
  version accept/reject.
- **Framing** — three packets in one chunk; a packet split mid-way across two
  chunks; the whole stream fed one byte at a time. This is the spec rule most
  likely to produce a silent corruption under load, so it is tested first.
- **Loopback over a real socket** — two `BgbLink` endpoints, full handshake
  including the status exchange, then a byte stream **both directions,
  byte-exact**, with the master/slave roles the protocol defines. The test
  stream deliberately includes `$FD` and `$FE`, the Gen1 preamble and patch-list
  sentinel bytes.

Real BGB is not installed here and is not needed to prove the wire layer: two of
our own endpoints speaking the documented format are BGB-compatible by
construction. Interop against an actual BGB build remains an unticked box and is
stated as such.

## What is still missing

The transport was the easy half. Three things genuinely change when the peer is
remote. All three are now solved (M5b wq#482, M5a wq#481, M5c wq#483+wq#511);
what is left is the trade and battle sequences themselves, not the link:

1. **The peer's RAM is unreadable — SOLVED (M5b, wq#482).**
   `src/link/invariants.ts` re-expresses the mirror checks one-sided, using
   only our own RAM plus the bytes that physically arrived on the wire.
   TRADE: structural validation of the received 415-byte block (exact length
   and partitioning, the `$FE` patch-list exclusion, every field range-checked
   against ROM-derived offsets) plus a post-swap assertion that our party
   mutated exactly per protocol (traded slot now holds the peer's advertised
   mon, all other slots byte-identical, count unchanged). BATTLE: a
   turn-by-turn ledger over SETTLED samples only, whose anchor is that any
   enemy move our RAM reports must have physically ARRIVED on the link — a
   move byte with no wire evidence is the remote equivalent of a mirror break.
   Everything fails closed: missing evidence is a failure, never a pass.

   **Honest limit:** Gen1's trade block carries no protocol checksum, so there
   is none to verify; a structurally valid block from a hostile peer can still
   contain a legal-but-false party. One-sided verification cannot detect that
   and does not claim to.
2. **We cannot drive the peer's menus — SOLVED (M5c, wq#483 + wq#511).**
   Each side drives only its own core and infers the partner's state from its
   own RAM plus link liveness: rendezvous to the room (wq#483), then the
   415-byte party exchange (wq#511, "Continuation" below), then selection,
   confirm and the swap itself (wq#484, "The trade itself, across two
   processes"). What remains unbuilt is a **battle to knockout** against a remote
   peer (wq#3201).
3. **Latency replaces lockstep — SOLVED (M5a).** `src/link/bridge.ts` binds a
   core's SB/SC to a `BgbLink` endpoint; a master transfer stays OPEN until the
   remote sync2 arrives, and the core is NOT stepped while a byte is pending,
   so emulated time freezes through network latency (timestamps advance with
   emulated cycles only — spec rule 5 — so the remote side sees us waiting).
   Measured: a 250ms injected delay froze the link timestamp exactly, executed
   zero frames, faked zero completions, and the handshake still finished.

### M5a evidence (wq#481)

- `src/link/capture_handshake.ts` — taps the in-process M3 rig and captures the
  handshake byte tape: `docs/multiplayer/evidence/m5a-handshake-tape.json`
  (30 exchanges: `01->02` connect, `$60<->$60` nybble syncs, `$D0`-family room
  selection, warp to map `$EF`).
- `src/link/mock_peer.ts` — scripted slave speaking bgblink, phase machine
  derived from the tape + pokered `main_menu.asm` ground truth (selection byte
  = `$D0 + item + 4*(A pressed)`; the master's exchange loop needs a received
  `$D0`-family byte, so the mock answers its `$D0` TRADE CENTER selection to
  everything once selection talk starts — a premature `$FE` starves the loop).
- `src/link/probe_bridge.ts` — 13/13: our REAL ROM core walks to the attendant
  and completes room-select against the mock over localhost TCP in 36
  exchanges (in-process ground truth: 30), including the 250ms-delay stall
  case. `npm run verify` (P0) and `npm run p1` untouched and passing;
  `probe_bgblink` still 16/16 after the backward-compatible `DEFER_REPLY`
  addition that lets the mock inject latency.

### M5b evidence (wq#482)

- `src/link/invariants.ts` — verify-only, fail-closed; never writes to a core.
  Party-struct offsets are derived from `roms/pokeblue.sym` and asserted at
  construction, so a wrong assumption throws loudly instead of passing.
- `src/link/probe_invariants.ts` — **30/30** red/green both directions: valid
  blocks and ledgers pass; corrupted ones are caught individually ($FE on the
  wire, impossible party count, missing species terminator, species-list vs
  struct disagreement, level 0/255, hp>maxHp, bad move ids, PP on empty slots,
  impossible PP, post-trade slot unchanged / wrong species / untraded slot
  mutated / count changed, enemy move never on the wire, unknown own move,
  unaccounted HP rises, no-effect settled turn, zero settled turns, and an
  empty `combine()`). Junk in unoccupied slots is deliberately ignored (no
  false positive).
- `src/link/probe_invariants_wire.ts` — **5/5** M5a integration: a real party
  block read from a live core is shipped through the M5a transport over a real
  localhost socket and validated from the RECEIVED bytes; corruption and an
  injected `$FE` introduced in transit are both rejected downstream.
- No in-process regression: `probe_bridge` 13/13, `probe_bgblink` 16/16,
  `npm run verify` P0 ALL PASS. M3/M4 paths untouched.

Next tranche: the distributed rendezvous (problem 2), then two full processes
over Tailscale — the rendezvous landed (wq#483/wq#510/wq#511, below); the
cross-node run is measured as far as this fleet's tooling permits and its
remaining gap is named, in "Cross-node (M5d, wq#484)" at the end of this file.

---

# Rendezvous protocol (M5c, wq#483) — spec for the other side

Everything above gets bytes across the wire. This section is the **arrival
coordination**: how two independent processes, each able to read only its own
RAM, agree that they are in the same Cable Club room. Implement this and our
agent will rendezvous with your end.

Reference implementation: `src/link/rendezvous.ts` (state machine),
`src/link/rdv_side.ts` (one side as its own OS process).

## Phases

```
IDLE -> WALK_TO_ATTENDANT -> AWAIT_PARTNER -> HANDSHAKE -> ROOM_SELECT
     -> IN_ROOM    (success)
     -> ABORTED    (terminal failure, at any point)
     -> STRANDED   (retryable — wq#510, see §STRANDED below)
```

Every transition is driven by an observation of **your own** side — your RAM,
plus link liveness and the bytes that arrived. No phase requires reading the
partner's memory. That is the whole point: the in-process version parked one
side with `if (a.menu || b.menu)` over both cores, which a remote peer cannot do.

### 1. WALK_TO_ATTENDANT (before any link traffic)

Stand on the tile below the Cable Club attendant and face UP. Do **not** start
the dialog yet.

### 2. AWAIT_PARTNER

Wait for the TCP socket to be up **before advancing the ROM**. This ordering is
load-bearing: the attendant dialog is where the ROM probes the cable, so
starting it with no peer attached burns the probe window. A partner arriving
late is then simply a longer wait — verified with a 30 s stagger (the early
side waited 35.9 s and still completed).

Timeout: `LPP_RDV_PARTNER_MS` (default 120 000 ms) → `ABORTED`.

### 3. HANDSHAKE

Drive **only your own** attendant dialog (tap A) until your own screen shows the
room-select menu. The ROM's connection loop does the rest. Two bytes of local
RAM tell you where you are:

| Address | Meaning |
|---|---|
| `$FFAA` | role, set by the ROM's connection loop: **2 = master** (drives the clock), **1 = slave**, `$FF` = not yet negotiated |
| `$D12B` | `wLinkState` |

Timeout: `LPP_RDV_HANDSHAKE_MS` (default 90 000 ms) → `ABORTED`.

### 4. ROOM_SELECT and the yield rule

Selections are the ROM's own encoding (`main_menu.asm`): `$D0 + menu item`, so
`$D0` = TRADE CENTER, `$D1` = COLOSSEUM, `$D2` = CANCEL. The master's exchange
loop spins until it receives a byte whose high nybble is `$D`.

If the two sides want **different** rooms, they must not both politely yield —
that deadlocks. The rule is deterministic and needs **no extra protocol
round-trip**:

> **The SLAVE yields to the MASTER's room.**

Role is not a preference; it is assigned by the ROM's own handshake and is
readable at `$FFAA` on both ends, so both sides compute the *same* winner from
purely local RAM. A tie is impossible — the handshake assigns exactly one
master. (`resolveRoom()` in `rendezvous.ts`.)

Landing in the peer's room is **success, not failure**: if you time out waiting
for your own room but find yourself on the other room's map, you were the side
that yielded. Room maps: TRADE CENTER = `$EF` (239), COLOSSEUM = `$F0` (240).

Timeout: `LPP_RDV_ROOM_MS` (default 60 000 ms).

### 5. IN_ROOM — and the linger obligation

**Whoever reaches the room first must keep its core running and its socket
open.** The partner is still exchanging selection bytes and needs a live peer to
answer. Measured in vivo: an implementation that exits on arrival drops the
socket and aborts the other side, which then reports "peer disconnected during
room select". A real session continues straight into the trade or battle here,
so this is the natural steady state — but a *test harness* must linger
deliberately.

## Disconnect handling

A dropped socket must fail every pending transfer **immediately**. Our
`SerialBridge` sets a `closed` flag from the link's `onClose` and releases all
waiters (`bridge.ts`, wq#483). Without that, each pending byte burns its full
settle timeout: measured, a dropping side spent 15 s *per frame* after closing,
wedging the abort path for minutes.

Once closed, stop stepping the core into the dead link, walk any open dialog to
a close, and report `ABORTED` with a reason. Do not kill the core mid-transfer.
Verified: both the victim and the dropper abort in under 7 s and leave their
cores on a sane map (`$3A`, the Cable Club), never mid-transfer.

## Timeouts are configuration, not constants

`CFG.rendezvous` — all env-overridable so a cross-continent link is a config
change, not a code change:

    LPP_RDV_PARTNER_MS    120000    wait for the peer socket
    LPP_RDV_HANDSHAKE_MS   90000    ROM connection loop + attendant dialog
    LPP_RDV_ROOM_MS        60000    room-select agreement
    LPP_RDV_RETRY_MAX          3    max orchestrator-level retry attempts
    LPP_RDV_RETRY_BACKOFF   2000    ms base delay between retries

## STRANDED detection and retry (wq#510)

The slave ROM never initiates clock transfers (`sent` is always 0 — it is
purely passive). Once the master enters the room its ROM stops clocking, so a
slave that has not yet warped can **never progress**: the only clock source is
gone. No linger constant fixes this (tested at 6 s, 25 s, and 90 s — same
failure mode; proven by rabbit2 and rabbit15). This is a state-machine gap,
not a tuning problem.

### Detection

During `ROOM_SELECT`, two conditions signal STRANDED:

1. **Peer drops the socket** while we have not reached any room map — the
   master entered the room, lingered, and gave up.
2. **Room timeout fires** (`LPP_RDV_ROOM_MS`) with the socket still alive and
   us not in any room map — the master is in the room and idle but has not
   disconnected yet.

Both return `RendezvousResult` with `phase: "STRANDED"` and `retryable: true`.
Exit code 4 distinguishes this from terminal failure (exit 3).

### Retry lives at the orchestrator level

The two processes cannot coordinate a reconnect between themselves: the master
exits its linger before the slave can signal it, and silence-because-done and
silence-because-stranded are indistinguishable from the master's perspective
(rabbit15 finding, proven with 90 s linger). The orchestrator (`tools/rdv-soak`
or the production caller) detects exit code 4 from EITHER side, kills the other
if still running, and relaunches BOTH from their clean snapshot. Each fresh
launch reloads the Cable Club checkpoint, so ROM state is always clean — no
need to navigate out of the room or clean up link state.

Bounded by `LPP_RDV_RETRY_MAX` (default 3) per run. A genuinely dead peer
exhausts retries and terminates with exit 3.

### Contract for the other side

If your implementation detects STRANDED (room-select timeout with no progress),
close the socket. Our orchestrator will relaunch both processes. There is no
out-of-band retry message — the socket drop IS the signal, and the fresh TCP
connection IS the retry. This preserves BGB interop: no custom control frames
required.

## Verified (wq#483 + wq#510)

`npx tsx src/link/probe_rendezvous.ts` — **12/12**, three scenarios run as
**separate OS processes** with no shared memory:

1. **Happy path** — both sides reach map 239, exactly one master (roles 1/2),
   both agree on room `$D0`.
2. **Late join (30 s)** — early side waits 35.9 s, both still reach the room.
3. **Mid-handshake disconnect** — both sides `ABORTED` with a reason in
   under 7 s, cores left on map `$3A`, both processes exited cleanly.

`tools/rdv-soak 8` — **8/8 under load** (load avg 3.69–3.12, live service
running), with 5 orchestrator-level retries across the 8 runs. Every stranded
pair recovered on the first or second retry. Without the retry mechanism, the
same workload produced 4/8 (rabbit2) and 4/8 (rabbit15).

# Continuation (M5c-3, wq#511) — the 415-byte party exchange

Rendezvous ends with both sides standing in the room. wq#483 stopped there and
recorded the gap honestly: `exchanges=30` is the handshake and nothing else, so
the enemy-party RAM still held whatever was in it at boot and M5b rejected the
result. The validator was right; the driving was missing. This is that driving —
`RDV_CONTINUE=block` in `src/link/rdv_side.ts`, gated by
`npx tsx src/link/probe_m5c3.ts`.

## Driving it without reading the peer

Same shape as the rendezvous: every transition is an observation of OUR core.

1. Take a seat by ROLE — master left `(3,4)` facing right, slave right `(6,4)`
   facing left. Role comes from `$FFAA`, which both sides can read locally, so
   the two never contend for the same tile.
2. Press A at the table until our own `wLinkState` leaves the idle state.
3. Keep pressing A until `wLinkState == 50` — the ROM has taken the block in and
   put the trade menu up. **That is the completion signal**: not a byte count,
   not a timer, and not anything about the peer.

Step 3 runs under FINE slicing (`lockstep.ts`, ~512 cycles ≈ one DMG transfer
window). A whole frame freezes the core for ~70k cycles; a block clocked at one
byte per frame leaves a partner sitting in its serial wait loop for 400 frames.
Navigation and dialog stay COARSE — full frames — because they are long, and the
traffic there is only position sync.

## Where the received block actually lives

Read this before concluding that a block is garbage. The 415 bytes are NOT
contiguous and the tail does not start where the staging buffer's name suggests:

| part | symbol | length |
| --- | --- | --- |
| trainer name | `wLinkEnemyTrainerName` `$D887` | 11 |
| party tail | `wEnemyPartyCount` `$D89C` → nicknames end | 404 |

`wSerialEnemyDataBlock` (`$D893`) is the RAW STAGING BUFFER and sits **nine
bytes before** the parsed party. Reassembling from it yields `count=$FD`,
`level=0`, `hp>maxHp` — a perfectly good block that reads as noise, which is
what wq#483 saw. `invariants.readPartyBlock()` builds the block from symbols and
asserts the partitioning, so a wrong assumption dies at construction instead of
surfacing 400 bytes downstream.

## Three pacing rules the transport must obey

None of these are visible on the wire. Both sides' transfer tapes can be
byte-identical while the received party is one byte short with its whole tail
shifted — which is exactly how this failed, roughly one run in three, always on
the passive side.

1. **Yield on a MACROTASK every step.** Node only reads a socket on a macrotask;
   a core stepping through microtask-only awaits starves its own link. Every
   slice ends in `setImmediate` — the check phase, which runs AFTER poll, so a
   packet that arrived during the frame is read before the next one starts.
   `Emulator.framePacer` exists so this reaches navigation and dialog too: the
   walk to the trade table is precisely where the ROM clocks the partner's
   position every frame.
2. **Hand over at most one byte per executed step, and only when the ROM can
   take it.** Gen1's serial ISR parks the received byte in a ONE-DEEP slot
   (`hSerialReceiveData`) for the main loop. Delivering on packet arrival lets
   the next byte overwrite the last, and the ROM drops a byte the transport
   thinks it delivered. The gate: transfer armed on the EXTERNAL clock, no
   serial IRQ still pending, a fresh out-byte staged, and the ROM has READ the
   previous byte out of the slot. Watch a READ of the DATA, not the flag beside
   it (`hSerialReceivedNewData`) — other link routines clear that flag before
   they wait, which reopens the gate a step early.
3. **Leave the peer's transfer OPEN until your core consumed the byte** (BGB
   `DEFER_REPLY`: answer the sync1 late). Your sync2 is the backpressure; it is
   what stops a free-running master from out-pacing its partner.
4. **Never deliver faster than the cable could** — one byte per 4096 CPU cycles
   (`BridgeOptions.byteTicks`; DMG serial is an 8192 Hz bit clock, 1 KB/s). A
   socket will hand you bytes orders of magnitude faster than that, and if you
   take them, your ROM's game loop drifts out of phase with the peer's while
   both are still nominally in the same routine. Because your reply is the
   master's backpressure, pacing your own deliveries paces the master too —
   which is precisely what a cable does.

**Patience is bounded** (`BridgeOptions.holdCycles`, default 4096 ≈ eight
transfer windows). Real hardware has none — the slave's shift register swaps
whether or not the ROM is ready — so a byte held longer than the hardware ever
would is not fidelity, it is a hang, and it hangs BOTH sides because the peer is
holding its transfer open for us. Measured: an unbounded gate deadlocked the
Cable Club handshake at 17 bytes with the master parked in the ROM's serial loop.
Because the bound is in cycles, it means the same thing at any slice size, and
it only bites where it matters: under fine slicing, around the block.

## Contract for the other side

Sit at the free chair, face the table, and drive your own A-presses. Answer
sync1 when your core has taken the byte, not when the packet lands. Nothing new
goes on the wire — this is all local pacing, and a BGB-correct implementation
that happens to be slow is indistinguishable from ours.

Rendezvous can still land in STRANDED before the continuation ever starts
(wq#510); the remedy is unchanged and lives at the orchestrator — relaunch both
sides, bump the port. `probe_m5c3` applies the same policy `tools/rdv-soak`
does, and prints the retry count rather than hiding it.

## Verified (wq#511)

`npx tsx src/link/probe_m5c3.ts` — **14/14**, two independent processes, no
shared memory:

- Both sides reach map 239, one master and one slave, and both ROMs report
  `wLinkState == 50`: the 415-byte block went in and the trade menu came up.
- **717 exchanges** across the bridge (wq#483 measured 30 — the handshake).
- M5b structural invariants **pass on both received blocks**; the peer's party
  reads as a real one (count=1, species 178, L20, hp 57/57).
- Every one of the 415 bytes matches our own party block **byte for byte, both
  directions**. The measurement that got there labels each differing byte by
  section (`mon0+22:134/23`, `ot0+3:128/80`): when the received byte at one
  offset equals ours N offsets later, that is N bytes LOST, not corruption —
  which is how a four-byte loss inside the mon array was found and fixed.

`npx tsx src/link/probe_invariants.ts` — 38/38, including the layout assertions
(`$D89C`, not `$D893`), a mirror that catches a one-byte-short shifted block,
and one that correctly ignores never-filled party slots.

**Honest limit:** both sides boot the same snapshot, so this proves the BLOCK
crossed intact, not that a trade swapped anything. Two different identities and
the post-swap check (`verifyPostTrade`) were the next milestone — they are the
"Trade" section under M5d below (wq#484), which also explains why a clone pair's
byte-for-byte mirror gate cannot be the desync check once the sides differ.

---

# Cross-node (M5d, wq#484) — measured, and where it stops

Everything above this line ran on one machine. M5d's question is the only one
localhost cannot answer: does the 415-byte exchange survive **two machines'
clocks and a real path's jitter**. This section replaces the old status line
("two full processes over Tailscale" as future work) with what is actually
built, what was actually measured, and the one thing that is blocked.

## What the link layer needed, and now has

1. **An address.** `rdv_side.ts` hardcoded `127.0.0.1` for both `listen` and
   `connect` — the single line that made a cross-node run impossible. It now
   reads `RDV_BIND` (listen address) and `RDV_HOST` (dial address), defaulting to
   `127.0.0.1` so every M5c caller is unchanged. Two variables, not one:
   listening on a tailnet address and dialling one are different decisions, and
   collapsing them is how you bind `0.0.0.0` by accident.
2. **A latency measurement that can actually see a network.** This is the part
   worth reading carefully, because the obvious implementation measures nothing.
   The protocol's `i1` timestamps count **emulated cycles** and deliberately do
   not advance while a byte is pending — that freeze is spec rule 5 and it is
   precisely what lets a remote peer wait for us correctly (M5a). So a link
   across a continent and a link on loopback produce **identical `i1` deltas**. A
   "latency distribution from bgblink timestamps" built on `i1` would be a
   distribution of emulated time and would read the same at any distance.
   `BgbLink` therefore samples **wall clock**: sync1 written to the socket ->
   the peer's answer (`sync2`, or a `sync3` ack) parsed back out of it, with the
   sync1's `i1` recorded beside it so the series can still be read against
   emulated time. Only a real answer to an outstanding sync1 closes a sample; the
   unsolicited timestamp-only `sync3` (b2=0) and a `sync2` arriving with no
   transfer open are both ignored, because counting either invents microsecond
   samples and makes any link look fast.
3. **The slave side kept separate, and the DEFERRED case sampled.** A sync1 we
   *answer* is our own core's turnaround, not the network's, so it lands in a
   distinct `serve` series — folding it into the round trips would let a slow
   core read as a slow link. The subtlety that bit the first run: `SerialBridge`
   answers every passive transfer via `DEFER_REPLY` (pacing rule 3), so an
   implementation that only times inline replies produces an empty series on the
   entire slave side. The first M5d pack came back with a 0-sample slave file for
   exactly that reason. The clock now runs from sync1 arrival until the handler's
   own `sync2`/`sync3`-ack is written, and samples carry a `deferred` flag,
   because a deferred hold (how long WE made a remote master wait) and an inline
   reply (pure handler cost) are different quantities.
4. **Percentiles, not an average.** A block is ~415 sequential transfers, so the
   number that decides whether one completes is the tail — one 15s outlier trips
   the bridge's settle budget and strands the peer while the mean stays in
   microseconds. `latency.ts` reports p50/p90/p99/max over fixed doubling
   buckets (fixed so two runs compare bucket-for-bucket; a histogram whose bins
   move with the sample is a picture, not a measurement).

`npx tsx src/link/probe_latency.ts` — **31/31**, and the red half is the point:
the no-open-transfer sync2, the b2=0 sync3, a duplicate answer, and handshake
version/status traffic are each asserted to produce **zero** samples, and a
999-fast-plus-one-20ms series is asserted to move p99/max while leaving the mean
healthy. `probe_bgblink` is still 19 PASS / 0 FAIL after the change.

## What was measured

`npx tsx src/link/probe_m5d.ts --sessions 3 --bind 100.117.66.102` runs the
M5c-3 two-process session repeatedly and writes the pack to
`docs/multiplayer/evidence/M5d/` (see its `README.md`). Per session it gates on
rendezvous, the seat, `wLinkState == 50`, M5b invariants over the received
bytes, and — the desync gate — the received block matching our own party **byte
for byte**, which is the only check that sees a single lost byte.

**3 consecutive sessions, 47 PASS / 1 FAIL — the one FAIL is the probe refusing
to call a same-host run cross-node.** Every session: both sides reached map 239,
one master and one slave (the roles are negotiated, and they swapped between
sessions), both ROMs reported `wLinkState == 50`, ~702 exchanges each, M5b
invariants passed on both received blocks, and **zero desyncs — 0 differing
bytes, 3/3 sessions, both sides**. One session needed no retry; the wq#510
STRANDED relaunch fired twice on an earlier run of the same probe and is
reported, not hidden.

The latency result is the interesting part, and it is not the number the
aggregate first suggests. Over a whole session the distribution reads as
catastrophic — p50 293us against p99 105ms and max 238ms, a 350x spread. Split
the series and the spread disappears:

```
$ npx tsx src/link/latency_report.ts docs/multiplayer/evidence/M5d/m5d-latency-s3-B.json
all     : n=702 p50=260.8us p90=543.7us  p99=15059.2us  max=182893.1us
pre-415 : n=287 p50=234.9us p90=2636.2us p99=162556.3us max=182893.1us
last 415: n=415 p50=285.0us p90=490.1us  p99=858.9us    max=1172.4us
p99 payload / p99 all = 0.057
```

**The 415-byte block is not where the tail lives.** Its worst transfer of 415 is
1.2ms and its p99 is 859us; every hundred-millisecond hold is in the handshake
and room negotiation before it, where the ROM legitimately sits between bytes
and our side holds the peer's transfer open (pacing rule 3) while its core
catches up. The slave's own `serve` series confirms the mechanism rather than
inferring it: its p99 is the same 115ms magnitude as the master's rtt tail, so
those round trips are the PEER holding the transfer, not a path.

One serve sample in the pack reads 11.97s, which is close enough to the 15s
settle budget to look like a near-miss and is worth naming rather than leaving
for a reader to trip over. It is sample **index 0** of session 3 side A — the
very first transfer, the late-joining side waiting for its own core to walk in
and take the first byte. Its immediate neighbours are 161ms and 109ms, and only
2 of that side's 608 samples exceed 1s. It is a startup artifact, not steady
state; a cross-node run should still expect it, because the first transfer waits
on the slower side's walk no matter where that side is.

That makes a falsifiable prediction for the cross-node run, which is the most
useful thing a baseline can produce. The per-byte settle budget is 15s, so even
a 100ms path has ~150x headroom per transfer and no individual byte is at risk.
The exposure is cumulative wall time: the block costs 130ms here, and at a
tailnet round trip of 30ms it would cost 415 x 30ms ~= 12s — still under the
25s idle-linger that ends a session, but without much margin. **If a cross-node
session fails, expect it to fail as a linger timeout on the whole block, not as
a lost byte on one transfer.** That is the hypothesis the blocked half should
test first.

`latency_report.ts` reads a committed evidence file, so the split above is
re-runnable from the repo at any later commit — no emulator, no sockets, and no
way to accidentally cite a different session than the one in the pack.

## The trade itself, across two processes

The section above stops where M5c-3 stopped: the two parties have been shown to
each other. A trade is what happens next, and until now it existed only
in-process (M3, `trade.ts`), because M3's confirm loop reads BOTH cores — it waits
until both sides report the STATS|TRADE submenu and only then presses RIGHT+A,
"parking whoever arrives first". A remote side cannot do that; it cannot see the
peer's menu at all.

What replaces it is what a human player does, and the ROM is already built for
it. `trade_side.ts` walks its OWN menu to the wanted slot, selects TRADE, and
then **holds still** while `Serial_SyncAndExchangeNybble` ($00:227F) converges.
The quiet phase is load-bearing rather than polite: a keypress knocks a waiting
side out of the sync loop at $226E and the two selections never agree. The menu
decode both drivers use is one module now (`trade_menu.ts`, ROM-derived from
`wMenuWatchedKeys`), because a difference in how the in-process and cross-process
drivers read the same menu would be indistinguishable from a link fault.

**The pair must be asymmetric, and that changes the desync gate.** Both sides
boot one snapshot, so their parties are byte-identical and a completed swap
leaves RAM unchanged — indistinguishable from a swap that never happened (M3's
blind-run rule). Exactly one side is therefore patched into a different trainer
before the first byte. Which side is fixed by TAG, not by the negotiated
master/slave role: the roles swap between sessions, and a patch that followed
them would change what each session proves.

That makes the byte-for-byte mirror gate above unusable here — an asymmetric pair
is SUPPOSED to differ. The replacement is stricter in the way that matters: the
difference must be **confined to the block sections the peer's known patch can
reach, and non-empty**. Both halves can fail. A byte lost or shifted anywhere
lands outside the allowed set (`mon2+1` for a slot the patch never touches);
a patch that never crossed leaves the set empty and is reported as "the peer's
identity did not cross" rather than as a clean run. The allowed set is derived
from the patch fields and the symbol table, never from remembered offsets:
`writeIdentity` couples playerName -> mon1OT and playerID -> mon1OTID, so it is
wider than the patch literal looks (30 sections moved in every session here).

`npx tsx src/link/probe_m5d.ts --mode trade --sessions 3 --bind 100.117.66.102` —
**72 PASS / 1 FAIL, and the FAIL is again the probe refusing to call a same-host
run cross-node.** Every session, both sides:

- a **full two-way swap** — each side gave its own mon away and received the
  peer's (`sp178/id$23c2/lv20/OT:AAAAAAA/nick:CHARMELEON` one way,
  `sp178/id$1122/lv25/OT:BOB/nick:BOBMON` the other),
- the mon held afterwards is **exactly the identity the peer's block advertised**,
  OT and nickname included — the one-sided form of "A ends holding B's exact
  mon", checked against the received bytes rather than against the peer's RAM,
- `verifyPostTrade` green: party count stable, every other slot untouched,
- **zero desyncs, 3/3 sessions, both sides** — 30 moved sections, 0 outside the
  allowed set, on all six side-runs,
- one confirm attempt each: the first selection converged every time.

Session 2 needed one wq#510 STRANDED relaunch, which is reported rather than
hidden. A trade session is **7.8k to 15.8k master round trips (mean 12.6k over
the three) against the block's 702** — an order of magnitude more link traffic,
and the reason it sharpens the cross-node prediction below. The spread is wide
because the trade phase ends when the sync converges, not after a fixed count;
take the mean as the planning number and the 15.8k as the one to budget for.

**The pack ships its own negative control**, because a gate that has only ever
been shown passing cannot be told apart from a gate wired to `true`.
`--patched-tag none` runs the same trade mode with nobody patched — a clone pair —
and asserts the inverse: every side must be REFUSED. Its artifacts are
`m5d-trade-control-*` and their content is failures by design. The pure half of
the same logic is covered without an emulator by
`npx tsx src/link/probe_trade_side.ts` — **44/44**, whose red half asserts that a
byte moved in slot 2 lands outside the allowed set, that an unpatched pair yields
an empty one, that a peer which never converges produces `swapped: false` instead
of a hang, and that a cancel box is dismissed with B (pressing A there ends the
session).

## What is blocked, and why it is not a code problem

The peer has to run on a second machine, and a fworker cannot start a process on
one. Not a Thor-specific rule and not something a policy PR can widen:

- `ssh` is absent from `harness/worker-settings.json`, which grants exactly one
  remote reach, `Bash(/home/lumen/bin/fleet-exec *)`.
- `fleet-exec run thor node --version` ->
  `DENY [policy:shell_escape_basename]: node is never a run target`. `node` and
  `nodejs` are members of `_SHELL_ESCAPE_BASENAMES`
  (`/home/lumen/bin/fleet_exec_policy.py:30-34`), rejected in `check_run()`
  **before** any allowlist or per-ticket grant is consulted, on **every** node.
- `fleet-exec run isis node --version` -> `DENY [grant:no_ssh_run]`, i.e. the
  same wall one layer earlier on a node that is not Thor. The probe was run
  off-Thor deliberately: a denial observed only on the hardlocked node would
  have proved nothing about the rule's scope.
- Thor additionally carries `THOR_HARDLOCK` (same file, `:26`, `:198`), which
  `foreman/harness/fleet-exec-policy.yaml` documents as deliberately code-level
  so an edited copy of that yaml still cannot open it past read-only `run` plus
  `copy` into `/home/thor/lumen-drop`.
- `copy` can stage a prebuilt bundle into that drop, but nothing on
  `run_readonly_cmds` (`cat ls stat df free journalctl ss`, `ip addr`,
  `tailscale status`, `docker ps|logs`) can start it — and
  `fleet-exec run thor ls -la /home/thor/lumen-drop` shows the drop **empty with
  no watcher**, so staging cannot be turned into starting by dropping into
  something that already runs what lands there.
- `fleet-exec --help` lists the whole verb set: `{run,copy,restart,grant}`. There
  is no verb that executes a script, and `restart` is refused on a never-node.

One narrow path does already exist in the policy code and is worth naming,
because it is the difference between "widen the gate" and "review one tool":
`check_bench()` (`fleet_exec_policy.py:267-274`) permits a run on a hardlocked
node for any tool listed in `bench_tools[<node>]` — a yaml allowlist reviewed
entry by entry, requiring no change to `_SHELL_ESCAPE_BASENAMES` and no
loosening of `THOR_HARDLOCK`. It is not a route today: fleet-exec has no `bench`
verb yet (the docstring says so). That decision is **wq#3200** (fleet lane),
which also records why removing `node` from `_SHELL_ESCAPE_BASENAMES` is the
wrong fix — it opens arbitrary exec on every node to unblock one game link.

The tailnet itself is healthy and was verified from Thor's own view:
`fleet-exec run thor tailscale status` reports `100.117.66.102 lumen-1 ...
active; direct`, and `lumen`'s `tailscale0` holds `100.117.66.102/32`. Nothing
about the network is the obstacle.

**Two things must happen before M5d's gate can close, and only one of them is
still a milestone.**

First, a way for the peer to run on a second node. That is **wq#3200** — a
reviewed narrow exec path, not a widening — or a human launching `rdv_side.ts`
from a synced checkout. `probe_m5d --peer remote --mode trade` prints that
command with the port, both addresses, and the asymmetry env all filled in, then
waits for it; a peer started without `RDV_IDENT`/`RDV_ASYM` would be a clone pair
whose swap is invisible, so the printer never omits them.

Second, the battle. The trade half of "full trade AND battle across the tailnet"
is now built and measured (previous section) — a distance only has to carry it.
A battle to knockout against a remote peer is still two-cores-in-one-process
only: `invariants.verifyBattleLedger()` is already the one-sided verification and
has no driver calling it. That is **wq#3201**, and it needs no cross-node
capability at all, so it is not blocked by wq#3200.

What the trade pack changes about the cross-node prediction, and it is worth
restating because the earlier number was for the block alone: a trade session
runs **7.8k-15.8k transfers**, not ~700. No single transfer is at risk — the per-byte
settle budget is 15s and the observed per-transfer p50 is ~0.9ms, ~16000x of
headroom. The exposure is entirely cumulative wall time, and it is now an order of
magnitude larger: at a 30ms tailnet round trip, the mean 12.6k sequential
transfers is **~6.3 minutes of link time** (~8 at the observed worst session), and
three constants sit inside that. `spawnSide`'s `--timeout-ms` is 600s, so a 378s
trade phase plus rendezvous lands just under a SIGKILL — and the 15.8k session
would exceed it. The linger is `RDV_LINGER_MS=45000` hard with a 25s idle cutoff,
which is ample at 0.9ms per transfer and nowhere near enough for a side waiting on
a 30ms-RTT peer to finish. **So the first cross-node trade
should be expected to fail as a timeout — the linger first, the side timeout
second — and not as a lost byte; the fix is budgets scaled from the measured
round trip rather than constants.** Change those three before concluding
anything about the path. The block-only mode stays the cheap cross-node smoke
test: 702 transfers is ~21s at the same round trip and fits every budget as it
stands.

No firewall or iptables rule was added, removed, or changed for any of this.
