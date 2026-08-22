# Bounded per-MODE intervention layer (wq#672)

`tools/lpp_stuck_mode.py` (wq#671) answers *what kind* of stuck the live
agent is in. This module answers *what to try*, bounded at **K=3** attempts
per `(mode, location)`, every attempt logged with before/after game-state,
and deliberately honest about where its authority currently ends.

    tools/lpp_stuck_intervene.py [--json] [--dry-run]

## Root-cause: the wq#621 vision valve "0 fires in 43h" claim is false

The ticket and the originating spec both assert the valve is dead ("no
vision-valve.log, 0 consults in 43h"). Checked directly against the live
run's own event log (`events/live-agent-1786898534540.jsonl`, the run
spanning the tail of the 43h stall through the ticket filing):

    $ grep -c '"vision_consult"' events/live-agent-1786898534540.jsonl
    41

Cross-checked two independent ways — `think_chunk{model:"lumen-vision"}`
count (41) and `events/run-summary-*.json`'s own `autoCalls.vision_consult`
field (41) — and by trigger: 40 via the oscillation path (wq#658), 1 via the
original stuck-tile path (wq#621). Both are wired live in `src/agent.ts` and
neither is disabled.

"No vision-valve.log" is *literally true* — there never was a dedicated log
file; vision events land in the shared `events/live-agent-*.jsonl` stream,
same as everything else, by design (`src/vision.ts` has no file-logging code
at all). That is almost certainly what produced the "0 fires" belief:
whichever check looked for a standalone log file, or for a persisted
`"VISION"` key in `runtime/notepad.txt` (also correctly absent —
`src/notepad.ts`'s `toJSON()` deliberately excludes the in-memory guidance
`Map`, wq#486), found nothing on either path and read that as "never fired"
rather than "writes somewhere that isn't a standalone file."

**Consequence for this ticket:** "fix the dead valve" is not this module's
job, because the valve is not dead. "make it fire on stuck>=3turns" is also
already true today — `CFG.visionValve.stuckN` (`src/config.ts`) has defaulted
to 3 since wq#621 shipped, unchanged. The real gap, and the one this module
actually targets: 41 hints over 27.5 hours each produced a one-or-two-
sentence "what's on screen" nudge, and the loop never broke, because the
valve is a **hint channel by design** (`vision.ts`: "not a channel the brain
gets every turn"; `agent.ts`: "hint only, does not override RAM/grid") and
the real blocker is a leveling/strategy gap — matching wq#674's independent
diagnosis exactly (underleveled starter vs. Misty's Staryu L18/Starmie L21).
No amount of "what's on the screen" commentary was ever going to fix that.
This module's `FIGHT_LOSS_LOOP` prescription is a **structural** nudge (a
grind sub-objective, pinned into the notepad) layered on top of the
already-firing valve, not a repair to the valve itself.

## Prescriptions

| Mode | Action | Notes |
|---|---|---|
| `FIGHT_LOSS_LOOP` | `grind_sub_objective` | pins a grind target (Route 24/25, level range, type-counter hint) keyed to the gym location |
| `NAV_LOOP` | `checkpoint_restore_then_goto_ban` | pins a goto-ban + fallback-checkpoint instruction |
| `OBJECTIVE_UNREACHABLE` | `replan_verify_map_data` | pins a re-verify instruction against the frontier's `pathExhausted` milestone |
| `RESUME_DEADEND` | `alternate_checkpoint` | pins an instruction to resume from a different checkpoint next boot |
| `IDLE` | *(none)* | the spec defines no IDLE action; guessing one would be exactly the unfounded intervention this module exists to avoid |

## Bounding and resolution

Each `(mode, locationId)` — the same key wq#671 exposes as `modeLocation` —
gets up to **K=3** logged attempts. A 4th `decide()` call for the same open
key returns `exhausted: true` and appends **nothing** to the log; that is the
signal wq#673 uses to file (or append to) its one ticket and stop trying
locally. An attempt resolves as `"advanced"` (closing the counter, K resets)
the moment a later read shows `storyScore`, `badges` or the event-flag count
higher than the attempt's own `beforeState` — matching wq#671's own
story_score-primary axis exactly, so "did the intervention work" is answered
the same way "is the game stuck" is. An attempt resolves as `"superseded"`
(closes the entry, but does **not** reset K) if the incident's mode or
location changes before an advance — drifting into a different stuck shape
is not evidence the intervention worked.

## What this does not do yet

Prescribing "grind Route 24/25" only helps if the live agent process reads
it. The natural channel is the same one `src/recovery.ts`'s `CORRIDOR`
already uses — a boot-time goal injected into the notepad's pinned region —
but wiring that consumption point is a change to `src/agent.ts`, and at the
time this ticket was worked `src/agent.ts` had a live, uncommitted diff from
a concurrent session (wq#674, attacking the same incident from the opposite
end: breaking the live stall directly, right now). Editing the same file
underneath an in-flight concurrent change is exactly the "collide in a
shared tree" failure wq#520's own history warns against. This module
therefore **prescribes and persists** the directive
(`runtime/supervisor_directive.json`) and **logs** every attempt with
before/after state (`runtime/intervention_log.json`), fully bounded and
fully tested — but *consumption*, the live agent actually reading and acting
on the directive file, is not wired. That is a small, well-scoped follow-up
(a single boot-time read, mirroring `CORRIDOR` exactly) once `src/agent.ts`
is free, not silently claimed as done here.

## Verification

`python3 tools/verify_672.py` — **32/32**. Every call passes an explicit
`log` dict (never touches the live `runtime/intervention_log.json`), mirroring
`verify_489.py`'s own pattern of exercising `emit()` directly against a
throwaway state rather than real persisted state. Covers: no intervention
when healthy or when MODE is `IDLE`; a `FIGHT_LOSS_LOOP` attempt fires and
logs `beforeState`/unresolved `afterState`; the K=3 bound (3 attempts fire,
the 4th is `exhausted` and appends no new log entry); resolution on a real
advance (closes prior attempts as `"advanced"`, K resets for a fresh stall
at the same location); independent K counters per distinct location (a
second gym doesn't share the first gym's count); a mode/location drift
without an advance marks the prior entry `"superseded"` without resetting K;
and every non-`IDLE` mode produces a JSON-serialisable directive.

## Rollback

Deleting `runtime/intervention_log.json` resets every K counter to zero —
safe, no live consumer depends on its history yet (see "what this does not
do yet"). Deleting `runtime/supervisor_directive.json` costs nothing; it is
overwritten in full on every intervening call. Nothing in this module
touches the game, the service, checkpoints, `events/`, or the work queue.
