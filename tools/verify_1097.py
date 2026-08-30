#!/usr/bin/env python3
"""verify_1097 — offline proof that a FIGHT_LOSS_LOOP can no longer be kept
alive forever by event-flag noise (wq#1097).

The incident this pins down: FIGHT_LOSS_LOOP@3 ran for two days with
storyScore=10 and badges=1 the whole time, while the supervisor logged
attempt 1(superseded), 2(advanced), 3(advanced), 2(advanced), 3(advanced),
2, 3 — a K ladder oscillating between 2 and 3, never exhausting, never
returning to 1, and appending 47 byte-identical REPEAT blocks to one ticket.
Every one of those "advanced" outcomes was an eventFlags tick.

Run:  python3 tools/verify_1097.py
Offline: injected state/log/escal dicts and a fake wq, same convention as
verify_672.py and verify_673.py. Touches no runtime/*.json and no network.
"""
import json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_mode as M
import lpp_stuck_intervene as I
import lpp_stuck_feedback as F

PASS = FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}{('  ' + str(detail)) if detail else ''}")


H_MS = 3_600_000
T0 = 1_786_000_000_000
LOC = 3
KEY = f"FIGHT_LOSS_LOOP@{LOC}"


def stalled(story=10, badges=1, events=46, location=LOC):
    return {"ok": True, "stalled": True, "mode": "FIGHT_LOSS_LOOP", "modeLocation": location,
            "storyScore": story, "badges": badges, "eventFlags": events, "map": location,
            "lastAdvanceAt": "2026-08-27T21:52:27Z", "frozenHours": 34.7,
            "storyStalledSince": "2026-08-27T21:52:27Z", "storyFrozenHours": 34.7,
            "frozenAxes": ["story_score", "badges", "event_flags"]}


# ── 1. an eventFlags tick does not refund the K budget ─────────────────────
print("\n-- K budget survives event-flag noise --")
log = {"v": 1, "attempts": []}
for i in range(1, 4):
    I.decide(state=stalled(), log=log, now_ms=T0 + i * H_MS)
ok("three attempts logged", len(log["attempts"]) == 3, log["attempts"])

r = I.decide(state=stalled(), log=log, now_ms=T0 + 4 * H_MS)
ok("4th call is exhausted", r.get("exhausted") is True, r)

# eventFlags 46 -> 47, story axis untouched. This is the exact transition the
# live ticket recorded at 2026-08-29T13:53:09Z.
r = I.decide(state=stalled(events=47), log=log, now_ms=T0 + 5 * H_MS)
ok("flag-only tick leaves the key exhausted", r.get("exhausted") is True, r)
ok("flag-only tick prescribes nothing", r.get("intervened") is not True, r)
ok("no attempt was closed as advanced",
   all(e.get("outcome") != "advanced" for e in log["attempts"]),
   [e.get("outcome") for e in log["attempts"]])
ok("flag-only tick leaves attempts open for a later real advance",
   all(e.get("afterState") is None for e in log["attempts"]),
   [e.get("outcome") for e in log["attempts"]])
ok("budget still reads 3 of 3 spent", I.open_attempt_count(log, KEY, stalled(events=47)) == 3,
   I.open_attempt_count(log, KEY, stalled(events=47)))

# Repeat it — the live loop ticked every ~30 minutes for 25 hours.
for i in range(6, 16):
    I.decide(state=stalled(events=47 + i), log=log, now_ms=T0 + i * H_MS)
ok("ten more flag ticks add no attempts", len(log["attempts"]) == 3, len(log["attempts"]))

# ── 2. a real story advance DOES refund the budget ─────────────────────────
print("\n-- a real advance resets K --")
advanced_state = stalled(story=11, events=60)
was = list(log["attempts"])
r = I.decide(state=advanced_state, log=log, now_ms=T0 + 20 * H_MS)
ok("story advance closes every prior attempt as advanced",
   all(e.get("outcome") == "advanced" for e in was), [e.get("outcome") for e in was])
ok("supervisor may intervene again, from attempt 1",
   r.get("intervened") is True and r["attempt"] == 1, r)

# A badge counts as story progress too.
log2 = {"v": 1, "attempts": []}
I.decide(state=stalled(), log=log2, now_ms=T0)
I.decide(state=stalled(badges=2), log=log2, now_ms=T0 + H_MS)
ok("a badge closes the attempt as advanced", log2["attempts"][0]["outcome"] == "advanced",
   log2["attempts"][0]["outcome"])

# ── 3. a stale superseded attempt no longer occupies a slot forever ────────
print("\n-- superseded attempts expire at the next real advance --")
log3 = {"v": 1, "attempts": []}
I.decide(state=stalled(), log=log3, now_ms=T0)
# agent wanders off to a different mode/location: attempt 1 -> superseded
I.decide(state={"ok": True, "stalled": True, "mode": "NAV_LOOP", "modeLocation": 59,
                "storyScore": 10, "badges": 1, "eventFlags": 46, "map": 59},
         log=log3, now_ms=T0 + H_MS)
ok("attempt 1 is superseded", log3["attempts"][0]["outcome"] == "superseded",
   log3["attempts"][0]["outcome"])
ok("superseded still costs a slot while nothing has advanced",
   I.open_attempt_count(log3, KEY, stalled()) == 1,
   I.open_attempt_count(log3, KEY, stalled()))
# ...then the story genuinely moves and the agent comes back stuck later.
r = I.decide(state=stalled(story=12), log=log3, now_ms=T0 + 2 * H_MS)
ok("after a real advance the key starts clean again",
   r.get("intervened") is True and r["attempt"] == 1, r)

# ── 4. the detector reports per-axis freshness honestly ────────────────────
print("\n-- frozen axes are computed, not asserted --")
NOW = T0 + 42 * H_MS
# storyScore/badges flat across the whole corpus; one event flag at +40h. This
# is the live 46 -> 47 transition that reset a 40h stall clock to 2.9h.
sidecars = [(0, 10, 1, 46), (40, 10, 1, 47), (41.98, 10, 1, 47)]
adv = M.advances([{"ts": int(T0 + h * H_MS), "storyScore": ss, "badges": b, "events": e}
                  for h, ss, b, e in sidecars])
ok("the flag tick is recorded on the event_flags axis only",
   [a["axes"] for a in adv] == [["event_flags"]], [a.get("axes") for a in adv])

d = tempfile.mkdtemp(prefix="verify_1097_")
os.makedirs(f"{d}/checkpoints", exist_ok=True)
for i, (h, ss, b, e) in enumerate(sidecars):
    json.dump({"v": 3, "kind": "periodic", "map": LOC, "x": 19, "y": 18,
               "storyScore": ss, "badges": b, "events": e, "ts": int(T0 + h * H_MS)},
              open(f"{d}/checkpoints/auto-p{i:03d}.json", "w"))
st = M.compute(base=d, now_ms=NOW, warps=[], resume_picks=[], names={})
ok("any-axis clock reads ~2h (the flag tick)", abs(st["frozenHours"] - 2.0) < 0.05,
   st["frozenHours"])
ok("story clock reads ~42h (the real stall)", abs(st["storyFrozenHours"] - 42.0) < 0.05,
   st["storyFrozenHours"])
ok("story_score and badges report as frozen",
   "story_score" in st["frozenAxes"] and "badges" in st["frozenAxes"], st["frozenAxes"])
ok("event_flags does not report as frozen", "event_flags" not in st["frozenAxes"],
   st["frozenAxes"])

# ── 5. the ticket report names the real axes and both clocks ───────────────
print("\n-- the report stops claiming story_score froze 2.9h ago --")
live = dict(stalled(events=47))
live.update({"frozenHours": 2.9, "lastAdvanceAt": "2026-08-29T13:53:09Z",
             "storyFrozenHours": 42.0, "storyStalledSince": "2026-08-27T21:52:27Z",
             "frozenAxes": ["story_score", "badges"]})
rep = F.build_report("FIGHT_LOSS_LOOP", KEY, LOC, live, log, T0)
ok("frozen axes are the computed ones", "frozen_axes=story_score+badges" in rep, rep)
ok("the story clock is reported", "story frozen=42.0h" in rep, rep)
ok("the any-axis clock is reported too", "any-axis frozen=2.9h" in rep, rep)
ok("the hardcoded frozen_axis= claim is gone", "frozen_axis=" not in rep, rep)


class FakeWQ:
    """Minimal wq stand-in: enough of add/list/show/edit/done for the append
    path. verify_673.py owns the full-contract version."""
    def __init__(self, next_id=1200):
        self.next_id = next_id
        self.tickets = {}
        self.calls = []

    def __call__(self, args):
        self.calls.append(list(args))
        cmd = args[0]
        if cmd == "add":
            tid = self.next_id
            self.next_id += 1
            self.tickets[tid] = {"title": args[args.index("--title") + 1],
                                 "detail": args[args.index("--detail") + 1], "status": "open"}
            return f"added task {tid}"
        if cmd == "list":
            return "\n".join(f"{tid} [pokemon/open] {t['title']}"
                             for tid, t in self.tickets.items() if t["status"] != "done")
        if cmd == "show":
            return f"detail: {self.tickets[int(args[1])]['detail']}"
        if cmd == "edit":
            self.tickets[int(args[1])]["detail"] = args[args.index("--detail") + 1]
            return "ok"
        if cmd == "done":
            self.tickets[int(args[1])]["status"] = "done"
            return "ok"
        return ""


# ── 6. an unchanged report is not re-appended every tick ───────────────────
print("\n-- REPEAT appends are bounded --")
wq = FakeWQ()
escal = {"v": 1, "incidents": {}}
first = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", KEY, LOC, live, log, wq, T0)
ok("the incident files one ticket", first["action"] == "filed" and len(wq.tickets) == 1, first)

suppressed = 0
for i in range(1, 11):  # ten supervisor ticks, 30 minutes apart
    r = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", KEY, LOC, live, log, wq,
                               T0 + i * H_MS // 2)
    suppressed += r["action"] == "suppressed"
ok("every identical tick inside the cooldown is suppressed", suppressed == 10, suppressed)
ok("the ticket detail carries no REPEAT block yet",
   "REPEAT" not in wq.tickets[1200]["detail"], wq.tickets[1200]["detail"][:120])
ok("still exactly one ticket", len(wq.tickets) == 1, wq.tickets)

r = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", KEY, LOC, live, log, wq,
                           T0 + int(F.APPEND_COOLDOWN_H + 1) * H_MS)
ok("past the cooldown, the heartbeat append lands", r["action"] == "appended", r)
ok("the heartbeat is a REPEAT block", "REPEAT" in wq.tickets[1200]["detail"],
   wq.tickets[1200]["detail"][:120])

# A report that actually says something new appends immediately.
changed = dict(live)
changed["eventFlags"] = 99
r = F.maybe_file_or_append(escal, "FIGHT_LOSS_LOOP", KEY, LOC, changed, log, wq,
                           T0 + int(F.APPEND_COOLDOWN_H + 1) * H_MS + 60_000)
ok("a changed report appends without waiting", r["action"] == "appended", r)

# ── 7. an event flag does not auto-close a live stuck ticket ───────────────
print("\n-- auto-resolve needs story progress --")
wq2 = FakeWQ()
escal2 = {"v": 1, "incidents": {KEY: {
    "ticketId": 1097, "firstStalledAt": T0, "ntfySentAt": None, "lastAppendAt": T0,
    "baselineStoryScore": 10, "baselineBadges": 1, "baselineEventFlags": 46}}}
wq2.tickets[1097] = {"title": "t", "detail": "d", "status": "open"}
closed = F.resolve_advanced(escal2, stalled(events=47), wq2, T0 + H_MS)
ok("a flag tick does not close the ticket", closed == [] and KEY in escal2["incidents"], closed)
ok("wq done was never called", not any(c[0] == "done" for c in wq2.calls), wq2.calls)

closed = F.resolve_advanced(escal2, stalled(story=11, events=47), wq2, T0 + 2 * H_MS)
ok("a story advance does close the ticket", len(closed) == 1 and KEY not in escal2["incidents"],
   closed)
ok("wq done was called for it", any(c[0] == "done" and c[1] == "1097" for c in wq2.calls),
   wq2.calls)

# ── 8. the exhausted pin is refreshed, not frozen ─────────────────────────
print("\n-- the exhausted path still writes the directive --")
spent = {"v": 1, "attempts": []}
for i in range(1, 4):
    I.decide(state=stalled(), log=spent, now_ms=T0 + i * H_MS)
exhausted = I.decide(state=stalled(), log=spent, now_ms=T0 + 4 * H_MS)
ok("exhausted decisions still carry a directive",
   exhausted.get("exhausted") is True and exhausted.get("directive") is not None, exhausted)

p = os.path.join(tempfile.mkdtemp(prefix="verify_1097_dir_"), "supervisor_directive.json")
ok("persist_directive writes an exhausted directive", I.persist_directive(exhausted, p) is True)
written = json.load(open(p))
ok("the written pin is labelled EXHAUSTED, not attempt 3/3",
   "EXHAUSTED" in written["notepadPin"] and "SUPERVISOR (3/3)" not in written["notepadPin"],
   written["notepadPin"][:90])
ok("persist_directive writes an intervening directive too",
   I.persist_directive(I.decide(state=stalled(story=99), log={"v": 1, "attempts": []},
                                now_ms=T0), p) is True)
ok("persist_directive writes nothing without a directive",
   I.persist_directive({"intervened": False, "reason": "not stalled"}, p) is False)

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
