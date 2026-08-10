# R5 — BGB link-over-TCP (M5 research, thread D3) — 2026-08-10

Source of truth: <https://bgb.bircd.org/bgblink.html> ("bgb 1.4 link protocol",
used in bgb 1.4.x/1.5.x). Read directly, not from memory. Everything below is
from that page unless marked OURS.

## Shape

TCP/IP. **One side listens, the other connects.** After the handshake, and until
the socket breaks, a plugged-in link cable is emulated.

Two operational requirements the page calls out explicitly, both easy to get
wrong:

- **`TCP_NODELAY` must be set**, or the OS adds delays.
- **Packet boundaries are not guaranteed.** Several commands can arrive in one
  TCP segment and one command can be split across segments. A reader that
  assumes one packet per `data` event will corrupt the stream — it must buffer
  and cut on 8-byte boundaries.

## Packet

All communication is 8-byte packets. Bit 0 is the lowest bit.

| ofs | size | field |
|---|---|---|
| 0 | 1 | `b1` — command |
| 1 | 1 | `b2` |
| 2 | 1 | `b3` |
| 3 | 1 | `b4` |
| 4 | 4 | `i1` — timestamp, **little endian** |

`i1` is usually a timestamp but its meaning is per-command.

## Commands

| # | name | fields |
|---|---|---|
| 1 | version | `b2=1 b3=4 b4=0 i1=0` |
| 101 | joypad | `b2` bit0-2 button, bit3 pressed; bits 4-7 MUST be 0 |
| 104 | sync1 | send a byte **as master**. `b2`=data, `b3`=control (bit0=1, bit1 high speed, bit2 double speed, bit7=1), `i1`=timestamp |
| 105 | sync2 | send a byte **as slave**, in response to a sync1 when a passive transfer was started. `b2`=data, `b3`=`$80` |
| 106 | sync3 | `b2=1` → ack of an active transfer when not doing a passive transfer. `b2=0` → timestamp-only sync, `i1`=timestamp |
| 108 | status | `b2` bit0 running, bit1 paused, bit2 supports reconnect |
| 109 | wantdisconnect | 1.5.2+, all fields 0 |

**Handshake:** both sides send `version` and verify what they receive; a
mismatch drops the connection. `status` is sent **in response to version** and
whenever status changes, and **must not** be sent in response to a status.

**Reserved bits:** any field or bit not used for a purpose MUST be 0 on send and
MUST be ignored on receive. The joypad bits 4-7 are permanently reserved because
of an old bgb bug.

## Timestamps

Both sides keep a timestamp in **2 MiHz clocks (2^21 per second)**, send their
own in packets, and track the difference against the received one. **Lowest 31
bits only, top bit always 0**, and they wrap. Their purpose is to let each side
wait for the remote at the right moments.

## Mapping onto our bus (OURS)

R2's design lock-in is that the network form changes nothing above the
transport: `send_byte = f(previously_received_byte)` is unchanged, and our
`SerialBus.exchange(fromCore, outByte) -> inByte` is exactly that. So M5 swaps
the *peer end* of the bus, not the ROM wiring and not the session logic.

| our event | BGB packet |
|---|---|
| our core writes SC with bit7+bit0 (internal clock = master) | send `sync1`, `b2`=SB, `b3`=SC\|`$80` |
| peer answers | `sync2` → deliver `b2` to our core as the received byte |
| we receive `sync1` (peer is master) | reply `sync2` with our staged `$FFAC` byte, deliver their `b2` to our core |
| we receive `sync3 b2=0` | timestamp-only; answer with our own `sync3` |

The R2 forgiving-timing rule still saves us: if the passive side has not staged
a fresh byte, its previous byte goes out again and the master never blocks. That
is the same tolerance our in-process bus already relies on, so the network form
does not need a new correctness argument — only bounded latency.

## What is genuinely different over TCP (OURS)

1. **The peer's RAM is unreadable.** Every verification we built for M3/M4 reads
   both cores' RAM in one process. A remote match can only be verified from
   *our* side plus what the ROM itself received (the partner's party block, the
   partner's selected move). The mirror check has to become a one-sided
   invariant.
2. **We cannot drive the peer's menus.** The trade rendezvous parks a side until
   its partner arrives, which our driver currently decides by reading both
   sides. Against a remote agent, each side drives only itself, and the
   rendezvous becomes a real distributed protocol problem.
3. **Latency replaces lockstep.** In-process we step both cores and control
   exactly when a byte lands. Over TCP, our core must be able to wait — which is
   what the timestamps are for.

## Verification plan (OURS)

Real BGB is not installed here and is not needed to prove the transport: two of
**our own** processes, one listening and one connecting, speaking the documented
packet format, is a complete test of the wire layer and is BGB-compatible by
construction. Order:

1. Codec + framing, with a split-packet test (the boundary rule above is the
   most likely silent bug).
2. Loopback: two `BgbLink` endpoints over localhost, byte-exact stream both
   directions, master and slave roles.
3. One core + one remote peer: our ROM's Cable Club handshake against a
   scripted mock over the socket.
4. Two full processes, two cores, over Tailscale.

Steps 3-4 need the one-sided session rework in "What is genuinely different"
and are the next tranche.
