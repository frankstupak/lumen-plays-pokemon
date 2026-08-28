# wq#511 — M5c-3 party-exchange over the bridge (2026-08-28) — PARTIAL

**Status: NOT done. The block-transfer half (fine-slice + follower catch-up)
is built, tsc-clean, and committed; test-to-failure proved the real current
wall is UPSTREAM — the trade SESSION never starts over the bridge, so no block
ever runs. Scenario 4 left GATED (honest). Ticket left claimed, mid-flight.**

Agent: claude-web-511-155878 · branch fix/wq511-...-a1 · design:
docs/multiplayer/M5c3_continuation_design.md

## Root cause of the ORIGINAL symptom (verified against code)

trade.ts moves the 415-byte block intact via three things around the block:
fine-slice both cores (`setSlice`), defer completion (`bus.deferTicks`), and
peer catch-up (`bus.peerRunner` runs the follower until it stages a FRESH `SB`
byte before each delivery). The bridge path had none: `rdv_side` stepped full
coarse `doFrame()` (the `CYC` value fed only `bridge.advance()`, the BGB
*timestamp*, not the cycle budget), and as follower answered each async `sync1`
with whatever `stagedOut` held — a stale/`$FE` race. This is the same
coarse-frame stale-follower corruption lockstep.ts + serialbus.catchUp kill
in-process; the bridge inherited the transport but not the scheduling.

## What shipped (necessary, correct, but not yet exercisable)

1. **bridge.ts — follower catch-up.** `enableFollowerCatchUp({run,ready,...})`;
   `serveMaster` runs OUR core in bounded bursts until a fresh `SB` write
   (`stagedFresh`, secondary gate `$FFAC != $FE`) BEFORE capturing the reply —
   the cross-process port of serialbus.catchUp, order-faithful (catch up →
   capture → deliver → answer sync2). Off by default; handshake path unchanged.
   Telemetry: catchUpSteps / catchUpTimeouts.
2. **rdv_side.ts — fine-slice block driver + instrumentation.**
   `runCycles(core, TRANSFER_CYCLES)` per slice with `settled()` between and a
   yield every 8 slices; drive by wLinkState like trade.ts (seat → >=2 → ==50);
   player x/y (`$D362/$D361`) + linkState logging; no-progress bail.
3. **tools/rdv-cont-test** — #510 retry-on-4 orchestrator + green check.

## The wall (test-to-failure, 3 detached e2e runs on a loaded box)

Rendezvous is solid: both sides reach IN_ROOM map `$EF` (239), roles resolve
1/2, 30-exchange handshake. Then, on BOTH seat mappings tested:

| run | seat map | player after nav | wLinkState | serial (ex) |
|-----|----------|------------------|-----------|-------------|
| c1  | role     | at (3,4)/(6,4) row4 | stuck 1 | 30 (handshake only) |
| c2  | mode     | (3,5)/(6,5) row5 (off-seat) | stuck 1 | 30 |
| c3  | role (final) | (3,4)/(6,4) row4, faced across | stuck 1 | 30 |

**Zero serial flows at the table on both sides** — neither ROM sets SC=$81 to
initiate the trade-data exchange, so `catchUpSteps=0` (my catch-up never fires)
and `$D887/$D893` stay uninitialised; M5b correctly rejects (count=36, level=0,
hp>maxHp), exactly as before. Seat spawn is now characterized: master/connect
spawns LEFT (3,4), slave/listen RIGHT (6,4), table between at row 4 — role-based
seating (final code) matches spawn; players sit correctly and still nothing
initiates.

**Conclusion:** the block-transfer catch-up is downstream of an unsolved
trade-START coordination. trade.ts converges because it steps BOTH cores in one
process, coupled tick-by-tick (both press A on the same step, bus.tick() carries
the trade-start serial). Across two OS processes the independent A-press never
makes either ROM enter the table-talk that clocks the first trade byte. Do NOT
improvise this — it needs the Trade-Center ROM script + a designed cross-process
trade-start handshake.

## NEXT — research/design prompt (ready to dispatch, lpp-mp lane)

> Investigate how Gen1's Trade Center ($EF) table-talk drives wLinkState 1→2→50
> and clocks the first trade byte, and design the cross-process equivalent.
> Read: the TradeCenter_* / Cable Club link scripts in the disassembly
> (`roms/pokeblue.sym` + bank 1 `TradeCenter_SelectMon` $01:5530 and the link
> entry that sets wLinkState past 1), and trade.ts `exchangeParties`/`connect`
> (which PROVABLY reaches ls==50 in-process by lockstepping both cores). Answer,
> on disk, with evidence file:line: (1) exactly what player state (tile, facing,
> button) triggers the ROM to leave wLinkState 1 and emit the first trade SC=$81;
> (2) why the same drive over the bridge emits zero serial (run c1/c3 logs:
> /tmp/claude-web-511-155878/rdv-cont-test/{a,b}.log — both sit at (3,4)/(6,4),
> ls=1, ex=30); (3) whether the two sides must press A within a serial round-trip
> of each other (a start-handshake), and if so design it as a small state machine
> in rdv_side (mirror the rendezvous ROOM_SELECT pattern: each side drives its own
> core and infers the peer from link liveness). Then wire it AHEAD of the existing
> fine-slice block driver (bridge.enableFollowerCatchUp is already in place and
> will be exercised once ex climbs past 30) and re-run tools/rdv-cont-test to
> failure; only ungate probe_rendezvous scenario 4 once BOTH BLOCKCHECK lines
> report ok:true. .bak; tsc clean; report reports/511b_trade_start.md.

## Files (committed on branch; baks src/link/*.bak.20260828_202436)

bridge.ts (follower catch-up), rdv_side.ts (fine-slice driver + instrumentation),
tools/rdv-cont-test (new), docs/multiplayer/M5c3_continuation_design.md (new).
No service / DB / fleet-state change. Downstream wq#484 (cross-node link) stays
blocked on this.
