#!/usr/bin/env python3
"""test_stuck1660 — brain-unreachable is its own stuck mode, ahead of everything.

Run:  python3 tools/test_stuck1660.py
No service, no network: a scratch LPP_BASE and a scratch AQ_DB, every timestamp
explicit.

THE INCIDENT (M2/E6, foreman/research/LPP_BEHAVIORAL_ANALYSIS.md): Sep 3-9 the
run had no working brain rung at all — 45,965 "Budget has been exceeded" 4xx —
and the supervisor classified the frozen warp window as FIGHT_LOSS_LOOP 9,200
times, prescribing grind pins to a brain that could not read them. The fix has
two halves: src/live_agent.ts writes runtime/brain_unreachable.json while it
holds (heartbeat ~60s), and this module (a) classifies a FRESH signal as
BRAIN_UNREACHABLE before any history-based mode, (b) opens/bumps the aq row
the wq#965 responder escalates (source='probe', priority='high', count>=3 =>
one P0 ticket + one page).

Sections: A fresh signal preempts a loop-shaped warp history. B a stale
heartbeat classifies nothing (the outage is over or the writer is dead). C no
file, no mode. D fresh signal preempts even before the wall-clock window is
spent. E the aq row: upsert bumps, resolve edge-clears, a new outage is a NEW
row. F the mode is first in MODES.
"""
import json, os, sqlite3, sys, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="stuck1660-")
os.environ["LPP_BASE"] = TMP          # must precede the import: module paths bake at import time
os.environ["AQ_DB"] = f"{TMP}/alerts.db"
sys.path.insert(0, HERE)
import lpp_stuck_mode as M

passed = failed = 0
def chk(name, ok, detail=""):
    global passed, failed
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" :: {detail}" if detail else ""))
    if ok: passed += 1
    else: failed += 1

NOW = 1_800_000_000_000          # fixed epoch ms
H = 3_600_000

def iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

def write_base(sidecar_ts):
    os.makedirs(f"{TMP}/checkpoints", exist_ok=True)
    os.makedirs(f"{TMP}/runtime", exist_ok=True)
    with open(f"{TMP}/checkpoints/a.json", "w") as f:
        json.dump({"ts": sidecar_ts, "storyScore": 40, "badges": 2, "events": 45, "map": 36}, f)

def write_signal(updated_ms, since_ms=None):
    with open(f"{TMP}/runtime/brain_unreachable.json", "w") as f:
        json.dump({"since": iso(since_ms or updated_ms - H), "updatedAt": iso(updated_ms),
                   "lastError": "gateway 400: Budget has been exceeded",
                   "rungs": [{"model": "cerebras-oss-120b", "error": "gateway 400: budget"}]}, f)

def rm_signal():
    try: os.unlink(f"{TMP}/runtime/brain_unreachable.json")
    except FileNotFoundError: pass

# A loop-shaped warp window that would otherwise classify (gym map 65 absent
# from scratch names, so it lands in NAV_LOOP/IDLE territory — the point is
# only that it is NOT BRAIN_UNREACHABLE without the signal).
WARPS = [36, 35, 36, 35, 36, 35, 36, 35]

def run_compute():
    return M.compute(base=TMP, now_ms=NOW, warps=list(WARPS), resume_picks=[],
                     names={}, progress=[])

# --- A: fresh signal preempts everything ------------------------------------
write_base(NOW - 6 * H)          # frozen 6h > 2h window: wall-clock stalled
write_signal(NOW - 2 * 60_000)   # heartbeat 2 min ago: fresh
st = run_compute()
chk("A1 fresh signal classifies BRAIN_UNREACHABLE", st.get("mode") == "BRAIN_UNREACHABLE", str(st.get("mode")))
chk("A2 stalled on the brain axis", st.get("stalled") is True and st.get("stallAxis") == "brain",
    f"stalled={st.get('stalled')} axis={st.get('stallAxis')}")
chk("A3 evidence carries the gateway error and the since timestamp",
    "Budget has been exceeded" in (st.get("modeEvidence") or "") and "since" in (st.get("modeEvidence") or ""),
    (st.get("modeEvidence") or "")[:90])
chk("A4 anchored on the run's latest map", st.get("modeLocation") == 36, str(st.get("modeLocation")))

# --- B: stale heartbeat classifies nothing -----------------------------------
write_signal(NOW - 20 * 60_000)  # 20 min > the 10-min freshness bar
st = run_compute()
chk("B1 stale signal does NOT classify BRAIN_UNREACHABLE", st.get("mode") != "BRAIN_UNREACHABLE", str(st.get("mode")))
chk("B2 the ordinary classifier runs instead (still stalled, some mode set)",
    st.get("stalled") is True and st.get("mode") in M.MODES, str(st.get("mode")))

# --- C: no file, no mode ------------------------------------------------------
rm_signal()
st = run_compute()
chk("C1 absent signal never classifies BRAIN_UNREACHABLE", st.get("mode") != "BRAIN_UNREACHABLE", str(st.get("mode")))

# --- D: preempts BEFORE the wall-clock window is spent ------------------------
write_base(NOW - 10 * 60_000)    # frozen only 10 min: NOT wall-clock stalled
write_signal(NOW - 60_000)
st = run_compute()
chk("D1 a live outage does not wait out the 2h freeze window",
    st.get("mode") == "BRAIN_UNREACHABLE" and st.get("stalled") is True,
    f"mode={st.get('mode')} stalled={st.get('stalled')}")
rm_signal()
st = run_compute()
chk("D2 without the signal the same young freeze is not stalled at all",
    st.get("stalled") is False, str(st.get("stalled")))

# --- E: the aq row (the wq#965 page path) -------------------------------------
fake_state = {"mode": "BRAIN_UNREACHABLE", "modeEvidence": "every brain rung terminal since X: gateway 400"}
r1 = M.open_aq_row(fake_state)
r2 = M.open_aq_row(fake_state)
r3 = M.open_aq_row(fake_state)
chk("E1 three ticks upsert ONE row", r1 == r2 == r3 and r1 is not None, f"{r1},{r2},{r3}")
c = sqlite3.connect(os.environ["AQ_DB"])
row = c.execute("SELECT source, key, priority, count, status FROM alerts WHERE id=?", (r1,)).fetchone()
chk("E2 row matches the wq#965 responder predicate at the escalation bar",
    row == ("probe", "lpp-brain-unreachable", "high", 3, "open"), str(row))
resolved = M.resolve_aq_row()
row = c.execute("SELECT status, resolved_ts FROM alerts WHERE id=?", (r1,)).fetchone()
chk("E3 recovery edge-clears the open row", resolved == r1 and row[0] == "resolved" and row[1],
    f"resolved={resolved} row={row}")
chk("E4 resolving again is a no-op", M.resolve_aq_row() is None)
r4 = M.open_aq_row(fake_state)
chk("E5 a NEW outage is a NEW row (a new outage deserves a new page)", r4 != r1, f"{r1} vs {r4}")
c.close()

# --- F: mode registry ---------------------------------------------------------
chk("F1 BRAIN_UNREACHABLE is first in MODES, ahead of FIGHT_LOSS_LOOP",
    M.MODES.index("BRAIN_UNREACHABLE") == 0 and M.MODES.index("FIGHT_LOSS_LOOP") == 1,
    str(M.MODES[:2]))

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{passed} PASS / {failed} FAIL")
sys.exit(1 if failed else 0)
