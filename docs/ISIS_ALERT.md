# The critical page has a reader now (wq#2389)

## The hole

`tool_call {tool:"isis_alert", level:"critical"}` is the most serious line this
process can produce. Two places emit it:

- `src/brain.ts` `trackPrimaryFail()` — the primary model has not served
  `CFG.brain.primaryFailThreshold` turns inside `primaryFailWindowMs` (fails and
  breaker/dead-rung skips both count, wq#1584).
- `src/live_agent.ts` — `deadCycles >= DEAD_CYCLE_ALERT`: the agent has rebooted
  that many times without playing a single turn (wq#1578).

Both wrote the event to the bus and a `CRITICAL:` line to stderr, and that was
the end of it. A grep across `src`, `tools`, `ops`, `/home/lumen/bin`, the
foreman harness and `kb` found **zero** readers of either: `events/*.jsonl` has
no watcher, the unit journal has no alerting tail, and the fleet's existing
pagers (`litellm-auth-alert`, `spend-alert.py`, `alert-deadman-beat.sh`) each
watch their own subsystem and none of them reads an LPP event log. wq#1584 made
the page able to fire into a room with nobody in it.

## The path

```
brain.ts / live_agent.ts  --emit-->  EventBus  --+--> events/*.jsonl
                                                 |
                                                 +--> src/isis_page.ts (attached
                                                      once, live_agent.ts:124)
                                                        |
                                                        +--> /home/lumen/bin/ntfy-send
                                                        |      -p high -t lumen-fleet
                                                        +--> tool_call isis_page
                                                             {ok, rc, key, alert}
                                                             back onto the bus

events/*.jsonl  --every 15min-->  tools/lpp_isis_audit.py --send
   (alert with no isis_page receipt behind it)  -->  ntfy-send
```

`ntfy-send` is the delivery path on purpose: it is the publisher
`alert-deadman-beat.sh` proves healthy before it beats the off-fleet dead man's
switch, and the one chokepoint where the fleet alert gate (operator silences and
burst grouping, `aq_gate.py`) applies. Priority is `high`, matching
`tools/lpp_stuck_feedback.py`'s 3h stall page — `urgent` is the priority
ntfy-send escalates out-of-band, which is more than a dead game run is worth.
`LPP_ISIS_PRIORITY`, `LPP_NTFY_TOPIC` and `LPP_NTFY_BIN` override it.

The `isis_page` receipt carries `ok`/`rc` and **not** the publisher's own
output. `stream.ts` renders every event's JSON into the public kiosk feed
(`stream.ts:121`), and ntfy-send's failure text quotes the command line, fleet
topic included — not a credential, but a publish target for Frank's phone and no
business of a public stream. The full text goes to stderr and therefore the unit
journal, next to the rest of this incident class (wq#1578).

### Dedup

One page per key per run, where the key is the producer plus the alert text with
digit runs collapsed to `#`. Not the raw text: live_agent re-emits the dead-loop
alert on **every** reboot past the threshold, and that text carries the cycle
count and the backoff seconds, so exact-text dedup would page once per reboot —
a page storm at the moment the loop is spinning fastest. `brain.ts` latches its
own alert per outage; the key makes both producers safe without either knowing
that a pager exists.

A publish that FAILS releases the key. A page that did not leave the box is not
a page, so the next identical alert retries instead of the run going quiet on
the strength of a delivery that never happened.

### Why in-process, and what audits it

The pager lives inside the process the alert is about, which is the right place
to page from (no install step, no polling delay, and the producers are already
there) and the wrong place to audit from: if ntfy was down for the minute it
tried, or the process died between the alert and the publish, the only surviving
record is the event log.

`tools/lpp_isis_audit.py` is the out-of-process half. It reads `events/*.jsonl`,
pairs every critical `isis_alert` with the `isis_page {ok:true}` that followed
it in the same run (`-pN` rotations are the same run), and reports every alert
nothing delivered:

```
tools/lpp_isis_audit.py                 # report; exit 1 if anything is unpaged
tools/lpp_isis_audit.py --send          # ...and replay those pages through ntfy-send
tools/lpp_isis_audit.py --json --since-hours 72
```

`--send` records what it sent to `runtime/isis_audit.jsonl` (runtime/, not
events/, because `retainEventLogs()` sweeps `events/*.jsonl` at every service
boot and would eventually delete the dedup state) and reads that file back on
every run, so a replay never double-pages; a failed replay is recorded
as unsent and stays red for the next run to retry. Alerts younger than
`LPP_ISIS_SETTLE_SEC` (120s) are left alone — the live pager may still have a
publish in flight. `--max-send` (default 3) bounds a backlog: a run that died
with a queue of alerts is one incident, not N reasons to buzz a phone.

It is read-only without `--send`, so it is safe to run at any time.

### The sweep, and why the audit is not optional

`startUnpagedSweep()` (same module, started once by `live_agent.ts`) runs
`lpp_isis_audit.py --send --quiet --since-hours 6 --max-send 1` every
`LPP_ISIS_SWEEP_MS` (15 min; `0` disables). This is not belt-and-braces, it
covers a hole the inline pager structurally cannot:

`brain.ts` **latches** its alert for the whole outage (`st.alerted` stays true
until the primary serves a turn again). So if the one publish of that page lost
a race with a 30-second ntfy hiccup, nothing re-emits it and the outage runs to
its end unpaged — wq#1578's 14 invisible hours, reproduced through a healthy
alert path. The sweep is the retry the producer cannot perform for itself, and
it also picks up pages a previous run died holding.

It is bounded by construction: one page per sweep, deduped against the receipts
and `runtime/isis_audit.jsonl`, nothing younger than the settle window, exit 1
("still unpaged") treated as the next sweep's job rather than an error. A sweep
that finds nothing costs one short-lived process and pages nobody.

## Probes

- `src/probe_isis2389.ts` (pure; in `scripts/probes-pure.sh`): asserts the argv
  the pager hands ntfy-send, one page per outage, a dead loop paging once rather
  than once per reboot, non-critical events staying off the pager, the publisher
  output staying off the bus and on stderr, a failed publish not latching and
  retrying on the next alert, a missing ntfy binary failing loudly instead of
  throwing into the turn loop, and the sweep's invocation. `LPP_NTFY_BIN` and
  `LPP_ISIS_AUDIT_BIN` point at throwaway recorders — no real publish.
- `tools/test_isis2389.py` (in `scripts/probes-stuck.sh`): the audit against a
  scratch events dir — key parity with the TypeScript pager byte for byte,
  rotation vs. a genuinely new run, the settle window, replay dedup, a failed
  replay staying red, and the exit codes.
