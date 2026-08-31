#!/usr/bin/env python3
"""wq#1118 probe — RESUME_DEADEND fires only when the harness guard is beaten,
anchors on a real map, and prescribes something its reader can actually do.

THE INCIDENT
  RESUME_DEADEND@None sat on one live stall for 35h: three K attempts, all
  "superseded", a ticket re-appended every ~30min, and a prescription
  ("alternate_checkpoint — resume from a different one") that could not work
  even if obeyed perfectly. Three defects, one per section below.
"""
import os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lpp_stuck_mode as M
import lpp_stuck_intervene as I

names = M.load_map_names()
LIMIT = M.resume_repeat_limit()


def picks(f, n):
    return [{"file": f}] * n


# --- A: the bar is READ from src/resume.ts, not retyped here ---
assert os.path.exists(M.RESUME_TS), f"A1: src/resume.ts not found at {M.RESUME_TS}"
src = open(M.RESUME_TS).read()
assert LIMIT == int(re.search(r"RESUME_REPEAT_LIMIT\s*=\s*(\d+)", src).group(1)), \
    f"A2: parsed limit {LIMIT} disagrees with src/resume.ts"
assert M.resume_viable_pct() == float(re.search(r"VIABLE_HP_PCT\s*=\s*([0-9.]+)", src).group(1)), \
    "A3: parsed VIABLE_HP_PCT disagrees with src/resume.ts"
assert M.resume_repeat_limit("/nonexistent/resume.ts") == M.RESUME_REPEAT_FALLBACK, \
    "A4: unreadable source must degrade to the fallback, not raise"
print(f"A: thresholds read from src/resume.ts: repeat_limit={LIMIT}, "
      f"viable={M.resume_viable_pct()}")

# --- B: a run of exactly the limit is the guard's remedy IN FLIGHT ---
# src/resume.ts demotes a file picked LIMIT times running whenever a newer
# non-warp state exists. Declaring a deadend there prescribed "resume from a
# different checkpoint" at the exact boot the picker was about to do that
# itself — the wq#1118 misfire.
trail = [3, 15, 59]
modeB, evB, locB = M.classify_mode(trail, picks("auto-x-map3.state.gz", LIMIT), names)
assert modeB != "RESUME_DEADEND", f"B1: at the limit should not be a deadend, got {modeB} :: {evB}"
print(f"B: {LIMIT} identical picks -> {modeB} (guard has not been beaten yet)")

# --- C: one MORE than the limit is the guard beaten — deadend, with a map ---
modeC, evC, locC = M.classify_mode(trail, picks("auto-x-map3.state.gz", LIMIT + 1), names)
assert modeC == "RESUME_DEADEND", f"C1: past the limit should be a deadend, got {modeC} :: {evC}"
assert locC == trail[-1], f"C2: location should anchor on the current map {trail[-1]}, got {locC}"
assert locC is not None, "C3: location must never be None — RESUME_DEADEND@None is one global key"
assert str(LIMIT) in evC and "resume.ts" in evC, f"C4: evidence should cite the harness bar: {evC}"
print(f"C: {LIMIT + 1} identical picks -> {modeC}@{locC}: {evC[:72]}...")

# --- D: alternating picks are still not a deadend (unchanged pre-wq#1118) ---
alt = [{"file": "auto-a.state.gz"}, {"file": "auto-b.state.gz"}, {"file": "auto-a.state.gz"}]
modeD, _, _ = M.classify_mode(trail, alt, names)
assert modeD != "RESUME_DEADEND", f"D1: alternating picks are not a deadend, got {modeD}"
print(f"D: alternating picks -> {modeD}")

# --- E: the prescription addresses the actor that can actually act ---
# The in-game brain does not choose the resume target — pickResume does, at
# boot, before the brain exists. A pin telling it to "resume from a different
# checkpoint" is obeyable and useless (the wq#1091 lesson).
log = {"v": 1, "attempts": []}
state = {"ok": True, "stalled": True, "mode": "RESUME_DEADEND", "modeLocation": 36,
         "storyScore": 10, "badges": 1, "eventFlags": 47, "map": 36}
r = I.decide(state=state, log=log)
pin = r["directive"]["notepadPin"]
assert r["intervened"], f"E1: should prescribe on attempt 1, got {r}"
assert not re.search(r"resume from a different", pin, re.I), \
    "E2: pin must not ask the brain to pick a checkpoint — it has no such authority"
assert "36" in pin, f"E3: pin should name the location: {pin}"
assert f"{I._viable_pct()}%" in pin, "E4: pin must quote the picker's own viability bar"
assert "warp tile" in pin, "E5: pin must say why a warp-tile save cannot replace the boot state"
assert r["directive"]["gotoBan"] == [], "E6: RESUME_DEADEND never bans maps"
print(f"E: attempt {r['attempt']}/{r['k']} action={r['directive']['action']}")

# --- F: per-location dedup — two deadends do not share one K budget ---
# wq#671's key is (mode, location) "so two different stuck spots never share one
# counter or one ticket". location=None broke exactly that for this mode.
I.decide(state=dict(state, modeLocation=36), log=log)
I.decide(state=dict(state, modeLocation=36), log=log)
exhausted = I.decide(state=dict(state, modeLocation=36), log=log)
assert exhausted.get("exhausted"), f"F1: K should bound one location, got {exhausted}"
elsewhere = I.decide(state=dict(state, modeLocation=59), log=log)
assert elsewhere["intervened"] and elsewhere["attempt"] == 1, \
    f"F2: a deadend at another map starts its own budget, got {elsewhere}"
print(f"F: RESUME_DEADEND@36 exhausted at {exhausted['attempts']}/{exhausted['k']}, "
      f"RESUME_DEADEND@59 starts at 1/{elsewhere['k']}")

print("\ntest_stuck1118: ALL PASS (6 sections, A-F)")
