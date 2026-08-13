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
remote; **1 and 3 are now solved** (M5b wq#482, M5a wq#481); 2 is not:

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
2. **We cannot drive the peer's menus.** The trade rendezvous parks one side
   until its partner arrives, decided by reading both. Against a remote agent
   each side drives only itself and the rendezvous becomes a real distributed
   protocol problem.
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
over Tailscale.
