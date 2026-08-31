#!/usr/bin/env python3
"""verify_672 — offline proof for the wq#672 bounded intervention layer
(tools/lpp_stuck_intervene.py).

Run:  python3 tools/verify_672.py
No service, no network, no writes outside a temp dir. Every call passes an
explicit `log` dict and never touches the live runtime/intervention_log.json
or runtime/supervisor_directive.json, mirroring how verify_489.py exercises
lpp-sentinel's emit() directly against a throwaway state dict rather than the
real runtime/sentinel_state.json.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_intervene as I
import lpp_stuck_mode as M

PASS = FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}{('  ' + detail) if detail else ''}")


def stalled_state(mode, location, story=10, badges=1, events=37, ts=1_786_000_000_000):
    return {"ok": True, "stalled": True, "mode": mode, "modeLocation": location,
            "storyScore": story, "badges": badges, "eventFlags": events, "map": location,
            "generatedAt": "2026-08-17T20:00:00Z"}


def healthy_state(story=11, badges=1, events=38, location=3):
    return {"ok": True, "stalled": False, "mode": None, "modeLocation": None,
            "storyScore": story, "badges": badges, "eventFlags": events, "map": location}


# ── 1. no intervention when not stalled ────────────────────────────────────
print("\n-- basic gating --")
log = {"v": 1, "attempts": []}
r = I.decide(state=healthy_state(), log=log)
ok("healthy state does not intervene", r["intervened"] is False and not log["attempts"], json.dumps(r))

log = {"v": 1, "attempts": []}
r = I.decide(state=stalled_state("IDLE", None), log=log)
ok("IDLE has no prescription, does not intervene", r["intervened"] is False, json.dumps(r))
ok("IDLE does not raise for locationKey formatting with location=None", "reason" in r, r)

# ── 2. FIGHT_LOSS_LOOP fires and logs before/after ─────────────────────────
print("\n-- FIGHT_LOSS_LOOP: fires, logs, before/after --")
log = {"v": 1, "attempts": []}
state = stalled_state("FIGHT_LOSS_LOOP", 65)
r = I.decide(state=state, log=log)
ok("first attempt intervenes", r["intervened"] is True, json.dumps(r))
ok("attempt number is 1", r["attempt"] == 1, r["attempt"])
ok("directive names the gym as location", r["directive"]["location"] == 65, r["directive"])
ok("directive action is grind_sub_objective", r["directive"]["action"] == "grind_sub_objective", r["directive"])
ok("notepadPin mentions the location", "65" in r["directive"]["notepadPin"], r["directive"]["notepadPin"])
ok("log gained exactly one entry", len(log["attempts"]) == 1, len(log["attempts"]))
ok("beforeState captured on the entry", log["attempts"][0]["beforeState"]["storyScore"] == 10, log["attempts"][0])
ok("afterState starts unresolved", log["attempts"][0]["afterState"] is None, log["attempts"][0])

# ── 3. K=3 bound: 3 attempts succeed, 4th is exhausted, not a 4th log entry ─
print("\n-- K=3 bound --")
log = {"v": 1, "attempts": []}
attempts = []
for i in range(4):
    r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log)
    attempts.append(r)
ok("attempts 1-3 all intervene", all(a["intervened"] for a in attempts[:3]),
   [a["intervened"] for a in attempts[:3]])
ok("attempt numbers are 1,2,3", [a["attempt"] for a in attempts[:3]] == [1, 2, 3],
   [a.get("attempt") for a in attempts[:3]])
ok("4th call is exhausted, not a 4th intervention", attempts[3]["intervened"] is False and attempts[3].get("exhausted"),
   json.dumps(attempts[3]))
ok("exhausted call does NOT append a 4th log entry", len(log["attempts"]) == 3, len(log["attempts"]))

# ── 4. resolution: a story_score advance closes the pending entry and resets K
print("\n-- resolution on advance --")
log = {"v": 1, "attempts": []}
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=10), log=log)
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=10), log=log)
ok("2 attempts open before the win", len(log["attempts"]) == 2, len(log["attempts"]))
# story_score rises -> the mode clears (healthy_state) on the NEXT read
r = I.decide(state=healthy_state(story=12), log=log)
ok("advance closes without a new attempt", r["intervened"] is False, r)
resolved = [e for e in log["attempts"] if e.get("outcome") == "advanced"]
ok("both prior attempts resolved as 'advanced'", len(resolved) == 2, log["attempts"])
# a FRESH stall at the same location afterwards starts back at attempt 1
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=12), log=log)
ok("K resets after a real advance", r["attempt"] == 1, r)

# ── 5. a DIFFERENT location gets an independent K counter ──────────────────
print("\n-- independent counters per (mode, location) --")
log = {"v": 1, "attempts": []}
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log)  # Cerulean Gym, attempt 1
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log)  # attempt 2
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 92), log=log)  # a DIFFERENT gym (Vermilion)
ok("a different gym starts its own counter at 1", r["attempt"] == 1, r)
ok("the first gym's open attempts are untouched", I.open_attempt_count(log, "FIGHT_LOSS_LOOP@65") == 2,
   I.open_attempt_count(log, "FIGHT_LOSS_LOOP@65"))

# ── 6. superseded (mode/location changed without advancing) doesn't reset K,
#      and doesn't get counted as a win either ─────────────────────────────
print("\n-- superseded attempts --")
log = {"v": 1, "attempts": []}
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=10), log=log)
# same location, still stalled, story_score unchanged, but the agent has
# since drifted into a NAV_LOOP shape instead -- not an advance.
r = I.decide(state=stalled_state("NAV_LOOP", 3, story=10), log=log)
superseded = [e for e in log["attempts"] if e.get("outcome") == "superseded"]
ok("mode change without advance marks the prior entry superseded", len(superseded) == 1, log["attempts"])
ok("superseded (not advanced) still counts toward the OLD key's K",
   I.open_attempt_count(log, "FIGHT_LOSS_LOOP@65") == 1, log["attempts"])

# ── 7. every mode except IDLE has a prescription; the directive always
#      round-trips through json (no non-serialisable objects) ─────────────
print("\n-- all modes --")
for mode in M.MODES:
    log = {"v": 1, "attempts": []}
    r = I.decide(state=stalled_state(mode, 3), log=log)
    if mode == "IDLE":
        ok(f"{mode} has no prescription", not r["intervened"], r)
    else:
        ok(f"{mode} produces a directive", r["intervened"] is True, r)
        json.dumps(r["directive"])  # raises if not serialisable
        ok(f"{mode} directive round-trips through json", True)


# ── 8. wq#1091: the FIGHT_LOSS_LOOP pin must agree with the harness gate ───
#      The original pin said "grind to roughly L18-21" — Misty's OWN team
#      levels — while src/guidance.ts refuses gym entry below L30 + potions +
#      roster + a Grass/Rock counter. An agent obeying that pin exactly could
#      never clear the gate, which is how three K attempts on
#      FIGHT_LOSS_LOOP@3 burned 33h without moving story_score.
print("\n-- wq#1091: pin agrees with guidance.ts's entry gate --")
gate = I._misty_gate()
ok("gate parsed from src/guidance.ts, not the fallback",
   os.path.exists(I.GUIDANCE_TS), I.GUIDANCE_TS)
ok("parsed min level matches guidance.ts MISTY_MIN_LEVEL",
   gate["min_level"] == 30, gate)
ok("parsed potions/roster match guidance.ts",
   gate["min_potions"] == 3 and gate["min_roster"] == 2, gate)
ok("a missing guidance.ts degrades to the fallback instead of raising",
   I._misty_gate(path="/nonexistent/guidance.ts") == I.GATE_FALLBACK,
   I._misty_gate(path="/nonexistent/guidance.ts"))

log = {"v": 1, "attempts": []}
pin = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log)["directive"]["notepadPin"]
ok("pin names the gate's level, not the opposing team's levels",
   f">= {gate['min_level']}" in pin, pin)
ok("pin no longer prescribes the L18-21 target the gate rejects",
   "18-21" not in pin and "L18" not in pin, pin)
ok("pin states the potion and roster conditions the gate also enforces",
   f">= {gate['min_potions']} potions" in pin and f">= {gate['min_roster']} party" in pin, pin)
ok("pin states the type counter as required, not preferred",
   "Grass or Rock" in pin and "Prefer" not in pin, pin)
ok("pin names the location instead of a bare id next to the level numbers",
   "Cerulean City (map3)" in pin, pin)
ok("pin keeps the live hot-patch's grind mechanics (grass via goto, no warp-in)",
   "tall grass" in pin and "goto()" in pin and "enter_warp" in pin, pin)
ok("pin keeps the live hot-patch's no-heal-at-full-HP instruction",
   "full HP" in pin, pin)
ok("an unknown map id still renders, and still carries the raw id",
   I._located(60001) == "map60001", I._located(60001))

# ── 9. wq#1091: exhausted refreshes the directive but still logs nothing ───
#      Without this the pin on disk stays frozen at the attempt-3 text
#      forever: the key can never intervene again, so no corrected
#      prescription could ever reach the live agent.
print("\n-- wq#1091: exhausted still refreshes the directive --")
log = {"v": 1, "attempts": []}
for _ in range(3):
    I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log)
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log)
ok("4th call is still exhausted and still not an intervention",
   r.get("exhausted") is True and r["intervened"] is False, r)
ok("exhausted STILL appends no log entry (wq#673's ticket signal is intact)",
   len(log["attempts"]) == 3, len(log["attempts"]))
ok("exhausted now carries a directive to persist", bool(r.get("directive")), r)
ok("exhausted directive is marked exhausted, not a 4th attempt",
   r["directive"]["exhausted"] is True and r["directive"]["attempt"] == 3, r["directive"])
ok("exhausted pin says EXHAUSTED instead of claiming an attempt is in flight",
   "EXHAUSTED after 3/3" in r["directive"]["notepadPin"], r["directive"]["notepadPin"])
ok("exhausted pin still carries the standing gate requirement",
   f">= {gate['min_level']}" in r["directive"]["notepadPin"], r["directive"]["notepadPin"])
ok("exhausted directive drops any ban — the supervisor stopped intervening",
   r["directive"]["gotoBan"] == [], r["directive"])
json.dumps(r["directive"])  # raises if not serialisable
ok("exhausted directive round-trips through json", True)

# every mode's template must survive the terminal-directive format() call,
# including the NAV_LOOP/WARP_OSC pins that reference {loop_maps}/{loop_labels}
for mode in M.MODES:
    if mode == "IDLE":
        continue
    log = {"v": 1, "attempts": []}
    for _ in range(4):
        r = I.decide(state=stalled_state(mode, 3), log=log)
    ok(f"{mode} exhausted directive formats without KeyError",
       bool(r.get("directive", {}).get("notepadPin")), r)


# ── 10. wq#1149: a ban may never name a map the agent's own plan needs ──────
# The live Route 25 stall was prescribed "ban Cerulean City + Route 25" — the
# only heal point and the grind route — because the resolver fell back to the
# window's two most frequent maps whenever it held more than 3 distinct ids,
# which across a multi-day freeze it always does. Frequency is not adjacency.
print("\n-- wq#1149: the ban list names an edge, or nothing --")
import tempfile

_real_warp_history = I.WARP_HISTORY
_tmpdir = tempfile.mkdtemp(prefix="verify672-")


def _loop_maps_for(warps):
    path = os.path.join(_tmpdir, "warp_history.json")
    with open(path, "w") as fh:
        json.dump({"warps": warps}, fh)
    I.WARP_HISTORY = path
    try:
        return I._resolve_loop_maps()
    finally:
        I.WARP_HISTORY = _real_warp_history


REGION = M.stage_region()
LIVE_1119 = ([88, 36, 64, 3, 63, 3, 64, 3, 63, 3, 64, 3, 3, 63, 3, 64, 3, 3, 63,
              3, 64, 3, 63, 3, 64, 3, 63, 3, 67, 3, 64, 3, 3, 63, 3, 64, 3, 63,
              3, 64, 3, 88] + [36] * 22)

ok("the live window no longer resolves to a ban at all",
   _loop_maps_for(LIVE_1119) == [], _loop_maps_for(LIVE_1119))
ok("specifically, it no longer bans the grind route or the heal hub",
   not ({3, 36} & set(_loop_maps_for(LIVE_1119))), _loop_maps_for(LIVE_1119))
ok("a window that spreads over more than the NAV_LOOP bar names no loop",
   _loop_maps_for([59, 60, 61, 62, 63] * 14) == [],
   str(_loop_maps_for([59, 60, 61, 62, 63] * 14)))
ok("a genuine two-map loop outside the stage still resolves",
   _loop_maps_for([60, 61] * 12) == [60, 61], str(_loop_maps_for([60, 61] * 12)))
ok("a tight loop is still filtered down to the maps outside the stage",
   _loop_maps_for([3, 60] * 12) == [60], str(_loop_maps_for([3, 60] * 12)))
ok("every stage map is filtered, leaving an empty ban rather than a partial one",
   _loop_maps_for([REGION[0], REGION[-1]] * 12) == [],
   str(_loop_maps_for([REGION[0], REGION[-1]] * 12)))
# wq#1119's "same scope for the guard as for the detector", applied to the ban:
# WARP_OSC fires on the last 16 warps, so a wide window that has drifted must not
# be the only scope the ban is resolved at.
_drifted = [59, 62, 63, 15, 88, 67] * 8 + [60, 61] * 8
ok("an edge the detector sees in its own 16-warp scope still resolves",
   _loop_maps_for(_drifted) == [60, 61], str(_loop_maps_for(_drifted)))
ok("an unreadable warp history is still an empty ban, not a raise",
   _loop_maps_for([]) == [])

# The pin that interpolates a ban still renders when there is nothing to ban —
# an empty list has always been possible here, but it is now the common case.
log = {"v": 1, "attempts": []}
I.WARP_HISTORY = os.path.join(_tmpdir, "absent.json")
r = I.decide(state=stalled_state("NAV_LOOP", 60), log=log)
I.WARP_HISTORY = _real_warp_history
ok("NAV_LOOP still prescribes with an empty ban list",
   r["directive"]["gotoBan"] == [] and "unknown" in r["directive"]["notepadPin"],
   json.dumps(r.get("directive")))

# ── 11. wq#1149: one freeze is one key, so K bounds one incident ────────────
# wq#671's (mode, location) key stopped two stuck spots sharing one counter; it
# never stopped one stuck spot splitting across several. Replayed over the live
# window the classifier used to name FIGHT_LOSS_LOOP@3, WARP_OSC@36 and
# FIGHT_LOSS_LOOP@36 in turn — three K budgets, three tickets, three pins taking
# turns in the single directive file — which is why wq#1149's three logged
# attempts all closed "superseded" without one of them ever being tested.
print("\n-- wq#1149: one freeze, one incident key --")
NAMES = M.load_map_names()
keys = []
for n in range(8, len(LIVE_1119) + 1):
    m_, _, loc_ = M.classify_mode(LIVE_1119[:n], [], NAMES)
    k = f"{m_}@{loc_}"
    if not keys or keys[-1] != k:
        keys.append(k)
ok("the live freeze now replays as exactly one incident key", len(keys) == 1, keys)
ok("and that key is the stage-anchored fight-readiness stall",
   keys == [f"FIGHT_LOSS_LOOP@{M.stage_anchor(REGION, NAMES)}"], keys)

log = {"v": 1, "attempts": []}
anchor = M.stage_anchor(REGION, NAMES)
for _ in range(3):
    I.decide(state=stalled_state("FIGHT_LOSS_LOOP", anchor), log=log)
ok("three attempts against one stable key stay OPEN, not superseded",
   all(e.get("outcome") is None for e in log["attempts"]), log["attempts"])
ok("K then bounds the incident it was counting",
   I.decide(state=stalled_state("FIGHT_LOSS_LOOP", anchor), log=log).get("exhausted"), log)


# ── 12. wq#1149: the K budget belongs to the incident, not to the log ───────
# Only an 'advanced' close frees a slot, and resolve_pending sets an outcome
# only on an entry still open — so an entry closed 'superseded' could never
# afterwards become 'advanced' and occupied one of its key's three slots for the
# life of the file. Three drifts spent the key permanently, across every later
# advance and every fresh stall, having never once tested the remedy.
print("\n-- wq#1149: a spent budget is released by the next advance --")
OLD_FREEZE_MS = 1_786_000_000_000
NEW_FREEZE_MS = OLD_FREEZE_MS + 48 * 3.6e6


def stalled_since(iso, mode="FIGHT_LOSS_LOOP", location=3, story=10):
    return dict(stalled_state(mode, location, story=story), lastAdvanceAt=iso)


spent = {"v": 1, "attempts": [
    {"ts": OLD_FREEZE_MS + i * 1000, "mode": "FIGHT_LOSS_LOOP",
     "locationKey": "FIGHT_LOSS_LOOP@3", "attempt": i + 1, "directive": {},
     "beforeState": {"storyScore": 10, "badges": 1, "eventFlags": 47, "map": 3},
     "afterState": {"storyScore": 10, "badges": 1, "eventFlags": 47, "map": 36},
     "outcome": "superseded"} for i in range(3)]}

old = I.decide(state=stalled_since(I._iso(OLD_FREEZE_MS)),
               log=dict(spent, attempts=list(spent["attempts"])))
ok("three drifted attempts still bound the freeze they were logged in",
   old.get("exhausted") is True, json.dumps(old.get("reason")))

fresh_log = dict(spent, attempts=list(spent["attempts"]))
new = I.decide(state=stalled_since(I._iso(NEW_FREEZE_MS)), log=fresh_log)
ok("but a LATER freeze at the same key starts its own budget",
   new.get("intervened") and new["attempt"] == 1, json.dumps(new.get("reason")))
ok("and the old entries are left in the log, not rewritten",
   sum(1 for e in fresh_log["attempts"] if e.get("outcome") == "superseded") == 3,
   str([e.get("outcome") for e in fresh_log["attempts"]]))

# A state with no lastAdvanceAt (an older cache, or a caller passing a bare
# dict) must behave exactly as before rather than silently unbounding K.
legacy = {"v": 1, "attempts": list(spent["attempts"])}
ok("a state without lastAdvanceAt keeps the pre-wq#1149 bound",
   I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=legacy).get("exhausted") is True,
   str(len(legacy["attempts"])))

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
