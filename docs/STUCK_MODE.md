# Stuck-mode: story_score/state stall + MODE classifier (wq#671)

`lpp_frontier.py` (wq#515) answers "has the game moved forward" on the
**critical-path-rank** axis: badges, and furthest overworld/dungeon map. That
axis missed the 2026-08-17 incident completely. The agent reached Route 25
(rank 13, a side detour) and `frontier.json` sat at `"furthestRank": 13` for
43h while the live agent spent every one of those hours bouncing **Cerulean
Gym (65) <-> City (3) <-> Pokecenter (64), losing to Misty**. Cerulean Gym is
not on `CRITICAL_PATH` at all — entering it was never "progress" by the rank
axis, so the rank axis reported a frozen spur while the real story was two
rooms over. Cost of the one stuck fight: **43h / 1263 turns / 5.4M tokens /
25 runs**.

    tools/lpp_stuck_mode.py [--window-hours N] [--json] [--one-line] [--no-persist]

Read-only: reads `checkpoints/**/*.json` sidecars, `runtime/warp_history.json`
(wq#517), `runtime/resume_history.json`, `tools/map_names.json`, and (for the
`OBJECTIVE_UNREACHABLE` mode only) `lpp_frontier.compute(live=False)`. Writes
only its own cache at `runtime/stuck_mode.json`.

## What counts as advance on this axis

`storyScore` rising (**PRIMARY** — the spec's own wording), or `badges`
rising, or the raw event-flag count rising. Any one resets the clock. Unlike
the frontier engine's rank axis, there is no side-detour trap to defend
against here: none of these three ever move backwards during ordinary
(non-whiteout) play, so a fresh flag or badge is real state progress even
without a critical-path rank change.

### Per-axis freshness (wq#1097)

`stalled` and `frozenHours` stay that conjunction — any axis rising un-stalls
the run — because it is the conservative test and widening it would flag
ordinary grinding. But "the game moved at all" and "the axis this incident is
*about* moved" are different questions, and the layers above need the second
one. `compute()` therefore also reports:

| field | meaning |
| --- | --- |
| `frozenAxes` | which of `story_score` / `badges` / `event_flags` have not risen inside the window |
| `axisFrozenHours` | hours since each axis last rose |
| `storyFrozenHours` | hours since `storyScore` **or** `badges` last rose |
| `storyStalledSince` | ISO instant that story clock started |

`event_flags` is the noisy one: it ticks for an item pickup or an NPC line,
neither of which unsticks a lost gym fight. Reporting only the conjunction is
what let `FIGHT_LOSS_LOOP@3` file `frozen=2.9h` against a story axis that had
by then been frozen for 42 hours — one flag going 46 → 47 reset a 40-hour
clock. Consumers that need to know whether an *incident* is progressing read
the story fields; `frozenHours` remains what `stalled` is computed from.

## Window

**2 hours**, deliberately tighter than the frontier engine's 12h. This axis
exists to catch a stall *inside* one objective (one gym, one fight loop), not
just cross-map stagnation — and the wq#673 K=3-interventions / 3h-Frank-page
cadence only makes sense against a detection window materially shorter than
3h. Sized against the live corpus: `checkpoints/**/*.json` sidecars land every
~10-25 minutes during normal play, so 2h clears ordinary grind/travel between
checkpoints without false-firing, while still leaving room for three
interventions plus escalation inside the same incident.

## MODE classification

Computed only once the story_score axis is stalled, from state that already
exists and is already durable — nothing new is persisted mid-run to compute
this. Priority order below (first match wins):

| Mode | Fires when |
|---|---|
| `RESUME_DEADEND` | the same `resumedFrom` checkpoint booted on **>=2 consecutive** boots (`runtime/resume_history.json`) — mirrors `lpp_frontier.restart_loop`'s own definition (wq#515), reused here as a mode rather than a standalone alert |
| `FIGHT_LOSS_LOOP` | among the most recent persisted warps (`runtime/warp_history.json`, capped at 64 by wq#517), a **gym** map (label containing "Gym") appears >=2x **and** a heal/city map for that trip (Pokecenter or a `*City`/`*Town` label) also appears >=2x — walked into the gym, walked back out, more than once |
| `OBJECTIVE_UNREACHABLE` | the frontier engine reports `pathExhausted` while this axis is *also* stalled — no further `CRITICAL_PATH` milestone is encoded to aim at |
| `NAV_LOOP` | no gym involved, but the warp window collapses onto <=3 distinct maps with >=4 warps — an overworld/dungeon loop, not a gym fight |
| `IDLE` | stalled but nothing above matched — catch-all, deliberately last |

Classification runs over the **full persisted `warp_history.json` window**
(64 entries), not a tighter recent slice. A 20-entry slice was tried first and
missed the live fixture: the most recent 20 raw warps in the 43h incident
happen to be a pure city<->pokecenter shuffle with the last gym re-entry just
outside that slice — a real but narrower symptom of the same episode. The
persisted list is itself already a bounded recent window (wq#517's own
`KEEP=64`), so no further truncation is needed.

## Verification

`python3 tools/verify_671.py` — **22/22**. Unit-tests `classify_mode()`
directly for MODE priority (an inlined literal copy of the live 43h stall's
`warp_history.json`, captured 2026-08-17T20:15Z, MUST classify
`FIGHT_LOSS_LOOP` and name both Cerulean Gym and Cerulean City in the
evidence string; healthy multi-map travel and a single gym visit must NOT;
`RESUME_DEADEND` takes priority when present but alternating-checkpoint
resumes — the live fixture's own shape — must NOT mask a real
`FIGHT_LOSS_LOOP`), then exercises `compute()` end-to-end against synthetic
checkpoint sidecars in a temp tree (flat story_score over the window stalls
and classifies; a story_score rise, a badge-only rise, and a sub-window gap
all stay silent), then two graceful-degradation cases (no sidecars, no warp
history). A final SKIP-shaped live-corpus check (never fails the suite on its
own — see `src/fixtures.ts`'s own doctrine on corpus rot) confirms the real
`runtime/` still reproduces the incident today.

## Known limits

- Party level/species/type are **not** in checkpoint sidecars (confirmed:
  only `hpPct`/`ppOk` aggregate booleans). `FIGHT_LOSS_LOOP`'s "underleveled
  starter" root cause (wq#672/wq#674) needs a live `.state.gz` decode through
  `src/state.ts`'s `party: PartyMon[]`, not this module — this module only
  detects the *shape* of the loop, not *why* the fights are being lost.
- `OBJECTIVE_UNREACHABLE` degrades to "never selected" (not a crash) if
  `lpp_frontier` fails to import, matching `lpp-sentinel`'s own
  `frontier_unavailable` precedent of reporting failure loudly rather than
  swallowing it — but this module reports it as a silently-skipped mode
  rather than its own alert, since it has no alerting path of its own yet
  (wq#673 wires that).

## Rollback

Deleting `runtime/stuck_mode.json` costs nothing — it is fully recomputed
every call, no merge-max history to lose. Nothing currently calls this module
from a live/cron path (wq#673 wires that); running it manually never touches
the game, the service, checkpoints or the work queue.
