#!/usr/bin/env python3
"""lpp_stuck_mode — story_score/state stall detector + MODE classifier (wq#671).

WHY THIS EXISTS
  `lpp_frontier.py` (wq#515) answers "has the game moved forward" on the
  CRITICAL-PATH-RANK axis, badges + furthest overworld/dungeon map. That axis
  missed the 2026-08-17 incident completely: the agent reached Route 25
  (rank 13, a side detour), which out-ranks Cerulean Gym itself (map 65 is not
  on CRITICAL_PATH at all — entering a gym is not "progress" by that axis).
  frontier.json sat at "furthestRank": 13 for 43h while the live agent spent
  every one of those hours bouncing Cerulean Gym <-> City <-> Pokecenter,
  losing to Misty. The rank axis reported a FROZEN SPUR; the real axis, the
  agent's own storyScore/badge/flag state, was ALSO frozen (10/25, 1 badge, 37
  events, unmoved for the same 43h) but nothing was watching THAT axis and
  nothing described WHAT KIND of stuck it was. This module is that second,
  finer axis, plus the MODE classification the spec asks for so an
  intervention layer (wq#672) knows what to try.

WHAT COUNTS AS ADVANCE ON THIS AXIS
  storyScore rising (PRIMARY — spec wq#671 "story_score (PRIMARY, not rank)"),
  or badges rising, or the raw event-flag count rising. Any one of the three
  resets the clock; unlike the frontier engine's rank axis, there is no
  side-detour trap here to defend against, because none of these three ever
  moves backwards during ordinary (non-whiteout) play, and a fresh flag or
  badge is real state progress even without a rank change.

WINDOW
  Deliberately tighter than the frontier engine's 12h: this axis is meant to
  catch a stall INSIDE a single objective (one gym, one fight loop), not just
  cross-map stagnation, and the spec's own K=3/3h intervention-and-escalation
  cadence only makes sense against a detection window materially shorter than
  3h. 2h is the default: long enough that ordinary grind/travel between
  checkpoints (checkpoints/**/*.json sidecars land every ~10-25 min in the
  live corpus) doesn't false-fire, short enough that three failed K=3
  interventions plus a 3h Frank page both still fit inside the same incident.

MODE CLASSIFICATION (spec wq#671 section 1)
  Computed only once the story_score axis is stalled, from state that already
  exists and is already durable (nothing new is persisted mid-run to compute
  this):
    RESUME_DEADEND    — runtime/resume_history.json: the same resumedFrom
                        checkpoint booted on >=2 CONSECUTIVE boots. Mirrors
                        lpp_frontier.restart_loop's own definition exactly
                        (wq#515), reused here as a mode rather than a
                        standalone alert.
    FIGHT_LOSS_LOOP   — runtime/warp_history.json (wq#517 persisted, survives
                        restarts): among the most recent warps, a GYM map (per
                        tools/map_names.json label containing "Gym") appears
                        >=2 times AND a heal/city map for that same trip
                        (Pokecenter or City, by label) also appears >=2 times.
                        This is literally "walked into the gym, walked out
                        again, more than once" — the healing_cycle pattern the
                        spec names by name.
    NAV_LOOP          — no gym involved, but the recent warp window collapses
                        onto a small set of maps (<=3 distinct ids) with
                        repeats — an overworld/dungeon loop, not a gym fight.
    OBJECTIVE_UNREACHABLE — the frontier engine reports pathExhausted (the
                        agent reached the last known CRITICAL_PATH milestone
                        and there is nowhere further encoded to walk toward)
                        while this axis is ALSO stalled. Non-fatal to import:
                        if lpp_frontier can't be reached, this mode is simply
                        never selected rather than raising.
    IDLE              — story_score is stalled but NONE of the above match:
                        no warps recorded in the window at all (not even a
                        loop — the agent is not moving map-to-map in either
                        direction), and no repeated-resume signature. Catch-
                        all, deliberately last in priority order.

  Priority order (RESUME_DEADEND, then FIGHT_LOSS_LOOP, then
  OBJECTIVE_UNREACHABLE, then NAV_LOOP, then IDLE) exists because a
  same-checkpoint resume loop is the most specific and most actionable signal
  when present — but see MISS below.

READ-ONLY. Reads runtime/*.json, checkpoints/**/*.json, tools/map_names.json.
Writes only its own cache at runtime/stuck_mode.json (merge-max free — unlike
the frontier cache, this one is fully recomputed every call, no history to
preserve across restarts other than what the source files already durably
hold).
"""
import glob, json, os, sys
from datetime import datetime, timezone

BASE = os.environ.get("LPP_BASE", "/home/lumen/pokemon")
STATE = f"{BASE}/runtime/stuck_mode.json"
NAMES_FILE = f"{os.path.dirname(os.path.abspath(__file__))}/map_names.json"
WARP_HISTORY = f"{BASE}/runtime/warp_history.json"
RESUME_HISTORY = f"{BASE}/runtime/resume_history.json"

DEFAULT_WINDOW_H = 2.0
WARP_WINDOW = 64          # matches oscillation.ts's own KEEP=64 cap on warp_history.json —
                           # classify over the FULL persisted window rather than truncating
                           # further. A tighter sub-slice (tried: 20) missed the fixture: the
                           # live 43h stall's most recent 20 raw warps happen to be a pure
                           # city<->pokecenter shuffle with the gym re-entry just outside that
                           # slice, which is a real but narrower symptom of the same episode.
                           # The full persisted cap is itself already a bounded recent window
                           # (wq#517), so no further truncation is needed to keep this cheap.
NAV_LOOP_MAX_DISTINCT = 3  # <=N distinct maps across WARP_WINDOW warps => a loop, not travel

MODES = ("FIGHT_LOSS_LOOP", "NAV_LOOP", "OBJECTIVE_UNREACHABLE", "RESUME_DEADEND", "IDLE")

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import lpp_frontier
    _frontier_import_err = None
except Exception as e:  # pragma: no cover - exercised only if the sibling module breaks
    lpp_frontier = None
    _frontier_import_err = e


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_map_names(names_file=NAMES_FILE):
    try:
        return json.load(open(names_file))
    except Exception:
        return {}


def map_label(mid, names):
    return names.get(str(mid)) or names.get(mid) or f"map{mid}"


def is_gym(mid, names):
    return "gym" in map_label(mid, names).lower()


def is_heal_or_city(mid, names):
    label = map_label(mid, names).lower()
    return "pokecenter" in label or "pokémon center" in label or label.endswith("city") or label.endswith("town")


def load_sidecars(base=BASE):
    out = []
    for p in glob.glob(f"{base}/checkpoints/**/*.json", recursive=True):
        try:
            j = json.load(open(p))
        except Exception:
            continue
        if not isinstance(j, dict) or "ts" not in j:
            continue
        out.append(j)
    out.sort(key=lambda j: j["ts"])
    return out


def load_json(path, default=None):
    try:
        return json.load(open(path))
    except Exception:
        return default


# ---------------------------------------------------------------- story_score axis
def advances(sidecars):
    """Every sidecar instant where storyScore, badges or events rose.

    Unlike lpp_frontier.advances (rank axis, side-detour-aware), all three
    signals here are monotonic-in-practice during ordinary play (whiteout
    regressions are handled separately by src/recovery.ts, out of scope for a
    read-only detector), so any rise resets the clock — no side-detour trap to
    defend against on this axis.
    """
    max_ss = max_b = max_e = -1
    out = []
    for j in sidecars:
        ss, b, e = j.get("storyScore"), j.get("badges"), j.get("events")
        why = []
        if ss is not None and ss > max_ss:
            if max_ss >= 0:
                why.append(f"storyScore {max_ss}->{ss}")
            max_ss = ss
        if b is not None and b > max_b:
            if max_b >= 0:
                why.append(f"badges {max_b}->{b}")
            max_b = b
        if e is not None and e > max_e:
            if max_e >= 0:
                why.append(f"eventFlags {max_e}->{e}")
            max_e = e
        if why:
            out.append({"ts": j["ts"], "why": ", ".join(why),
                        "storyScore": max_ss, "badges": max_b, "events": max_e})
    return out


# ---------------------------------------------------------------- MODE classification
def classify_mode(warps, resume_picks, names, path_exhausted=False):
    """Returns (mode, evidence_str, location_id). `warps` newest-last, same
    shape as runtime/warp_history.json's "warps" list. `resume_picks`
    newest-last list of resumedFrom checkpoint filenames, same shape as
    resume_history.json's "picks" (each a dict with a "file" key).

    `location_id` is a best-guess single map id anchoring the incident — the
    gym for FIGHT_LOSS_LOOP, the smallest looping map for NAV_LOOP, the most
    recent map otherwise — used by wq#672's intervention K-count and wq#673's
    ticket dedup key (mode+location), so two different stuck spots never
    share one counter or one ticket.
    """
    recent_resumes = [p.get("file") for p in (resume_picks or [])[-4:] if p.get("file")]
    if len(recent_resumes) >= 2 and recent_resumes[-1] == recent_resumes[-2]:
        return "RESUME_DEADEND", (
            f"last 2 boots both resumed from {recent_resumes[-1]} "
            f"— the harness is not advancing its own starting point"), None

    window = (warps or [])[-WARP_WINDOW:]
    if not window:
        return "IDLE", "no warps recorded in the detection window — not moving map-to-map at all", None

    gym_hits = {m: window.count(m) for m in set(window) if is_gym(m, names)}
    heal_hits = {m: window.count(m) for m in set(window) if is_heal_or_city(m, names)}
    fighting_gym = {m: c for m, c in gym_hits.items() if c >= 2}
    if fighting_gym and any(c >= 2 for c in heal_hits.values()):
        gym_id = max(fighting_gym, key=fighting_gym.get)
        heal_id = max(heal_hits, key=heal_hits.get)
        return "FIGHT_LOSS_LOOP", (
            f"last {len(window)} warps bounce {map_label(gym_id, names)} "
            f"({fighting_gym[gym_id]}x) <-> {map_label(heal_id, names)} "
            f"({heal_hits[heal_id]}x) — healing-cycle pattern, not travel"), gym_id

    if path_exhausted:
        return "OBJECTIVE_UNREACHABLE", (
            "story_score/state axis is stalled and the frontier engine reports "
            "pathExhausted — no further CRITICAL_PATH milestone is encoded to aim at"), window[-1]

    distinct = sorted(set(window))
    if len(distinct) <= NAV_LOOP_MAX_DISTINCT and len(window) >= 4:
        labels = ", ".join(map_label(m, names) for m in distinct)
        return "NAV_LOOP", (
            f"last {len(window)} warps collapse onto {len(distinct)} map(s) ({labels}) "
            f"with no gym involved — an overworld/dungeon loop"), distinct[0]

    return "IDLE", (
        f"story_score/state axis stalled but no RESUME_DEADEND, FIGHT_LOSS_LOOP, "
        f"OBJECTIVE_UNREACHABLE or NAV_LOOP signature matched "
        f"(last warps: {window[-8:]})"), window[-1]


# ---------------------------------------------------------------- compute/persist
def compute(base=BASE, window_h=DEFAULT_WINDOW_H, now_ms=None, warps=None,
            resume_picks=None, names=None):
    sidecars = load_sidecars(base)
    if not sidecars:
        return {"ok": False, "reason": "no checkpoint sidecars on disk"}
    now_ms = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000
    sidecars = [j for j in sidecars if j["ts"] <= now_ms]
    if not sidecars:
        return {"ok": False, "reason": f"no sidecar evidence at or before {_iso(now_ms)}"}

    adv = advances(sidecars)
    last = adv[-1] if adv else None
    last_ts = last["ts"] if last else sidecars[0]["ts"]
    frozen_h = (now_ms - last_ts) / 3.6e6
    stalled = frozen_h > window_h

    latest = sidecars[-1]
    st = {
        "ok": True,
        "generatedAt": _iso(now_ms),
        "windowHours": window_h,
        "storyScore": latest.get("storyScore"),
        "badges": latest.get("badges"),
        "eventFlags": latest.get("events"),
        "map": latest.get("map"),
        "lastAdvanceAt": _iso(last_ts),
        "lastAdvanceWhy": last["why"] if last else "(baseline: no advance recorded yet)",
        "frozenHours": frozen_h,
        "stalled": stalled,
        "advanceCount": len(adv),
        "mode": None,
        "modeEvidence": None,
        "modeLocation": None,
    }

    if stalled:
        if warps is None:
            warps = (load_json(WARP_HISTORY, {}) or {}).get("warps", [])
        if resume_picks is None:
            resume_picks = (load_json(RESUME_HISTORY, {}) or {}).get("picks", [])
        if names is None:
            names = load_map_names()
        path_exhausted = False
        if lpp_frontier is not None:
            try:
                fr = lpp_frontier.compute(base=base, now_ms=now_ms, live=False)
                path_exhausted = bool(fr.get("pathExhausted"))
            except Exception:
                path_exhausted = False
        mode, evidence, location_id = classify_mode(warps, resume_picks, names, path_exhausted)
        st["mode"] = mode
        st["modeEvidence"] = evidence
        st["modeLocation"] = location_id

    return st


def persist(st, path=STATE):
    if not st.get("ok"):
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, path)


def one_line(st):
    if not st.get("ok"):
        return f"stuck-mode: DEAD — {st.get('reason')}"
    if not st.get("stalled"):
        return (f"stuck-mode: OK story_score={st.get('storyScore')} "
                f"frozen={st.get('frozenHours'):.1f}h (< {st.get('windowHours')}h window)")
    return (f"stuck-mode: STALLED mode={st.get('mode')} story_score={st.get('storyScore')} "
            f"frozen={st.get('frozenHours'):.1f}h — {st.get('modeEvidence')}")


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--window-hours", type=float, default=DEFAULT_WINDOW_H)
    p.add_argument("--json", action="store_true")
    p.add_argument("--one-line", action="store_true")
    p.add_argument("--no-persist", action="store_true")
    args = p.parse_args(argv)

    st = compute(window_h=args.window_hours)
    if not args.no_persist:
        persist(st)
    if args.json:
        print(json.dumps(st, indent=1))
    else:
        print(one_line(st))
    return 0 if st.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
