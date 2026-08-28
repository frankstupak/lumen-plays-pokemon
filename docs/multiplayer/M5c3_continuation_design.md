# M5c-3 (wq#511) — driving the 415-byte party exchange over the bridge

## Root cause (verified against code, 2026-08-28)

The in-process trade (`TradeSession.exchangeParties`) moves the 415-byte block
intact because it does THREE things around the block phase:

1. **fine-slice** both cores — `setSlice(core, 64)` ≈ one 512-cycle serial
   transfer window per `doFrame`, so the follower's ISR + main loop run between
   the master's clocks (`lockstep.ts`).
2. **defer** completion — `bus.deferTicks = 1`, the swap finishes on a later
   `bus.tick()`.
3. **peer catch-up** — `bus.peerRunner` runs the follower in small bursts until
   it commits a FRESH `SB` byte (`markStaged`) BEFORE each delivery, so a stale
   `$FE` never rides the wire and the receiver's preamble scan never
   misaligns (`serialbus.catchUp`).

The bridge path (`rdv_side.ts` + `bridge.ts`) had NONE of this for the block:

- `core.step()` ran full **coarse** `doFrame()` (~33k cyc). `CYC` fed only
  `bridge.advance()` — the BGB *timestamp*, not the cycle budget.
- As master it was throttled ~1 byte/frame by `settled()`, but as **follower**
  `bridge.onMasterByte` answered each async `sync1` with whatever `stagedOut`
  held at that instant — racing its own coarse frame → stale/`$FE` bytes →
  `$D887/$D893` never receive a clean block. M5b then correctly rejects
  uninitialised RAM (count=36, level=0, hp>maxHp).

**Class of defect:** the cross-process transport reproduces the *coarse-frame
stale-follower-byte* corruption that `lockstep.ts` + `serialbus.catchUp` were
built to kill in-process. The bridge inherited the transport but not the
scheduling discipline.

## Prior WIP salvage

`scratch/worktrees/pokemon-feat-rdv-continuation` (uncommitted, 2026-08-23) had
the **master-side fine-slice** already: `runCycles(core, TRANSFER_CYCLES)` with
`settled()` between slices. Correct, kept. It was missing the **follower half**,
which is exactly why scenario 4 still failed. `tools/rdv-cont-test` (retry-on-4
orchestrator) is also salvaged.

## Chosen fix

**Symmetric port of the in-process discipline into the bridge path.**

1. **`bridge.ts` — follower catch-up (the new mechanism).** Optional, enabled
   only for the block phase. Before `onMasterByte` captures the reply byte, run
   OUR core in bounded small bursts (`catchUpCycles=64`, `catchUpMaxSteps=8`,
   hard `catchUpCycleCap`) until it commits a fresh `SB` write since this
   `sync1` (`stagedFresh`, secondary gate `$FFAC != $FE`). Order mirrors
   `serialbus.masterExchange`: **catch up → capture staged → deliver peer byte →
   answer `sync2`.** Kept synchronous (`runCycles` is sync, no re-entrancy: the
   handler only fires at the loop's await points, and catch-up is block-phase
   only, where the clock owner is fixed). No `DEFER_REPLY` needed.
2. **`rdv_side.ts` — block driver.** Fine-slice the local core
   (`runCycles(core, TRANSFER_CYCLES)`), `settled()` between slices, yield to the
   event loop every few slices so the follower handler interleaves. Drive by
   `wLinkState` like `trade.ts`: seat → `>=2` (session started) → `==50`
   (LINK_STATE_TRADE_MENU = block exchanged), pressing A on dialog sparingly.
   Log the linkState progression as the **seat-nav verification** evidence
   (ticket deliverable 2), then BLOCKCHECK `$D887/$D893`.
3. **`probe_rendezvous.ts` — ungate scenario 4** only AFTER a real green run
   (ticket deliverable 4).

## Test to failure (instinct: no green-on-first-run)

- `tools/rdv-cont-test` under the #510 retry harness on a LOADED box.
- Fail conditions to chase, in order: never reach `wLinkState 50` (seat-nav /
  budget), `$FE` in block (`no_FE` fail = catch-up budget too small), count/level
  garbage (block never assembled), `hp>maxHp` (partial block). Iterate slice /
  catch-up budget / seat coords until M5b `verifyTradeBlock` passes on a REAL
  received block on BOTH sides, then re-run to confirm repeatability.

## Rollback

`.bak` siblings of `bridge.ts` + `rdv_side.ts` pre-edit; the block driver and
follower catch-up are additive and gated (catch-up off unless armed; scenario 4
gated until proven). `git` branch `fix/wq511-...-a1`; revert = restore baks +
drop the commit. No service, DB, or fleet-state change.
