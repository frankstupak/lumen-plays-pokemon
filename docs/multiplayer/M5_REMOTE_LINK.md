# M5 — Remote link over BGB TCP

**Status 2026-08-10: transport layer BUILT AND VERIFIED. The ROM-over-TCP
bridge is not built yet** — see "What is still missing" at the bottom. Nothing
here claims a remote battle has happened.

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

The transport is the easy half. Three things genuinely change when the peer is
remote, and none are solved yet:

1. **The peer's RAM is unreadable.** Every verification in M3/M4 reads both
   cores in one process — the mirror check compares A's HP against B's view of
   it. Remotely we can only verify from our own side plus what the ROM itself
   received. The mirror has to be re-expressed as a one-sided invariant.
2. **We cannot drive the peer's menus.** The trade rendezvous parks one side
   until its partner arrives, decided by reading both. Against a remote agent
   each side drives only itself and the rendezvous becomes a real distributed
   protocol problem.
3. **Latency replaces lockstep.** In-process we choose exactly when a byte
   lands. Over TCP our core has to be able to wait — which is what the
   timestamps are for, and the reason ours tracks emulated cycles.

Next tranche, in order: a scripted mock peer over the socket against our real
ROM's Cable Club handshake, then two full processes over Tailscale.
