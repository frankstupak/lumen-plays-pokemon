# LPP stuck-supervisor: detect -> intervene -> auto-ticket + escalate (wq#671-673)

Three modules, wired into one entrypoint, closing the loop the 2026-08-17
incident exposed: `lpp_frontier`/`lpp-sentinel` alerted hourly on the WRONG
axis (critical-path rank) for 43h while the agent was stuck losing to Misty
at Cerulean Gym, and the one tool built to intervene (the wq#621 vision
valve) was firing but not actually breaking the loop, and nothing closed the
loop back to a human.

| Module | Ticket | Answers |
|---|---|---|
| `tools/lpp_stuck_mode.py` | wq#671 | What kind of stuck? (`docs/STUCK_MODE.md`) |
| `tools/lpp_stuck_intervene.py` | wq#672 | What to try, bounded K=3? (`docs/STUCK_INTERVENE.md`) |
| `tools/lpp_stuck_feedback.py` | wq#673 | When to stop trying and tell Frank? (this doc) |
| `tools/lpp-stuck-supervisor` | — | wires the three into one timer entrypoint |

## The escalation ladder, and what happens past K (wq#1563)

Until wq#1563 the ladder ended at K: three interventions, then a "handoff" that
handed off to nothing and a supervisor that ticked forever. `FIGHT_LOSS_LOOP@3`
sat in that state for 167.9h.

| Rung | Fires when | Does | Ends when |
|---|---|---|---|
| L1-L3 | stalled, attempt <= K | the per-MODE prescription (`PRESCRIPTIONS`) | story advances, or K is spent |
| L4 BREAKOUT | K spent **and** `breakout_anchor()` finds a map-local cage | refuses `goto` **on that one map** for `3 x DP_WINDOW_TURNS` turns, names a real map to walk to, leaves `leave_edge`/`enter_warp` open | the budget runs out, or story advances |
| L5 HANDOFF | K spent and the breakout is spent too, or there was never an anchor | imposes nothing, says plainly that the machine is out of moves | a human |

**Why this rung and not the obvious ones.** Forced flee/run has no mechanism
(this supervisor writes files, it never presses a button) and no target (the
frozen agent entered zero battles). Forced heal-return-to-Pokecenter routing is
the failure mode, not the remedy — the party was at full HP and the wq#1091 pin
already had to say *stop* warping to the centre. Checkpoint restore / soft-reset
is the destructive one: it can regress story flags, `src/resume.ts` owns the
boot pick anyway (wq#1118), and a reset that lands back on the same state is
just `RESUME_DEADEND`. Banning the map is wrong by construction here — the agent
is already inside it and needs its exits — and banning the individual tiles is
worse, because the trailing window covers ~25 of them and banning 25 tiles can
make the map's own exit unreachable. What is left is the bounded explore-away
directive, which cannot corrupt a save, regress the story, or loop a reset.

**Kill-criteria** (each asserted in `tools/test_stuck1563.py`): an anchor is
required, so the rung never invents a target; it fires at most once per
unresolved incident key; it is bounded in turns, not wall-clock; it releases its
own ban on expiry; and it lifts free when the story advances, via the baseline
mechanism `src/agent.ts` already had.

Two mechanisms had to be repaired before any of this could reach the game.
`lpp-stuck-supervisor` gated the directive write on `intervened`, so every
directive computed on the exhausted path since wq#1091 was thrown away —
`runtime/supervisor_directive.json` sat unchanged from 2026-08-29 while the
supervisor ticked over the incident for a week. And `src/agent.ts` read the
directive only in its constructor, so a directive written mid-run was invisible
until the next boot, ~450 turns later; `refreshSupervisorDirective()` now
re-reads it when the file's mtime moves.

### Was the freeze a brain regression? No — it predates the pin.

`runtime/frontier.json` puts `lastAdvanceAt` at **2026-08-16T00:46:09Z**
("reached Route 25"), 582h frozen. The Cerebras reroute (`0fa30e0`, "reroute LPP
fallback from DeepSeek to cerebras") landed **2026-08-22**, six days later. The
critical-path axis was already frozen when the brain changed, so the freeze is
pre-existing and the model pin did not cause it. The story_score axis froze
later (2026-09-02) and is the shallower symptom of the same stall.

What the agent was actually doing, from `events/run-summary-live-agent-*.json`
and the live event log: 452 turns, 725 `goto` calls, 29 `enter_warp`, **zero
battles entered and zero catches**, every progress sample on map 35, 0-2 new
tiles per 40-turn window. It was not losing fights — it entered none. The brain's
own reasoning names the cause: *"wild grass not shown ... Assume we can move to
a grass tile"*. `FIGHT_LOSS_LOOP` is the closest label the classifier has, but
the prescription it carries (go grind, catch a type counter) describes exactly
what the agent was already failing to do. Making tall grass visible in the
observation is the real fix and is not this ticket; L4 at least stops the agent
paying 725 turns to learn that pacing one route does not work.

## Click-path (this ticket's explicit ask)

Not installed by this ticket — a systemd unit change is a real operational
action outside a read/write-local-files-only worker's authority, so the
units are checked in and documented, not activated.

    tools/lpp-stuck-supervisor --dry-run --json   # verify it behaves before installing
    sudo cp deploy/lumen-lpp-stuck-supervisor.service \
            deploy/lumen-lpp-stuck-supervisor.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now lumen-lpp-stuck-supervisor.timer
    systemctl status lumen-lpp-stuck-supervisor.timer
    journalctl -u lumen-lpp-stuck-supervisor.service -n 50

Same activation shape as `lumen-lpp-sentinel.timer` (`docs/SENTINEL.md`).
Runs every 30 minutes, not 10 — see the timer unit's own comment: at 10-minute
spacing, K=3 intervention attempts would exhaust in 30 minutes flat, faster
than any prescribed action could plausibly play out in-game.

## What auto-tickets and escalates (wq#673)

**Dedup / append, never duplicate.** The ticket title carries a stable
marker, `[lpp][stuck] MODE@LOCATION`, deterministic from wq#671's own
`(mode, modeLocation)` pair — no timestamp in the title. Before filing,
`wq list --status open` is scanned for that marker; a hit means **append** (a
dated block gets concatenated onto the existing `detail`) instead of a new
ticket. As a race-safe backstop, `wq add` itself refuses an exact-title
duplicate (`DUPLICATE — task <id> ...`) — that response is parsed the same
way and also treated as an append, so a filing race between two supervisor
ticks still can't produce two tickets for one incident.

**One append per change, not per tick (wq#1162).** An exhausted key stays
exhausted, so every subsequent tick reaches the append path — and appended.
`FIGHT_LOSS_LOOP@3` collected seven near-identical `REPEAT` blocks in 2.6h
whose sole difference was `frozen=2.4h` counting up to `frozen=5.0h`, and it
would have kept going for as long as the stall lasted. The append is now gated
on `report_signature()`: the report with the frozen-hours figure masked out,
compared against the last one stored on the incident. Anything that could
genuinely be news — a new attempt, a changed outcome, moved counters, a
`since <lastAdvanceAt>` that jumped because the freeze clock restarted — still
earns its block; a stall that merely got older writes nothing and `run()`
reports `action: "unchanged"`. An incident tracked from before this shipped
has no stored signature, so it appends exactly once more and then goes quiet.

**Ticket content** (from `build_report()`): mode, the frozen axis
(story_score primary, plus badges/eventFlags), how many hours frozen and
since when, every logged intervention attempt for this location with its
outcome (`advanced` / `superseded` / pending), and a proposed-resolution
pulled straight from wq#672's own prescription table — so the ticket reads
as a case file, not just an alert.

**Escalation.** Exactly once per incident: the first supervisor tick where
`now - firstStalledAt >= 3h` (measuring from the incident's own
`lastAdvanceAt`, i.e. when the game itself actually stopped moving — not
from when a ticket happened to get filed, which can lag behind by however
long K=3 attempts take) sends one `ntfy-send -t lumen-fleet -p high` page
naming the ticket. `-p high` is a first for this codebase — `lpp-sentinel`'s
own alerts never override the default priority. State
(`runtime/stuck_escalation.json`'s `ntfySentAt`) guarantees it never repeats
for the same incident, however many more ticks find it still stalled.

**Auto-resolve.** Every tick, before deciding anything new: any tracked
incident whose CURRENT storyScore/badges/eventFlags exceed the values
recorded when the incident was first filed gets its ticket closed
(`wq done <id> --notes "AUTO-RESOLVED ... storyScore X->Y, ..."`) with the
advance itself as the evidence, and drops out of tracked state. This fires
even if the game has since moved into a *different* stuck incident — an old
resolved incident is closed regardless of what's happening now.

The one exception is the incident stalled *right now* (wq#1162). That baseline
comparison is the same three-counter test wq#672's own resolver got wrong: a
partial tick clears the baseline while the agent is still losing the same
fight in the same room, and closing the ticket there retracts an escalation
the classifier is reporting live in the very same call — after which the next
tick files it all over again. The live key is skipped and resolves normally as
soon as the stall clears. See `docs/STUCK_INTERVENE.md` for the wq#672 half.

**Never autospawns fix-workers** (spec section 4, and the ticket's own
title). The only side effects anywhere in this chain are: writing
`runtime/*.json` state files, `wq add`/`wq edit`/`wq done` calls, and
`ntfy-send`. Nothing here claims a ticket, starts a Claude session, restarts
the service, or touches the emulator.

## Verification

`python3 tools/verify_673.py` — **39/39**. A `FakeWQ` emulates the real
`wq` CLI's `add`/`list`/`show`/`edit`/`done` text output (confirmed against
`/home/lumen/bin/wq`'s own source, including its exact-title duplicate
guard) so the dedup/append parsing is proven against the real format without
touching the real database. Covers: no ticket before K exhausts; exactly one
ticket filed on exhaustion, carrying mode/proposed-resolution; a repeat
exhaustion carrying new facts appends rather than duplicating, while one
carrying only a larger `frozen=` is dropped as `unchanged` and four further
identical polls issue no `wq edit` at all; `wq add`'s own duplicate-guard
response is handled as a race-safe append path; ntfy fires exactly once, only
at/after the 3h mark measured from the incident's true start (not from
ticket-filing time — this scenario is spaced tightly enough in the test to
separate "ticket exists, still under 3h" from "past 3h" as two distinct,
independently-asserted moments); a second poll past 3h does not re-send; and
a real advance both closes the ticket with evidence and clears tracked state,
including when the *current* incident has since moved to a different
mode/location; and (wq#1162) a counter tick while the same key is still the
live stall resolves nothing and leaves the ticket open, yet those same
counters do resolve it once the stall clears.

## Rollback

Deleting `runtime/stuck_escalation.json` forgets all tracked incidents —
the next stalled tick re-derives `firstStalledAt` from wq#671's own
`lastAdvanceAt` and either finds the existing open ticket via the marker
scan or, worst case, refiles one that `wq add`'s duplicate guard immediately
catches. No history is lost from the work queue itself, only from this
module's own "have I already paged for this" memory. Stopping/disabling the
timer costs nothing — every component script is safe to run standalone or
not at all.
