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
            # The real CLI filters on --status and truncates the title column;
            # both matter here (wq#1097 turned on a multi-status scan, and the
            # marker has to survive the truncation for dedup to see it).
            want = args[args.index("--status") + 1] if "--status" in args else None
            lines = []
            for tid, t in self.tickets.items():
                if want is not None and t["status"] != want:
                    continue
                lines.append(f"[{tid:>3}] pokemon p1 {t['status']:<8} {t['title'][:66]}")
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
            "lastAdvanceAt": last_advance, "frozenHours": frozen_h, "map": location}


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
# already tracked must never add a second ticket. wq#1097: an UNCHANGED repeat
# inside the heartbeat window is suppressed outright rather than appended.
r2 = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                             stalled("FIGHT_LOSS_LOOP", 65), log, wq, T0 + 5 * H_MS)
ok("unchanged repeat is suppressed, not appended", r2["action"] == "unchanged" and r2["ticketId"] == ticket_id, r2)
ok("still exactly one ticket after the repeat", len(wq.tickets) == 1, wq.tickets)
ok("suppressed repeat writes nothing at all", not any(c[0] == "edit" for c in wq.calls), wq.calls)

# a MATERIALLY changed report (event flag moved) appends immediately, and
# carries the suppressed-poll count so the ticket stays honest about the gap
r3 = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                             stalled("FIGHT_LOSS_LOOP", 65, events=38), log, wq, T0 + 6 * H_MS)
ok("a materially changed report appends", r3["action"] == "appended", r3)
ok("appended detail contains a REPEAT marker", "REPEAT" in wq.tickets[ticket_id]["detail"],
   wq.tickets[ticket_id]["detail"])
ok("the suppressed poll is counted in the block that lands",
   "+1 identical poll(s) suppressed" in wq.tickets[ticket_id]["detail"], wq.tickets[ticket_id]["detail"])
ok("suppression counter resets after an append",
   escal["incidents"]["FIGHT_LOSS_LOOP@65"]["suppressedRepeats"] == 0, escal["incidents"])

# ...and an unchanged report still lands one heartbeat block past the interval
edits_before = len([c for c in wq.calls if c[0] == "edit"])
F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                       stalled("FIGHT_LOSS_LOOP", 65, events=38), log, wq,
                       T0 + 6 * H_MS + int(F.REPEAT_MIN_INTERVAL_H * H_MS) - 1)
ok("no heartbeat block just inside REPEAT_MIN_INTERVAL_H",
   len([c for c in wq.calls if c[0] == "edit"]) == edits_before, wq.calls)
r4 = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", 65,
                            stalled("FIGHT_LOSS_LOOP", 65, events=38), log, wq,
                            T0 + 6 * H_MS + int(F.REPEAT_MIN_INTERVAL_H * H_MS))
ok("an unchanged report still heartbeats once past REPEAT_MIN_INTERVAL_H",
   r4["action"] == "appended", r4)

# ── 2b. a CLAIMED ticket is still the incident's ticket (wq#1097) ──────────
print("\n-- dedup spans every live status, not just open --")
for status in F.LIVE_STATUSES:
    wq_s = FakeWQ()
    title_s = "[lpp][stuck] FIGHT_LOSS_LOOP@3 — FIGHT_LOSS_LOOP unresolved after K interventions"
    wq_s.tickets[910] = {"title": title_s, "detail": "first observation", "status": status}
    escal_s = {"v": 1, "incidents": {}}
    r = F.maybe_file_or_append(escal_s, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@3", 3,
                               stalled("FIGHT_LOSS_LOOP", 3), {"v": 1, "attempts": []}, wq_s, T0)
    ok(f"a {status} ticket is appended to, not duplicated",
       r["action"] == "appended" and r["ticketId"] == 910 and len(wq_s.tickets) == 1, (status, r, wq_s.tickets))

# a CLOSED ticket does not block a fresh filing, but is named in the new one —
# this is the wq#1091 -> wq#1097 recurrence, which filed a verbatim duplicate
# carrying no pointer back to the PR the first ticket had already landed.
wq_c = FakeWQ()
title_c = "[lpp][stuck] FIGHT_LOSS_LOOP@3 — FIGHT_LOSS_LOOP unresolved after K interventions"
wq_c.tickets[1091] = {"title": title_c, "detail": "first round", "status": "done"}
escal_c = {"v": 1, "incidents": {}}
r5 = F.maybe_file_or_append(escal_c, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@3", 3,
                            stalled("FIGHT_LOSS_LOOP", 3), {"v": 1, "attempts": []}, wq_c, T0)
ok("a recurrence after a close files a new ticket", r5["action"] == "filed" and r5["ticketId"] != 1091, r5)
ok("the new ticket names the closed prior ticket",
   "prior-tickets: wq#1091" in wq_c.tickets[r5["ticketId"]]["detail"],
   wq_c.tickets[r5["ticketId"]]["detail"])

# ── 2c. the stored detail is capped however long the incident runs ─────────
print("\n-- detail stays bounded --")
wq_b = FakeWQ()
escal_b = {"v": 1, "incidents": {}}
r6 = F.maybe_file_or_append(escal_b, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@3", 3,
                            stalled("FIGHT_LOSS_LOOP", 3), {"v": 1, "attempts": []}, wq_b, T0)
bounded_id = r6["ticketId"]
# 200 polls a day apart: every one is materially different (the event flag
# moves) so every one appends — the worst case the cap exists for.
for i in range(1, 201):
    F.maybe_file_or_append(escal_b, "FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@3", 3,
                           stalled("FIGHT_LOSS_LOOP", 3, events=37 + i), {"v": 1, "attempts": []},
                           wq_b, T0 + i * 24 * H_MS)
grown = wq_b.tickets[bounded_id]["detail"]
ok("detail stays under the cap after 200 appends", len(grown) <= F.MAX_DETAIL_CHARS + 600, len(grown))
ok("the first observation survives the elision", grown.startswith("mode=FIGHT_LOSS_LOOP"), grown[:80])
ok("the elision says how many blocks it dropped", "earlier REPEAT block(s) elided" in grown, grown[:400])
ok("the newest block survives the elision", "eventFlags=237" in grown, grown[-300:])
# elide_detail itself, at the moment it fires: head + exactly KEEP_TAIL_BLOCKS.
# (The integration figure above is larger on purpose — the detail is allowed to
# refill to MAX_DETAIL_CHARS between elisions; only the ceiling is guaranteed.)
long_detail = "FIRST OBSERVATION" + "".join(f"{F.REPEAT_SEP}block {i} " + "x" * 400 for i in range(30))
elided = F.elide_detail(long_detail)
ok("elide_detail keeps exactly KEEP_TAIL_BLOCKS blocks",
   elided.count(F.REPEAT_SEP) == F.KEEP_TAIL_BLOCKS, elided.count(F.REPEAT_SEP))
ok("elide_detail keeps the head block", elided.startswith("FIRST OBSERVATION"), elided[:60])
ok("elide_detail counts what it dropped", f"[{30 - F.KEEP_TAIL_BLOCKS} earlier REPEAT" in elided, elided[:300])
# re-eliding an already-elided detail rewrites the note instead of stacking one
twice = F.elide_detail(elided + "".join(f"{F.REPEAT_SEP}more {i} " + "x" * 400 for i in range(30)))
ok("re-elision rewrites the note rather than stacking notes",
   twice.count("earlier REPEAT block(s) elided") == 1, twice[:400])
ok("re-elision accumulates the dropped count",
   f"[{30 - F.KEEP_TAIL_BLOCKS + 30} earlier REPEAT" in twice, twice[:300])

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
