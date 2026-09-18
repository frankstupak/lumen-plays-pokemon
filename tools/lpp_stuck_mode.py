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

SECOND AXIS: COMPOSITE PROGRESS DELTA, IN TURNS (wq#1179)
  The window above is a WALL CLOCK, and an agent that re-enters the same
  doorway forever moves none of storyScore/badges/eventFlags — so a live
  60%-refused-warp stall ran with mode=None and the sentinels silent for
  twelve days. src/novelty.ts samples a composite scalar
  P = 1000*storyScore + 500*badges + 10*levelSum + 5*pokedexOwned + tiles
  once per TURN into runtime/progress.json, including the exploration term
  (unique (map,x,y) tiles ever stood on) that this repo previously had
  nowhere. dP == 0 over DP_WINDOW_TURNS samples is a stall the 2h clock cannot
  see yet, and it is what separates productive grinding (levels rising) from a
  fight-loss loop (nothing rising).

  OBSERVE-ONLY BY DEFAULT. The dP block is always computed and always reported;
  it only sets `stalled` (and so only reaches the wq#672 intervention layer)
  under --dp-axis / LPP_DP_AXIS=1. Thresholds and weights are PARSED from
  src/novelty.ts, and each logged P is recomputed from its own components —
  a mismatch disables the axis rather than guessing (fail-closed).

MODE CLASSIFICATION (spec wq#671 section 1)
  Computed only once the story_score axis is stalled, from state that already
  exists and is already durable (nothing new is persisted mid-run to compute
  this):
    RESUME_DEADEND    — runtime/resume_history.json: the same resumedFrom
                        checkpoint booted on MORE consecutive boots than
                        src/resume.ts's own RESUME_REPEAT_LIMIT tolerates
                        (wq#1118). At exactly the limit the harness's repeat
                        guard is about to demote that file itself, so a run of
                        exactly the limit is a remedy in flight, not a
                        deadend; a longer run is proof the guard ran and found
                        nothing newer to take. The bar is READ FROM
                        src/resume.ts, never retyped here — and it deliberately
                        no longer mirrors lpp_frontier.restart_loop's >=2
                        streak: that is an ALERT (report a repeat as soon as it
                        is visible), this is a PRESCRIPTION (only act once the
                        harness's own remedy has provably failed).
    FIGHT_LOSS_LOOP   — runtime/warp_history.json (wq#517 persisted, survives
                        restarts): among the most recent warps, a GYM map (per
                        tools/map_names.json label containing "Gym") appears
                        >=2 times AND a heal/city map for that same trip
                        (Pokecenter or City, by label) also appears >=2 times.
                        This is literally "walked into the gym, walked out
                        again, more than once" — the healing_cycle pattern the
                        spec names by name.
    OBJECTIVE_DRIFT   — the FIGHT_LOSS_LOOP shape, around a gym whose badge is
                        ALREADY WON (wq#1867). runtime/fight_ledger.json holds a
                        win on that gym map recorded at a LOWER badge count than
                        the player now holds, so nothing is refusing a gym fight
                        here and there is no fight left to prepare for: the
                        stall is the agent not leaving for the next objective.
                        Returned wherever a FIGHT_LOSS_LOOP verdict would
                        otherwise be, because "you already beat this gym" is
                        strictly more specific than "you keep losing to it" —
                        and it is the only one of the two that can be true after
                        a badge lands.
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

  Priority order (RESUME_DEADEND, then FIGHT_LOSS_LOOP/OBJECTIVE_DRIFT, then
  OBJECTIVE_UNREACHABLE, then NAV_LOOP, then IDLE) exists because a
  same-checkpoint resume loop is the most specific and most actionable signal
  when present — but see MISS below.

READ-ONLY. Reads runtime/*.json (warp_history, resume_history, progress),
checkpoints/**/*.json, tools/map_names.json, and src/{resume,novelty}.ts for the
thresholds it must not retype.
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
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
NAMES_FILE = f"{TOOLS_DIR}/map_names.json"
RESUME_TS = os.path.join(os.path.dirname(TOOLS_DIR), "src", "resume.ts")
RESUME_REPEAT_FALLBACK = 2   # what src/resume.ts holds today; parse failure must
                             # degrade to the real bar, not to a stricter guess
RESUME_VIABLE_FALLBACK = 0.5 # ditto for VIABLE_HP_PCT
WARP_HISTORY = f"{BASE}/runtime/warp_history.json"
RESUME_HISTORY = f"{BASE}/runtime/resume_history.json"
# wq#1867: src/ledger.ts's own record of how every trainer fight ended. The one
# place in the run that knows a gym fight was WON, which is the fact that makes
# a FIGHT_LOSS_LOOP verdict on that gym impossible.
FIGHT_LEDGER = f"{BASE}/runtime/fight_ledger.json"
# wq#1179: the composite-progress axis. src/novelty.ts samples P once per turn
# into runtime/progress.json; the constants below are PARSED from that file for
# the same reason resume_repeat_limit() parses src/resume.ts — a threshold this
# module compares against must come from the code that produces it, or the two
# drift silently.
NOVELTY_TS = os.path.join(os.path.dirname(TOOLS_DIR), "src", "novelty.ts")
DP_WINDOW_FALLBACK = 40
DP_WEIGHTS_FALLBACK = {"story": 1000, "badge": 500, "level": 10, "dex": 5, "tile": 1}

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

MODES = ("FIGHT_LOSS_LOOP", "OBJECTIVE_DRIFT", "WARP_OSC", "NOISE_STORM", "NAV_LOOP",
         "OBJECTIVE_UNREACHABLE", "RESUME_DEADEND", "IDLE")

# wq#1867: reach.ts's verdict when the A* cannot leave the region the agent is
# standing in. Matched as a phrase because that is all it is — src/reach.ts
# builds it inline, so there is no constant to read; tools/test_stuck1867.py
# fails if the wording there moves.
#
# STOPS SHORT OF THE FULL SENTENCE ON PURPOSE. What this module reads is the
# turn_summary line, and that is truncated to a fixed width (200 chars live), so
# a phrase matched near the end of the refusal is a phrase matched on only some
# of the renders.
#
# wq#1877: THE WORDING DID MOVE, and this went dark for it. wq#1870 replaced
# "you are in a closed-off part of this map. Reachable warps: ..." with two new
# refusals — "this map is SPLIT and (x,y) is in a part of it you cannot walk to"
# (stuckHint) and "no opening on the S edge is reachable" (edgeStuckHint) — and
# nothing here followed. Measured over the six newest live event files at the
# time of the wq#1877 stall: 68 turn summaries, 0 matching the old phrase, 18
# matching SPLIT and 9 the edge one. So the pocket clause was silent through the
# whole 4.6h freeze it exists for. All three shapes are matched now; the old one
# stays for fixtures written against it.
CLOSED_OFF_RE = re.compile(
    r"closed-off part of this"
    r"|this map is split"
    r"|no opening on the \S+ edge", re.I)

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


def resume_repeat_limit(path=RESUME_TS):
    """How many identical consecutive resume picks the HARNESS itself tolerates.

    Read out of src/resume.ts (`export const RESUME_REPEAT_LIMIT = <int>;`) by
    regex rather than retyped here — same idiom and same reason as
    lpp_stuck_intervene._misty_gate reading the gym gate out of src/guidance.ts
    (wq#1091): a threshold this module compares against must come FROM the code
    that enforces it, or the two drift and the classifier fires on a state the
    harness is already handling.
    """
    try:
        with open(path) as fh:
            m = re.search(r"export\s+const\s+RESUME_REPEAT_LIMIT\s*=\s*(\d+)", fh.read())
        if m:
            return max(1, int(m.group(1)))
    except Exception:
        pass
    return RESUME_REPEAT_FALLBACK


def resume_viable_pct(path=RESUME_TS):
    """The HP fraction src/resume.ts calls a state "viable" at (VIABLE_HP_PCT).

    The repeat guard refuses to trade a viable boot state for a non-viable newer
    one, so it is the second reason a resume deadend can persist while newer
    saves keep landing — and any prescription that asks the agent to leave a
    replacement save behind has to name the bar the picker actually applies.
    Read from the enforcing code for the same reason as resume_repeat_limit.
    """
    try:
        with open(path) as fh:
            m = re.search(r"export\s+const\s+VIABLE_HP_PCT\s*=\s*([0-9.]+)", fh.read())
        if m:
            return float(m.group(1))
    except Exception:
        pass
    return RESUME_VIABLE_FALLBACK


# ---------------------------------------------------------------- dP axis (wq#1179)
def dp_window_turns(path=NOVELTY_TS):
    """The stall window, in TURNS, that src/novelty.ts declares (DP_WINDOW_TURNS).

    Read from the producing module, never retyped — same idiom and same reason
    as resume_repeat_limit() above.
    """
    try:
        with open(path) as fh:
            m = re.search(r"export\s+const\s+DP_WINDOW_TURNS\s*=\s*(\d+)", fh.read())
        if m:
            return max(2, int(m.group(1)))
    except Exception:
        pass
    return DP_WINDOW_FALLBACK


def dp_weights(path=NOVELTY_TS):
    """The composite weights src/novelty.ts uses, parsed from its WEIGHTS object.

    Parsed rather than assumed so this module can RE-DERIVE each logged P from
    its own components and refuse to trust a log the producer and the consumer
    disagree about (see `pMismatch` in dp_axis) — the fail-closed rule: a
    detector that cannot verify its input must say so, not guess.
    """
    try:
        with open(path) as fh:
            m = re.search(r"export\s+const\s+WEIGHTS\s*=\s*\{([^}]*)\}", fh.read())
        if m:
            w = {k: int(v) for k, v in re.findall(r"(\w+)\s*:\s*(\d+)", m.group(1))}
            if set(DP_WEIGHTS_FALLBACK) <= set(w):
                return {k: w[k] for k in DP_WEIGHTS_FALLBACK}
    except Exception:
        pass
    return dict(DP_WEIGHTS_FALLBACK)


def composite_from_parts(sample, weights):
    """P recomputed from a sample's components. Mirror of novelty.ts composite()."""
    return (weights["story"] * (sample.get("storyScore") or 0)
            + weights["badge"] * (sample.get("badges") or 0)
            + weights["level"] * (sample.get("levelSum") or 0)
            + weights["dex"] * (sample.get("pokedexOwned") or 0)
            + weights["tile"] * (sample.get("uniqueTiles") or 0))


def load_progress(base=BASE, path=None):
    """Samples from runtime/progress.json, oldest-first. Missing file is normal
    (a deployment that has not yet run the wq#1179 tracker) and must degrade to
    an empty list, never raise — this axis is additive to the wall-clock one."""
    j = load_json(path or f"{base}/runtime/progress.json", {}) or {}
    s = j.get("samples")
    return s if isinstance(s, list) else []


def dp_axis(samples, window_turns=None, weights=None):
    """Composite-progress delta over the last `window_turns` SAMPLES.

    Turn-count windowing, not wall-clock: turn rate varies by an order of
    magnitude between brain turns and deterministic ones, so hours are a poor
    unit for "the agent has taken N shots at this and none of them moved
    anything". Samples are windowed by POSITION in the log, not by their `turn`
    field — turn counters restart at 1 on every reboot and the loops this
    catches outlive reboots.

    `flat` is dP <= 0 over a COMPLETE window. A partial window (fresh boot,
    tracker just deployed) is never a stall claim.
    """
    w = int(window_turns or dp_window_turns())
    weights = weights or dp_weights()
    out = {"ok": False, "windowTurns": w, "samples": 0, "complete": False,
           "spanTurns": 0, "dP": None, "newTiles": 0, "flat": False,
           "first": None, "last": None, "pMismatch": 0, "saturated": False,
           "reason": None}
    win = [s for s in (samples or []) if isinstance(s, dict) and isinstance(s.get("P"), (int, float))][-w:]
    if len(win) < 2:
        out["samples"] = len(win)
        out["reason"] = ("no progress samples on disk — src/novelty.ts is not "
                         "running in this deployment" if not win else
                         "only one progress sample so far")
        return out
    first, last = win[0], win[-1]
    out.update({
        "ok": True,
        "samples": len(win),
        "complete": len(win) >= w,
        "spanTurns": (last.get("seq") or 0) - (first.get("seq") or 0),
        "dP": last["P"] - first["P"],
        "newTiles": sum(int(s.get("newTiles") or 0) for s in win),
        "first": first["P"], "last": last["P"],
        "uniqueTiles": last.get("uniqueTiles"),
        # A saturated tile set (MAX_TILES in novelty.ts) reports zero novelty
        # for a reason that is NOT a stall; carry the flag so a reader can tell
        # the two apart.
        "saturated": any(bool(s.get("saturated")) for s in win),
        "pMismatch": sum(1 for s in win if composite_from_parts(s, weights) != s["P"]),
    })
    out["flat"] = bool(out["complete"] and out["dP"] <= 0 and out["pMismatch"] == 0)
    if out["pMismatch"]:
        out["reason"] = (f"{out['pMismatch']} of {len(win)} samples do not match a P "
                         f"recomputed from their own components with src/novelty.ts's "
                         f"weights — log and weights disagree, not trusting this axis")
    elif not out["complete"]:
        out["reason"] = f"partial window ({len(win)}/{w} samples) — too early to call a stall"
    return out


def dp_evidence(dp, names=None):
    """One sentence describing why the dP axis called a stall."""
    tiles = f", {dp['newTiles']} new tiles" if dp.get("newTiles") is not None else ""
    return (f"composite progress flat over {dp['samples']} turns "
            f"(dP={dp['dP']}, P={dp['first']}->{dp['last']}{tiles}): no story flag, "
            f"badge, level, dex entry or unvisited tile gained in the window")


def is_gym(mid, names):
    return "gym" in map_label(mid, names).lower()


def is_heal_or_city(mid, names):
    label = map_label(mid, names).lower()
    return "pokecenter" in label or "pokémon center" in label or label.endswith("city") or label.endswith("town")


def town_of(label):
    """The town a ROM map label belongs to — its first word.

    "Cerulean Gym", "Cerulean City", "Cerulean Pokecenter" and "Cerulean Mart"
    all answer "cerulean". Every one of the eight Gen 1 gyms is labelled
    "<Town> Gym" and shares that first word with the hub it stands in, because
    src/names.ts derives both from the same ROM map headers. That is the only
    adjacency this module needs — which gym belongs to the hub a loop collapsed
    onto — and it needs no map graph to answer it.
    """
    parts = (label or "").split()
    return parts[0].lower() if parts else ""


def cleared_gyms(records, badges, names):
    """{gym map id: label} for every gym whose badge is already in the bag.

    wq#1867: a gym counts as CLEARED when src/ledger.ts's fight ledger holds a
    WIN on that map recorded at a LOWER badge count than the player now holds —
    a fight was won there and the badge total rose after it. That is the test
    that survives both ways the simpler ones break:

      * "the last outcome on this map is a win" credits a win over a gym's
        JUNIOR trainer while the leader is still unbeaten. The badge count does
        not move for those, so this test stays silent on them.
      * "the freeze began with badges N->N+1" is erased by the next partial
        tick: advances() restarts the freeze clock on ANY of the three counters
        rising, which rewrites lastAdvanceWhy and would silently un-clear the
        gym mid-stall.

    A checkpoint restore that rolls badges back below the record stops clearing
    the gym, which is right — the badge is not in the bag any more. A missing,
    empty or (past KEEP_RECORDS=200) rotated-out ledger clears nothing, so every
    caller degrades to exactly the behaviour it had before this existed.
    """
    out = {}
    for r in records or []:
        if not isinstance(r, dict) or r.get("outcome") != "win":
            continue
        mid = r.get("map")
        if mid is None or not is_gym(mid, names):
            continue
        if (r.get("badges") or 0) < (badges or 0):
            out[mid] = map_label(mid, names)
    return out


def closed_off_turns(turn_summaries):
    """How many recent turns ended in reach.ts's closed-off-region verdict.

    Not a mode of its own: it is the local half of why an OBJECTIVE_DRIFT pin
    must not simply say "walk south". The agent standing in a pocket has already
    been told by the harness that goto cannot leave it, so a pin repeating the
    instruction that just failed 26 times is the wq#1091 footgun all over again.
    """
    return sum(1 for line in (turn_summaries or []) if CLOSED_OFF_RE.search(line or ""))


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
    """Load recent turn_summary lines from the two newest event files.

    wq#1867: this read the wrong shape and had returned NOTHING since wq#697
    shipped. src/events.ts emits `{ t, ...data, kind }` — flat, envelope last
    (wq#522) — so a turn summary on disk is {"t":..,"line":"T49 ..","kind":
    "turn_summary"}. This asked for ev["k"] and ev["d"]["line"], a nesting no
    writer in this repo has ever produced (every other reader — turncost_487,
    backtest_520, verify_489 — already uses `kind` + a flat `line`). The cost
    was silent: NOISE_STORM is the only consumer this module had, its detector
    takes an empty list and reports a streak of 0, so the mode simply never
    fired on live data. Caught because wq#1867's closed-off-pocket clause reads
    the same lines and came up empty against a run that was emitting 33 of them.

    The old shape is still accepted so that any fixture written against it keeps
    working; nothing on disk uses it.
    """
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
                        if (ev.get("kind") or ev.get("k")) == "turn_summary":
                            lines.append(ev.get("line")
                                         or (ev.get("d") or {}).get("line", ""))
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue
    return lines[-n:]


def _hub_anchor(window, names, town=None):
    """The hub map a stalled loop is orbiting RIGHT NOW: the last city/town warp
    in the window, falling back to the last heal/hub map. Optionally restricted
    to one town.

    wq#1874: recency, never frequency. The old readings took
    Counter(cities).most_common(1) over the whole 64-warp window, which is a
    majority vote between towns whenever the window spans two of them — and the
    ordinary shape of a stall is "just arrived somewhere and was immediately
    gated", where the town just LEFT still holds more warps than the town the
    run is stuck in. Counting warps then anchors the incident on the town the
    run has already finished with. How recently the run warped into a town is
    what says where it is; how often it did says only how long it was there.
    """
    scope = [m for m in window
             if town is None or town_of(map_label(m, names)) == town]
    cities = [m for m in scope if map_label(m, names).lower().endswith(("city", "town"))]
    if cities:
        return cities[-1]
    heals = [m for m in scope if is_heal_or_city(m, names)]
    return heals[-1] if heals else None


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
    # map). Route to FIGHT_LOSS_LOOP (grind remedy) and anchor on the city/town
    # hub the loop is orbiting now (wq#1874: the most RECENT one, not the most
    # frequent — a window that spans two towns must not anchor the stall on the
    # one the run has already left) — a STABLE location that collapses the two
    # transient WARP_OSC endpoints into one incident / one ticket.
    heal_city = [m for m in window if is_heal_or_city(m, names)]
    if not gym_hits and len(heal_city) >= max(4, int(0.6 * len(window))):
        hub = _hub_anchor(window, names) or heal_city[-1]
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


def _drift_diagnosis(window, names, cleared, badges, next_milestone):
    """wq#1867: the fight-loss SHAPE around a gym that is already beaten.

    Returns the same (mode, evidence, location) triple as every other branch, or
    None when no cleared gym belongs to this loop. The anchor is the town the
    loop collapsed onto, never the gym: the gym's warps age out of the window
    long before the stall ends (a win leaves exactly two, the way in and the way
    out), and an anchor that moves mid-stall splits one incident across two
    dedup keys and two K budgets.
    """
    if not window or not cleared:
        return None
    # wq#1872: the town fallback is anchored to the HUB's town, not to any town
    # appearing anywhere in the window. A 64-warp window routinely spans two
    # towns — the one just cleared and the one the run has moved on to — and
    # matching "somewhere in the window" let a stale warp from the cleared town
    # convert a genuine readiness-gate stall at the NEXT, unbeaten gym into
    # "that gym is already beaten". That is the inverse of the wq#1867 failure
    # (false all-clear instead of false grind order) and just as wrong: the pin
    # named the hub's town while the ledger evidence came from another one.
    # Only the gym standing IN the town the loop collapsed onto can be the gym
    # this loop is orbiting.
    #
    # wq#1874: and WHICH town that is is a question about now, not about the
    # window's arithmetic. Picking the hub by Counter(...).most_common re-opened
    # the same false all-clear one layer down, gated on warp COUNTS instead of
    # warp PRESENCE: a run that just arrived in Vermilion and was gated at its
    # unbeaten gym still carries more Cerulean warps than Vermilion ones, so the
    # majority vote named Cerulean the hub and the Cascade Badge cleared a stall
    # happening two towns away. The cleared gym the loop actually warped into
    # settles it outright when there is one; with no gym warp at all — the
    # readiness-gate shape, where the entry refusal keeps the gym out of the
    # history — the last town warped into is the only honest answer.
    seen = [m for m in window if m in cleared]
    if seen:
        # the cleared gym the loop orbits: the one warped into most often, and
        # the most recent of those on a tie.
        gym_id = max(reversed(seen), key=seen.count)
        town = town_of(cleared[gym_id])
    else:
        town = town_of(map_label(_hub_anchor(window, names) or window[-1], names))
        hit = [m for m in sorted(cleared) if town and town_of(cleared[m]) == town]
        if not hit:
            return None
        gym_id = hit[0]
    hub = _hub_anchor(window, names, town) or window[-1]
    goal = (f"the next milestone the frontier engine names ({next_milestone})"
            if next_milestone else "the goal its own ROUTE line names")
    return "OBJECTIVE_DRIFT", (
        f"the loop orbits {map_label(hub, names)} around {map_label(gym_id, names)}, whose "
        f"badge is ALREADY WON — the fight ledger holds a win on that map at a lower badge "
        f"count than the {badges} the player now holds. Nothing is refusing a gym fight "
        f"here and there is no fight left to prepare for: the stall is not leaving for "
        f"{goal}"), hub


def classify_mode(warps, resume_picks, names, path_exhausted=False, turn_summaries=None,
                  cleared=None, badges=0, next_milestone=None):
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
    # wq#1081/#1084: RESUME_DEADEND is a FALLBACK, not a pre-emptor. A long
    # freeze naturally resumes the same checkpoint across reboots, so evaluating
    # it first masked the real stuck mode every time the freeze spanned >1
    # restart (this is how the reported stall kept flip-flopping modes). Compute
    # the flag here but defer the return until after the fight-readiness
    # diagnoses below.
    # wq#1118: the bar is now "MORE identical picks than the harness tolerates",
    # not ">=2". src/resume.ts's repeat guard already demotes a file picked
    # RESUME_REPEAT_LIMIT (2) times running whenever a newer state exists, so the
    # old >=2 bar fired at exactly the boot the picker was about to step aside on
    # its own — and prescribed "resume from a different checkpoint", the remedy
    # already in flight. A run LONGER than the limit is the honest signal: the
    # guard ran and kept the same file because nothing newer exists to take.
    repeat_limit = resume_repeat_limit()
    need = repeat_limit + 1
    recent_resumes = [p.get("file") for p in (resume_picks or [])[-need:] if p.get("file")]
    resume_deadend = len(recent_resumes) >= need and len(set(recent_resumes)) == 1

    window = (warps or [])[-WARP_WINDOW:]
    if not window:
        return "IDLE", "no warps recorded in the detection window — not moving map-to-map at all", None

    cleared = cleared or {}
    gym_hits = {m: window.count(m) for m in set(window) if is_gym(m, names)}
    heal_hits = {m: window.count(m) for m in set(window) if is_heal_or_city(m, names)}
    bouncing = {m: c for m, c in gym_hits.items() if c >= 2}
    healing = any(c >= 2 for c in heal_hits.values())
    # wq#1867: a gym whose badge is already won is not a fight the agent can be
    # stuck LOSING, and its warps outlive the win by a long way — the two map65
    # warps that held this verdict through three K attempts were the winning
    # visit's own way in and out, ~45 warps stale by the time it escalated. Left
    # in `fighting_gym` they re-diagnose every post-badge orbit as the fight that
    # was just won, and prescribe grinding for it.
    fighting_gym = {m: c for m, c in bouncing.items() if m not in cleared}
    if fighting_gym and healing:
        gym_id = max(fighting_gym, key=fighting_gym.get)
        heal_id = max(heal_hits, key=heal_hits.get)
        return "FIGHT_LOSS_LOOP", (
            f"last {len(window)} warps bounce {map_label(gym_id, names)} "
            f"({fighting_gym[gym_id]}x) <-> {map_label(heal_id, names)} "
            f"({heal_hits[heal_id]}x) — healing-cycle pattern, not travel"), gym_id

    if bouncing and healing:
        # The same shape with every bouncing gym cleared. Diagnosed here rather
        # than left to fall through, because the modes downstream of this point
        # prescribe map BANS, and the maps on offer are the town hub and its only
        # heal point (wq#1081's lesson: banning those can never help).
        drift = _drift_diagnosis(window, names, cleared, badges, next_milestone)
        if drift:
            return drift

    stall = _readiness_stall(window, names)
    scope = window
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
        scope = window[-WARP_OSC_WINDOW:]
        stall = _readiness_stall(scope, names)
    if stall:
        # wq#1867: both diagnoses in _readiness_stall name a readiness gate
        # refusing a GYM ENTRY. Once that gym's badge is won there is no such
        # gate — guidance.ts's refusal is scoped to the unbeaten fight — so the
        # same loop shape is drift, diagnosed on the SAME slice that fired so the
        # anchor (and the incident key) matches the branch above.
        return _drift_diagnosis(scope, names, cleared, badges, next_milestone) or stall

    # wq#1081/#1084: deferred RESUME_DEADEND — the harness keeps resuming the
    # same checkpoint and the warps DON'T show a fight-readiness stall, so a
    # genuine "can't advance its own start point" deadend is the best read.
    # wq#1118: anchored on the map the agent is actually standing on rather than
    # None. wq#671's dedup key is (mode, location) precisely "so two different
    # stuck spots never share one counter or one ticket" — a None location broke
    # that invariant for this mode alone: every resume deadend anywhere in the
    # game shared the single key RESUME_DEADEND@None (one K=3 budget, one
    # permanently-exhausted ticket), and the pin it wrote read "near mapNone".
    # `window` is non-empty here (the empty case returned IDLE above).
    if resume_deadend:
        return "RESUME_DEADEND", (
            f"last {len(recent_resumes)} boots all resumed from {recent_resumes[-1]} — more "
            f"than the {repeat_limit} identical picks src/resume.ts tolerates, so its repeat "
            f"guard has already run and kept the same file: there is no newer non-warp "
            f"checkpoint to step aside to. Re-picking cannot advance the start point; only a "
            f"newer save further along can"), window[-1]

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
def dp_axis_enabled(explicit=None):
    """Is the dP axis allowed to DRIVE `stalled`, or only to report?

    Default OFF (observe-only), per the house shipping order: the signal lands
    on disk and in the JSON first, and only starts moving `stalled` — and
    therefore the wq#672 intervention layer and the wq#673 ticket writer —
    once someone has looked at a week of it. `--dp-axis` or LPP_DP_AXIS=1
    turns it on; `--no-dp-axis` forces it off regardless of the env.
    """
    if explicit is not None:
        return bool(explicit)
    return os.environ.get("LPP_DP_AXIS", "").strip().lower() in ("1", "true", "yes", "on")


def compute(base=BASE, window_h=DEFAULT_WINDOW_H, now_ms=None, warps=None,
            resume_picks=None, names=None, dp_enabled=None, progress=None):
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

    # wq#1179: the composite-progress axis, ALWAYS computed and ALWAYS reported.
    # Whether it may set `stalled` is the flag; whether it is visible is not,
    # because the whole point of the observe-only stage is having the numbers on
    # disk before anything acts on them.
    dp = dp_axis(load_progress(base) if progress is None else progress)
    enabled = dp_axis_enabled(dp_enabled)
    st["dP"] = dp
    st["dPAxisEnabled"] = enabled
    st["stallAxis"] = "storyScore" if stalled else None
    if not stalled and enabled and dp["flat"]:
        # The wall clock has not run out yet, but the agent has taken a full
        # window of turns and moved NOTHING on any axis it could have moved.
        # That is the same stall, seen earlier — so it gets the same classifier.
        stalled = True
        st["stalled"] = True
        st["stallAxis"] = "dP"

    if stalled:
        if warps is None:
            warps = (load_json(WARP_HISTORY, {}) or {}).get("warps", [])
        if resume_picks is None:
            resume_picks = (load_json(RESUME_HISTORY, {}) or {}).get("picks", [])
        if names is None:
            names = load_map_names()
        path_exhausted = False
        next_milestone = None
        if lpp_frontier is not None:
            try:
                fr = lpp_frontier.compute(base=base, now_ms=now_ms, live=False)
                path_exhausted = bool(fr.get("pathExhausted"))
                # wq#1867: the frontier already knows where the run goes next
                # ("Route 5" while this stall ran). Carried into the state so the
                # pin names the objective the engine picked instead of a target
                # the supervisor invented — the read-don't-retype rule, applied
                # to a destination rather than a threshold.
                next_milestone = fr.get("nextMilestone")
            except Exception:
                path_exhausted = False
        summaries = load_recent_turn_summaries(base)
        ledger = (load_json(FIGHT_LEDGER, {}) or {}).get("records", [])
        cleared = cleared_gyms(ledger, st.get("badges"), names)
        st["clearedGyms"] = {str(m): lbl for m, lbl in sorted(cleared.items())}
        st["nextMilestone"] = next_milestone
        st["closedOffTurns"] = closed_off_turns(summaries)
        mode, evidence, location_id = classify_mode(
            warps, resume_picks, names, path_exhausted,
            turn_summaries=summaries, cleared=cleared,
            badges=st.get("badges") or 0, next_milestone=next_milestone)
        st["mode"] = mode
        # A dP-triggered stall names the signal that fired FIRST, then the mode
        # evidence — a reader (and wq#673's ticket body) must be able to tell
        # "flat for 40 turns" from "frozen for 2 hours" at a glance.
        st["modeEvidence"] = f"{dp_evidence(dp)} | {evidence}" if st["stallAxis"] == "dP" else evidence
        st["modeLocation"] = location_id

    return st


def persist(st, path=STATE):
    if not st.get("ok"):
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, path)


def dp_one_line(st):
    """The dP axis as a suffix for the one-liner. Says OFF explicitly while the
    axis is observe-only, so nobody reads a flat dP as an active detector."""
    dp = st.get("dP") or {}
    if not dp.get("ok"):
        return f" dP=n/a ({dp.get('reason')})"
    tag = "" if st.get("dPAxisEnabled") else " OBSERVE-ONLY"
    return (f" dP={dp['dP']} over {dp['samples']}/{dp['windowTurns']} turns "
            f"(+{dp['newTiles']} tiles){'' if not dp['flat'] else ' FLAT'}{tag}")


def one_line(st):
    if not st.get("ok"):
        return f"stuck-mode: DEAD — {st.get('reason')}"
    if not st.get("stalled"):
        return (f"stuck-mode: OK story_score={st.get('storyScore')} "
                f"frozen={st.get('frozenHours'):.1f}h (< {st.get('windowHours')}h window)"
                + dp_one_line(st))
    return (f"stuck-mode: STALLED[{st.get('stallAxis')}] mode={st.get('mode')} "
            f"story_score={st.get('storyScore')} "
            f"frozen={st.get('frozenHours'):.1f}h — {st.get('modeEvidence')}"
            + dp_one_line(st))


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--window-hours", type=float, default=DEFAULT_WINDOW_H)
    p.add_argument("--json", action="store_true")
    p.add_argument("--one-line", action="store_true")
    p.add_argument("--no-persist", action="store_true")
    # wq#1179: the dP axis reports either way; these only decide whether it may
    # set `stalled`. Default comes from LPP_DP_AXIS (unset = observe-only).
    p.add_argument("--dp-axis", dest="dp_axis", action="store_true", default=None,
                   help="let the composite-progress (dP) axis drive `stalled`")
    p.add_argument("--no-dp-axis", dest="dp_axis", action="store_false",
                   help="force the dP axis to observe-only, ignoring LPP_DP_AXIS")
    args = p.parse_args(argv)

    st = compute(window_h=args.window_hours, dp_enabled=args.dp_axis)
    if not args.no_persist:
        persist(st)
    if args.json:
        print(json.dumps(st, indent=1))
    else:
        print(one_line(st))
    return 0 if st.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
