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

## How a directive stops being one (wq#1840)

`runtime/supervisor_directive.json` is written here and consumed in
`src/agent.ts`: `gotoBan` refuses `enter_warp` targets, `notepadPin` is the
`!!` line of every overworld state block. Until wq#1840 both cleared on **one**
condition — `storyScore`/`badgeCount`/`eventCount` rising past the baseline
captured when the directive loaded.

That is unsound for the directive class this supervisor mostly writes, because
a stuck-remedy pin's exit condition *is* the story advance it is failing to
produce. Measured: `FIGHT_LOSS_LOOP@3`, `generatedAt 2026-08-29T16:44:34Z`,
attempt 3/3, still in the prompt on 2026-09-12 with `storyScore` stuck at 10
since 09-02 — fourteen days of ordering grass-pacing on Route 24, while
wq#1731's escape walked the agent out of that grass and wq#1828's exclusion
refused `goto` back in, and wq#1829 measured $96 and zero balls against a $200
ball, so the catch it demanded was unaffordable too.

`src/pin.ts` gives a directive the three shapes every other harness override
already has (cf. wq#1181's ledger, wq#1828's exclusion):

- **Retire on age.** `LPP_PIN_MAX_HOURS` (6) from `generatedAt`, story advance
  or not, and it retires the **whole** artifact — pin *and* bans, which share
  one stamp and one K-attempt ladder. This cannot cut an escalation short: a
  supervisor that still believes the stall rewrites the file (the `WARP_OSC@36`
  attempts in `runtime/intervention_log.json` are 1837s apart), and a rewrite
  resets the clock. Nothing rewrites a ladder that has finished at K/K.
  `LPP_PIN_MAX_TURNS` (300) is the fallback for a file with no parseable stamp;
  it cannot be primary, because `live_agent` builds a fresh `Agent` on every
  continue and the turn counter restarts with it.
- **Suppress on contradiction.** A pin ordering a CATCH while the bag holds
  zero balls and the purse cannot buy one is withheld for the turn, replaced by
  one line naming both numbers. It returns by itself the moment the money does.
  `LPP_PIN_CONTRADICTION=0` reverts.
- **Qualify, don't contradict.** A pin ordering the agent into tall grass while
  a wq#1828 exclusion is live gets the excluded patch, its map and its expiry
  appended — "grass, but not *that* grass" — instead of two harness voices
  arguing. The rest of the pin is untouched.

Events: `supervisor_directive_expired` (with `atBoot` — an already-dead
directive never reaches the prompt even once), and
`supervisor_pin_suppressed`/`_restored` on the rising edge only.

Verification: `npx tsx src/probe_pin1840.ts` — **29/29**, pure, driven off the
live `FIGHT_LOSS_LOOP` prescription text and the `WARP_OSC@36` pin that was on
disk on 2026-09-12.

## Rollback

Deleting `runtime/stuck_escalation.json` forgets all tracked incidents —
the next stalled tick re-derives `firstStalledAt` from wq#671's own
`lastAdvanceAt` and either finds the existing open ticket via the marker
scan or, worst case, refiles one that `wq add`'s duplicate guard immediately
catches. No history is lost from the work queue itself, only from this
module's own "have I already paged for this" memory. Stopping/disabling the
timer costs nothing — every component script is safe to run standalone or
not at all.
