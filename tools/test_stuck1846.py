#!/usr/bin/env python3
"""test_stuck1846 — the K budget belongs to a stall EPISODE, not to a key forever.

Run:  python3 tools/test_stuck1846.py
No service, no network. Every call passes an explicit log dict and an explicit
now_ms, and the warp history is redirected to a temp file, so nothing here reads
or writes live runtime state.

The stall: FIGHT_LOSS_LOOP@65 spent all three attempts on 2026-08-18 (closed
"superseded" when a checkpoint restore rolled the save back, eventFlags 43->39).
The unrelated freeze that began 2026-09-02 then got ZERO interventions for 246h,
because open_attempt_count() counted every unresolved attempt ever logged for the
key with no window at all, so decide() answered exhausted on its first tick and
every tick after.

The trap, and why the two shapes below are tested together: the obvious window —
count only attempts newer than state.lastAdvanceAt — re-opens wq#1162 exactly,
because lpp_stuck_mode.advances() restarts the freeze clock on ANY of
storyScore/badges/eventFlags rising, so one partial tick mid-stall would refund K
and bring back the 1,2,3,2,3 ladder. The episode boundary used instead is "the key
stopped being the live stall for longer than the freeze clock can account for",
which a partial tick cannot manufacture.
"""
import json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_intervene as I
import lpp_stuck_mode as M

tmpdir = tempfile.mkdtemp(prefix="stuck1846-")
_warps = os.path.join(tmpdir, "warp_history.json")
with open(_warps, "w") as f:
    # The WARP_OSC@36 <-> 88 bounce, so section B's live key resolves a real
    # edge instead of reading the live runtime file.
    json.dump({"v": 1, "warps": [88, 36] * 8}, f)
I.WARP_HISTORY = _warps

H = 3.6e6
DAY = 24 * H

# Live evidence, verbatim from runtime/intervention_log.json.
LIVE_65 = [1787053717495.0918,   # 2026-08-18T11:48:37Z
           1787055598783.8198,   # 2026-08-18T12:19:58Z
           1787057460146.987]    # 2026-08-18T12:51:00Z
LIVE_OSC36 = [1789208698203.7,   # 2026-09-12T10:24:58Z
              1789210535770.9]   # 2026-09-12T10:55:35Z
NOW = 1789214000000.0            # 2026-09-12T11:53:20Z — 599.0h after the last
                                 # FIGHT_LOSS_LOOP@65 attempt, 0.96h after the
                                 # last WARP_OSC@36 one.


def stalled_state(mode, location, story=10, badges=1, events=39, window_h=None):
    st = {"ok": True, "stalled": True, "mode": mode, "modeLocation": location,
          "storyScore": story, "badges": badges, "eventFlags": events, "map": location}
    if window_h is not None:
        st["windowHours"] = window_h
    return st


def spent_log(location_key, stamps, mode=None, rev=None, outcome="superseded"):
    """A log holding one already-spent K budget for `location_key`."""
    mode = mode or location_key.split("@")[0]
    return {"v": 1, "attempts": [
        {"ts": ts, "mode": mode, "locationKey": location_key, "attempt": n,
         **({"rev": rev} if rev is not None else {}),
         "directive": {"action": "x"},
         "beforeState": {"storyScore": 10, "badges": 1, "eventFlags": 43, "map": 35},
         "afterState": {"storyScore": 10, "badges": 1, "eventFlags": 39, "map": 3},
         "outcome": outcome}
        for n, ts in enumerate(stamps, 1)]}


# --- A: the 25-day-old spent key refunds ----------------------------------
log = spent_log("FIGHT_LOSS_LOOP@65", LIVE_65)
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW)
assert r.get("intervened") is True and r["attempt"] == 1, \
    f"A1: a new freeze 599h later must start a new budget, got {r.get('attempt')}/{r.get('exhausted')}"
assert r["episode"] == 2 and log["attempts"][-1]["episode"] == 2, \
    f"A2: and it is episode 2 of the key, got {r.get('episode')}"
assert len(log["attempts"]) == 4, "A3: the 2026-08-18 attempts stay in the log as history"
assert I.open_attempt_count(log, "FIGHT_LOSS_LOOP@65") == 4, \
    "A4: an unscoped count still sees the whole history"
# and the refunded budget is still a BUDGET: K and then the handoff, not a ladder
for i in range(2):
    r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW + (i + 1) * 1800e3)
assert r["attempt"] == 3, f"A5: the new episode climbs to K, got {r.get('attempt')}"
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW + 3 * 1800e3)
assert r.get("exhausted") is True and len(log["attempts"]) == 6, \
    "A6: the 4th attempt of the new episode exhausts and appends nothing"
print("A: the 25-day-old spent key refunds, once, and re-exhausts at K")

# --- B: the live re-freeze on a live key does NOT refund -------------------
log = spent_log("WARP_OSC@36", LIVE_OSC36, rev=2)
r = I.decide(state=stalled_state("WARP_OSC", 36), log=log, now_ms=NOW)
assert r.get("intervened") is True and r["attempt"] == 3, \
    f"B1: 0.96h of quiet is the same episode — attempt 3, got {r.get('attempt')}"
assert r["episode"] == 1, f"B2: still the first episode this log has seen, got {r.get('episode')}"
r = I.decide(state=stalled_state("WARP_OSC", 36), log=log, now_ms=NOW + 1800e3)
assert r.get("exhausted") is True, "B3: and the 4th tick exhausts"

# the wq#1162 shape stated exactly: full K spent, a partial tick, a re-freeze 2h
# later on the same key. eventFlags rise (45->48) and story_score does not.
log = spent_log("FIGHT_LOSS_LOOP@3", [NOW - 3 * H, NOW - 2.5 * H, NOW - 2 * H])
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3, events=48), log=log, now_ms=NOW)
assert r.get("exhausted") is True, \
    f"B4: a 2h re-freeze must NOT refund K, got attempt {r.get('attempt')}"
assert len(log["attempts"]) == 3, "B5: and appends nothing"
print("B: the live 0.96h re-freeze and the wq#1162 2h re-freeze both stay exhausted")

# --- C: the live ladder's own gaps stay inside one episode -----------------
# FIGHT_LOSS_LOOP@3 re-froze 9.2h after one attempt and 7.7h after the next
# (2026-08-28T22:53 -> 08-29T08:05 -> 16:14). Those entries closed "advanced"
# under the pre-wq#1162 resolver, which is its own refund path; what is under
# test here is that the GAP alone refunds nothing.
for gap_h in (9.2, 7.7, 23.9):
    log = spent_log("FIGHT_LOSS_LOOP@3", [NOW - (gap_h + 1) * H, NOW - (gap_h + 0.5) * H,
                                          NOW - gap_h * H])
    r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log, now_ms=NOW)
    assert r.get("exhausted") is True, f"C1: a {gap_h}h gap is still one episode"
log = spent_log("FIGHT_LOSS_LOOP@3", [NOW - 26 * H, NOW - 25.5 * H, NOW - 24.1 * H])
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log, now_ms=NOW)
assert r.get("intervened") is True and r["attempt"] == 1, \
    f"C2: 24.1h of quiet is past the boundary, got {r.get('attempt')}/{r.get('exhausted')}"
print("C: 9.2h/7.7h/23.9h gaps keep the spent budget; 24.1h opens a new episode")

# --- D: the boundary is the classifier's window, not a hardcoded day -------
# EPISODE_GAP_WINDOWS windows of the window the state was computed with.
log = spent_log("NAV_LOOP@3", [NOW - 26 * H, NOW - 25.5 * H, NOW - 25 * H])
r = I.decide(state=stalled_state("NAV_LOOP", 3, window_h=6.0), log=log, now_ms=NOW)
assert r.get("exhausted") is True, \
    "D1: at windowHours=6 the boundary is 72h, so 25h of quiet is the same episode"
log = spent_log("NAV_LOOP@3", [NOW - 26 * H, NOW - 25.5 * H, NOW - 25 * H])
r = I.decide(state=stalled_state("NAV_LOOP", 3, window_h=1.0), log=log, now_ms=NOW)
assert r.get("intervened") is True, \
    "D2: at windowHours=1 the boundary is 12h, so the same 25h is a new episode"
assert I.EPISODE_GAP_WINDOWS * M.DEFAULT_WINDOW_H == 24, \
    "D3: the live default is a 24h boundary"
print("D: the boundary scales with lpp_stuck_mode's own freeze window")

# --- E: an unbroken freeze never refunds, however long it runs -------------
# The heartbeat is what makes this true: an exhausted tick appends no attempt, so
# without it the attempt timestamps alone would make a 25-day unbroken freeze
# look exactly like a key that had been quiet for 25 days.
log = spent_log("FIGHT_LOSS_LOOP@65", [NOW - 2 * H, NOW - 1.5 * H, NOW - H])
ticks = int(25 * DAY / 1800e3)  # the live supervisor polls every ~30 minutes
for i in range(1, ticks + 1):
    r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW + i * 1800e3)
    assert r.get("exhausted") is True, f"E1: refunded K at tick {i} of an unbroken freeze"
assert len(log["attempts"]) == 3, "E2: and appended nothing across 25 days of polling"
assert log["keys"]["FIGHT_LOSS_LOOP@65"]["episode"] == 1, "E3: still one episode"
# the same 25 days with the supervisor NOT running is a new episode, because the
# key genuinely stopped being the live stall for all of it
log = spent_log("FIGHT_LOSS_LOOP@65", [NOW - 2 * H, NOW - 1.5 * H, NOW - H])
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW + 25 * DAY)
assert r.get("intervened") is True and r["attempt"] == 1, "E4: a 25-day silence refunds"
print("E: 25 days of polling an unbroken freeze refunds nothing; 25 days of silence does")

# --- F: the heartbeat stays out of the attempts log (wq#673's invariant) ---
log = {"v": 1, "attempts": []}
for i in range(5):
    I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW + i * 1800e3)
assert len(log["attempts"]) == 3, "F1: exhausted ticks still append no attempt"
assert list(log["keys"]) == ["FIGHT_LOSS_LOOP@65"], "F2: liveness lives in log['keys']"
assert log["keys"]["FIGHT_LOSS_LOOP@65"]["lastLiveAt"] == NOW + 4 * 1800e3, \
    "F3: every tick heartbeats, exhausted ones included"
assert json.loads(json.dumps(log)) == log, "F4: the log stays JSON-serialisable"
# the heartbeat only works if it survives the file the timer writes each tick
roundtrip = os.path.join(tmpdir, "intervention_log.json")
I.save_log(log, path=roundtrip)
reloaded = I.load_log(path=roundtrip)
assert reloaded["keys"] == log["keys"], "F4b: and survives save_log/load_log"
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=reloaded, now_ms=NOW + 5 * 1800e3)
assert r.get("exhausted") is True, "F4c: a reloaded log keeps the episode it was saved in"
# an open attempt orphaned by a finished episode is closed, not held open forever
log = {"v": 1, "attempts": [
    {"ts": NOW - 30 * DAY, "mode": "FIGHT_LOSS_LOOP", "locationKey": "FIGHT_LOSS_LOOP@65",
     "attempt": 1, "directive": {},
     "beforeState": {"storyScore": 10, "badges": 1, "eventFlags": 43, "map": 35},
     "afterState": None, "outcome": None}]}
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW)
assert log["attempts"][0]["outcome"] == "superseded", \
    f"F5: a prior episode's open attempt closes, got {log['attempts'][0]['outcome']}"
print("F: heartbeat outside log['attempts']; prior-episode opens get closed")

# --- G: episodes are per key, and compose with the rev filter --------------
log = spent_log("FIGHT_LOSS_LOOP@65", LIVE_65)
log["attempts"] += spent_log("NAV_LOOP@3", [NOW - 2 * H, NOW - 1.5 * H, NOW - H])["attempts"]
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log, now_ms=NOW)
assert r["attempt"] == 1, "G1: the old key refunds"
r = I.decide(state=stalled_state("NAV_LOOP", 3), log=log, now_ms=NOW)
assert r.get("exhausted") is True, "G2: the live key next door keeps its spent budget"
# rev still filters within the episode: an old-rev attempt made minutes ago is
# history for a bumped prescription, not a spent try of the current remedy
log = spent_log("WARP_OSC@36", [NOW - 2 * H, NOW - 1.5 * H, NOW - H], rev=1)
r = I.decide(state=stalled_state("WARP_OSC", 36), log=log, now_ms=NOW)
assert r.get("intervened") is True and r["attempt"] == 1, \
    "G3: wq#1826's rev refund still works inside one episode"
print("G: per-key episodes, and rev filtering still composes")

print("\ntest_stuck1846: 7 sections A-G OK")
