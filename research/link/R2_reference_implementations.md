# R2 — Reference link implementations (how correct emulators wire it) — model to copy

Sources: gbdev gg8 wiki (master/passive mechanics + bit-shift diagram); GBPlay blog
"Connecting to a Game Boy Link Cable From a PC" (callback model + BGB-server-modeled code);
insideGadgets wireless cable (MCU byte-swap ISR); gb-asm-tutorial serial-link (Emulicious/GBE+
network-socket model); SameBoy libretro "2 Player Game Boy Link Subsystem API" (two cores in
one process). BGB link-over-TCP = the de-facto network standard (target for M5).

## Master / passive mechanics (gg8, authoritative)
- Master: load SB, set SC=0x81 (start + internal clock). Done => SC bit7 clears (SC=0x01) +
  serial IRQ (jump 0x0058).
- Passive: load SB, optionally set SC=0x80 (external, request). When master transfers, the
  exchange happens regardless; passive's IRQ fires at end.
- FORGIVING TIMING: if passive hasn't loaded its next byte at transfer time, THE LAST BYTE
  GOES OUT AGAIN. If ready early, it waits. => our bridge does not need perfect readiness;
  it needs correct byte-swap at each master transfer-start.
- Bit shift (both sides, MSB first, simultaneous): each cycle leftmost bit out over wire,
  incoming bit in from other side. After 8, SB holds the fully-received byte.

## THE canonical software model (adopt verbatim as our interface)
Every network/adapter link server (BGB, GBPlay, Arduino) is the SAME callback:
    send_byte = f(previously_received_byte_or_null)
A loop: call f with last received byte -> get byte to send -> exchange -> save response.
=> Our SerialBus is: exchange(outByte) -> inByte, with the two cores as the two ends.
   M5 network form: the same bytes over a socket (BGB protocol) instead of in-process.

## Two-cores-in-one-process precedent
SameBoy's libretro core runs TWO Game Boys simultaneously with a link subsystem in ONE
process. Confirms our in-process M1 plan (two serverboy Emulator instances + a bus between
them, stepped in lockstep) is a proven shape, not novel risk.

## Design lock-ins from R1+R2+R3
1. Interface: `SerialBus.exchange(fromCore: 0|1, outByte): inByte` — byte granularity.
2. Lockstep: step both cores; when either sets SC bit7 with a partner attached, perform the
   exchange (master's clock drives; follower's queued byte is the reply; if follower not
   ready, resend last — matches hardware). Then both get their serial IRQ.
3. Clock domain owned by the bridge (R1 fact: external side waits indefinitely) => no race.
4. Replace serverboy stub at L1603/L1773 + the SC external-clock zeroing (L4910) with
   bus-driven exchange. Keep the internal-clock timer path (IRQ + auto-clear) intact.
5. Network (M5): swap the in-process bus for a BGB-protocol TCP socket; f() is unchanged.

## Prior art to study (NOT copy — license + our-harness reasons)
- projectpokemon "Generation 1 Link Protocol" (real-device over internet).
- nitwhiz mock trader + GBPlay mock Pokemon trader (Python) — great TEST oracles: we can
  validate our bridge against a known-good trade byte stream before wiring two live cores.

## BLOCK TRANSFER: interleaving granularity (measured 2026-08-08, wq#431)
Source: MrCheeze/pokered-self-replicator (runs on real hardware) documents
Serial_ExchangeBytes: "The data sent ... must begin with the byte FD. The data received is
stored to [de], and will start with an UNKNOWN NUMBER OF FD bytes" — the receiver copes with
a variable-length preamble by scanning past FDs. nitwhiz documents the two 190-byte PATCH
LISTS that encode where 0xFE occurs in the 415-byte trade block (0xFE cannot ride the wire;
received data has 0xFF at those indexes and is patched back).

CONSEQUENCE FOR OUR BUS: the ROM tolerates a variable preamble but NOT lost byte alignment.
serverboy only exposes whole-frame execution (~70k cycles). Running core A for a full frame
then core B for a full frame freezes the follower for the master's entire frame, so it cannot
run its serial ISR to stage a fresh reply; per the hardware rule the unready follower
re-sends its LAST byte. Over a 415-byte block the master therefore clocks hundreds of bytes
against one stale value.
MEASURED SYMPTOM: trade menu rendered the partner's party as glitch entries ('M 'M 'M ...).
FIX: shrink each doFrame() to ~one serial-transfer window (512 cycles at the DMG 8192Hz
rate; divisor 64 of serverboy's ~33552 default => 524 cycles) and complete transfers on a
deferred tick so the follower executes between clocks. See src/link/lockstep.ts.
MEASURED RESULT: partner list renders the REAL party ("AAAAAAA CHARMELEON"), ZERO glitch
entries; exchanges 701 -> 826.
COST: wall time scales with the divisor -> use COARSE for navigation/dialog, FINE only
around block transfers (hybrid).
NOTE: an earlier attempt at FRAME-granularity deferral (deferTicks with full frames) was
tested and REJECTED — a frame is ~137x the transfer window; it collapsed to 4 exchanges.
The granularity, not the deferral idea, was what was wrong.
