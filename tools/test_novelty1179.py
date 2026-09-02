#!/usr/bin/env python3
"""wq#1179 probe — the composite-progress (dP) axis sees a stall the wall clock
does not, ships observe-only, and refuses to fire on a log it cannot verify.

THE INCIDENT
  A live 60%-refused-warp stall ran with stuck_mode=None and every sentinel
  silent for twelve days. Both existing axes are wall-clock ones over
  storyScore/badges/eventFlags, so an agent that re-enters the same doorway
  forever is invisible to them until hours have passed — and, on that stall,
  not even then. src/novelty.ts adds the missing exploration term and composes
  all four into one scalar sampled per TURN; this file is the acceptance test
  for the consumer side.

  Run: python3 tools/test_novelty1179.py
"""
import json, os, re, shutil, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lpp_stuck_mode as M

names = M.load_map_names()
W = M.dp_weights()
WINDOW = M.dp_window_turns()


def sample(seq, *, P=None, story=10, badges=1, levels=12, dex=5, tiles=100, new=0, turn=None):
    s = {"seq": seq, "turn": turn if turn is not None else seq, "ts": 0,
         "map": 65, "x": 4, "y": 5, "newTiles": new,
         "storyScore": story, "badges": badges, "levelSum": levels,
         "pokedexOwned": dex, "uniqueTiles": tiles}
    s["P"] = P if P is not None else M.composite_from_parts(s, W)
    return s


def loop_samples(n, start=1, tiles=100):
    """A re-entry loop: two tiles already visited, nothing else moving.

    `tiles` carries the visited-set size FORWARD from whatever came before —
    uniqueTiles is monotonic in a real log, and a fixture that reset it would
    hand the axis a P DROP and make the onset test pass for the wrong reason.
    """
    return [sample(start + i, tiles=tiles) for i in range(n)]


def walk_samples(n, start=1):
    """Ordinary exploration: a new tile at the end of every turn."""
    return [sample(start + i, tiles=100 + i, new=1) for i in range(n)]


def grind_samples(n, start=1):
    """Standing on walked ground but LEVELLING — the case the 2h clock cannot
    tell apart from a fight-loss loop."""
    return [sample(start + i, levels=12 + i // 10) for i in range(n)]


# --- A: thresholds and weights are READ from src/novelty.ts, not retyped ---
assert os.path.exists(M.NOVELTY_TS), f"A1: src/novelty.ts not found at {M.NOVELTY_TS}"
src = open(M.NOVELTY_TS).read()
assert WINDOW == int(re.search(r"DP_WINDOW_TURNS\s*=\s*(\d+)", src).group(1)), \
    f"A2: parsed window {WINDOW} disagrees with src/novelty.ts"
ts_w = dict(re.findall(r"(\w+):\s*(\d+)", re.search(r"WEIGHTS\s*=\s*\{([^}]*)\}", src).group(1)))
assert W == {k: int(v) for k, v in ts_w.items()}, f"A3: parsed weights {W} != {ts_w}"
assert M.dp_window_turns("/nonexistent/novelty.ts") == M.DP_WINDOW_FALLBACK, \
    "A4: unreadable source must degrade to the fallback, not raise"
assert M.dp_weights("/nonexistent/novelty.ts") == M.DP_WEIGHTS_FALLBACK, "A5: ditto for weights"
assert W["tile"] < W["dex"] < W["level"] < W["badge"] < W["story"], "A6: tiers must be ordered"
print(f"A: window={WINDOW} turns, weights={W} — both read from src/novelty.ts")

# --- B: the loop is flagged, real progress is not ---
dpB = M.dp_axis(loop_samples(WINDOW))
assert dpB["ok"] and dpB["complete"], f"B1: full window should be complete: {dpB}"
assert dpB["dP"] == 0 and dpB["flat"], f"B2: a re-entry loop must be flat: {dpB}"
assert dpB["newTiles"] == 0, f"B3: a re-entry loop discovers no tiles: {dpB}"

dpB2 = M.dp_axis(walk_samples(WINDOW))
assert not dpB2["flat"] and dpB2["dP"] == WINDOW - 1, f"B4: exploration must not flag: {dpB2}"

dpB3 = M.dp_axis(grind_samples(WINDOW))
assert not dpB3["flat"] and dpB3["dP"] > 0, f"B5: productive grinding must not flag: {dpB3}"

# Onset: a loop that starts after a stretch of real exploration is flagged once
# — and only once — the window has filled with flat samples.
mixed = walk_samples(WINDOW) + loop_samples(WINDOW, start=WINDOW + 1, tiles=100 + WINDOW - 1)
first_flat = next((i for i in range(2, len(mixed) + 1) if M.dp_axis(mixed[:i])["flat"]), None)
assert first_flat is not None, "B6: a loop after exploration must eventually flag"
assert first_flat - WINDOW <= WINDOW + 2, \
    f"B7: flagged {first_flat - WINDOW} turns after onset, expected <= {WINDOW + 2}"
# One story flag inside a dead window clears it: the axis reports, it does not latch.
assert not M.dp_axis(loop_samples(WINDOW - 1) + [sample(WINDOW, story=11)])["flat"], \
    "B8: a story flag inside the window must clear the stall"
print(f"B: loop flat (dP=0), exploration dP={dpB2['dP']}, grind dP={dpB3['dP']}, "
      f"onset->flag in {first_flat - WINDOW} turns")

# --- C: a window it cannot stand behind is never a stall claim ---
assert not M.dp_axis(loop_samples(WINDOW - 1))["flat"], "C1: a partial window must not flag"
assert M.dp_axis(loop_samples(WINDOW - 1))["reason"], "C2: and must say why"
empty = M.dp_axis([])
assert not empty["ok"] and not empty["flat"] and "novelty.ts" in empty["reason"], \
    f"C3: no samples = axis absent, not a stall: {empty}"
assert not M.dp_axis([sample(1)])["flat"], "C4: one sample is not a window"
# Fail-closed on a log whose P disagrees with its own components: the producer
# and the consumer have drifted, so the axis refuses rather than guessing.
bad = loop_samples(WINDOW)
bad[-1]["P"] = bad[-1]["P"] + 7
dpC = M.dp_axis(bad)
assert dpC["pMismatch"] == 1 and not dpC["flat"] and "weights disagree" in dpC["reason"], \
    f"C5: unverifiable log must not flag: {dpC}"
print(f"C: partial window, empty log and P-mismatch all refuse to flag "
      f"(pMismatch={dpC['pMismatch']})")

# --- D: observe-only by default, drives `stalled` only behind the flag ---
base = tempfile.mkdtemp(prefix="novelty1179-")
try:
    os.makedirs(f"{base}/checkpoints", exist_ok=True)
    os.makedirs(f"{base}/runtime", exist_ok=True)
    T0 = 1_780_000_000_000
    # One sidecar, one hour ago: the wall-clock axis (2h window) says FINE.
    json.dump({"ts": T0, "storyScore": 10, "badges": 1, "events": 37, "map": 65},
              open(f"{base}/checkpoints/a.json", "w"))
    json.dump({"v": 1, "seq": WINDOW, "samples": loop_samples(WINDOW)},
              open(f"{base}/runtime/progress.json", "w"))
    now = T0 + int(1.0 * 3.6e6)
    warps = [65, 3] * 8      # gym <-> city, the healing-cycle shape
    picks = []

    off = M.compute(base=base, now_ms=now, warps=warps, resume_picks=picks, names=names,
                    dp_enabled=False)
    assert off["ok"] and not off["stalled"], f"D1: wall clock alone must not stall: {off}"
    assert off["dP"]["flat"], "D2: the dP axis still REPORTS while observe-only"
    assert off["dPAxisEnabled"] is False and off["mode"] is None, \
        f"D3: observe-only must not classify or act: {off}"
    assert "OBSERVE-ONLY" in M.one_line(off), f"D4: the one-liner must say so: {M.one_line(off)}"

    on = M.compute(base=base, now_ms=now, warps=warps, resume_picks=picks, names=names,
                   dp_enabled=True)
    assert on["stalled"] and on["stallAxis"] == "dP", f"D5: flagged axis must stall: {on}"
    assert on["mode"] == "FIGHT_LOSS_LOOP", f"D6: the existing classifier still runs: {on}"
    assert "composite progress flat" in on["modeEvidence"], \
        f"D7: evidence must name the axis that fired first: {on['modeEvidence']}"
    assert "STALLED[dP]" in M.one_line(on), f"D8: one-liner names the axis: {M.one_line(on)}"

    # Real progress inside the window, same wall clock, flag ON: still not stalled.
    json.dump({"v": 1, "seq": WINDOW, "samples": walk_samples(WINDOW)},
              open(f"{base}/runtime/progress.json", "w"))
    moving = M.compute(base=base, now_ms=now, warps=warps, resume_picks=picks, names=names,
                       dp_enabled=True)
    assert not moving["stalled"], f"D9: exploration must not stall with the flag on: {moving}"

    # A deployment with no tracker running is unchanged in every respect.
    os.remove(f"{base}/runtime/progress.json")
    none = M.compute(base=base, now_ms=now, warps=warps, resume_picks=picks, names=names,
                     dp_enabled=True)
    assert not none["stalled"] and not none["dP"]["ok"], f"D10: no log = no axis: {none}"

    # The wall-clock axis is untouched: 3h of freeze still stalls on storyScore
    # even with the dP axis explicitly off.
    late = M.compute(base=base, now_ms=T0 + int(3 * 3.6e6), warps=warps, resume_picks=picks,
                     names=names, dp_enabled=False)
    assert late["stalled"] and late["stallAxis"] == "storyScore", \
        f"D11: the pre-existing axis must be unchanged: {late}"
finally:
    shutil.rmtree(base, ignore_errors=True)
print("D: observe-only by default; --dp-axis stalls on the loop, spares exploration, "
      "leaves the 2h storyScore axis untouched")

# --- E: the flag resolution itself ---
saved = os.environ.pop("LPP_DP_AXIS", None)
try:
    assert M.dp_axis_enabled() is False, "E1: unset env = observe-only"
    for v in ("1", "true", "YES", "on"):
        os.environ["LPP_DP_AXIS"] = v
        assert M.dp_axis_enabled() is True, f"E2: LPP_DP_AXIS={v} must enable"
    os.environ["LPP_DP_AXIS"] = "0"
    assert M.dp_axis_enabled() is False, "E3: LPP_DP_AXIS=0 must not enable"
    os.environ["LPP_DP_AXIS"] = "1"
    assert M.dp_axis_enabled(False) is False, "E4: --no-dp-axis overrides the env"
    assert M.dp_axis_enabled(True) is True, "E5: explicit True wins too"
finally:
    os.environ.pop("LPP_DP_AXIS", None)
    if saved is not None:
        os.environ["LPP_DP_AXIS"] = saved
print("E: LPP_DP_AXIS / --dp-axis / --no-dp-axis resolve as documented")

print("\ntest_novelty1179: ALL PASS (5 sections, A-E)")
