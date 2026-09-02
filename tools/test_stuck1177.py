#!/usr/bin/env python3
"""wq#1177 probe — RESUME_DEADEND is judged on the resumed GAME STATE.

THE REGRESSION
  Checkpoint filenames are unique per run by design (src/agent.ts stamps a
  runTag), so a campaign that reboots into the identical position/story/party
  every time writes a DIFFERENT filename each boot. The file-only test here
  (and the matching guard in src/resume.ts) therefore asked a question that
  could not detect the loop it exists to name.

  src/resume.ts now stamps `stateKey` into v4 sidecars and records it on each
  pick; this module compares that key when present and the filename when it is
  not, so classifier and harness agree on what "the same choice" means — the
  wq#1091/#1118 discipline of reading the threshold FROM the code that
  enforces it, applied to the identity as well.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lpp_stuck_mode as M

names = M.load_map_names()
LIMIT = M.resume_repeat_limit()
NEED = LIMIT + 1
TRAIL = [3, 15, 59]          # a plain travel trail: no other mode may claim it
KEY = "m59@8,4/s6/b1/l42"


def picks(entries):
    return [dict(e) for e in entries]


# --- A: same state, fresh filename every boot (the live shape) ---
same_state = picks([{"file": f"auto-run{i}-t10.state.gz", "key": KEY} for i in range(NEED)])
modeA, evA, locA = M.classify_mode(TRAIL, same_state, names)
assert modeA == "RESUME_DEADEND", f"A1: expected RESUME_DEADEND, got {modeA} ({evA})"
assert KEY in evA, f"A2: evidence must name the repeated state: {evA}"
assert "auto-run2-t10.state.gz" in evA, f"A3: evidence must still name a real file: {evA}"
assert len({p["file"] for p in same_state}) == NEED, "A4: fixture must use distinct filenames"
print(f"A: {NEED} boots, {NEED} filenames, one state -> {modeA}@{locA}")

# --- B: the file-only test the old code ran is blind to A ---
old_style = [p["file"] for p in same_state]
assert len(set(old_style)) != 1, "B1: RED — the old filename test cannot see this loop"
print("B: RED confirmed — comparing filenames finds no repeat in the same fixture")

# --- C: one filename, different states, is NOT a deadend ---
# The mirror case: a recycled name (legacy corpus) whose states genuinely
# differ means the campaign is moving, and re-picking is not the problem.
moving = picks([{"file": "auto-x-t10.state.gz", "key": f"m59@{8 + i},4/s6/b1/l42"}
                for i in range(NEED)])
modeC, evC, _ = M.classify_mode(TRAIL, moving, names)
assert modeC != "RESUME_DEADEND", f"C1: moving states must not be a deadend ({evC})"
print(f"C: same filename, {NEED} distinct states -> {modeC} (not a deadend)")

# --- D: pre-wq#1177 picks (no key) keep the filename behaviour exactly ---
legacy = picks([{"file": "auto-x-t10.state.gz"}] * NEED)
modeD, _, _ = M.classify_mode(TRAIL, legacy, names)
assert modeD == "RESUME_DEADEND", "D1: keyless repeats must still classify as before"
mixed = picks([{"file": "auto-x-t10.state.gz"},
               {"file": "auto-x-t10.state.gz", "key": KEY},
               {"file": "auto-y-t10.state.gz", "key": KEY}])
modeD2, _, _ = M.classify_mode(TRAIL, mixed, names)
assert modeD2 != "RESUME_DEADEND", \
    "D2: a history straddling the upgrade must not fire on mismatched identities"
print("D: keyless history unchanged; an upgrade-straddling history does not misfire")

# --- E: below the bar is still the guard's remedy in flight (wq#1118) ---
modeE, _, _ = M.classify_mode(TRAIL, same_state[:LIMIT], names)
assert modeE != "RESUME_DEADEND", "E1: at the limit the harness guard has not been beaten yet"
print(f"E: {LIMIT} identical states (the harness limit) -> {modeE}, deadend deferred")

print("\ntest_stuck1177: ALL PASS (5 sections, A-E)")
