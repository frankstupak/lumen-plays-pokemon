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


def stalled(mode, location, story=10, badges=1, events=37, last_advance="2026-08-16T00:38:24Z",
            frozen_h=43.0):
    return {"ok": True, "stalled": True, "mode": mode, "modeLocation": location,
            "storyScore": story, "badges": badges, "eventFlags": events,
            "lastAdvanceAt": last_advance, "frozenHours": frozen_h, "map": location,
            # wq#1097: per-axis freshness. Every axis is flat in this fixture,
            # so all three read frozen and the two clocks agree.
            "storyStalledSince": last_advance, "storyFrozenHours": frozen_h,
            "frozenAxes": ["story_score", "badges", "event_flags"]}


def healthy(story=11, badges=1, events=38):
    return {"ok": True, "stalled": False, "mode": None, "modeLocation": None,
            "storyScore": story, "badges": badges, "eventFlags": events, "map": 3}


H_MS = 3_600_000
T0 = int(F._parse_iso_ms("2026-08-16T00:38:24Z"))


# ── 1. no ticket while K is not yet exhausted ──────────────────────────────
print("\n-- gating on K exhaustion --")
wq, ntfy = FakeWQ(), FakeNtfy()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + 1 * H_MS)
ok("attempt 1 does not file a ticket", result["filed"] is None, result)
ok("wq is never called before exhaustion", wq.calls == [], wq.calls)

# ── 2. K=3 exhausted -> files exactly ONE ticket ───────────────────────────
print("\n-- files on exhaustion --")
wq, ntfy = FakeWQ(), FakeNtfy()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
for i in range(1, 4):
    result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                           escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + i * H_MS)
    ok(f"attempt {i}/3 does not file yet", result["filed"] is None, result)
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + 4 * H_MS)
ok("4th (exhausted) call files a ticket", result["filed"] is not None and result["filed"]["action"] == "filed",
   result)
ok("exactly one ticket exists", len(wq.tickets) == 1, wq.tickets)
ticket_id = result["filed"]["ticketId"]
ok("ticket detail carries the mode", "mode=FIGHT_LOSS_LOOP" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])
ok("ticket detail carries a proposed-resolution", "proposed-resolution:" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])
ok("incident is now tracked", "FIGHT_LOSS_LOOP@65" in escal["incidents"], escal["incidents"])

# repeat exhaustion (K refills after resolve_pending marks the old 3 attempts
# 'superseded' via a fresh decide() cycle is out of scope here — this tests
# the DEDUP path directly: calling maybe_file_or_append again for a location
# already tracked must APPEND, never add a second ticket.
#
# wq#1097 put a cooldown on identical repeats, so this clock is past
# APPEND_COOLDOWN_H; verify_1097.py owns the suppression half of that contract.
before_calls = len(wq.calls)
r2 = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                             stalled("FIGHT_LOSS_LOOP", 65), log, wq,
                             T0 + int(4 + F.APPEND_COOLDOWN_H + 1) * H_MS)
ok("repeat exhaustion appends, does not add a new ticket", r2["action"] == "appended" and r2["ticketId"] == ticket_id, r2)
ok("still exactly one ticket after the repeat", len(wq.tickets) == 1, wq.tickets)
ok("appended detail contains a REPEAT marker", "REPEAT" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])

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
wq, ntfy = FakeWQ(), FakeNtfy()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
STEP = H_MS // 6  # 10 minutes
for i in range(1, 4):
    _, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                      escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + i * STEP)
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + 4 * STEP)
ok("ticket is filed by the 4th (exhausted) call, well under 3h", result["filed"] is not None, result)
ticket_id_4 = result["filed"]["ticketId"]
ok("ntfy not sent before 3h have elapsed since firstStalledAt", result["ntfy"] is None, result)
ok("no ntfy calls yet", ntfy.calls == [], ntfy.calls)

result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + 3 * 60 * 60_000 + 4 * STEP)
ok("ntfy fires once past the 3h mark", result["ntfy"] is not None and result["ntfy"]["sent"], result)
ok("ntfy called with -p high", "-p" in ntfy.calls[-1] and ntfy.calls[-1][ntfy.calls[-1].index("-p") + 1] == "high",
   ntfy.calls[-1])
ok("ntfy message includes the ticket id", f"wq#{ticket_id_4}" in result["ntfy"]["message"],
   result["ntfy"]["message"])

# a later poll, still stalled, still past 3h -> NOT sent again
calls_before = len(ntfy.calls)
result, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + 3 * 60 * 60_000 + 10 * STEP)
ok("ntfy is NOT sent a second time for the same incident", len(ntfy.calls) == calls_before, ntfy.calls)
ok("run() reports no new ntfy on the repeat poll", result["ntfy"] is None, result)

# ── 5. auto-resolve on story advance closes the ticket, evidence attached ──
print("\n-- auto-resolve on advance --")
wq, ntfy = FakeWQ(), FakeNtfy()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
for i in range(1, 5):
    _, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65, story=10), intervention_log=log,
                      escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + i * H_MS)
tracked_id = escal["incidents"]["FIGHT_LOSS_LOOP@65"]["ticketId"]
ok("ticket open before the advance", wq.tickets[tracked_id]["status"] == "open")

result, escal = F.run(state=healthy(story=12, badges=1, events=38), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + 6 * H_MS)
ok("advance is reported as resolved", len(result["resolved"]) == 1 and result["resolved"][0]["ticketId"] == tracked_id,
   result)
ok("the ticket is actually marked done", wq.tickets[tracked_id]["status"] == "done", wq.tickets[tracked_id])
ok("incident dropped from tracked state", "FIGHT_LOSS_LOOP@65" not in escal["incidents"], escal["incidents"])
done_call = [c for c in wq.calls if c[0] == "done"][0]
ok("done call carries advance evidence in --notes", "storyScore 10->12" in done_call[done_call.index("--notes") + 1],
   done_call)

# resolution also fires even if the CURRENT mode/location has moved on
# entirely (not just when it returns to healthy at the same spot)
wq, ntfy = FakeWQ(), FakeNtfy()
log = {"v": 1, "attempts": []}
escal = {"v": 1, "incidents": {}}
for i in range(1, 5):
    _, escal = F.run(state=stalled("FIGHT_LOSS_LOOP", 65, story=10), intervention_log=log,
                      escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + i * H_MS)
result, escal = F.run(state=stalled("NAV_LOOP", 59, story=13), intervention_log=log,
                       escal=escal, wq_call=wq, ntfy_call=ntfy, now_ms=T0 + 6 * H_MS)
ok("advance resolves the OLD incident even while a NEW one is stalled",
   any(r["locationKey"] == "FIGHT_LOSS_LOOP@65" for r in result["resolved"]), result)

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
