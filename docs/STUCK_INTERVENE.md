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
| `RESUME_DEADEND` | `advance_past_boot_state` | pins the three conditions `src/resume.ts`'s picker applies to a replacement save — newer than the boot state, not written on a warp tile, at or above `VIABLE_HP_PCT` (read, not retyped). The old `alternate_checkpoint` pin asked the brain to resume from a different checkpoint: it does not choose the save, and the harness's repeat guard had already tried that and found nothing to take (wq#1118) |
| `WARP_OSC` | `checkpoint_restore_then_goto_ban` | wq#697; bans the two maps of an A↔B bounce — see the edge rule below |
| `NOISE_STORM` | `history_clear_restart` | wq#697; clears a history poisoned by consecutive invalid tool calls |
| `IDLE` | *(none)* | the spec defines no IDLE action; guessing one would be exactly the unfounded intervention this module exists to avoid |

## Bounding and resolution

Each `(mode, locationId)` — the same key wq#671 exposes as `modeLocation` —
gets up to **K=3** logged attempts. A 4th `decide()` call for the same open
key returns `exhausted: true` and appends **nothing** to the log; that is the
signal wq#673 uses to file (or append to) its one ticket and stop trying
locally. An attempt is only eligible to close **once the classifier stops
naming its key as the live stall** (wq#1162). It then resolves as `"advanced"`
(closing the counter, K resets) if `storyScore`, `badges` or the event-flag
count reads higher than the attempt's own `beforeState`, or as `"superseded"`
(closes the entry, but does **not** reset K) if not — drifting into a
different stuck shape is not evidence the intervention worked.

### Why the eligibility check, and not the counters alone (wq#1162)

The counter comparison used to run on its own, without asking whether the
stall was over. That is a strictly weaker test than the classifier's:
`advances()` in `lpp_stuck_mode` restarts the *freeze clock* on those same
three counters, so a partial tick — eventFlags 45→48 while `storyScore` sits
at 10 — resets the clock, the stall re-freezes on the **same key** an hour
later, and the still-open attempts now compare favourably against their stale
`beforeState` and close as wins. Each false win refunded the K budget.

`FIGHT_LOSS_LOOP@3` ran the ladder **1, 2, 3, 2, 3, 2, 3** across 4.9h that
way: K never bit, the same grind prescription reissued indefinitely, and the
one thing the bound exists to trigger — exhaust once, hand off to wq#673 —
never happened. The rule is now the obvious one: the authority on whether a
stall is over is the thing that declared it, and while it still says
`FIGHT_LOSS_LOOP@3`, no counter reading closes an attempt prescribed for
`FIGHT_LOSS_LOOP@3`.

The same correction applies on the wq#673 side. `resolve_advanced()` compared
current counters against the incident's baseline and would `wq done` the
ticket on a mid-stall tick — retracting an escalation for a stall the
classifier reported live in that very call. It now skips the key that is
stalled right now, and resolves it the moment the stall genuinely clears.

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

## An edge ban needs an edge, and the guards must share a scope (wq#1119)

`WARP_OSC` is the only mode whose remedy names a *pair* of maps, so the
classifier now refuses to select it unless a pair exists and banning it could
help. Two rules, both learned from the same 34h stall on Route 25 (map 36),
which burned all three K attempts on `checkpoint_restore_then_goto_ban` and
stayed frozen:

1. **No self-bounce.** When every warp in the detector's slice lands on the
   same map, the agent is re-entering one doorway, not alternating between two.
   The pin's "the last several warps alternate between exactly two maps" is
   false, and `_resolve_loop_maps()` pads the ban list to two entries from the
   wider window's next most frequent id — which is how "ban Route 25 (the grind
   route) and Cerulean City (the only heal point)" got prescribed three times.
   `classify_mode` now returns `WARP_OSC` only when the two endpoints differ.
2. **Same scope for the guard as for the detector.** The wq#1081/#1084
   route/hub diagnoses — the ones that say a map ban *cannot* help because the
   loop is a fight-readiness stall — tested the full 64-warp window, while
   `detect_warp_osc` fires on the last 16. Across a multi-day freeze the wide
   window drifts over more maps than the `<=3 distinct` test allows (6, live)
   even when the recent behaviour is a tight one-map bounce, so the guard went
   silent and the deferral wq#1081/#1084 added was left half-done: with the
   real mode hidden, the deferred `RESUME_DEADEND` masked it anyway, since a
   freeze that long naturally reboots onto the same checkpoint. The diagnoses
   are now asked at both scopes before that fallback.

Live warp history at the time of the wq#1119 ticket reclassifies from
`WARP_OSC@36` (ban the route) to `FIGHT_LOSS_LOOP@36` (grind, `gotoBan: []`) —
whose pin already says, verbatim, to walk into the grass instead of re-entering
the doorway, which is the behaviour the trace shows.

## A pin must also be addressed to an actor that can act (wq#1118)

`RESUME_DEADEND@None` is the wq#1091 lesson one step further out. Its
prescription, `alternate_checkpoint`, pinned **"resume from a different,
earlier checkpoint next boot"** into the notepad the in-game brain reads. The
brain has no such authority: `pickResume()` (`src/resume.ts`) chooses at boot,
before the brain exists. Worse, the harness *already applies that remedy* — the
repeat guard demotes a file picked `RESUME_REPEAT_LIMIT` times running whenever
a newer non-warp state exists. So the pin asked the wrong actor for the one
thing that had already been tried and proved impossible; three K attempts and
35 hours later, `storyScore` was still 10.

Three changes:

1. **The mode fires only once the guard is beaten** —
   `lpp_stuck_mode.resume_repeat_limit()` parses `RESUME_REPEAT_LIMIT` out of
   `src/resume.ts` and the classifier requires *more* than that many identical
   consecutive picks. A run of exactly the limit is the guard's own remedy in
   flight, not a deadend.
2. **The location is a real map** (the one the agent is standing on), not
   `None`. wq#671's dedup key is `(mode, location)` "so two different stuck
   spots never share one counter or one ticket", and `None` broke that for this
   mode alone: every resume deadend anywhere in the game shared one key, one
   K=3 budget, one permanently-exhausted ticket, and a pin reading "near
   `mapNone`".
3. **The pin names what the picker will actually take** — a save that is newer
   than the boot state, not written on a warp tile (`onWarp` sorts below every
   non-warp save; the guard's escape hatch looks for a non-warp state first),
   and at or above `VIABLE_HP_PCT` (parsed by `resume_viable_pct()`, same
   read-don't-retype rule as `_misty_gate()`). Those are the three legs of
   `pickResume`'s own predicate, and all three are things the brain can do.

Probe: `python3 tools/test_stuck1118.py` — 6 sections, A-F.

## Verification

`python3 tools/verify_672.py` — **69/69**. Every call passes an explicit
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
wq#1162 adds the ladder itself: the `FIGHT_LOSS_LOOP@3` sequence replayed with
eventFlags ticking mid-stall now climbs `1, 2, 3` and stays exhausted instead
of resetting, logs exactly K entries, credits no win while the key is still
stalled — and still closes all three as `"advanced"` (refunding K) the moment
the stall clears, or as `"superseded"` if it clears with nothing moved.

## Rollback

Deleting `runtime/intervention_log.json` resets every K counter to zero —
safe, no live consumer depends on its history yet (see "what this does not
do yet"). Deleting `runtime/supervisor_directive.json` costs nothing; it is
overwritten in full on every intervening call. Nothing in this module
touches the game, the service, checkpoints, `events/`, or the work queue.
