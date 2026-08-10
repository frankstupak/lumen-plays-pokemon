# R1 — DMG Serial Protocol (link cable) — RESEARCH-BACKED, cite before code

Sources: Pan Docs "Serial Data Transfer (Link Cable)" (gbdev.io); GB CPU Manual (Pan of
Anthrox et al.); gbdev gg8 wiki. Cross-agreed across all three.

## Registers
- **SB = $FF01** — serial transfer data (R/W). The 8 bits shifted out AND the byte shifted in.
- **SC = $FF02** — serial control (R/W):
  - bit7 = Transfer Start (1=start; auto-clears to 0 at end of transfer).
  - bit1 = Clock Speed (CGB only; 0=normal 1=fast). DMG/Gen1: ignore.
  - bit0 = Shift Clock source. **0 = External clock, 1 = Internal clock (8192Hz on DMG).**

## Transfer semantics (the load-bearing facts)
1. Transmit + receive are SIMULTANEOUS. During one transfer a byte shifts OUT of SB while a
   byte shifts IN to SB. **MSB first**, both directions.
2. Exactly ONE side supplies internal clock (drives), the OTHER uses external (follows).
   Gen1 negotiates who is which (master/slave) in its own handshake (see R3).
3. External-clock side "eagerly waits for the next bit... no limitation... even 1 bit per
   month" and "will not complete until the last bit is received." => The BRIDGE owns the clock
   domain: the follower blocks in-emulation until we deliver the master's byte. This is what
   makes deterministic lockstep possible — we are not racing two free-running clocks.
4. Internal clock + NO partner present => **$FF received** (open cable = high line).
   NOTE: serverboy's stub shifts in `|0x01` (L1603/L1773), i.e. it fills with 1-bits but as a
   left-shift-in-LSB it yields 0xFF over 8 shifts anyway; either way the REAL-partner path
   replaces this. Do not preserve the stub behavior.
5. bit7 auto-clears at end; a Serial interrupt (IF bit3 / $FF0F) fires on completion. Gen1
   uses the serial IRQ, so the completion signal must set interruptsRequested |= 0x8 exactly
   as the internal-clock timer path already does (gameboy.js L1596).

## serverboy core mapping (verified in-tree 2026-08-08)
- SC write handler ~L4900: internal-clock branch sets serialTimer (4096 normal / 128 fast) +
  serialShiftTimer (512 / 16); external-clock branch ZEROS timers "as if nothing connected".
- Shift spots L1603 & L1773 fill SB with open-cable bits + no partner byte.
=> The bridge must: (a) on a start-transfer write with a partner attached, exchange the SB
   byte with the peer instead of open-cabling; (b) make the external-clock (follower) side
   actually advance when the master transfers, instead of zeroing its timers.

## DMG-only simplification for M1
Gen1 Blue boots DMG mode (cGBC=false path). Single 8192Hz rate. Ignore CGB 4-rate + double
speed until a Gen2/GBC phase. This shrinks M1 to the normal-speed internal/external pair.

## Open question for R2/R3
- Cycle-exact vs byte-exact sync: does Gen1's protocol tolerate byte-level lockstep (exchange
  whole bytes at each SC-start) or does it depend on sub-byte timing? (Trade/battle are
  turn-based request/response -> byte-level is almost certainly sufficient; CONFIRM in R2 via
  a correct emulator's implementation + R3 via the disasm's delay loops.)
