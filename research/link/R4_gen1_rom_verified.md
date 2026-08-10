# R4 — Gen1 link facts VERIFIED FROM THE RUNNING ROM (pokeblue.gb) — 2026-08-08

Method: disassembled bytes at symbol addresses from roms/pokeblue.sym. This is ground
truth (the actual cart the harness runs), superseding any web/memory value.

## Pinned WRAM addresses (from pokeblue.sym, authoritative)
- wLinkState              = $D12B  (master link status byte the harness reads)
- wLinkTimeoutCounter     = $CC47
- wSerialExchangeNybbleReceiveData = $CC3E ; SendData = $CC42
- wLinkBattleRandomNumberList       = $D148 ; ...ListIndex = $CCDE
- wSerialPlayerDataBlock  = $D152 ; wSerialEnemyDataBlock = $D893
- wPlayerName             = $D158 ; wLinkEnemyTrainerName = $D887
- wSerialPartyMonsPatchList = $C508 ; EnemyMonsPatchList = $C5D0

## Serial ISR @ $2125 (bank0) — decoded, confirms our bus design
- Reads a link-status mirror, branches on "connectionNotYetEstablished".
- `cp 2 ; jr z` — link-state value 2 is a real branch target (START/negotiation).
- **Follower path sets SC=$80**: bytes `3e 80 e0 02` = `ld a,$80 ; ldh [$FF02],a`
  => external clock, transfer-request. EXACTLY what our hook treats as the follower arming.
- usingInternalClock path (@ $215F): `ld a,$01 ; ldh [$FFA9],a` then touches $FFAC — the
  master/internal branch. Confirms Gen1 negotiates internal-vs-external at runtime; our bus
  assigning master/follower per SC bit0 is faithful.

## Serial_ExchangeBytes @ $216F — decoded, confirms preamble + timing model
- `ld a,$01 ; ldh [$FFAB],a` (sets an in-progress flag), then reads SB mirror.
- **Inter-byte DELAY LOOP**: `ld a,$30 ; .loop dec a ; jr nz,.loop` — a software spin between
  byte transfers. Our BYTE-LEVEL lockstep handles this for free: the external side waits
  (R1), so the delay just spins locally; no bus action needed mid-delay.
- **`cp $FD`**: `fe fd 20 e6` — **SERIAL_PREAMBLE_BYTE = $FD**, VERIFIED from ROM (resolves
  the R3 open question: $FD, not $DF; the $DF sighting was a different writeup/version).

## Consequences locked
1. Our SerialBus + hook (M1) matches the ROM's actual serial contract: SC=$80 follower /
   SC=$81 master, byte-at-a-time with local delay loops the bus does not need to model.
2. M2 reads wLinkState @ $D12B to know connection status; harness needs the exact
   LINK_STATE_* enum values — pin them by SINGLE-STEPPING the live ROM through Serial once
   M2 wiring exists (observe the value written to $D12B at each stage), rather than trusting
   any external table. Placeholder mapping to confirm: 0=none, then cable-club/battling/
   trading are small ints (ISR branches on 2). CONFIRM IN VIVO before relying.
3. $FD preamble + $FE "no data" sentinel (R3) both confirmed relevant; bridge stays
   byte-transparent (ROM handles framing), so no special-casing needed in the bus itself —
   the special bytes only matter to the ROM, which runs its own link code over our wire.

## IN-VIVO CONFIRMED (2026-08-08, wq#434/#431) — observed on running cores
- **wLinkState 0x01 = LINK_STATE_IN_CABLE_CLUB** — observed on a core that completed the
  Cable Club handshake over our SerialBus (peer simultaneously at the room-select menu).
- **Cable Club attendant**: Pewter Center (map 58), NPC sprite pic=42 at tile (11,2).
  Player interacts from (11,3) facing UP.
- **Connection window is DURING the attendant dialog**, not after the save prompt: the ROM
  alternates SC=$80/$81 ~73x while the dialog runs, then issues ZERO SC writes afterwards.
  A link hook attached after that point can never fire (the core blocks on SC=$80 forever).
- **Handshake requires OPPOSITE phase**: the loop stages SB=2 while waiting / SB=1 while
  probing, and the Serial ISR sets $FFAA (connection status) to the RECEIVED byte. Two cores
  in perfect lockstep from one checkpoint stage the SAME byte simultaneously and neither ever
  gets the complementary value. A ~27-frame PHASE SKEW reproduces real-player asymmetry and
  the handshake completes. (No hardware analogue to the deadlock — it is a lockstep artifact.)
- **Room-select menu**: "TRADE CENTER" / "COLOSSEUM" / "CANCEL", cursor lands on TRADE CENTER
  at screen (6,7). Selection is exchanged as a nybble: send $CC42, recv $CC3E, via
  Serial_SyncAndExchangeNybble ($2247) / Serial_ExchangeLinkMenuSelection.
- **Trade Center room = map 239 ($EF)** — REACHED in vivo by the selecting core.
- RESOLVED 2026-08-10 (was OPEN): the nybble exchange DOES converge — both sides reach
  $CC3D=$CC3E and the trade completes. The fix was sub-frame slicing plus peer catch-up
  (see the M3 section below). Original note kept for the record:
- (superseded) the nybble exchange does not converge for the non-selecting peer (selector
  s/r=d4/00, peer s/r=d0/7f). Suspected cause = instant-delivery staleness in the bus (the
  master receives the follower's previous byte). Next: give the follower a chance to stage
  its reply within the transfer window (sub-frame, NOT frame-granularity — frame deferral was
  tested and is far too coarse).

## IN-VIVO CONFIRMED (2026-08-10) — M3 TRADE COMPLETE

Full Cable Club trade executed between two independent cores over our SerialBus,
end-to-end from a cold start. Details and the drive sequence:
`docs/multiplayer/M3_TRADE.md`. Implementation: `src/link/trade.ts`,
`src/link/identity.ts`. Entry point: `src/link/drive_trade_e2e.ts`.

### Method note that outranks the findings below
Both cores had always been booted from ONE snapshot, so they were byte-identical
across `$D163`-`$D2F7`, `wPlayerName` and `wPlayerID` (zero differing bytes on a
direct diff). A trade between clones leaves RAM unchanged, so **every "did the
trade happen?" check was blind** and the recurring "OT still 49699 on both
sides" was the only possible outcome either way. The ROM had been completing the
trade before it was ever observed. **Any future link claim must be measured
against DIFFERENTIATED sides** (`identity.writeIdentity`); `TradeSession`
reports `blind: true` instead of success when the sides are clones.

### wLinkState ($D12B) values, observed
- `$01` = IN_CABLE_CLUB (already recorded above).
- `$02` = session started — set on both sides the moment the two players face
  each other across the trade table and press A.
- `$32` (50) = TRADE MENU — set on both sides once the 415-byte party block has
  completed. This is the reliable "block finished" gate; screen text is not.

### Party data block
- Send buffer `wSerialPlayerDataBlock` `$D152`, receive `wSerialEnemyDataBlock`
  `$D893`. Receive-side alignment confirmed by label: `$D89C` = enemy party
  count, `$D89D` = species list, `$D8A4` = first enemy mon struct. The `$FD`
  preamble bytes land in the buffer's leading slack and are harmless.
- Names and nicknames ride the block correctly: with side B renamed BOB, side A's
  received block head read `81 8e 81` (= B O B) and A's party list rendered
  `AAAAAAA CHARMELEON / BOB CHARMELEON / CANCEL`.
- Populated receive-side mirrors: `$D887` `wLinkEnemyTrainerName`, `$D8B0`
  `wEnemyMon1OTID`, `$D8C5` `wEnemyMon1Level`, `$D9AC` `wEnemyMon1OT`, `$D9EE`
  `wEnemyMon1Nick`.

### TradeCenter_SelectMon ($01:5530) — menu contract
- `.displayStatsTradeMenu` `$01:5679` sets `wMaxMenuItem` `$CC28` = 0,
  `wTopMenuItemY` `$CC24` = `$10`, `wMenuWatchedKeys` `$CC29` = `$13`
  (RIGHT|B|A). **The STATS|TRADE submenu is HORIZONTAL and DOWN is not watched** —
  which is why walking the cursor downward silently did nothing for several
  sessions. RIGHT reaches TRADE, A dispatches to `.choseTrade` `$01:56F9`.
- On the party LIST, DOWN moves onto CANCEL and A aborts the session
  (`wLinkState` 50 -> 1, bus goes quiet). Never press DOWN in either menu.
- The exchanged selection nybble is **2**, not a party index: both sides converge
  on `$CC3D` = `$CC3E` = 2 and the swap fires a few steps later. The
  out-of-range-index theory was an artifact of the blind test.
- `$CC3D` = `$0F` is the CANCEL sentinel; `.choseTrade` jumps away on it.

### Timing contract for the confirm
`Serial_SyncAndExchangeNybble` `$227F` spins until `$CC3D`/`$CC3E` agree. **Both
sides must sit undisturbed inside it** — any keypress knocks a waiting side out
of the loop and the sync never converges. Drive to the submenu, then go
completely quiet.

### Known rough edges
- The first rendezvous does not always converge (`$CC3D` stayed 0 through 14
  quiet steps); the second attempt lands. Retry is mandatory; root cause not yet
  traced.
- `catchUpTimeouts` = 671 of ~702 exchanges during the block phase. It completes,
  but the peer catch-up is hitting its step limit on nearly every byte and that
  is the main wall-clock cost.
