#!/usr/bin/env python3
"""test_stuck1826 — the WARP_OSC ban must be the edge the classifier detected.

Run:  python3 tools/test_stuck1826.py
No service, no network. The live warp history is replaced by a temp file for
every section, so nothing here reads or writes real runtime state.

The stall: WARP_OSC@36 frozen 242.7h (since 2026-09-02), three
checkpoint_restore_then_goto_ban attempts, all superseded. The directive's own
evidence named the bounce "Route 25 <-> Bills House" while its gotoBan named
[Cerulean City, Route 25] — a ban resolved from a 4x wider window's two most
frequent maps rather than from the oscillation's endpoints. It banned the only
heal point and the city holding the objective gym, never banned the doorway
being re-entered, and (banning both sides) would seal the agent inside Bills
House, whose only exit warp lands on Route 25.
"""
import json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_intervene as I
import lpp_stuck_mode as M

names = M.load_map_names()
tmpdir = tempfile.mkdtemp(prefix="stuck1826-")


def use_warps(warps):
    """Point the intervention layer's warp-history read at a temp file."""
    p = os.path.join(tmpdir, "warp_history.json")
    with open(p, "w") as f:
        json.dump({"v": 1, "warps": warps}, f)
    I.WARP_HISTORY = p


def stalled_state(mode, location):
    return {"ok": True, "stalled": True, "mode": mode, "modeLocation": location,
            "storyScore": 10, "badges": 1, "eventFlags": 48, "map": location,
            "generatedAt": "2026-09-12T09:53:00Z"}


# runtime/warp_history.json verbatim at the moment ticket wq#1826 was appended
# (2026-09-12T09:53Z): five distinct maps across the 64-warp window, the last
# several alternating 88 <-> 36.
LIVE = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 36, 36, 36, 36, 36, 36, 36, 67, 3,
        67, 3, 67, 3, 3, 3, 64, 3, 67, 3, 67, 3, 64, 3, 64, 3, 88, 36, 36, 64, 3,
        64, 3, 36, 36, 64, 3, 88, 36, 36, 88, 36, 36, 36, 64, 3, 64, 3, 88, 36, 88, 36]

# --- A: the live window classifies as a genuine two-map oscillation ---------
mode, ev, loc = M.classify_mode(LIVE, [], names)
assert mode == "WARP_OSC", f"A1: expected WARP_OSC, got {mode}"
assert loc == 36, f"A2: incident should anchor on Route 25 (map36), got {loc}"
hit, a, b, alt = M.detect_warp_osc(LIVE)
assert hit and a == 36 and b == 88, f"A3: edge should be 36<->88, got {a}<->{b}"
print(f"A: live window -> {mode}@{loc}, edge {M.map_label(a, names)} <-> {M.map_label(b, names)}")

# --- B: the old wide-window resolver disagreed with that evidence ----------
use_warps(LIVE)
old = I._resolve_loop_maps()
assert old == [3, 36], f"B1: reproduce the shipped ban, got {old}"
assert b not in old, "B2: the old ban never contained the map being re-entered"
assert M.is_heal_or_city(3, names), "B3: map3 is the heal/hub the old ban forbade"
print(f"B: wide-window resolver bans {[M.map_label(m, names) for m in old]} — neither is the far endpoint")

# --- C: the new resolver bans exactly the far side of the detected edge ----
ban, here, there = I._resolve_osc_ban(36)
assert ban == [88], f"C1: expected [88], got {ban}"
assert (here, there) == (36, 88), f"C2: endpoints should be (36, 88), got {(here, there)}"
assert here not in ban, "C3: never ban the map the agent is standing on (no seal-in)"
assert set(ban) <= {a, b}, "C4: the ban must be a subset of the detected edge"
print(f"C: edge resolver bans {[M.map_label(m, names) for m in ban]} only")

# --- D: a heal/hub far side is dropped, not banned (wq#1081/#1084) ---------
# Bounce between Route 24 (35) and Cerulean City (3), standing on the route.
use_warps([3, 35] * 8)
ban_hub, here_hub, there_hub = I._resolve_osc_ban(35)
assert (here_hub, there_hub) == (35, 3), f"D1: endpoints should be (35, 3), got {(here_hub, there_hub)}"
assert ban_hub == [], f"D2: the only heal point must never be banned, got {ban_hub}"
print("D: heal/hub far side -> no ban, pin only")

# --- E: a ban resolved off a window that has moved on is no ban -----------
use_warps(LIVE)
ban_stale, _, _ = I._resolve_osc_ban(88)
assert ban_stale == [], f"E1: location/window mismatch must not ban, got {ban_stale}"
print("E: stale window (location no longer the edge's near side) -> no ban")

# --- F: end to end, the directive's ban and its prose agree ---------------
use_warps(LIVE)
log = {"v": 1, "attempts": []}
r = I.decide(state=stalled_state("WARP_OSC", 36), log=log)
d = r["directive"]
assert d["gotoBan"] == [88], f"F1: directive should ban [88], got {d['gotoBan']}"
pin = d["notepadPin"]
assert "Route 25 (map36) <-> Bills House (map88)" in pin, f"F2: pin must name the edge: {pin}"
assert "Bills House (map88) is BANNED" in pin, f"F3: pin must name the ban: {pin}"
assert "Cerulean" not in pin and "(map3)" not in pin, \
    f"F4: the heal hub has no business in this pin: {pin}"
json.dumps(d)
print("F: directive bans the far endpoint and its pin names the same edge")

# --- G: no edge, no ban — and the pin still renders ------------------------
use_warps([60] * 20)
log = {"v": 1, "attempts": []}
r = I.decide(state=stalled_state("WARP_OSC", 60), log=log)
assert r["directive"]["gotoBan"] == [], "G1: a self-bounce has no edge to ban"
assert "No map is banned" in r["directive"]["notepadPin"], "G2: the pin must say so"
print("G: self-bounce (no edge) -> empty ban, pin explains why")

# --- H: NAV_LOOP's own resolution is untouched ----------------------------
use_warps([59, 60, 61] * 8)
log = {"v": 1, "attempts": []}
r = I.decide(state=stalled_state("NAV_LOOP", 59), log=log)
assert r["directive"]["gotoBan"] == [59, 60, 61], \
    f"H1: NAV_LOOP still bans the collapsed set, got {r['directive']['gotoBan']}"
assert "map59,map60,map61" in r["directive"]["notepadPin"], "H2: NAV_LOOP pin unchanged"
print("H: NAV_LOOP resolution unchanged")

# --- I: the exhausted directive still formats and still drops the ban -----
use_warps(LIVE)
log = {"v": 1, "attempts": []}
for _ in range(4):
    r = I.decide(state=stalled_state("WARP_OSC", 36), log=log)
assert r.get("exhausted") is True, "I1: 4th call must exhaust"
assert r["directive"]["gotoBan"] == [], "I2: exhausted drops the ban"
assert "EXHAUSTED after 3/3" in r["directive"]["notepadPin"], "I3: exhausted pin label"
assert len(log["attempts"]) == 3, f"I4: exhausted appends nothing, got {len(log['attempts'])}"
print("I: exhausted path formats, bans nothing, appends nothing")

# --- J: K counts tries of the CURRENT remedy, not of the broken one -------
# The live log's three WARP_OSC@36 attempts (2026-08-28, all superseded) were
# spent under rev 1. Without the refund the corrected remedy could never be
# issued for this key at all: the classifier still names WARP_OSC@36, so those
# entries can never close as "advanced", and decide() answers exhausted forever.
use_warps(LIVE)
legacy = {"v": 1, "attempts": [
    {"ts": 1787944730325.0, "mode": "WARP_OSC", "locationKey": "WARP_OSC@36",
     "attempt": n, "directive": {}, "beforeState": {"storyScore": 10},
     "afterState": {"storyScore": 10}, "outcome": "superseded"} for n in (1, 2, 3)]}
assert I.open_attempt_count(legacy, "WARP_OSC@36") == 3, "J1: history still counts as history"
assert I.open_attempt_count(legacy, "WARP_OSC@36", rev=2) == 0, "J2: none were tries of rev 2"
r = I.decide(state=stalled_state("WARP_OSC", 36), log=legacy)
assert r["intervened"] is True and r["attempt"] == 1, \
    f"J3: the corrected remedy gets a fresh budget, got {r.get('attempt')}/{r.get('exhausted')}"
assert r["directive"]["gotoBan"] == [88], "J4: and it bans the edge"
assert legacy["attempts"][-1]["rev"] == 2, "J5: new attempts are stamped with the rev they tried"
# a mode whose prescription did not change keeps its spent budget
spent = {"v": 1, "attempts": [
    {"ts": 1.0, "mode": "FIGHT_LOSS_LOOP", "locationKey": "FIGHT_LOSS_LOOP@3",
     "attempt": n, "directive": {}, "beforeState": {"storyScore": 10},
     "afterState": {"storyScore": 10}, "outcome": "superseded"} for n in (1, 2, 3)]}
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=spent)
assert r.get("exhausted") is True, "J6: an unchanged prescription keeps its spent K"
print("J: rev bump refunds K for WARP_OSC only; unchanged modes stay exhausted")

print("\ntest_stuck1826: 10 sections A-J OK")
