# Forward-progress FRONTIER (wq#515)

The metric that was missing for five days.

From **2026-08-08 to 2026-08-13** the agent ran 34 runs, 4,995 turns, 32.6M
tokens and 120.5 wall hours, and the badge count went **1 → 1**. Cerulean City
(map 3) has never been visited in the entire project history. Every guard in
the codebase reported healthy for the whole stretch.

    tools/lpp_frontier.py [--window-hours N] [--rule strict|events|newmap]
                          [--json] [--one-line] [--backtest] [--no-live]

Read-only: reads checkpoint sidecars, run summaries and one localhost GET. The
only file it writes is its own cache at `runtime/frontier.json`.

## Why every existing guard missed it

| Guard | Requires | Why it stayed silent |
|---|---|---|
| `src/recovery.ts` (wq#477) | `storyScore < maxStoryScore` | score sat **at** max 6 — a regression detector is structurally blind to stagnation |
| `lpp-sentinel` `check_stall` | flat score **AND** a step-budget SOFT alarm | runs died before any floor budget hit 2×, so the conjunction never held |
| `lpp-sentinel` `check_loop` | one map + a ≤3-tile bbox over 20 turns | the agent moved briskly across four maps |
| `agent.ts` `notePotentialOscillation` | ≤2 distinct maps in 6 warps | the real loop had four, and its history resets every restart |

**The shape they share:** all are scoped *within one run* and keyed on a
*decrease*. The real failure was *across runs* and was *flatness*.
`tools/lpp-stats` even printed `storyScore 6->6` in both its columns and
everyone read past it.

## What moves the frontier

Exactly two things:

1. **`badgeCount` rising.**
2. **Reaching a map further along `CRITICAL_PATH`** than any map reached before.

Everything else — new side maps, a rising raw event-flag count, turns, tokens,
tool calls — is **context**. It is printed in the alert and it never resets the
clock.

### Why not "any new map counts as advance"

That was the obvious guard, and this campaign's own history disproves it. On
**2026-08-10 and 2026-08-11**, deep inside the freeze, the agent backtracked
from Mt Moon to Pewter City and entered **Museum 2F**, **Pewter Speech House**
and **Pewter Nidoran House** for the first time. Three never-before-seen map
ids, all of them backwards. A new-map rule resets the clock on each and
shatters one continuous **55.9h** freeze into 20.1h + 12.4h + 23.3h fragments.

Raw event-flag count is the same trap: it ticked to 25 on 08-10 and 26 on 08-12
while the game went nowhere.

Both alternatives are kept as `--rule newmap` / `--rule events` so the backtest
can *measure* them rather than assert. Both are shipped **off**.

### Why the window is 12h, not the 6h the ticket proposed

Because 6h and 8h both fire during genuine progress. The Mt Moon descent on
2026-08-08 took **8.97h** between real frontier advances and was real work.
Measured on the full history:

| Rule | False alerts @12h | First fire on the real freeze |
|---|---|---|
| **`strict`** (shipped) | **0** | **2026-08-09T11:25Z** |
| `events` | 2 | 2026-08-12T22:22Z |
| `newmap` | 2 | 2026-08-11T23:03Z |

`strict` threshold sweep — a *false alert* is a quiet stretch that ended in a
real advance (slow but progressing), which must stay silent:

| Window | False alerts | Catches the freeze |
|---|---|---|
| 4h | 3 | yes |
| 6h | 2 | yes |
| 8h | 1 | yes |
| **10h** | **0** | yes |
| **12h (default)** | **0** | yes |
| 24h | 0 | yes |

10h is the minimum clean threshold; 12h is the round number above it with
margin over the 8.97h hard corridor. Frank noticed the freeze on 08-13 —
**this fires 08-09T11:25Z, 3.75 days earlier.**

## The critical path

`CRITICAL_PATH` in `tools/lpp_frontier.py` is main-line overworld and dungeon
maps only. Gyms, marts, centres, houses, gates and side rooms are deliberately
absent: entering one is not progress.

**Order is authored. Names are not.** Every label is reverse-looked-up from the
ROM via `MapHeaderPointers`/`MapHeaderBanks` (`tools/map_names.json`, generated
by `tools/dump_map_names.ts`, reusing the wq#503 `GameNames` decoder), and
`probe_frontier.py` regenerates the table and diffs it, so a ROM change fails
loudly instead of mislabelling an alert. The sequence itself follows the
project's own verified corridor text in `src/live_agent.ts corridorNotepad()`.

**Route 4 (map 15) is one map id spanning both sides of Mt Moon** — the project's
own corridor note says `Route4 west(map15) -> MT MOON 1F ... -> Route4 EAST(map15)`.
It is therefore ranked *below* Mt Moon: standing on Route 4 does not prove you
are past the mountain, and ranking it above would let the west side falsely
claim the frontier. Mt Moon depth carries the progression instead. This is
locked by a test, not a comment.

When the agent reaches the **last** entry in the table, the check emits
`frontier_path_end` instead of a stall — extend `CRITICAL_PATH` or it goes
blind from there.

## Evidence sources

| Source | Gives | Notes |
|---|---|---|
| `checkpoints/**/*.json` | exact `ts` + map + badges + events | primary timing; survives runs by design (wq#490 archive-never-delete) |
| `events/run-summary-*.json` | `mapsSeen`, badges, `startedAt`, `wallMs` | an advance inside a run is attributed to the run's **end** — the latest instant it could have happened, so gaps are never overstated |
| `:8871/progress.json` | live storyScore / objective | display only. Only 6 of 51 runs still have an event log, so the frontier cannot depend on storyScore and never resets on it |

`runtime/frontier.json` is a **merge-max cache, not a source of truth** — the
frontier is always recomputed from evidence, so archiving old checkpoints can
never walk the recorded high-water mark backwards.

`compute(now_ms=…)` filters evidence to that instant, so any past moment can be
replayed. That is what makes the backtest meaningful.

## Verification

`python3 tools/probe_frontier.py` — **48/48**, offline, no service, no network.
Covers ROM-name agreement, the Route 4 ordering decision, advance/backtrack
semantics, merge-max persistence, graceful degradation on empty evidence, and
both directions of the guard: histories that **must stay silent** (steady
progress, a 9h hard corridor, side-room detours alongside real progress) and
histories that **must fire** (a four-map loop with no depth gain, a loop
sprinkled with new side maps, a loop with rising event flags).

The live end-to-end alert was verified over the real board + ntfy path on
2026-08-13T05:44Z, with the dedupe re-run confirmed suppressed.

## Rollback

`lpp-sentinel --no-frontier` disables the check; deleting
`runtime/frontier.json` costs nothing (it is recomputed). No service restart is
involved either way — the sentinel is a timer-driven read-only observer.

## Restart-loop detection (wq#515 absorbed scope, was wq#504 MISS 2)

The frontier answers *"has the game moved forward?"*. The restart-loop check
answers *why it has not*, and it can answer on the **second boot** rather than
after a 12-hour window has closed.

Two independent pathologies, one alert key (`restart_loop`):

| Signal | Meaning |
| --- | --- |
| **repeat** | the same `resumedFrom` across ≥2 consecutive boots — the harness is not advancing its own starting point |
| **rewind** | a boot that resumes *shallower* on the critical path than the previous run actually reached — progress being discarded, stated directly rather than inferred from flatness |

On the real campaign at the time of writing this fires with **9 consecutive
boots** on `auto-msqlak0v-map15.state.gz` and 16 rewind boots on record. That
is the wq#518 resume trap, and this is the detector that would have named it on
2026-08-08 rather than five days later.

### Why the map id in a filename is trustworthy here

The boot's starting map is parsed out of the checkpoint filename
(`auto-<id>-map<N>.state.gz`). That parse is only legitimate because the
filename id matches the **RAM-read** `map` field inside the corresponding
sidecar for every checkpoint on disk — verified 33/33 exact, 0 mismatches, and
re-verified by `probe_frontier.py` on every run. If the naming convention ever
drifts, the probe fails instead of this check quietly lying.

### Two numbers that were wrong in the first draft

Both were caught by the probe and are now regression-tested:

* *turns discarded* summed a rewind list that is **not index-aligned** with the
  boot streak, giving a plausible-looking 301 instead of the correct 185. It is
  now computed from the streak's own boots, excluding the one still running.
* the alert said **"deepest discarded"** while the code took the *most recent*
  rewind. Confident text that does not match what the code computes is the
  precise failure mode this project keeps paying for.

## Deploy drift (wq#515, folded in 06:03Z)

"Landed on origin" is not "live". `deploy_drift` reports **three** shas —
running, tree, `origin/main` — plus any uncommitted `src/`/`tools/` paths that
the next restart would deploy unreviewed.

### The trap: `git rev-parse HEAD` is not the deployed sha

The board reported `deployed=62fa545` for roughly 40 minutes on 2026-08-13 and
it was wrong. The service runs `tsx` straight out of the working tree, so the
tree moves under a live process without redeploying it: **HEAD is what the next
restart will load, never proof of what is loaded now.** The live process had
loaded `7a44df9` and the tree had since fast-forwarded twice past it.

So the running sha is resolved from the **reflog as of the process start
time** (`/proc/<MainPID>/stat`, locale-free), which is the only local record of
what the tree contained when the code was actually read.

### Known limitation

`git reflog` timestamps have **one-second resolution**. If a fast-forward lands
in the same second the service starts, the resolution is ambiguous and the
newest entry wins. Real restarts and pulls are seconds to minutes apart — the
live case resolved correctly on a 6-second gap — but the limit is real and is
recorded here rather than hidden. `originRefAgeHours` is reported alongside,
because the check deliberately does **not** run `git fetch`: a monitor firing
every 10 minutes should not make authenticated network calls, so a stale
`origin/main` ref is surfaced as an age instead of silently assumed current.
