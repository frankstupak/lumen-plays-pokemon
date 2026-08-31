#!/usr/bin/env python3
"""verify_671 — offline proof for the wq#671 story_score/state stall + MODE
classifier (tools/lpp_stuck_mode.py).

Run:  python3 tools/verify_671.py
No service, no network, no writes outside a temp dir + /tmp.

Mirrors tools/probe_frontier.py's shape: synthetic checkpoint sidecars in a
temp tree exercise compute() end-to-end; classify_mode() is also unit-tested
directly for MODE priority, since building a fake pathExhausted case through
the real lpp_frontier engine would mean faking an entire CRITICAL_PATH walk
for no extra coverage.

The FIGHT_LOSS_LOOP case uses an INLINE literal copy of the live 43h stall's
runtime/warp_history.json (captured 2026-08-17) rather than reading the file
live, per src/fixtures.ts's own doctrine: checkpoint/state rotation is normal,
so a regression test that depends on today's exact runtime/ contents is a
test with an undocumented expiry date. A SECOND, SKIP-shaped check at the
bottom also tries the live corpus, for a "did this still reproduce against
the real campaign" sanity signal that never fails the suite on its own.
"""
import json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_mode as M

PASS = FAIL = SKIP = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}{('  ' + detail) if detail else ''}")


def skip(label, detail=""):
    global SKIP
    SKIP += 1
    print(f"SKIP  {label}{('  ' + detail) if detail else ''}")


H = 3_600_000
T0 = 1_786_000_000_000
NAMES = M.load_map_names()
ok("map_names.json loaded", len(NAMES) > 200, f"got {len(NAMES)} entries")


def fixture(sidecars):
    """sidecars: [(hours_from_T0, storyScore, badges, events)]."""
    d = tempfile.mkdtemp(prefix="stuck_mode_probe_")
    os.makedirs(f"{d}/checkpoints", exist_ok=True)
    for i, (h, ss, b, e) in enumerate(sidecars):
        json.dump({"v": 3, "kind": "periodic", "map": 3, "x": 19, "y": 18,
                   "storyScore": ss, "badges": b, "events": e,
                   "ts": int(T0 + h * H)},
                  open(f"{d}/checkpoints/auto-p{i:03d}.json", "w"))
    return d


def state(d, at_h, window=2.0, warps=None, resume_picks=None):
    return M.compute(base=d, window_h=window, now_ms=int(T0 + at_h * H),
                      warps=warps, resume_picks=resume_picks, names=NAMES)


# ── 1. classify_mode unit tests: MODE priority and shape, RED + GREEN ──────
print("\n-- classify_mode: priority and shape --")

# GREEN: the live 43h stall's actual warp_history.json (wq#517), captured
# 2026-08-17T20:15Z, inlined verbatim so checkpoint rotation can't erode this.
LIVE_43H_WARPS = [
    64, 3, 3, 65, 3, 65, 3, 65, 3, 65, 3, 65, 3, 3, 3, 3, 3, 3, 3, 64, 3, 64,
    3, 64, 3, 64, 3, 64, 3, 64, 3, 64, 3, 64, 3, 64, 3, 64, 3, 64, 3, 64, 3,
    65, 3, 64, 3, 64, 3, 3, 3, 3, 3, 3, 64, 3, 64, 3, 64, 3, 3, 3, 3, 3,
]
mode, ev, _loc = M.classify_mode(LIVE_43H_WARPS, [], NAMES)
ok("live 43h warp fixture classifies FIGHT_LOSS_LOOP", mode == "FIGHT_LOSS_LOOP", f"got {mode} :: {ev}")
ok("evidence names Cerulean Gym", "Cerulean Gym" in ev, ev)
ok("evidence names Cerulean City", "Cerulean City" in ev, ev)

# RED: healthy travel through many distinct maps, no gym repeat.
travel = [3, 15, 59, 60, 61, 60, 59, 15, 3]
mode, ev, _loc = M.classify_mode(travel, [], NAMES)
ok("healthy multi-map travel does not classify FIGHT_LOSS_LOOP", mode != "FIGHT_LOSS_LOOP", mode)

# RED->GREEN: a gym visited once (walked past, or one clean win) is NOT a loop.
one_visit = [3, 65, 3, 15, 59]
mode, ev, _loc = M.classify_mode(one_visit, [], NAMES)
ok("single gym visit does not classify FIGHT_LOSS_LOOP", mode != "FIGHT_LOSS_LOOP", mode)

# GREEN: two non-gym overworld maps bouncing, no healing signature — a map
# loop, not a fight or a resume deadend. wq#697 split this shape out of
# NAV_LOOP into the more specific WARP_OSC (a clean A<->B alternation has an
# edge to ban; NAV_LOOP now covers the looser <=3-map collapse), so this check
# has been red since that mode landed. Accept either — what wq#671 asserts here
# is that a plain dungeon bounce is a map loop, and both modes say so.
nav = [59, 60, 59, 60, 59, 60, 59, 60]
mode, ev, _loc = M.classify_mode(nav, [], NAMES)
ok("non-gym 2-map bounce classifies as a map loop (NAV_LOOP or wq#697 WARP_OSC)",
   mode in ("NAV_LOOP", "WARP_OSC"), f"got {mode} :: {ev}")

# GREEN: RESUME_DEADEND — same resumedFrom on the last 2 consecutive boots,
# takes priority even over an in-progress warp trail.
resumes = [{"file": "auto-x-map3.state.gz"}, {"file": "auto-x-map3.state.gz"}]
mode, ev, _loc = M.classify_mode([3, 15, 59], resumes, NAMES)
ok("repeated resumedFrom classifies RESUME_DEADEND", mode == "RESUME_DEADEND", f"got {mode} :: {ev}")

# RED: resumes alternate between two DIFFERENT checkpoints -> not a deadend by
# this definition (matches lpp_frontier.restart_loop's own "consecutive" bar,
# and matches the live fixture's own resume_history.json shape, which
# alternates map3/map65 rather than repeating one file).
alt_resumes = [{"file": "auto-a-map3.state.gz"}, {"file": "auto-b-map65.state.gz"},
               {"file": "auto-a-map3.state.gz"}]
mode, ev, _loc = M.classify_mode(LIVE_43H_WARPS, alt_resumes, NAMES)
ok("alternating resumes do not mask FIGHT_LOSS_LOOP", mode == "FIGHT_LOSS_LOOP", f"got {mode} :: {ev}")

# GREEN: OBJECTIVE_UNREACHABLE — path_exhausted flag, no gym/nav signature.
mode, ev, _loc = M.classify_mode([3, 15], [], NAMES, path_exhausted=True)
ok("pathExhausted with no loop signature classifies OBJECTIVE_UNREACHABLE",
   mode == "OBJECTIVE_UNREACHABLE", f"got {mode} :: {ev}")

# GREEN: IDLE — no warps recorded at all.
mode, ev, _loc = M.classify_mode([], [], NAMES)
ok("zero warps classifies IDLE", mode == "IDLE", f"got {mode} :: {ev}")

# ── 2. compute(): story_score axis stall/no-stall, end to end ─────────────
print("\n-- compute(): story_score axis --")

# GREEN: flat storyScore/badges/events for 5h, window 2h -> stalled, and MODE
# gets classified using the live 43h warp fixture passed straight through.
flat = fixture([(0, 10, 1, 37), (1, 10, 1, 37), (3, 10, 1, 37), (5, 10, 1, 37)])
st = state(flat, at_h=5, warps=LIVE_43H_WARPS)
ok("flat story_score over the window is stalled", st["stalled"], json.dumps(st))
ok("frozenHours matches the gap since the last real advance", abs(st["frozenHours"] - 5.0) < 0.01, st["frozenHours"])
ok("mode fires FIGHT_LOSS_LOOP end-to-end through compute()", st.get("mode") == "FIGHT_LOSS_LOOP", st.get("mode"))
ok("storyScore reported is the PRIMARY axis value", st["storyScore"] == 10, st["storyScore"])

# RED: storyScore rose inside the window -> not stalled, mode stays None.
rising = fixture([(0, 8, 1, 30), (1, 9, 1, 33), (1.5, 10, 1, 37)])
st = state(rising, at_h=1.5, warps=LIVE_43H_WARPS)
ok("rising story_score inside the window is not stalled", not st["stalled"], json.dumps(st))
ok("mode is not classified when not stalled", st.get("mode") is None, st.get("mode"))

# RED: a badge-only rise (storyScore flat) still resets the clock — "game
# state" axis, not story_score alone, per the spec's own wording.
badge_rise = fixture([(0, 10, 0, 37), (1, 10, 1, 37)])
st = state(badge_rise, at_h=1, warps=LIVE_43H_WARPS)
ok("badge rise alone counts as an advance", not st["stalled"], json.dumps(st))

# RED: a genuinely slow but real 1.5h gap under the 2h window stays silent —
# the window must not be so tight it fires on ordinary play.
slow = fixture([(0, 9, 1, 33), (1.5, 10, 1, 37)])
st = state(slow, at_h=1.5, warps=LIVE_43H_WARPS)
ok("a sub-window gap after a real advance is not stalled", not st["stalled"], json.dumps(st))

# ── 3. degrade-gracefully cases ────────────────────────────────────────────
print("\n-- graceful degradation --")
empty_dir = tempfile.mkdtemp(prefix="stuck_mode_probe_empty_")
os.makedirs(f"{empty_dir}/checkpoints", exist_ok=True)
st = M.compute(base=empty_dir)
ok("no sidecars on disk reports ok:false, never raises", st.get("ok") is False, json.dumps(st))

st = state(flat, at_h=5, warps=[])
ok("no warp_history at all classifies IDLE, not a crash", st.get("mode") == "IDLE", st.get("mode"))

# ── 4. live corpus sanity (SKIP-shaped, corpus-rot tolerant) ──────────────
print("\n-- live corpus (informational, never fails the suite) --")
try:
    live = M.compute()
except Exception as e:
    live = {"ok": False, "reason": f"{type(e).__name__}: {e}"}
if not live.get("ok"):
    skip("live corpus unreadable", live.get("reason"))
elif not live.get("stalled"):
    skip("live corpus is no longer stalled", "the campaign has moved on since 2026-08-17 — expected eventually")
elif live.get("mode") != "FIGHT_LOSS_LOOP":
    skip("live corpus stall no longer classifies FIGHT_LOSS_LOOP",
         f"got {live.get('mode')} — corpus/warp_history.json has rotated past the captured incident")
else:
    ok("live corpus still reproduces FIGHT_LOSS_LOOP @ Cerulean Gym", True)

print(f"\n{PASS}/{PASS + FAIL} passed" + (f", {SKIP} skipped" if SKIP else ""))
sys.exit(1 if FAIL else 0)
