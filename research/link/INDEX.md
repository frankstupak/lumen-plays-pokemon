# LPP Multiplayer — Research Index (M0 phase)
Doctrine: ../../docs/multiplayer/DOCTRINE.md

- R1_dmg_serial_protocol.md   — SB/SC registers, internal/external clock, MSB-first, $FF open
                                 cable, serverboy stub mapping. DMG-only for M1.
- R2_reference_implementations.md — master/passive mechanics, the universal f(recv)->send
                                 callback model, two-cores-in-one-process precedent, design
                                 lock-ins, BGB-TCP for M5, mock traders as test oracles.
- R3_gen1_cable_club.md       — Gen1 handshake, 0xFD preamble / 0xFE sentinel, shared-RNG
                                 seed (=> reproducible link battles), 415-byte party block;
                                 byte-level turn-based => byte-exact lockstep SUFFICIENT.

## Verdict (M0 gate): GREEN to design M1.
serverboy's serial state machine is present-but-stubbed; the protocol is byte-level and
turn-based; the bridge is the industry-standard byte-swap callback; shared-RNG makes battles
reproducible for testing. No cycle-accurate sync needed. No emulator swap needed for M1.

## STILL TO PIN AT BUILD TIME (against pinned pokeblue.sym + a pinned pokered commit — never
## from memory): exact SERIAL_PREAMBLE_BYTE value + counts; wLinkState/wSerial* addresses;
## master/slave negotiation byte order from cable_club.asm.

## OPEN DEEPER-RESEARCH THREADS (optional, for "much much better"):
- D1: exact cycle budget of serverboy's serialShiftTimer vs our lockstep step size — confirm
      no IRQ-timing regression on the single-player path when the bus is idle.
- D2: SameBoy source (GB_serial_set_data / connect_serial_device) as a correctness oracle for
      edge cases (double-start, mid-transfer SC rewrite, disconnect).
- D3: BGB link-protocol wire format spec (for M5) — version handshake, timestamp sync bytes.

## R4 (ADDED 2026-08-08): ROM-verified facts — supersedes memory/web for byte values.
- SERIAL_PREAMBLE_BYTE = $FD (verified from Serial_ExchangeBytes cp $FD).
- Follower arms SC=$80, master SC=$81 (verified from Serial ISR bytes).
- wLinkState=$D12B, wLinkTimeoutCounter=$CC47 (from pokeblue.sym).
- Inter-byte software delay loop exists; byte-level lockstep absorbs it (no bus change).
- LINK_STATE_* numeric enum: CONFIRM IN VIVO in M2 (ISR branches on value 2); do not hardcode.

## STATUS 2026-08-10: M1/M2/M3 COMPLETE — trade verified end-to-end.
See ../../docs/multiplayer/M3_TRADE.md and the M3 section appended to R4.
- wLinkState pinned in vivo: $01 IN_CABLE_CLUB, $02 session started, $32 (50) trade menu.
- STATS|TRADE submenu is HORIZONTAL (wMenuWatchedKeys $CC29 = $13, RIGHT|B|A); DOWN is
  not watched. RIGHT then A. DOWN on the party list selects CANCEL and aborts the session.
- METHOD RULE (learned the expensive way): the two cores must have DIFFERENT identities
  before any link traffic. Booting both from one snapshot makes them byte-identical, so a
  successful trade and a failed trade produce the same RAM and every check is blind. Use
  src/link/identity.ts writeIdentity(); TradeSession refuses to report success from a clone
  pair. This cost several sessions of chasing ROM-side phantoms that were never wrong.
- M3-BATTLE DONE 2026-08-10: full Gen1 Cable Club link battle to knockout between two
  cores, 10/10 turns mirrored, shared RNG list identical both sides. See
  ../../docs/multiplayer/M3_BATTLE.md. COLOSSEUM = map $F0 (ROM: LoadSpecialWarpData $6314
  cp $F0); wLinkState 1 -> 3 -> 4 where 4 = BATTLING (CableClub_DoBattleOrTradeAgain $54D8);
  the battle move list is ONE-INDEXED; move selection has the SAME no-input law as the
  trade nybble sync, and link-battle narration scrolls itself (ManualTextScroll.inLinkBattle)
  so pressing A through it is actively harmful.
- M4 DUEL DONE 2026-08-10: model-vs-model link battle SHIPPED — cerebras-oss-120b vs
  deepseek-v4-flash, 6/6 mirrored, winner decided. Per-side BrainProfile from env
  (LPP_DUEL_A_MODEL etc). Brains choose a move SLOT only; keys/timing/bus stay inside the
  M3-verified LinkBattleSession. See ../../docs/multiplayer/M4_DUEL.md.
- Next: M5 (wq#433, stretch) — BGB link-over-TCP so a REMOTE orchestrator can challenge.
  Research thread D3 (BGB wire format) first; f(recv)->send stays unchanged per R2.
