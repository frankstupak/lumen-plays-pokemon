#!/usr/bin/env python3
# wq#520 backtest: replay every event log as if the sentinel ticked every 10
# minutes, and count how often the new stall checks would have fired.
#
# Checking only the END of a log would be a weak test -- it asks "is the agent
# stuck right now", not "would this detector have caught the stall while it was
# happening". This replays wall-clock ticks and applies the real 1h dedupe, so
# the output is an episode count a human can compare against what the campaign
# actually did on those days.
#
# Usage: tools/backtest_520.py [--min-static-turns N] [--stall-minutes M]
import argparse, glob, gzip, json, os, sys
from datetime import datetime, timedelta, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SENT = os.path.join(BASE, "tools", "lpp-sentinel")
# The event history lives in the PRIMARY tree. A worktree has its own tools/ but
# no events/, so the directory is a parameter rather than an assumption --
# symlinking events/ into a worktree would put an untracked link one careless
# `git add` away from the commit.
DEFAULT_EVENTS = "/home/lumen/pokemon/events"

# Load the sentinel as a module without running main(). Same technique
# verify_489.py uses, and for the same reason: the checks are the unit under
# test, not the CLI.
src = open(SENT).read().replace('if __name__ == "__main__":\n    sys.exit(main())', "")
mod = type(sys)("lppsent")
mod.__dict__["__name__"] = "lppsent"
exec(compile(src, SENT, "exec"), mod.__dict__)

TICK_MIN = 10          # the real timer interval
DEDUPE_MIN = 60        # the real dedupe window


def load(p):
    op = (lambda x: gzip.open(x, "rt")) if p.endswith(".gz") else open
    out = []
    try:
        for line in op(p):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    except Exception:
        return []
    return out


def ts(e):
    try:
        return datetime.fromisoformat(str(e.get("t")).replace("Z", "+00:00"))
    except Exception:
        return None


def replay(evs, min_turns, stall_min):
    """Tick every TICK_MIN of wall clock; return (episodes, peak_streak, peak_min)."""
    stamped = [(ts(e), e) for e in evs]
    stamped = [(t, e) for t, e in stamped if t is not None]
    if not stamped:
        return {}, 0, 0.0
    t0, tend = stamped[0][0], stamped[-1][0]
    fired = {}                 # key -> list of datetimes it fired
    last_fired = {}
    peak_turns, peak_min = 0, 0.0
    t = t0
    while t <= tend + timedelta(minutes=TICK_MIN):
        window = [e for tt, e in stamped if tt <= t]
        if window:
            # staleness is disabled for the backtest: we are asking whether the
            # SHAPE was detectable at that instant, and in replay "now" is the
            # tick, not the real clock the check would read.
            n, first, last = mod._standing_still(window)
            if n > peak_turns:
                peak_turns = n
            if first is not None and last is not None:
                a, b = ts(first), ts(last)
                if a and b:
                    held = (b - a).total_seconds() / 60.0
                    peak_min = max(peak_min, held)
                    hits = []
                    if n >= min_turns:
                        hits.append("no_progress")
                    if n >= 2 and held >= stall_min:
                        hits.append("wallclock_stall")
                    for key in hits:
                        prev = last_fired.get(key)
                        if prev is None or (t - prev).total_seconds() / 60.0 >= DEDUPE_MIN:
                            fired.setdefault(key, []).append(t)
                            last_fired[key] = t
        t += timedelta(minutes=TICK_MIN)
    return fired, peak_turns, peak_min


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-static-turns", type=int, default=4)
    ap.add_argument("--stall-minutes", type=float, default=10.0)
    ap.add_argument("--events-dir", default=DEFAULT_EVENTS,
                    help="directory holding live-agent-*.jsonl[.gz] history")
    args = ap.parse_args()

    files = sorted(glob.glob(f"{args.events_dir}/live-agent-*.jsonl")) + \
            sorted(glob.glob(f"{args.events_dir}/live-agent-*.jsonl.gz"))
    if not files:
        print(f"no logs under {args.events_dir}", file=sys.stderr)
        return 2
    print(f"wq#520 backtest — min_static_turns={args.min_static_turns} "
          f"stall_minutes={args.stall_minutes} tick={TICK_MIN}m dedupe={DEDUPE_MIN}m")
    print(f"{'log':38s} {'turns':>6s} {'peakStatic':>11s} {'peakMin':>8s} "
          f"{'no_prog':>8s} {'wallclk':>8s}")
    tot_np = tot_wc = 0
    for p in files:
        evs = load(p)
        turns = sum(1 for e in evs if e.get("kind") == "turn_summary")
        fired, pk, pm = replay(evs, args.min_static_turns, args.stall_minutes)
        np_n = len(fired.get("no_progress", []))
        wc_n = len(fired.get("wallclock_stall", []))
        tot_np += np_n
        tot_wc += wc_n
        print(f"{os.path.basename(p)[:38]:38s} {turns:6d} {pk:11d} {pm:8.0f} "
              f"{np_n:8d} {wc_n:8d}")
    print(f"{'TOTAL':38s} {'':6s} {'':11s} {'':8s} {tot_np:8d} {tot_wc:8d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
