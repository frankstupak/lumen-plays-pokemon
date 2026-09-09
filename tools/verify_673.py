#!/usr/bin/env python3
"""verify_673 — offline proof for the wq#673 auto-ticket + 3h escalation loop
(tools/lpp_stuck_feedback.py).

Run:  python3 tools/verify_673.py
No service, no network, no real wq/ntfy calls, no writes outside this
process's memory — `wq_call`/`ntfy_call` are injected fakes (a FakeWQ that
emulates enough of the real CLI's add/list/show/edit/done contract,
including its own exact-title duplicate guard, to prove the dedup/append
logic against the SAME text format the real `wq` binary prints) and every
test passes its own `state`/`escal` dicts, mirroring verify_672.py's pattern
of never touching real runtime/*.json.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_feedback as F
import lpp_stuck_intervene as I

PASS = FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}{('  ' + str(detail)) if detail else ''}")


class FakeWQ:
    """Emulates just enough of /home/lumen/bin/wq's add/list/show/edit/done
    output format (confirmed against the real script's cmd_add/cmd_list/
    cmd_show/cmd_edit source) to prove lpp_stuck_feedback's parsing against
    it, without touching the real work-queue database."""
    def __init__(self, next_id=700):
        self.next_id = next_id
        self.tickets = {}
        self.calls = []

    def __call__(self, args):
        self.calls.append(list(args))
        cmd = args[0]
        if cmd == "add":
            title = args[args.index("--title") + 1]
            detail = args[args.index("--detail") + 1]
            for tid, t in self.tickets.items():
                if t["status"] != "done" and t["title"] == title:
                    return (f"DUPLICATE — task {tid} [pokemon/open] already has this title:\n"
                            f"  {title}\nUse --force to add anyway.")
            tid = self.next_id
            self.next_id += 1
            self.tickets[tid] = {"title": title, "detail": detail, "status": "open"}
            return f"added task {tid} [pokemon]"
        if cmd == "list":
            lines = []
            for tid, t in self.tickets.items():
                if t["status"] == "open":
                    lines.append(f"[{tid:>3}] pokemon p1 open     {t['title'][:66]}")
            return "\n".join(lines) if lines else "(empty)"
        if cmd == "show":
            tid = int(args[1])
            t = self.tickets.get(tid)
            return f"detail       : {t['detail']}" if t else "no such task"
        if cmd == "edit":
            tid = int(args[1])
            self.tickets[tid]["detail"] = args[args.index("--detail") + 1]
            return f"edited {tid}: detail"
        if cmd == "done":
            tid = int(args[1])
            self.tickets[tid]["status"] = "done"
            return f"done {tid}"
        raise AssertionError(f"unexpected wq call: {args}")


class FakeNtfy:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def __call__(self, args):
        self.calls.append(list(args))
        return 1 if self.fail else 0


class FakeAQ:
    """Emulates aq's own ingest() upsert contract (source,key) — confirmed
    against /home/lumen/bin/aq's ingest(): an OPEN row with the same
    (source,key) is bumped (count,last_ts,message) instead of duplicated;
    `resolve` flips status so a later `add` with the same key opens a fresh
    row rather than reopening the old one (matches aq's own WHERE
    status='open' lookup)."""
    def __init__(self, next_id=500):
        self.next_id = next_id
        self.rows = {}
        self.calls = []

    def __call__(self, args):
        self.calls.append(list(args))
        cmd = args[0]
        if cmd == "add":
            _source, key, title, message = args[1], args[2], args[3], args[4] if len(args) > 4 else ""
            for rid, r in self.rows.items():
                if r["key"] == key and r["status"] == "open":
                    r["count"] += 1
                    r["message"] = message
                    return f"queued id={rid}"
            rid = self.next_id
            self.next_id += 1
            self.rows[rid] = {"key": key, "title": title, "message": message, "count": 1, "status": "open"}
            return f"queued id={rid}"
        if cmd == "resolve":
            rid = int(args[1])
            self.rows[rid]["status"] = "resolved"
            return "resolved"
        raise AssertionError(f"unexpected aq call: {args}")


def stalled(mode, location, story=10, badges=1, events=37, last_advance="2026-08-16T00:38:24Z",
            frozen_h=43.0):
    return {"ok": True, "stalled": True, "mode": mode, "modeLocation": location,
            "storyScore": story, "badges": badges, "eventFlags": events,
            "lastAdvanceAt": last_advance, "frozenHours": frozen_h, "map": location}


def healthy(story=11, badges=1, events=38):
    return {"ok": True, "stalled": False, "mode": None, "modeLocation": None,
            "storyScore": story, "badges": badges, "eventFlags": events, "map": 3}


H_MS = 3_600_000
T0 = int(F._parse_iso_ms("2026-08-16T00:38:24Z"))


# ── 1. no ticket while K is not yet exhausted ──────────────────────────────
print("\n-- gating on K exhaustion --")
wq, ntfy, aq = FakeWQ(), FakeNtfy(), FakeAQ()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 1 * H_MS)
ok("attempt 1 does not file a ticket", result["filed"] is None, result)
ok("wq is never called before exhaustion", wq.calls == [], wq.calls)

# ── 2. K=3 exhausted -> files exactly ONE ticket ───────────────────────────
print("\n-- files on exhaustion --")
wq, ntfy, aq = FakeWQ(), FakeNtfy(), FakeAQ()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
for i in range(1, 4):
    result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                           escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + i * H_MS)
    ok(f"attempt {i}/3 does not file yet", result["filed"] is None, result)
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 4 * H_MS)
ok("4th (exhausted) call files a ticket", result["filed"] is not None and result["filed"]["action"] == "filed",
   result)
ok("exactly one ticket exists", len(wq.tickets) == 1, wq.tickets)
ticket_id = result["filed"]["ticketId"]
ok("ticket detail carries the mode", "mode=FIGHT_LOSS_LOOP" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])
ok("ticket detail carries a proposed-resolution", "proposed-resolution:" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])
ok("incident is now tracked", "FIGHT_LOSS_LOOP@65" in escal["incidents"], escal["incidents"])

# repeat exhaustion for a location already tracked must never add a second
# ticket. wq#1162 splits that into two cases: a poll that would restate the
# ticket verbatim is dropped, and a poll carrying new facts appends.
r2 = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                             stalled("FIGHT_LOSS_LOOP", 65, frozen_h=44.0), log, wq, T0 + 5 * H_MS)
ok("a repeat with nothing new is dropped, not appended", r2["action"] == "unchanged", r2)
ok("the dropped repeat writes no REPEAT block", "REPEAT" not in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])
ok("a longer frozen= alone is not new information",
   "frozen=44.0h" not in wq.tickets[ticket_id]["detail"], wq.tickets[ticket_id]["detail"])

# ...but the freeze clock restarting IS new information, and so is a changed
# counter: both mean the incident's facts moved even though it stayed stuck.
r2b = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                              stalled("FIGHT_LOSS_LOOP", 65, events=48,
                                      last_advance="2026-08-16T04:00:00Z", frozen_h=2.4),
                              log, wq, T0 + 6 * H_MS)
ok("a repeat carrying new facts appends", r2b["action"] == "appended" and r2b["ticketId"] == ticket_id, r2b)
ok("still exactly one ticket after the repeat", len(wq.tickets) == 1, wq.tickets)
ok("appended detail contains a REPEAT marker", "REPEAT" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])
ok("the appended block carries the new counter", "eventFlags=48" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])

# and the SAME facts a third time go quiet again — one append per change, not
# one per poll, which is the wq#1162 REPEAT storm this guard exists to stop.
edits_before = len([c for c in wq.calls if c[0] == "edit"])
for i in range(4):
    F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                           stalled("FIGHT_LOSS_LOOP", 65, events=48,
                                   last_advance="2026-08-16T04:00:00Z", frozen_h=2.9 + i),
                           log, wq, T0 + (7 + i) * H_MS)
ok("four further polls of an unchanged stall write nothing",
   len([c for c in wq.calls if c[0] == "edit"]) == edits_before,
   [c for c in wq.calls if c[0] == "edit"])

# ── 2b. wq#1562: aq row opens on exhaustion and REFRESHES every poll, even
#      the ones above that the wq-ticket path just dropped as "unchanged" —
#      that silence is exactly what let FIGHT_LOSS_LOOP@3 tick-loop 167.9h.
print("\n-- aq: opens on exhaustion, refreshes (not dupes) on every later poll --")
ok("exactly one aq row for the incident", len(aq.rows) == 1, aq.rows)
aq_id = next(iter(aq.rows))
ok("aq row key is stuck:<mode>@<loc>", aq.rows[aq_id]["key"] == "stuck:FIGHT_LOSS_LOOP@65", aq.rows[aq_id])
count_before = aq.rows[aq_id]["count"]
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65, events=48,
                                     last_advance="2026-08-16T04:00:00Z", frozen_h=3.5),
                       intervention_log=log, escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq,
                       now_ms=T0 + 11 * H_MS)
ok("run() reports the aq refresh", result["aq"] is not None and result["aq"]["aqId"] == aq_id, result["aq"])
ok("still exactly one aq row (bumped, not duplicated)", len(aq.rows) == 1, aq.rows)
ok("the row's count went up on the unchanged-wq-ticket poll",
   aq.rows[aq_id]["count"] == count_before + 1, aq.rows[aq_id])

# ── 3. race backstop: wq add's OWN duplicate guard is honoured too ─────────
print("\n-- wq add's own duplicate guard as a backstop --")
wq2 = FakeWQ()
title = "[lpp][stuck] NAV_LOOP@59 — NAV_LOOP unresolved after K interventions"
wq2.tickets[900] = {"title": title, "detail": "mode=NAV_LOOP location=59 pre-existing", "status": "open"}
escal2 = {"v": 1, "incidents": {}}
r3 = F.maybe_file_or_append(escal2, "NAV_LOOP", "NAV_LOOP@59", 59, stalled("NAV_LOOP", 59), log, wq2, T0)
ok("DUPLICATE response is treated as append, not a crash", r3["action"] == "appended" and r3["ticketId"] == 900, r3)
ok("no second ticket created", len(wq2.tickets) == 1, wq2.tickets)

# ── 4. ntfy fires exactly once, only at/after the 3h mark ─────────────────
# firstStalledAt is pinned to the INCIDENT's own lastAdvanceAt (T0), not to
# "when this script first polled" or "when the ticket got filed" -- so K's 3
# attempts are spaced 10 minutes apart here (well inside 3h) to isolate
# "ticket exists but 3h hasn't elapsed YET" from "3h has now elapsed" as two
# genuinely distinct moments, matching how a 2h-windowed stall (wq#671) would
# actually reach K=3 in production long before the 3h escalation mark.
print("\n-- 3h escalation, fires once --")
wq, ntfy, aq = FakeWQ(), FakeNtfy(), FakeAQ()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
STEP = H_MS // 6  # 10 minutes
for i in range(1, 4):
    _, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                      escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + i * STEP)
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 4 * STEP)
ok("ticket is filed by the 4th (exhausted) call, well under 3h", result["filed"] is not None, result)
ticket_id_4 = result["filed"]["ticketId"]
ok("ntfy not sent before 3h have elapsed since firstStalledAt", result["ntfy"] is None, result)
ok("no ntfy calls yet", ntfy.calls == [], ntfy.calls)

result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 3 * 60 * 60_000 + 4 * STEP)
ok("ntfy fires once past the 3h mark", result["ntfy"] is not None and result["ntfy"]["sent"], result)
ok("ntfy called with -p high", "-p" in ntfy.calls[-1] and ntfy.calls[-1][ntfy.calls[-1].index("-p") + 1] == "high",
   ntfy.calls[-1])
ok("ntfy message includes the ticket id", f"wq#{ticket_id_4}" in result["ntfy"]["message"],
   result["ntfy"]["message"])

# a later poll, still stalled, still past 3h -> NOT sent again
calls_before = len(ntfy.calls)
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 3 * 60 * 60_000 + 10 * STEP)
ok("ntfy is NOT sent a second time for the same incident", len(ntfy.calls) == calls_before, ntfy.calls)
ok("run() reports no new ntfy on the repeat poll", result["ntfy"] is None, result)

# ── 5. auto-resolve on story advance closes the ticket, evidence attached ──
print("\n-- auto-resolve on advance --")
wq, ntfy, aq = FakeWQ(), FakeNtfy(), FakeAQ()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
for i in range(1, 5):
    _, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65, story=10), intervention_log=log,
                      escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + i * H_MS)
tracked_id = escal["incidents"]["FIGHT_LOSS_LOOP@65"]["ticketId"]
tracked_aq_id = escal["incidents"]["FIGHT_LOSS_LOOP@65"]["aqId"]
ok("ticket open before the advance", wq.tickets[tracked_id]["status"] == "open")
ok("aq row open before the advance", aq.rows[tracked_aq_id]["status"] == "open")

result, escal = F.run(state=healthy(story=12, badges=1, events=38), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 6 * H_MS)
ok("advance is reported as resolved", len(result["resolved"]) == 1 and result["resolved"][0]["ticketId"] == tracked_id,
   result)
ok("the ticket is actually marked done", wq.tickets[tracked_id]["status"] == "done", wq.tickets[tracked_id])
ok("the aq row is also resolved", aq.rows[tracked_aq_id]["status"] == "resolved", aq.rows[tracked_aq_id])
ok("incident dropped from tracked state", "FIGHT_LOSS_LOOP@65" not in escal["incidents"], escal["incidents"])
done_call = [c for c in wq.calls if c[0] == "done"][0]
ok("done call carries advance evidence in --notes", "storyScore 10->12" in done_call[done_call.index("--notes") + 1],
   done_call)

# resolution also fires even if the CURRENT mode/location has moved on
# entirely (not just when it returns to healthy at the same spot)
wq, ntfy, aq = FakeWQ(), FakeNtfy(), FakeAQ()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
for i in range(1, 5):
    _, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65, story=10), intervention_log=log,
                      escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + i * H_MS)
result, escal = F.run(state=stalled("NAV_LOOP", 59, story=13), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 6 * H_MS)
ok("advance resolves the OLD incident even while a NEW one is stalled",
   any(r["locationKey"] == "FIGHT_LOSS_LOOP@65" for r in result["resolved"]), result)

# ── 6. wq#1162: the incident stalled RIGHT NOW is never auto-resolved ──────
#      The baseline test is the same three-counter comparison wq#672's
#      resolve_pending used to misread. A partial tick (eventFlags 37->48 with
#      story_score frozen) clears the baseline while the agent is still losing
#      the same fight in the same room; closing the ticket there retracts an
#      escalation the classifier is reporting live in the very same call.
print("\n-- wq#1162: no auto-resolve while the key is still the live stall --")
wq, ntfy, aq = FakeWQ(), FakeNtfy(), FakeAQ()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
for i in range(1, 5):
    _, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65, story=10, events=37),
                      intervention_log=log, escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq,
                      now_ms=T0 + i * H_MS)
live_id = escal["incidents"]["FIGHT_LOSS_LOOP@65"]["ticketId"]
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65, story=10, events=48),
                       intervention_log=log, escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq,
                       now_ms=T0 + 5 * H_MS)
ok("a mid-stall counter tick resolves nothing", result["resolved"] == [], result)
ok("the ticket stays open", wq.tickets[live_id]["status"] == "open", wq.tickets[live_id])
ok("the incident stays tracked", "FIGHT_LOSS_LOOP@65" in escal["incidents"], escal["incidents"])

# the same counters, once the stall itself is over, DO resolve it
result, escal = F.run(state=healthy(story=10, badges=1, events=48), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, aq_call=aq, now_ms=T0 + 6 * H_MS)
ok("the same advance resolves it once the stall clears",
   len(result["resolved"]) == 1 and result["resolved"][0]["ticketId"] == live_id, result)
ok("and the ticket is marked done", wq.tickets[live_id]["status"] == "done", wq.tickets[live_id])

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
