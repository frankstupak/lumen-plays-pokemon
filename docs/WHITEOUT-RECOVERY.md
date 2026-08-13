# Whiteout / Story-Regression Recovery (wq#477)

Builds on storyScore (wq#471): popcount over 25 permanent, RAM-verified story
flags — strictly monotonic within a campaign.

## What it does

`src/recovery.ts` RecoveryTracker runs once per turn (agent.ts hook, before
the brain sees the state) and injects a top-priority `!! RECOVERY OBJECTIVE`
line into the state block ONLY when regressed. **Goal/prompt layer only — no
navigation-engine changes.**

Two modes:

| Mode | Trigger | Clears when |
|---|---|---|
| `whiteout` | party all-fainted EDGE (same logic as metrics/retry) — position regressed to last Pokecenter, flags intact | player reaches the frontier target map |
| `score_regression` | current storyScore < maxStoryScore (reboot resumed an OLDER checkpoint) | storyScore re-attains the max |

Frontier invariant: score == max and no whiteout ⇒ evaluate() returns null.
Normal exploration on the frontier map is never touched.

## Corridor mapping (the storyScore→frontier table)

`CORRIDOR` in src/recovery.ts: ordered most-advanced-first; the first entry
whose milestone flag is set names the frontier (target map id + directions).
Map ids are pret/pokered constants, cross-checked against the live notepad
(Pewter=2, Route2=13, Route3=14, Route4=15, MtMoon=59). Fallback (no flags):
Pallet Town. Current campaign (story 6, EVENT_BEAT_BROCK + fossil pending)
resolves to Route 3/Route 4 targets.

## Persistence

- `maxStoryScore` is tracked process-wide in live_agent (one tracker survives
  in-process gameplay continues) and written into every checkpoint sidecar.
- On process start it is seeded via `seedMaxFromSidecars(saves+checkpoints)`
  (max over storyScore AND maxStoryScore fields, typeof-guarded like
  resume.ts), so a service restart onto an older checkpoint still detects
  the regression. Live seed at ship time: 6.

## Stream / kiosk

`regression` events (stage: detected|cleared, reason, score, max, targetMap,
desc) are emitted on the bus → broadcast to :8871 → kiosk ticker renders them
via its generic event path (k-sys row, kind REGRESSION).

## Verification & rollback

probe_recovery.ts: 16/16 (corridor ordering, frontier no-fire, whiteout
edge+clear+re-fire, score regression fire+clear, seeding). Rollback: revert
the wq#477 commit or restore .bak.20260813_010722_pre_wq477 siblings
(agent.ts, live_agent.ts, events.ts) + delete recovery.ts, restart under
slock.
