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

`lpp-stuck-supervisor` is what the timer runs, so it — not
`lpp_stuck_intervene.py`'s own `main()` — is where production behaviour lives.
wq#1097 found the two had drifted: wq#1091 taught the exhausted path to
refresh `runtime/supervisor_directive.json` (the only way a corrected pin can
still reach the agent once a key can never intervene again) but taught it to
`main()`, which nothing schedules. The entrypoint kept writing the file only
on `intervened`, so the live agent read a frozen `SUPERVISOR (3/3)` pin for as
long as the key stayed exhausted. Both now persist on any directive. **When
you change one of these paths, check the other.**

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

**Ticket content** (from `build_report()`): mode, the frozen axes, two clocks
— how long the *story* axis has been frozen and how long *any* axis has —
every logged intervention attempt for this location with its outcome
(`advanced` / `superseded` / pending), and a proposed-resolution pulled
straight from wq#672's own prescription table — so the ticket reads as a case
file, not just an alert.

`frozen_axes` is read from wq#671's `frozenAxes` (wq#1097). It used to be the
literal string `frozen_axis=story_score`, printed next to the any-axis clock,
so a ticket could claim the story axis was frozen for 2.9h when what had moved
2.9h ago was one event flag and the story axis had been frozen for 42 hours.
Both numbers are now real and both are named.

**Repeat appends are bounded** (wq#1097). `run()` calls the file-or-append
path on every tick where wq#672's decision is `exhausted`, and `exhausted` is
a steady state, not an edge — so `FIGHT_LOSS_LOOP@3` collected **47
byte-identical REPEAT blocks** on one ticket over 25 hours, one per supervisor
tick, each costing a `wq show` + `wq edit` and burying the original report. An
append now needs something new to say: either a changed report signature
(mode, location, story/badge/flag counts, map, frozen axes, and the
attempt-outcome list — everything except the clock) or `APPEND_COOLDOWN_H = 6`
hours of silence, which keeps a genuine long stall visible as a heartbeat. An
unchanged report inside the cooldown returns `{"action": "suppressed"}` and
touches `wq` not at all.

**Escalation.** Exactly once per incident: the first supervisor tick where
`now - firstStalledAt >= 3h` (measuring from the incident's own
`storyStalledSince`, i.e. when the game itself actually stopped moving — not
from when a ticket happened to get filed, which can lag behind by however
long K=3 attempts take; wq#1097 moved this off the any-axis `lastAdvanceAt`,
which an event-flag tick could reset, deferring Frank's one page indefinitely
on a stall that had in fact been running for days) sends one
`ntfy-send -t lumen-fleet -p high` page
naming the ticket. `-p high` is a first for this codebase — `lpp-sentinel`'s
own alerts never override the default priority. State
(`runtime/stuck_escalation.json`'s `ntfySentAt`) guarantees it never repeats
for the same incident, however many more ticks find it still stalled.

**Auto-resolve.** Every tick, before deciding anything new: any tracked
incident whose CURRENT storyScore or badges exceed the values recorded when
the incident was first filed gets its ticket closed
(`wq done <id> --notes "AUTO-RESOLVED ... storyScore X->Y, ..."`) with the
advance itself as the evidence, and drops out of tracked state. This fires
even if the game has since moved into a *different* stuck incident — an old
resolved incident is closed regardless of what's happening now.

The event-flag count is deliberately *not* part of that test (wq#1097).
Closing a stuck ticket because one flag ticked marks an unresolved incident
`done` while the agent is still standing in front of the same gym — and then
re-files or re-appends the moment the 2h detection window lapses again.

**Never autospawns fix-workers** (spec section 4, and the ticket's own
title). The only side effects anywhere in this chain are: writing
`runtime/*.json` state files, `wq add`/`wq edit`/`wq done` calls, and
`ntfy-send`. Nothing here claims a ticket, starts a Claude session, restarts
the service, or touches the emulator.

## Verification

`python3 tools/verify_673.py` — **29/29**. A `FakeWQ` emulates the real
`wq` CLI's `add`/`list`/`show`/`edit`/`done` text output (confirmed against
`/home/lumen/bin/wq`'s own source, including its exact-title duplicate
guard) so the dedup/append parsing is proven against the real format without
touching the real database. Covers: no ticket before K exhausts; exactly one
ticket filed on exhaustion, carrying mode/proposed-resolution; a repeat
exhaustion appends rather than duplicating; `wq add`'s own duplicate-guard
response is handled as a race-safe append path; ntfy fires exactly once, only
at/after the 3h mark measured from the incident's true start (not from
ticket-filing time — this scenario is spaced tightly enough in the test to
separate "ticket exists, still under 3h" from "past 3h" as two distinct,
independently-asserted moments); a second poll past 3h does not re-send; and
a real advance both closes the ticket with evidence and clears tracked state,
including when the *current* incident has since moved to a different
mode/location.

## Rollback

Deleting `runtime/stuck_escalation.json` forgets all tracked incidents —
the next stalled tick re-derives `firstStalledAt` from wq#671's own
`lastAdvanceAt` and either finds the existing open ticket via the marker
scan or, worst case, refiles one that `wq add`'s duplicate guard immediately
catches. No history is lost from the work queue itself, only from this
module's own "have I already paged for this" memory. Stopping/disabling the
timer costs nothing — every component script is safe to run standalone or
not at all.
