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
| `FIGHT_LOSS_LOOP` | `grind_sub_objective` | pins the harness's own gym-entry gate — level, potions, roster, type counter — read from `src/guidance.ts` (wq#1091) |
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

## A pin the agent obeys must agree with the gate that refuses it (wq#1091)

Consumption is wired now — bans since wq#724, and the textual `notepadPin`
since wq#1081/#1084, rendered as a `!!` line every turn in `observe()`. That
promoted the pin's *content* from documentation to control input, and
exposed the bug this section exists for.

`FIGHT_LOSS_LOOP@3` (Cerulean, `MAP.CERULEAN = 3`) burned all three K
attempts over 33 hours with `storyScore` frozen at 10. The prescription was
read, and following it could not possibly help: it said **"grind Route 24/25
to roughly L18-21 before re-attempting"**, but L18/L21 are *Misty's own team
levels* (Staryu L18, Starmie L21 — quoted two sections up, and in
`src/probe_gymdoor674.ts`), not a grind target. `guidance.ts`'s
`misty_ready()` — enforced as a hard refusal at two `src/agent.ts` call
sites — requires **L30 + 3 potions + 2 party members + a Grass/Rock
counter**. An agent that obeyed the pin exactly ground to L21, walked back to
the gym and was refused; or read "do not re-enter below that level range" as
permission to re-enter at L21 and lost again. Either way: `grind_sub_objective`
three times, `storyScore` unchanged, escalation ticket.

Two changes, both in `tools/lpp_stuck_intervene.py`:

1. **`_misty_gate()` parses the thresholds out of `src/guidance.ts`** and the
   pin interpolates them, so a prescription can only ever name the number the
   gate actually enforces. A parse failure degrades to `GATE_FALLBACK` (the
   values as of today) rather than to no pin. The type counter is now stated
   as a requirement — wq#677 made it one, and per `probe_gymdoor674` it is the
   real wall; level alone never was. The pin also absorbs the live hot-patch
   applied to the primary tree during this same incident — walk into grass
   with `goto()`, do not `enter_warp` into a building looking for it, do not
   heal at full HP — which names the three turn-sinks the run was observed
   burning on instead of grinding.
2. **`exhausted` now refreshes the directive on disk** (`_terminal_directive`),
   labelled `SUPERVISOR (EXHAUSTED after 3/3)` with an empty `gotoBan`.
   Previously `main()` wrote only on the intervening path, so a spent key
   froze its pin at the attempt-3 text permanently — the key can never
   intervene again, so no corrected prescription could ever reach the live
   agent. The log invariant wq#673 keys on is untouched: `exhausted` still
   appends nothing.
3. **The same widened gate in `tools/lpp-stuck-supervisor`** (wq#1136). wq#1091
   fixed only this module's `main()`, which nothing in production runs: the
   30min `lumen-lpp-stuck-supervisor.timer` runs the wrapper, and the wrapper
   calls `decide()` and reimplements the write itself. It kept the old
   `if decision.get("intervened")` gate, so the fix above never reached the
   live agent — `runtime/supervisor_directive.json` sat frozen at a
   `FIGHT_LOSS_LOOP@3` pin for 25h+ while the run was actually stuck in an
   already-exhausted `WARP_OSC@36`, with `runtime/intervention_log.json`
   proving the timer itself was firing every cycle. Both call sites now gate
   on `result.get("directive")`. Any future caller that persists the directive
   must do the same.

## Verification

`python3 tools/verify_672.py` — **62/62**. Every call passes an explicit
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
and every non-`IDLE` mode produces a JSON-serialisable directive. wq#1091
adds: the gate parses out of `src/guidance.ts` and matches it; a missing
`guidance.ts` degrades to `GATE_FALLBACK` instead of raising; the pin names
the gate's level and no longer mentions L18-21; `exhausted` carries a
directive marked `exhausted` while still appending no log entry; and every
mode's template survives the terminal-directive `format()` call (the
`NAV_LOOP`/`WARP_OSC` pins reference `{loop_maps}`/`{loop_labels}`); plus
`{location}` rendering as `Cerulean City (map3)` rather than a bare `3`
sitting among the level numbers, falling back to `map<id>` for an unknown id.

`python3 tools/verify_1136.py` — **10/10**. `verify_672.py` only ever calls
`decide()`/`main()` in this module, so it cannot see the wrapper's own write
block, which is why the wq#1091 gap shipped green. This probe drives
`tools/lpp-stuck-supervisor`'s `main()` for real with the three component
modules stubbed and `DIRECTIVE_PATH` pointed at a temp file, asserting: an
exhausted decision writes the directive; a later cycle overwrites it rather
than freezing; the intervening path is unchanged; a decision with no directive
neither writes nor truncates an existing file; a not-`ok` stuck-mode state
writes nothing; and `--dry-run` stays read-only on the exhausted path. Reverting
the wrapper's gate to `intervened` fails 4 of the 10.

## Rollback

Deleting `runtime/intervention_log.json` resets every K counter to zero —
safe, no live consumer depends on its history yet (see "what this does not
do yet"). Deleting `runtime/supervisor_directive.json` costs nothing; it is
overwritten in full on every call that produces a directive — intervening or
exhausted. Nothing in this module
touches the game, the service, checkpoints, `events/`, or the work queue.
