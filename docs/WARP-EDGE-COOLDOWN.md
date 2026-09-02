# Warp-edge ledger, door cooldowns, and divergence-on-repeat (wq#1178)

Items 7 and 8 of the LPP improvement plan. Both exist because of one measured
stall: 60% of turns returning `enter_warp: refused - this is the door you just
arrived through`, `stuck_mode=None`, the frontier frozen at Route 25 for 407
hours — 8110 turns and 187.7M tokens spent standing still.

Nothing here was broken in the ordinary sense. The refusal was correct. The
detectors were correct and silent, because none of their axes (storyScore,
badges, event flags, arrival-map history) can see a warp that never fired. What
was wrong is that **the state block and the executor disagreed**, and that
**being refused cost nothing**, so repetition was free.

## What changed

### 1. The state block stopped advertising the refused move

`reach.ts` used to end the WARPS line with:

> `! You are STANDING ON warp 0 — enter_warp(0) still uses it.`

That hint (wq#536) is right in general and wrong on exactly one turn: the one
where you arrived through that door and have not moved. On that turn it was
recommending the call `agent.ts` refuses — directly above the refusal. It now
inverts on the arrival door and names the way out (take a real step first).

### 2. Warps are recorded as directed edges

`oscillation.ts`'s cross-run history is a list of **arrival map ids**. It cannot
say which door produced them, so a door-bounce and a legitimate there-and-back
look identical.

The new ledger (`runtime/warp_edges.json`) records `(fromMap, warpIndex,
toMap)` per warp that **actually fired**, with a timestamp and the visited-tile
count at that moment (`novelty.ts`). The destination is the map **landed on**,
never `w.destMap` — `0xFF` means "wherever I came in from" and only the landing
knows.

Two things follow:

- **WARPS annotations.** A door used twice or more in the last 10 warps is
  annotated in place: `0:(5,7)->Route 25 [STANDING-ON-IT] {taken 4x in last 10
  warps, 0 new tiles since}`. The cost of a door is visible when the brain
  picks one, not two turns later in a LOOP NOTICE.
- **Bounce detection.** Two *non-overlapping* round trips (A→B immediately
  followed by B→A, four warps) over the same pair, with **zero new tiles**
  found across the span, is a bounce. The novelty conjunct is what keeps Mt
  Moon working: its only exit runs back the way you came (wq#535), and a
  back-and-forth that covers new ground is a route, not a loop.

### 3. Doors go on a cooldown that expires two ways

A bounce, or three consecutive refusals of the same door, puts that **directed**
door on a cooldown. `enter_warp` then refuses it with the minutes remaining, the
reason, and the list of warps that *are* usable.

Every cooldown dies two ways, and this is the wq#517 lesson made structural — a
permanent ban wedges the one corridor that legitimately runs backward:

| Lift | When |
|---|---|
| wall clock | `COOLDOWN_MS`, 10 minutes (~10-30 turns at live cadence) |
| novelty | the **first tile the agent has never stood on** — one step, if it goes somewhere |
| compliance | a refusal-born cooldown (`kind: "refusal"`) is dropped the moment the agent moves at all — it only ever asked for that move |

Bounce cooldowns (`kind: "bounce"`) survive a step, because a step does not make
a round trip productive.

### 4. Divergence on repeat (item 8)

`live_agent` builds a **new Agent** on every continue, reboot and crash
recovery, each from the newest checkpoint. When that checkpoint keeps describing
the same game state, the brain gets the same inputs and produces the same run.
Demoting the checkpoint does not help: the *state* replays, not the file.

`DivergenceTracker` (`recovery.ts`) keys boots on **state identity** —
`(map, x, y, storyScore, badges, levelSum)` — not on a filename. A fresh
checkpoint written at the same position and story is the same trap under a new
name.

On the second boot from a key, the state block carries:

```
!! DIVERGENCE REQUIRED (boot 2 from the same game state: map/position/story/
badges/levels all identical). Your previous run from this exact state ran 40
turns and achieved dP=+0. DO NOT REPEAT THAT PLAN — the same inputs produced
the same nothing. MANDATORY ALTERNATIVE OBJECTIVE: <next corridor milestone>
(mapN). Pick a DIFFERENT first action than last time: a warp index you have not
used from here, a map edge, or a trainer you have not fought.
```

The dP quoted is measured, not asserted: each run records the composite P
(`novelty.ts`) it booted at and reached, in `runtime/boot_states.json`, for the
next boot from that key to read. It is an **objective, not a ban** — no move is
forbidden — and it clears itself the moment this run's P rises above where it
booted.

## Runtime files

| File | Written by | Bound |
|---|---|---|
| `runtime/warp_edges.json` | `agent.ts` on every warp that fires | 64 edges + live cooldowns |
| `runtime/boot_states.json` | `recovery.ts` at boot, flushed every 20 turns | 32 boots |

Both are gitignored, fail-soft (a bookkeeping failure can never break a turn),
and take env overrides — `LPP_WARP_EDGES`, `LPP_BOOT_LEDGER` — so a probe
cannot write into a live deployment's ledger.

## Observing it

Event-bus lines, all on existing kinds:

- `tool_call warp_cooldown_set` — a door went on cooldown, with the reason
- `tool_call warp_cooldown_refused` — an `enter_warp` hit a live cooldown
- `tool_call door_bounce_refused` — with `streak`, the consecutive-refusal count
- `regression state_repeat` (`stage: detected` / `cleared`) — divergence

Acceptance probe: `src/probe_warpedge1178.ts` (in the CI-safe pure set).
