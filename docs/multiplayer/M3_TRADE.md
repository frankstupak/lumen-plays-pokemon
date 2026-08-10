# M3 — Link Cable TRADE (COMPLETE, verified 2026-08-10)

Two independent serverboy cores complete a real Gen1 Cable Club trade over our
SerialBus. Verified end-to-end from a cold start: side A finished holding side
B's exact mon identity and side B finished holding side A's.

```
A before sp178 otid$23c2 lv20 OT"AAAAAAA" nick"CHARMELEON"
A after  sp178 otid$1122 lv25 OT"BOB"     nick"BOBMON"
B before sp178 otid$1122 lv25 OT"BOB"     nick"BOBMON"
B after  sp178 otid$23c2 lv20 OT"AAAAAAA" nick"CHARMELEON"
```

Entry point: `npx tsx src/link/drive_trade_e2e.ts` (standalone; never inside the
live service). Implementation: `src/link/trade.ts`, `src/link/identity.ts`.

---

## The finding that unblocked this: the test was blind, not the ROM

Every run before 2026-08-10 booted BOTH cores from the same snapshot. A byte
diff of the two trade-menu states across every field a trade moves —
`wPlayerName` `$D158`, `wPlayerID` `$D359`, and the whole party region
`$D163`–`$D2F7` — returned **zero differing bytes**. Same trainer, same ID, same
CHARMELEON, same OT, same nickname.

A trade between two identical trainers holding identical mons leaves RAM
unchanged. The signal earlier sessions were tracking — "OT is still 49699 on
both sides" — was therefore the *only possible outcome*, success or failure. It
carried no information.

The ROM had in fact been completing the trade for some time: an earlier log
(`tc_finish.txt`, 05:11) already showed side B rendering **"CHARMELEON is
transferred."** and, before that, **"AAAAAAA will trade CHARMELEON"**. Those were
the trade actually executing.

Diagnostic theories built on the blind signal — a stale `$CC28`, an out-of-range
`.chosePlayerMon` cursor, `send=2` being an illegal index for a one-mon party —
were chasing a phantom. `send=2` is the correct exchanged nybble; both sides
converge on `$CC3D` = `$CC3E` = 2 and the swap fires immediately after.

**Rule adopted:** `TradeSession` reads both identities up front and reports
`blind: true` rather than `swapped: true` when the two sides are clones. A run
that cannot distinguish success from failure is never reported as success.

## ROM facts this depends on

Label-exact from `roms/pokeblue.sym`:

| Address | Label |
|---|---|
| `$01:5530` | `TradeCenter_SelectMon` |
| `$01:5679` | `.displayStatsTradeMenu` |
| `$01:56F9` | `.choseTrade` |
| `$01:5849` | `TradeCenter_Trade` |
| `$00:227F` | `Serial_SyncAndExchangeNybble` |
| `$00:22C3` | `Serial_ExchangeNybble` |
| `$CC24/26/28/29` | `wTopMenuItemY` / `wCurrentMenuItem` / `wMaxMenuItem` / `wMenuWatchedKeys` |
| `$CC3D/3E/42` | sync-recv / exchange-recv / exchange-send nybble |

**The STATS|TRADE submenu is horizontal.** `.displayStatsTradeMenu` sets
`wMaxMenuItem`=0, `wTopMenuItemY`=`$10` and `wMenuWatchedKeys`=`$13`
(RIGHT|B|A). DOWN is not in the watch mask — which is why every attempt to walk
the cursor downward silently did nothing. **RIGHT** reaches TRADE, then **A**
dispatches to `.choseTrade`.

On the party list, DOWN moves the cursor onto CANCEL and A aborts the session
(`wLinkState` falls 50 → 1 and the bus goes quiet). Never press DOWN in either
menu.

## Sequence that works

1. **Connect** — both sides walk to the attendant `(11,3)`, face UP, tap A
   through the dialog until both report map `$EF` (Trade Center).
2. **Party block** — fine-slice both cores to ~one serial window (divisor 64,
   ≈524 cycles) with `bus.deferTicks = 1` and peer catch-up armed
   (`catchUpCycles` 64, `catchUpMaxSteps` 256). Stand on `(3,4)` / `(6,4)`, face
   RIGHT / LEFT, tap A. The 415-byte exchange runs behind "Just a moment." →
   "PLEASE WAIT!" and ends with both sides at `wLinkState` 50.
3. **Select and confirm** — *not* blind A-presses. Each side cycles
   list → submenu → stats → list on its own, so the two are almost never in the
   submenu simultaneously, and the trade needs both confirming at once. Drive by
   phase instead: **B** to back out of a stats page, **A** to select from a list,
   **no input at all** for a side already parked in the submenu. When both are
   parked: RIGHT, A, then go quiet.
4. **Quiet phase** — no input while `Serial_SyncAndExchangeNybble` converges.
   A keypress knocks a waiting side out of the sync loop and it never converges.
   The swap lands a few steps after `$CC3D` and `$CC3E` agree.

Phase detection uses screen text for a three-way discrimination only —
`STATUS/OK` = stats page, `TRADE` = submenu, `CANCEL` = list. Every *result* is
still verified from RAM, per doctrine.

## Evidence the block itself is sound

With B differentiated, side A's party list rendered the partner's real data:

```
AAAAAAA CHARMELEON / BOB CHARMELEON / CANCEL
```

and A's received block head reads `81 8e 81` = **B O B**. The enemy structures
(`$D887` `wLinkEnemyTrainerName`, `$D8B0` `wEnemyMon1OTID`, `$D8C5` level,
`$D9AC` OT, `$D9EE` nickname) all arrived populated and correct. Alignment is
exact: `$D89C` = party count, `$D89D` = species list, `$D8A4` = first mon.

## Open items

- **Rendezvous can need a retry.** In the E2E run the first attempt never
  converged (`$CC3D` stayed 0 through 14 quiet steps); the second landed.
  `TradeSession` retries up to `maxRendezvous` (default 6). Root cause not yet
  established — worth a trace of what the non-converging side is doing inside
  `$226E`.
- **`catchUpTimeouts` = 671 of ~702 exchanges.** Peer catch-up hits its step
  limit on nearly every byte. It works, but the margin is unclear and it is the
  main wall-clock cost of the block phase.
## Multi-mon parties — VERIFIED 2026-08-10

`npx tsx src/link/drive_trade_multimon.ts` builds a **two-mon party on each
side** (`src/link/party.ts` clones slot 1 and overrides identity only, so stats,
types, moves and DVs stay self-consistent with the species) and trades **slot 1
— a non-first slot**. Result, one rendezvous attempt, 748 exchanges:

```
A [1] lv30 OT"AAAAAAA" nick"ALPHATWO"  ->  B [1]
B [1] lv35 OT"BOB"     nick"BOBTWO"    ->  A [1]
slot 0 untouched on both sides
```

Evidence: `evidence/m3-trade-multimon-verified.log`.

This exercises what the one-mon proof could not: the list cursor, the CANCEL
boundary and non-first-slot selection.

**The cursor is never counted, it is read back.** `wCurrentMenuItem` (`$CC26`)
is re-read after every press and the driver presses DOWN again only while the
cursor is short of the target; a dropped or doubled input self-corrects. The
target is clamped below `wMaxMenuItem` because the last entry *is* CANCEL, and
selecting CANCEL kills the session (`wLinkState` 50 -> 1).

Menus are identified from `wMenuWatchedKeys` (`$CC29`), which every menu on this
screen sets distinctly — `$A1` enemy list (DOWN|LEFT|A), `$91` player list
(DOWN|RIGHT|A), `$13` STATS|TRADE submenu (RIGHT|B|A), `$23` cancel box
(LEFT|B|A). Neither list watches UP: the cursor is DOWN-only and wraps.

**Selections must be consistent.** Gen1 exchanges ONE agreed pair, so
`offerSlotA == wantSlotB` and `offerSlotB == wantSlotA`. An inconsistent pair
makes the nybble sync disagree and the confirm never lands — which looks exactly
like the rendezvous bug and is not one. `TradeSession` warns on this.
