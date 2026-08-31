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
import glob, json, os, re, sys
from collections import Counter
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
WARP_OSC_MIN_ALT = 4      # wq#697: minimum A<->B alternations to flag WARP_OSC
WARP_OSC_WINDOW = 16      # wq#697: recent warp window for oscillation detection
NOISE_STORM_K = 5          # wq#697: consecutive noise turns to flag NOISE_STORM
NOISE_RE = re.compile(r"unknown tool|parse_error|tool error|no tool call", re.I)

MODES = ("FIGHT_LOSS_LOOP", "WARP_OSC", "NOISE_STORM", "NAV_LOOP", "OBJECTIVE_UNREACHABLE", "RESUME_DEADEND", "IDLE")

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

def detect_warp_osc(warps, window=WARP_OSC_WINDOW, min_alt=WARP_OSC_MIN_ALT):
    """wq#697: detect A<->B two-map warp oscillation.

    Returns (hit, a, b, alternations). `a == b` means the whole slice landed on
    one map — a self-bounce, which is a real stuck signal but NOT an
    oscillation with an edge to ban; classify_mode gates on that (wq#1119).
    """
    recent = (warps or [])[-window:]
    if len(recent) < min_alt:
        return False, None, None, 0
    a, b = recent[-1], recent[-2] if len(recent) >= 2 else recent[-1]
    if a == b and len(recent) >= 3:
        for m in reversed(recent[:-1]):
            if m != a:
                b = m
                break
    alt = 0
    expected = a
    for m in reversed(recent):
        if m == expected:
            alt += 1
            expected = b if expected == a else a
        elif m == (b if expected == a else a):
            alt += 1
            expected = a if m == b else b
        else:
            break
    if alt >= min_alt:
        return True, a, b, alt
    return False, None, None, 0


def detect_noise_storm(turn_summaries, k=NOISE_STORM_K):
    """wq#697: detect K consecutive noise turns."""
    if not turn_summaries:
        return False, 0
    streak = 0
    for line in reversed(turn_summaries):
        if NOISE_RE.search(line):
            streak += 1
        else:
            break
    return (streak >= k, streak)


def load_recent_turn_summaries(base=BASE, n=50):
    """Load recent turn_summary lines from newest event file."""
    events_dir = os.path.join(base, "events")
    try:
        fs = [os.path.join(events_dir, f) for f in os.listdir(events_dir)
              if f.startswith("live-agent-") and f.endswith(".jsonl")]
    except FileNotFoundError:
        return []
    if not fs:
        return []
    fs.sort(key=os.path.getmtime, reverse=True)
    lines = []
    for fpath in fs[:2]:
        try:
            with open(fpath, errors="replace") as fh:
                for ln in fh:
                    try:
                        ev = json.loads(ln)
                        if ev.get("k") == "turn_summary":
                            lines.append(ev.get("d", {}).get("line", ""))
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue
    return lines[-n:]


def _readiness_stall(window, names):
    """wq#1081/#1084: the two "a map ban cannot help here" diagnoses, over an
    arbitrary slice of the warp history. Returns (mode, evidence, location) or
    None if neither matches.

    wq#1119 made this a function taking its slice as an argument, because the
    classifier has to ask the question twice at two different scopes. See the
    call site in classify_mode's WARP_OSC branch for why.
    """
    if not window:
        return None
    gym_hits = [m for m in window if is_gym(m, names)]

    # wq#1081/#1084: a stalled loop that collapses onto heal/hub maps
    # (Pokecenter + city/town) with NO gym warp in the window is a
    # fight-readiness / objective stall, not a navigation bug. The gym warp is
    # ABSENT precisely because a readiness gate (e.g. mistyGymEntryRefusal,
    # wq#674) refuses the entry, so it never lands in warp_history — which is
    # why this used to misclassify as WARP_OSC/NAV_LOOP and get prescribed a
    # map ban. Banning these maps can never help: they are the mandatory hub +
    # only heal point (the live WARP_OSC ban even targeted Route 25, the grind
    # map). Route to FIGHT_LOSS_LOOP (grind remedy) and anchor on the
    # most-frequent city/town hub — a STABLE location that collapses the two
    # transient WARP_OSC endpoints into one incident / one ticket.
    heal_city = [m for m in window if is_heal_or_city(m, names)]
    if not gym_hits and len(heal_city) >= max(4, int(0.6 * len(window))):
        cities = [m for m in heal_city
                  if map_label(m, names).lower().endswith(("city", "town"))]
        hub = Counter(cities or heal_city).most_common(1)[0][0]
        labels = ", ".join(sorted({map_label(m, names) for m in heal_city}))
        return "FIGHT_LOSS_LOOP", (
            f"stalled loop collapses onto heal/hub maps ({labels}) with no gym warp "
            f"recorded — a readiness gate is refusing the objective (gym entry), not a "
            f"navigation bug. Banning the hub/heal maps cannot help; the remedy is to "
            f"grind and catch a type counter, not to ban the hub"), hub

    # wq#1081/#1084: a stalled loop that keeps bouncing on and off a ROUTE (no
    # gym warp in the window) is a grind stall, not a warp bug — the agent has
    # reached the grind map but keeps re-entering an adjacent building/doorway
    # instead of walking into the grass. The WARP_OSC remedy would ban the route
    # itself, forbidding the exact map the agent must grind on. Route to
    # FIGHT_LOSS_LOOP (grind remedy) anchored on the route.
    routes = [m for m in window if map_label(m, names).lower().startswith("route")]
    if not gym_hits and routes and len(set(window)) <= 3 and len(window) >= 4:
        route_id = Counter(routes).most_common(1)[0][0]
        labels = ", ".join(sorted({map_label(m, names) for m in set(window)}))
        return "FIGHT_LOSS_LOOP", (
            f"stalled loop on/around a route ({labels}) with no gym warp recorded — the "
            f"agent reached the grind map but keeps bouncing off it (e.g. re-entering an "
            f"adjacent building) instead of grinding. Banning the route can't help; the "
            f"remedy is to walk into the grass and grind a type counter"), route_id

    return None


def classify_mode(warps, resume_picks, names, path_exhausted=False, turn_summaries=None):
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
    # wq#1081/#1084: RESUME_DEADEND is a FALLBACK, not a pre-emptor. A long
    # freeze naturally resumes the same checkpoint across reboots, so evaluating
    # it first masked the real stuck mode every time the freeze spanned >1
    # restart (this is how the reported stall kept flip-flopping modes). Compute
    # the flag here but defer the return until after the fight-readiness
    # diagnoses below.
    resume_deadend = len(recent_resumes) >= 2 and recent_resumes[-1] == recent_resumes[-2]

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

    stall = _readiness_stall(window, names)
    if stall is None:
        # wq#1119: ask again at the tighter, more recent scope WARP_OSC uses.
        # Both diagnoses above test the SHAPE of a loop (<=3 distinct maps, or
        # heal/hub maps dominating), and a 64-warp window that spans a 34h
        # freeze has usually drifted across more maps than that even when the
        # agent's CURRENT behaviour is a tight one-map bounce. On the live
        # Route 25 stall the wide window held 6 distinct maps — guard silent —
        # while the last 22 warps were a single map. Asking only at the wide
        # scope left the deferral wq#1081/#1084 built here half-done: the real
        # mode stayed hidden and RESUME_DEADEND below went on masking it,
        # which is the exact failure that deferral existed to stop.
        stall = _readiness_stall(window[-WARP_OSC_WINDOW:], names)
    if stall:
        return stall

    # wq#1081/#1084: deferred RESUME_DEADEND — the harness keeps resuming the
    # same checkpoint and the warps DON'T show a fight-readiness stall, so a
    # genuine "can't advance its own start point" deadend is the best read.
    if resume_deadend:
        return "RESUME_DEADEND", (
            f"last 2 boots both resumed from {recent_resumes[-1]} "
            f"— the harness is not advancing its own starting point"), None

    # wq#697: WARP_OSC
    osc_hit, osc_a, osc_b, osc_alt = detect_warp_osc(window)
    if osc_hit:
        # wq#1119: this mode's whole remedy is an EDGE ban — "ban the bounce
        # edge, try a different warp" — so it may only be returned when there
        # IS an edge. osc_a == osc_b means every warp in the slice landed on the
        # same map: the agent re-entering one doorway, not alternating between
        # two. There is nothing to ban, the pin's "the last several warps
        # alternate between exactly two maps" is simply false, and the
        # intervention layer pads the ban list out to two maps from the wider
        # window's next most frequent id — which is how the live Route 25 stall
        # got "ban the grind route + the only heal hub" prescribed three times
        # in a row. A self-bounce that is not a readiness stall (handled above)
        # falls through to NAV_LOOP/IDLE rather than to a ban that cannot help.
        if osc_a != osc_b:
            return "WARP_OSC", (
                f"warp oscillation: {osc_alt} alternations between "
                f"{map_label(osc_a, names)} <-> {map_label(osc_b, names)} "
                f"in last {min(len(window), WARP_OSC_WINDOW)} warps"), osc_a

    # wq#697: NOISE_STORM
    noise_hit, noise_streak = detect_noise_storm(turn_summaries, NOISE_STORM_K)
    if noise_hit:
        return "NOISE_STORM", (
            f"{noise_streak} consecutive noise turns (unknown tool/parse_error/tool error) "
            f"— append-only history poisoning, brain pattern-completing failures"), \
            window[-1] if window else None

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
        mode, evidence, location_id = classify_mode(
            warps, resume_picks, names, path_exhausted,
            turn_summaries=load_recent_turn_summaries(base))
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
