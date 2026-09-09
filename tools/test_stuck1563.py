#!/usr/bin/env python3
"""wq#1563 probe — the post-K recovery ladder, and every kill-criterion on it.

THE INCIDENT
  FIGHT_LOSS_LOOP@3 froze for 167.9h on the story_score axis while the frontier
  axis had been frozen since 2026-08-16 (582h). K was spent, so decide() emitted
  a handoff that handed off to nothing and the supervisor tick-looped. The live
  event log (events/live-agent-1788935768505.jsonl) shows what the agent was
  actually doing: 452 turns, 725 goto calls, ZERO battles entered, ZERO catches,
  every progress sample on map 35, 0-2 new tiles per 40-turn window.

  So there was no recovery of last resort, AND the two mechanisms that would
  have carried one were both broken: lpp-stuck-supervisor discarded any
  directive computed on the exhausted path, and src/agent.ts only ever read the
  directive at boot. Sections D and E cover those.

Sections
  A  breakout_anchor — fires on the real live incident, refuses without evidence
  B  the ladder — K, then exactly one BREAKOUT, then HANDOFF (kill-criteria 1-4)
  C  the directive itself — bounded, non-destructive, names a real way out
  D  lpp-stuck-supervisor persists an exhausted-path directive (the wq#1091 gap)
  E  src/agent.ts consumes staleMapGotoBan and reloads on mtime
"""
import copy, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lpp_stuck_mode as M
import lpp_stuck_intervene as I

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WINDOW = M.dp_window_turns()
MAXNEW = I.breakout_new_tile_max(WINDOW)


def samples(n, map_id, new_tiles=0, first_turn=1000):
    """A progress window: n samples on one map, new_tiles spread over it."""
    out = [{"turn": first_turn + i, "map": map_id, "newTiles": 0} for i in range(n)]
    for i in range(min(new_tiles, n)):
        out[i]["newTiles"] = 1
    return out


STATE = {"ok": True, "stalled": True, "mode": "FIGHT_LOSS_LOOP", "modeLocation": 3,
         "storyScore": 10, "badges": 1, "eventFlags": 48, "map": 35,
         "dP": {"ok": True}}
FRONTIER = {"furthestMap": 36, "mapsEver": [3, 35, 36, 64], "recentMaps": [{"id": 35}]}


def fresh_log(n_attempts):
    return {"attempts": [
        {"ts": 1, "mode": "FIGHT_LOSS_LOOP", "locationKey": "FIGHT_LOSS_LOOP@3",
         "attempt": i + 1, "directive": {}, "beforeState": {"storyScore": 10},
         "afterState": None, "outcome": None} for i in range(n_attempts)]}


# ---- A: the anchor ---------------------------------------------------------
a = I.breakout_anchor(STATE, samples(WINDOW, 35), WINDOW, FRONTIER)
assert a is not None, "A1: a full window on one map with no new tiles must anchor"
assert a["stallMap"] == 35 and a["targetMap"] == 36, f"A2: wrong anchor {a}"
assert a["budgetTurns"] == WINDOW * I.BREAKOUT_WINDOW_MULT, f"A3: budget {a}"

assert I.breakout_anchor(STATE, samples(WINDOW, 35, MAXNEW), WINDOW, FRONTIER), \
    "A4: at the tile ceiling is still a cage"
assert I.breakout_anchor(STATE, samples(WINDOW, 35, MAXNEW + 1), WINDOW, FRONTIER) is None, \
    "A5: above the tile ceiling the agent is exploring — must NOT fire"

mixed = samples(WINDOW, 35)
mixed[0]["map"] = 36
assert I.breakout_anchor(STATE, mixed, WINDOW, FRONTIER) is None, \
    "A6: two maps in the window is travel, not a map-local cage"
assert I.breakout_anchor(STATE, samples(WINDOW - 1, 35), WINDOW, FRONTIER) is None, \
    "A7: a short window is not enough evidence to name a cage"
assert I.breakout_anchor({"dP": {"ok": False}}, samples(WINDOW, 35), WINDOW, FRONTIER) is None, \
    "A8: no novelty tracking => no honest anchor"

# Already parked on the frontier map: aim somewhere else, never at itself.
onfront = I.breakout_anchor(STATE, samples(WINDOW, 36), WINDOW, FRONTIER)
assert onfront["targetMap"] not in (36, None), f"A9: target must differ from the cage {onfront}"

# The LIVE incident, read off the deployed runtime/ files. This is the ticket's
# "prove on the live frozen incident" for the decision half: the same evidence
# that has been sitting frozen for a week must produce an anchor.
live_state = M.compute()
if live_state.get("ok") and live_state.get("stalled"):
    live = I.breakout_anchor(live_state)
    assert live is not None, \
        f"A10: the live stall {live_state.get('mode')}@{live_state.get('modeLocation')} " \
        f"produced no breakout anchor"
    print(f"A10 live: anchor stallMap={live['stallMap']} target={live['targetMap']} "
          f"newTiles={live['newTiles']}/{MAXNEW} budget={live['budgetTurns']}t")
else:
    live = None
    print("A10 live: not stalled right now — synthetic sections still apply")


# ---- B: the ladder, and that it cannot thrash ------------------------------
sm = samples(WINDOW, 35, first_turn=1000)
patched = {"progress": sm, "frontier": FRONTIER}
_real_progress, _real_frontier = M.load_progress, I._frontier
M.load_progress = lambda *a, **k: patched["progress"]
I._frontier = lambda *a, **k: patched["frontier"]
try:
    # attempts 1..K intervene normally, on the ordinary prescription.
    for n in range(I.K):
        r = I.decide(state=copy.deepcopy(STATE), log=fresh_log(n), now_ms=1)
        assert r["intervened"] and r.get("rung") is None, f"B1: attempt {n + 1} {r}"

    # K spent -> exactly one BREAKOUT.
    log = fresh_log(I.K)
    r = I.decide(state=copy.deepcopy(STATE), log=log, now_ms=1)
    assert r.get("rung") == "breakout" and r["intervened"], f"B2: expected breakout, got {r}"
    d = r["directive"]
    assert I.breakout_entry(log, "FIGHT_LOSS_LOOP@3") is not None, "B3: breakout not logged"

    # Kill-criterion 2: a second supervisor tick inside the budget re-emits the
    # SAME directive and never appends a second breakout.
    before = len(log["attempts"])
    r2 = I.decide(state=copy.deepcopy(STATE), log=log, now_ms=2)
    assert not r2["intervened"] and r2["rung"] == "breakout", f"B4: {r2}"
    assert r2["directive"] == d, "B5: an in-flight breakout must not be restated"
    assert len(log["attempts"]) == before, "B6: a second breakout was appended"

    # Kill-criterion 3: past the budget, the ladder ends — HANDOFF, not another
    # breakout, no matter how many more ticks arrive.
    patched["progress"] = samples(WINDOW, 35, first_turn=d["expiresAtTurn"])
    for _ in range(3):
        r3 = I.decide(state=copy.deepcopy(STATE), log=log, now_ms=3)
        assert r3["rung"] == "handoff" and not r3["intervened"], f"B7: {r3}"
    assert len(log["attempts"]) == before, "B8: the handoff must append nothing"

    # A restart mid-budget also ends it: the directive was consumed at that boot.
    log2 = fresh_log(I.K)
    I.decide(state=copy.deepcopy(STATE), log=log2, now_ms=1)
    patched["progress"] = samples(WINDOW, 35, first_turn=1)      # turn counter reset
    assert I.decide(state=copy.deepcopy(STATE), log=log2, now_ms=2)["rung"] == "handoff", \
        "B9: a run restart must retire the breakout it was written for"

    # Kill-criterion 1 at the ladder level: no anchor => no breakout, and the
    # standing requirement keeps being refreshed instead.
    patched["progress"] = samples(WINDOW, 35, MAXNEW + 1)
    r4 = I.decide(state=copy.deepcopy(STATE), log=fresh_log(I.K), now_ms=1)
    assert r4.get("rung") is None and r4["exhausted"] and r4["directive"], f"B10: {r4}"
    assert r4["directive"]["action"] == "grind_sub_objective", f"B11: {r4['directive']}"

    # A breakout that WORKED does not disable the rung forever (breakout_entry).
    worked = fresh_log(I.K)
    patched["progress"] = sm
    I.decide(state=copy.deepcopy(STATE), log=worked, now_ms=1)
    for e in worked["attempts"]:
        e["outcome"] = "advanced"
    assert I.breakout_entry(worked, "FIGHT_LOSS_LOOP@3") is None, \
        "B12: an advanced breakout must not stay spent"

    # ---- C: the directive is bounded and non-destructive -------------------
    assert d["action"] == "breakout_leave_map", f"C1: {d['action']}"
    assert d["staleMapGotoBan"] == 35 and d["gotoBan"] == [], \
        "C2: the map-local ban must not be written as a warp ban"
    assert d["expiresAtTurn"] == d["issuedAtTurn"] + d["budgetTurns"], f"C3: {d}"
    assert d["exhausted"] is True and d["rung"] == "breakout", f"C4: {d}"
    for word in ("restore", "reset", "checkpoint", "flee", "run away", "heal"):
        assert word not in d["notepadPin"].lower(), \
            f"C5: the breakout must prescribe nothing destructive — found '{word}'"
    for exit_tool in ("leave_edge", "enter_warp"):
        assert exit_tool in d["notepadPin"], f"C6: the pin must name the exit {exit_tool}"
    assert "map35" in d["notepadPin"] or "35" in d["notepadPin"], "C7: name the cage"

    patched["progress"] = samples(WINDOW, 35, first_turn=d["expiresAtTurn"])
    h = I.decide(state=copy.deepcopy(STATE), log=log, now_ms=3)["directive"]
    assert h["action"] == "handoff_operator", f"C8a: {h['action']}"
    assert h["gotoBan"] == [] and "staleMapGotoBan" not in h, \
        "C8: kill-criterion 4 — a failed breakout must leave no live restriction"
    assert h["handoff"]["locationKey"] == "FIGHT_LOSS_LOOP@3", f"C9: {h}"
finally:
    M.load_progress, I._frontier = _real_progress, _real_frontier


# ---- D: the wrapper actually persists what decide() computed ---------------
sup = open(os.path.join(HERE, "lpp-stuck-supervisor")).read()
assert re.search(r'if decision\.get\("directive"\):', sup), \
    "D1: lpp-stuck-supervisor must gate the directive write on the DIRECTIVE. " \
    "Gating on `intervened` is why runtime/supervisor_directive.json sat " \
    "unchanged from 2026-08-29 while the supervisor ticked for 167.9h."
assert '"rung"' in sup, "D2: the wrapper should surface which rung fired"


# ---- E: the harness consumes it, and not only at boot ---------------------
agent = open(os.path.join(REPO, "src", "agent.ts")).read()
assert "staleMapGotoBan" in agent, "E1: agent.ts does not read the breakout ban"
assert "supervisorStaleMap" in agent and "goto: refused" in agent, \
    "E2: goto must be refused while standing on the stale map"
assert "refreshSupervisorDirective" in agent and "supervisorMtimeMs" in agent, \
    "E3: a directive written mid-run must reach a running agent, not wait for a boot"
assert re.search(r"this\.refreshSupervisorDirective\(\);", agent), \
    "E4: the reload must be wired into the per-dispatch path"
# The exits the pin promises have to remain open: the ban is checked inside
# `case "goto"`, never in the enter_warp or leave_edge arms.
goto_arm = agent.split('case "goto"', 1)[1].split('case "', 1)[0]
assert "supervisorStaleMap" in goto_arm, "E5: the ban must live in the goto arm"
for arm in ('case "enter_warp"', 'case "leave_edge"'):
    seg = agent.split(arm, 1)
    if len(seg) > 1:
        assert "supervisorStaleMap" not in seg[1].split('case "', 1)[0], \
            f"E6: {arm} must stay open — it is the way out the pin prescribes"

print("test_stuck1563: ALL PASS (5 sections, A-E)")
