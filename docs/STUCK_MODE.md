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
| `FIGHT_LOSS_LOOP` | among the most recent persisted warps (`runtime/warp_history.json`, capped at 64 by wq#517), a **gym** map (label containing "Gym") appears >=2x **and** a heal/city map for that trip (Pokecenter or a `*City`/`*Town` label) also appears >=2x — walked into the gym, walked back out, more than once |
| `OBJECTIVE_DRIFT` | the `FIGHT_LOSS_LOOP` shape (either the gym bounce above or one of the two hub/route readiness reads) around a gym whose **badge is already won** — `runtime/fight_ledger.json` holds a `win` on that gym map recorded at a *lower* badge count than the player now holds (wq#1867). Anchored on the town the loop collapsed onto, never the gym, so the incident key does not move when the winning visit's two warps age out of the window |
| `RESUME_DEADEND` | the same `resumedFrom` checkpoint booted on **more than `RESUME_REPEAT_LIMIT` consecutive** boots (`runtime/resume_history.json`; the bar is parsed out of `src/resume.ts`, never retyped). At exactly the limit the harness's own repeat guard is about to demote that file, so a run of exactly the limit is a remedy already in flight — only a longer run proves the guard ran and found no newer non-warp state to take (wq#1118). Deferred below the fight-readiness reads (wq#1081/#1084) because any long freeze re-resumes its own checkpoint; anchored on the map the agent is standing on, never `None` |
| `OBJECTIVE_UNREACHABLE` | the frontier engine reports `pathExhausted` while this axis is *also* stalled — no further `CRITICAL_PATH` milestone is encoded to aim at |
| `NAV_LOOP` | no gym involved, but the warp window collapses onto <=3 distinct maps with >=4 warps — an overworld/dungeon loop, not a gym fight |
| `IDLE` | stalled but nothing above matched — catch-all, deliberately last |

`FIGHT_LOSS_LOOP` is checked first but **cannot** be returned for a gym the
ledger says is beaten: a win on that map at a lower badge count than the
player's current one takes the gym out of the bounce set, and the same shape
resolves to `OBJECTIVE_DRIFT` instead. Read the two rows together — they are
one branch with a badge test in the middle, not two competing signatures. The
stall that forced this (wq#1867) had won the Cascade Badge three hours earlier
and was still being told to grind for Misty, because two warps to Cerulean Gym
— the winning visit's own way in and way out — never left the 64-warp window.

Classification runs over the **full persisted `warp_history.json` window**
(64 entries), not a tighter recent slice. A 20-entry slice was tried first and
missed the live fixture: the most recent 20 raw warps in the 43h incident
happen to be a pure city<->pokecenter shuffle with the last gym re-entry just
outside that slice — a real but narrower symptom of the same episode. The
persisted list is itself already a bounded recent window (wq#517's own
`KEEP=64`), so no further truncation is needed.

## Verification

`python3 tools/verify_671.py` — **23/23**. Unit-tests `classify_mode()`
directly for MODE priority (an inlined literal copy of the live 43h stall's
`warp_history.json`, captured 2026-08-17T20:15Z, MUST classify
`FIGHT_LOSS_LOOP` and name both Cerulean Gym and Cerulean City in the
evidence string; healthy multi-map travel and a single gym visit must NOT;
a same-checkpoint run PAST `RESUME_REPEAT_LIMIT` classifies `RESUME_DEADEND`
while a run of exactly the limit and alternating-checkpoint resumes — the live
fixture's own shape — must NOT), then exercises `compute()` end-to-end against synthetic
checkpoint sidecars in a temp tree (flat story_score over the window stalls
and classifies; a story_score rise, a badge-only rise, and a sub-window gap
all stay silent), then two graceful-degradation cases (no sidecars, no warp
history). A final SKIP-shaped live-corpus check (never fails the suite on its
own — see `src/fixtures.ts`'s own doctrine on corpus rot) confirms the real
`runtime/` still reproduces the incident today. Since wq#1867 that check
reports `OBJECTIVE_DRIFT`, which is the corrected verdict on the same corpus.

`python3 tools/test_stuck1867.py` — **39/39**, sections A-I: the live 64-warp
window plus the live ledger record reclassify (A); the same window with the
badge not yet won still reads `FIGHT_LOSS_LOOP@65` (B); a missing, empty or
junk ledger degrades to that too (C); what does and does not clear a gym —
a junior trainer's defeat does not, a checkpoint restore un-clears (D); the
hub-orbit read defers the same way with no gym warp in the slice at all (E);
both paths return one anchor, so one incident key (F); the prescription names
the frontier's milestone, orders no grind, bans nothing, and trips neither of
`src/pin.ts`'s two pin regexes (G); the closed-off-pocket clause appears only
on the evidence, matching both truncations of `reach.ts`'s phrase (H); and the
EXHAUSTED directive formats for every mode (I).

## The dP axis — composite progress in turns, not hours (wq#1179)

Both axes above are **wall-clock** ones over story flags, badges and event
flags. A live 60%-refused-warp stall ran with `stuck_mode=None` and every
sentinel silent for twelve days: the agent re-entered the same doorway
forever, which moves none of those three and so looked identical to "between
milestones". There was also no exploration signal anywhere in `src/` — nothing
counted whether the agent had ever stood somewhere new.

`src/novelty.ts` adds both halves of the PWhiddy borrow:

- **Tile novelty** — a persistent `Set` of visited `(map,x,y)` keys in
  `runtime/visited_tiles.json`, carried across reboots (the loops this catches
  outlive restarts). One sample per turn at the turn's **end** position, so
  `newTiles` is 0 or 1 per turn: it measures "did this turn end somewhere new",
  not "how much ground did this turn cover". Intra-turn steps live in
  `nav_trace` (wq#542) and are a possible later refinement.
- **Composite scalar** `P = 1000·storyScore + 500·badges + 10·Σ(levels) +
  5·pokedexOwned + 1·uniqueTiles`, appended per turn to
  `runtime/progress.json` (bounded at 512 samples) and emitted on the event bus
  as a `progress` event.

`dP` is `P(last) − P(first)` over the last **`DP_WINDOW_TURNS` = 40 samples**,
windowed by position in the log rather than by turn id, because turn counters
restart at 1 on every reboot. A window is `flat` when it is **complete** and
`dP <= 0`. That is what separates productive grinding (levels rising on ground
already walked) from a fight-loss loop (nothing rising at all) — today both
look identical until `storyScore` has been flat for two hours.

`tools/lpp_stuck_mode.py` reads `DP_WINDOW_TURNS` and `WEIGHTS` **out of
`src/novelty.ts`** rather than retyping them (same idiom as
`resume_repeat_limit()` reading `src/resume.ts`), and re-derives every logged
`P` from that sample's own components. If any sample disagrees, the axis
reports `pMismatch` and refuses to flag — a detector that cannot verify its
input says so rather than guessing.

**Shipping state: OBSERVE-ONLY.** `compute()` always reports the `dP` block
(and `one_line()` marks it `OBSERVE-ONLY`), but the axis only sets `stalled`
— and so only reaches wq#672's interventions and wq#673's tickets — behind
`--dp-axis` / `LPP_DP_AXIS=1`; `--no-dp-axis` forces it off regardless of the
env. When it does fire, `stallAxis` is `"dP"`, the existing classifier runs
unchanged, and the evidence string leads with the dP window so a reader can
tell "flat for 40 turns" from "frozen for 2 hours". A deployment with no
tracker running (no `runtime/progress.json`) behaves exactly as it did before.

Verification: `npx tsx src/probe_novelty1179.ts` — 32 checks (novelty collapses
in a synthetic re-entry loop and not in exploration; dP flags the loop within
window+2 turns of onset; a productive grind is never flagged; cross-reboot
persistence; corrupt/unwritable files degrade instead of throwing) — and
`python3 tools/test_novelty1179.py` — 5 sections A-E on the consumer side
(constants parsed from the TS source, loop-vs-exploration-vs-grind,
fail-closed on partial/unverifiable windows, observe-only default vs
`--dp-axis`, flag resolution).

## Known limits

- Party level/species/type are **not** in checkpoint sidecars (confirmed:
  only `hpPct`/`ppOk` aggregate booleans). `FIGHT_LOSS_LOOP`'s "underleveled
  starter" root cause (wq#672/wq#674) needs a live `.state.gz` decode through
  `src/state.ts`'s `party: PartyMon[]`, not this module — this module only
  detects the *shape* of the loop, not *why* the fights are being lost.
- The dP axis samples **once per turn regardless of what the turn was**, so a
  long legitimate battle can look flat: a multi-mon trainer fight is many
  `battle_move` turns with no level, tile, flag or badge gained until it ends.
  With `--dp-axis` on, that is a false-positive path — 40 such turns would be
  called a stall and classified like any other. It is why the axis ships
  observe-only: the gate that should suppress it (`inBattle`, or an XP-rate
  term) belongs with the battle work in items 5-6 of the improvement plan, not
  in a detector that cannot yet see a fight's shape. Items 5-6 landed in
  wq#1181 (`docs/FIGHT_GATES.md`) and now emit the two signals that gate would
  need — a per-battle-turn `winnability` verdict and a `fight_ledger` outcome
  record. wq#1867 consumes the second one, but only for the badge test that
  separates `FIGHT_LOSS_LOOP` from `OBJECTIVE_DRIFT`; the `winnability` verdict
  is still unread here, so the false-positive path above is unchanged.
- `NOISE_STORM` (wq#697) could not fire at all between shipping and wq#1867:
  `load_recent_turn_summaries()` looked for `ev["k"] == "turn_summary"` and
  `ev["d"]["line"]`, while `src/events.ts` writes `{ t, ...data, kind }` — flat,
  envelope last (wq#522). It returned an empty list on every live run, the
  detector read that as a streak of 0, and nothing ever said so. Fixed by
  reading `kind` + a flat `line` (the shape `turncost_487`, `backtest_520` and
  `verify_489` were already using); the old nesting is still accepted for
  fixtures. The same lines feed `OBJECTIVE_DRIFT`'s closed-off-pocket clause,
  which is how the dead read was caught.
- A phrase match against another module's prose is a live dependency, and
  wq#1877 is the second time it broke: `CLOSED_OFF_RE` was still reading for
  "closed-off part of this", the wording wq#1870 replaced, so the clause was
  silent through the whole 4.6h Cerulean freeze (68 live turn summaries, 0
  matches). It now matches all three shapes reach.ts has emitted, and
  `test_stuck1867.py` H4 asserts against the phrases in `src/reach.ts` itself
  rather than against a copy of them.
- The badge test behind `OBJECTIVE_DRIFT` is only as good as the ledger. A
  missing, empty or rotated-past ledger (`KEEP_RECORDS = 200` in
  `src/ledger.ts`) clears no gym, and the classifier degrades to exactly the
  `FIGHT_LOSS_LOOP` behaviour it had before wq#1867 — wrong in the same way,
  never worse.
- `OBJECTIVE_UNREACHABLE` degrades to "never selected" (not a crash) if
  `lpp_frontier` fails to import, matching `lpp-sentinel`'s own
  `frontier_unavailable` precedent of reporting failure loudly rather than
  swallowing it — but this module reports it as a silently-skipped mode
  rather than its own alert, since it has no alerting path of its own yet
  (wq#673 wires that).

## Rollback

Deleting `runtime/stuck_mode.json` costs nothing — it is fully recomputed
every call, no merge-max history to lose. The wq#1179 axis rolls back the same
way: `LPP_DP_AXIS` unset (the default) leaves it observe-only, and deleting
`runtime/progress.json` / `runtime/visited_tiles.json` costs only the visited
set — `src/novelty.ts` rebuilds both from the next turn onward, and a missing
log degrades the axis to "not running" rather than to a stall claim. Nothing currently calls this module
from a live/cron path (wq#673 wires that); running it manually never touches
the game, the service, checkpoints or the work queue.
