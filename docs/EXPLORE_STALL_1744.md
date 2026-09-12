# Keeping the brain out of the stalled patch (wq#1744)

wq#1731 shipped a hard exploration override (`src/explore.ts`, PR #113,
6a3f7f0): when the novelty window says the agent has stopped covering ground,
suspend the brain and drive K=30 directional steps. wq#1744 was filed to
verify it, together with the battle-bag fix (7950ea6), actually breaks the
map35 (Route 24/25) x=4..5 cycle.

It does not, and the reason is upstream of the escape planner: **on the live
run the stall verdict never becomes true at all.**

## The measurement

Live run `events/live-agent-1789183317445.jsonl`, started 2026-09-12T03:21:55Z
on 2c3e0f6 (includes both fixes), sampled 2026-09-12T10:04Z at turn 318.

Replaying that run's own novelty samples (`runtime/progress.json`, 512
samples, turns 220..338) through the production `assessStall()` at the live
config (`windowTurns: 150`, `minTiles: 5`):

    run samples: 512 (turn 220..338)
    windows evaluated: 363, stalled: 0
    non-fire reasons: { 'maps=3': 155, 'maps=4': 103, 'maps=2': 1,
                        'newTiles=1': 2, 'newTiles=2': 7, 'newTiles=3': 14,
                        'newTiles=4': 28, 'newTiles=5': 53 }
    map35: 398/512 samples; x=4..5 strip: 312 (60.9% of run)

363 of 363 windows: not stalled. Corroborated by
`runtime/stuck_escalation_overrides.jsonl`, whose last write is
2026-09-11T01:19:17Z — **zero fires in 6.7h / 318 turns of live play**, while
60.9% of the run's samples sat in the exact strip the override exists to
break. The 9 fires the ticket cites are all from the 2026-09-10 21:00Z ..
2026-09-11 01:19Z window, before the agent picked up this behaviour.

## Root cause: two immunity paths, and the agent walks both

`assessStall()` (src/explore.ts:88) declares a stall only when

    d.complete && d.newTiles === 0 && (seen.size < minTiles || maps.length === 1)

Every clause is evaluated over the *whole* 150-sample window, so a single
sample anywhere in it vetoes the verdict for the next 150 samples:

1. **`newTiles === 0`** — 104 of the 363 windows were vetoed by novelty. The
   run found exactly 5 new tiles, all between turns 234 and 285 (map36 x17,y8
   / x24,y9 / x39,y4 / x0,y6 and map88 x4,y4). Five tiles bought ~150 samples
   of immunity each.
2. **`maps.length === 1`** — 259 windows were vetoed by a second map. The
   agent pops to Route 25 (map36), Bill's house (map88) or Cerulean (map3)
   for a few turns, comes back, and the window is no longer single-map.

Neither veto is wrong on its own terms: a window that covers new ground or
two maps is genuinely not the frozen-in-place shape wq#1731 was written
against (the header's own case: "one map for 500 straight samples"). The
behaviour that defeats it is *shuttling* — a productive-looking excursion
every ~50 turns wrapped around a long unproductive grind — and that shape is
invisible to a whole-window AND.

`probe_explore1731` D5 already asserts the first veto as intended behaviour
("a new tile clears the urgency line"), so this is a design gap, not a bug in
the implementation of the design.

## Design

Two changes, in this order. The second is the one wq#1744 asked for; it is
useless without the first, because there is currently nothing to hang an
"after an escape" window off.

### 1. A stall verdict that survives a brief excursion

Replace the whole-window AND with a **dominant-patch** test, evaluated over
the same 150 samples:

- `patch` = the (map, x, y) cells holding >= `patchShare` (start: 0.5) of the
  window's samples. On this run that is map35 x=4..5, at 0.609.
- `patchNew` = new tiles discovered *while inside the patch* — not new tiles
  anywhere in the window. Attribute each `newTiles` increment to the sample
  that produced it (`novelty.ts` already carries per-sample `newTiles`), so
  the map36/map88 finds no longer launder the map35 grind.
- Stalled when the window is complete, `patchShare` is met, and
  `patchNew === 0`.

Keep the existing triggers as-is and add this as a third,
`trigger: "dominant_patch"`. The current two stay the fast path for a true
freeze; the new one catches the shuttle. Config knobs alongside the existing
ones in `config.ts:151`: `LPP_EXPLORE_PATCH_SHARE` (0.5),
`LPP_EXPLORE_PATCH_NEW` (0).

Falsifier before any code: run the same replay above with the new predicate
and require it to fire on this run's samples, and *not* to fire on a replay
of a window where the agent is genuinely progressing (e.g. the map36 stretch
turns 234..285 in isolation). Both replays belong in `probe_explore1731` as
fixture cases, fed from a checked-in slice of `runtime/progress.json` — the
probe is in `probes-pure.sh`, so they must be fixtures, not live reads.

### 2. Refuse re-entry to the patch for N turns after an escape

The fire record already writes everything needed:
`stuck_escalation_overrides.jsonl` `end` records carry
`window: {..., uniqueTiles, maps}` and the planner holds a `footprint:
Set<string>` of tileKeys over the stall window (src/explore.ts:266).
Currently the footprint is used only to pick a target with `clearance` from
the patch, and is discarded when the override ends — which is why all 9
historical fires read `escaped: true, mapChanged: false` and the brain walked
straight back.

Persist it instead:

- On `end`, write the footprint to `runtime/explore_exclusion.json` as
  `{ tiles: string[], untilTurn: number, fromFire: n }` with
  `untilTurn = turn + exclusionTurns` (start: 60, i.e. `LPP_EXPLORE_EXCLUDE_TURNS`).
- While an exclusion is live, `goto` refuses a target whose tileKey is in
  `tiles` with a message naming the reason and the turn it expires — the same
  refusal shape wq#1181's loss ledger already uses, so the brain gets a
  sentence it can act on rather than a silent no-op.
- The exclusion is advisory for *movement*: walking through the patch to
  reach somewhere else stays legal. Only choosing it as a destination is
  refused. Otherwise a patch that straddles the only corridor off the map
  bricks the run.
- Expire on `untilTurn`, on a map change, or on any new tile inside the
  patch (the patch stopped being dead ground — clear it and let the brain
  back in).

Escape hatch: `LPP_EXPLORE_EXCLUDE_TURNS=0` is a full revert, matching the
`LPP_EXPLORE_OVERRIDE=0` convention.

## What this deliberately does not fix

Catching is blocked on the live run by economics, not by either shipped fix:
the bag holds no Poke Balls (`item234x1, dome_fossil, antidote, item49,
item245, item80, repel x2, potion, item82`) and money is 96, below the 200 a
ball costs. `Items.useInBattle` correctly returns `use_item: no poke_ball in
bag` from the RAM read at src/items.ts:393, before it ever opens the bag.
Getting the agent off the strip will not, on its own, produce a catch. That
is a separate ticket.
