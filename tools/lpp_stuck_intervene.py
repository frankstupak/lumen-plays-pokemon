#!/usr/bin/env python3
"""lpp_stuck_intervene — bounded per-MODE intervention layer (wq#672).

WHY THIS EXISTS
  wq#671 (tools/lpp_stuck_mode.py) answers WHAT KIND of stuck the live agent
  is in. This module answers WHAT TO TRY, bounded, logged, and honest about
  where its authority ends. Per the spec's own anti-footgun clause (section
  4): "Supervisor NEVER autospawns fix-workers. File ONE ticket + page Frank;
  orch/Frank decide." This module PRESCRIBES and LOGS interventions; it does
  not touch the emulator, does not restart the service, and does not spawn
  agents. See "WHAT THIS DOES NOT DO YET" below for the one real gap.

ROOT-CAUSE: wq#621 vision valve "0 fires in 43h" — this premise is FALSE.
  The ticket and the spec both assert the valve is dead ("no vision-valve.log,
  0 consults in 43h"). Checked directly against the live run's own event log
  (events/live-agent-1786898534540.jsonl, the run spanning the tail of the
  43h stall through the ticket filing):

      $ grep -c '"vision_consult"' events/live-agent-1786898534540.jsonl
      41
      # cross-checked independently via think_chunk{model:"lumen-vision"}: 41
      # cross-checked independently via events/run-summary-*.json's own
      # autoCalls.vision_consult field: 41
      # 40 via the oscillation trigger (wq#658), 1 via the original stuck
      # trigger (wq#621) — both wired live in src/agent.ts, neither disabled.

  "No vision-valve.log" is literally true — there never was a dedicated log
  file; vision events land in the shared events/live-agent-*.jsonl stream,
  same as everything else, by design (src/vision.ts has no file-logging code
  at all). That is very likely what produced the "0 fires" belief: whichever
  check looked for a dedicated log file, or for a persisted "VISION" key in
  runtime/notepad.txt (also correctly absent — src/notepad.ts's toJSON()
  deliberately excludes the in-memory guidance Map, wq#486), found nothing on
  either path and read that as "never fired" instead of "writes somewhere
  that isn't a standalone file."

  CONSEQUENCE FOR THIS TICKET: "fix the dead valve" is not this module's job
  because the valve is not dead. "make it fire on stuck>=3turns" is also
  already true today — CFG.visionValve.stuckN (src/config.ts) already
  defaults to 3, matching the spec's own number, unchanged since wq#621
  shipped. The REAL gap, and the one this module actually addresses: 41 hints
  over 27.5 hours produced a one-or-two-sentence "what's on screen" nudge each
  time and the loop never broke, because the valve is a HINT channel by
  design (vision.ts: "not a channel the brain gets every turn"; agent.ts:
  "hint only, does not override RAM/grid") and the actual blocker is a
  leveling/strategy gap (underleveled starter vs. Misty's Staryu L18/Starmie
  L21) that no amount of "what's on the screen" commentary was ever going to
  fix. That is exactly wq#674's independent diagnosis. This module's
  FIGHT_LOSS_LOOP prescription is therefore a STRUCTURAL nudge (a grind
  sub-objective, pinned into the notepad) layered on top of the
  already-firing valve, not a repair to the valve itself.

CONSUMPTION (was "not wired yet"; it is wired now)
  Prescribing "grind Route 24/25" or "ban this goto target" only helps if the
  live agent process actually reads the prescription. It does, on both halves:
  wq#724 wired ban enforcement (src/agent.ts loadSupervisorBans/enter_warp)
  and wq#1081/#1084 wired the textual half (loadSupervisorDirective now
  returns guidance-only directives, and observe() renders notepadPin as a "!!"
  line every turn). Both lift automatically once story_score/badges/events
  rise past the boot-time baseline.

  wq#1091 is the lesson that followed: once a pin is genuinely read every
  turn, its CONTENT becomes load-bearing, and a pin that contradicts a hard
  harness gate is worse than no pin. See the FIGHT_LOSS_LOOP note on
  GATE_FALLBACK below — the pin prescribed a grind target 9 levels under the
  gate that refuses gym entry, so the agent could obey it perfectly and stay
  stuck. Any number a prescription states must be READ FROM the code that
  enforces it, never retyped alongside it.

BOUNDING (K=3)
  Each (mode, locationId) pair — wq#671's own dedup key — gets up to K=3
  prescribed attempts. `decide()` counts prior LOGGED attempts for that exact
  key since the key's last resolution (a story_score/badge/event advance
  logged as "afterState" on a later call) and returns exhausted=True once the
  count reaches K, WITHOUT prescribing a 4th — the signal wq#673 uses to file
  (or append to) its one ticket and stop trying locally.

READ+WRITE, LOCAL FILES ONLY. Reads runtime/stuck_mode.json (or recomputes it
live via lpp_stuck_mode), checkpoints/**/*.json. Writes only
runtime/intervention_log.json (append-only history) and
runtime/supervisor_directive.json (current directive, single object,
overwritten each call) — never events/, checkpoints/, the game or the work
queue.
"""
import json, os, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_mode as M

BASE = os.environ.get("LPP_BASE", "/home/lumen/pokemon")
LOG_PATH = f"{BASE}/runtime/intervention_log.json"
DIRECTIVE_PATH = f"{BASE}/runtime/supervisor_directive.json"

K = 3  # spec wq#672: "INTERVENE (K=3)"

# wq#1091: the gym-readiness bar the HARNESS enforces, read from its single
# source of truth (src/guidance.ts) instead of retyped here. The original
# FIGHT_LOSS_LOOP pin told the agent to "grind to roughly L18-21" — those are
# MISTY'S OWN team levels (Staryu L18 / Starmie L21, quoted in this module's
# header), not a grind target. guidance.ts's misty_ready() refuses gym entry
# below L30 + 3 potions + 2 party members + a Grass/Rock counter, so an agent
# that followed the pin exactly ground to L21, walked back to the gym, and was
# refused (or re-entered and lost again) — which is precisely why all three
# K attempts on FIGHT_LOSS_LOOP@3 resolved to nothing across 33h. Any pin that
# names a number the gate disagrees with is a pin that cannot break the loop.
GUIDANCE_TS = os.path.join(os.path.dirname(HERE), "src", "guidance.ts")

# Fallbacks are the values guidance.ts holds today. They exist so a parse
# failure degrades to a still-correct pin rather than to no pin at all; if the
# TS constants move, the parse below picks the new ones up automatically.
GATE_FALLBACK = {"min_level": 30, "min_potions": 3, "min_roster": 2}


def _misty_gate(path=None):
    """Read MISTY_MIN_LEVEL/POTIONS/ROSTER out of src/guidance.ts.

    A regex over the `export const NAME = <int>;` lines, not a TS parse: the
    three constants are plain integer literals and have been since wq#674, and
    a grep that fails closed onto GATE_FALLBACK is worth more here than a
    dependency on a TypeScript toolchain inside a read-mostly Python tool.
    """
    import re
    gate = dict(GATE_FALLBACK)
    try:
        with open(path or GUIDANCE_TS) as f:
            src = f.read()
    except Exception:
        return gate
    for key, const in (("min_level", "MISTY_MIN_LEVEL"),
                       ("min_potions", "MISTY_MIN_POTIONS"),
                       ("min_roster", "MISTY_MIN_ROSTER")):
        m = re.search(r"export const %s\s*=\s*(\d+)\s*;" % const, src)
        if m:
            gate[key] = int(m.group(1))
    return gate


def _viable_pct():
    """VIABLE_HP_PCT as a whole-number percent, for pins that name it.

    Same rule as _misty_gate — parsed out of src/resume.ts by
    lpp_stuck_mode.resume_viable_pct rather than retyped here, so the number the
    RESUME_DEADEND pin quotes is the number the resume picker enforces (wq#1118).
    """
    return int(round(M.resume_viable_pct() * 100))

# Per-MODE prescription. Each is a template; decide() fills in the live
# state (badges/story/location) at call time so the directive always carries
# what the agent SHOULD see, not just what to do in the abstract.
PRESCRIPTIONS = {
    "FIGHT_LOSS_LOOP": {
        "action": "grind_sub_objective",
        "summary": "Underleveled for the gym fight — stop re-attempting, grind first.",
        # wq#1091: every number here comes from _misty_gate() so the pin can
        # never again prescribe a target the harness's own entry gate rejects.
        # The type counter is stated as a REQUIREMENT, not a preference: wq#677
        # made it one, and it is the actual wall (a solo L30 Charmeleon still
        # loses an all-Water gym, per src/probe_gymdoor674.ts).
        #
        # The "how to actually grind" half (walk into grass with goto, stop
        # re-healing at full HP, stop warping into buildings) is the live
        # hot-patch that was applied to the primary tree during this same
        # incident: those are the three turn-sinks the run was observed
        # burning on instead of grinding. Kept verbatim in substance.
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): stuck losing the gym fight at {location}. "
            "STOP re-entering the gym — the harness REFUSES entry until all four hold: "
            "lead level >= {min_level}, >= {min_potions} potions, >= {min_roster} party "
            "members, and at least one Grass or Rock party member (the gym is Water; a "
            "Fire lead is resisted, so more levels on the same mon will never win it — "
            "the type counter is what unblocks the badge). Go to Route 24/25 and CATCH "
            "an Oddish/Bellsprout/Paras/Geodude, then level it. Once you are ON a route, "
            "use goto() to WALK into the tall grass to trigger wild battles. Do NOT "
            "enter_warp into a house or building to look for grass, do not walk back "
            "into the doorway you just came out of, and do not warp to the Pokecenter "
            "to heal when already at full HP. Do not re-enter the gym until every one "
            "of the four conditions is satisfied."
        ),
        "gotoBan": [],
    },
    "NAV_LOOP": {
        "action": "checkpoint_restore_then_goto_ban",
        "summary": "Looping a small set of maps with no gym involved — ban the loop edge, fall back a checkpoint.",
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): navigation loop detected — warps stuck on "
            "{loop_labels}. Maps {loop_maps} are BANNED by the harness until story advances. "
            "Do not enter_warp to any of them. Resume from an earlier checkpoint outside "
            "the loop or pursue a different objective."
        ),
        "gotoBan": "__RESOLVE_FROM_WARPS__",
    },
    "OBJECTIVE_UNREACHABLE": {
        "action": "replan_verify_map_data",
        "summary": "No further critical-path milestone encoded — replan and verify map data before continuing.",
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): the frontier engine reports no further "
            "known milestone past {location}. Re-verify the current objective against "
            "the corridor notes before continuing; the map/route table may be stale or "
            "the current objective may already be complete."
        ),
        "gotoBan": [],
    },
    # wq#1118: the old prescription was "alternate_checkpoint — resume from a
    # different one", pinned into the notepad the in-game brain reads. Two things
    # were wrong with it, and together they are why three K attempts and 35h
    # produced nothing. First, the brain has no authority over the resume pick at
    # all: src/resume.ts's pickResume chooses, at boot, before the brain exists.
    # Second, the harness ALREADY applies that exact remedy — the repeat guard
    # demotes a file picked RESUME_REPEAT_LIMIT times running — and wq#1118's
    # classifier bar now means the mode only fires once that guard has run and
    # found nothing newer to take. So the pin asked the wrong actor for the one
    # thing already proven impossible. This is the wq#1091 lesson in its purest
    # form: an agent could obey it perfectly and stay stuck forever.
    #
    # What the brain CAN do is the only thing that changes the next boot: get off
    # the boot state and put a newer, non-warp save on disk for the picker to
    # take. Every claim the pin makes about ranking is read off pickResume's own
    # comparator (badges/story -> onWarp -> rank), not asserted alongside it.
    "RESUME_DEADEND": {
        "action": "advance_past_boot_state",
        "summary": ("Same checkpoint re-booted past the harness's repeat-guard limit and "
                    "nothing newer on disk qualifies — leave a newer non-warp, healthy save."),
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): every recent boot has restored the SAME "
            "checkpoint at {location}, and each run ends back on it. You do not choose "
            "the save — the harness does, at boot — and its repeat guard has already "
            "tried to pick a different one and found nothing on disk it will take. New "
            "autosaves keep landing, so what disqualifies them is yours to fix. (1) A "
            "save written while you are standing on a warp tile sorts below every "
            "non-warp save and the guard looks past it: do not linger on, or walk back "
            "into, the warp you booted on. (2) A save under {viable_pct}% HP, or with no "
            "move that still has PP, counts as non-viable and the guard will not trade a "
            "healthy checkpoint for it: heal BEFORE you keep playing, not after the next "
            "save lands. Then put real progress — a level, a catch, a story flag — "
            "between you and the boot state, so the save that replaces it is worth "
            "restoring."
        ),
        "gotoBan": [],
    },
    "IDLE": None,  # no prescribed action: the spec defines no IDLE intervention,
                   # and prescribing a guess for "nothing matched" would be exactly
                   # the kind of unfounded action this module exists to avoid.
    # wq#697: new signatures
    "WARP_OSC": {
        "action": "checkpoint_restore_then_goto_ban",
        "summary": "Two-map warp oscillation detected — ban the bounce edge, try a different warp.",
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): warp oscillation at {location}. "
            "The last several warps alternate between exactly two maps. Do NOT "
            "enter_warp the same index again this session; pick a different warp "
            "or goto a non-warp tile first. If no other warp exists, resume from "
            "an earlier checkpoint."
        ),
        "gotoBan": "__RESOLVE_FROM_WARPS__",
    },
    "NOISE_STORM": {
        "action": "history_clear_restart",
        "summary": "Consecutive hallucinated/failed tool calls — history poisoned, restart needed.",
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): noise storm at {location}. "
            "The brain has emitted {attempt} consecutive invalid tool calls "
            "(unknown tool/parse_error). The conversation history is poisoned "
            "with failure patterns. A restart clears the history and breaks "
            "the pattern-completion loop."
        ),
        "gotoBan": [],
    },
}


WARP_HISTORY = f"{BASE}/runtime/warp_history.json"
NAMES_FILE = f"{os.path.join(HERE, 'map_names.json')}"


def _resolve_loop_maps():
    """The maps a ban may name, from the recent warp history. Sorted ints, or
    empty when the history does not identify a bannable loop.

    wq#1149 removed the two ways this could name a map the agent needs.

    The old "top-2 most frequent" fallback fired whenever the window held more
    than 3 distinct ids — which, across a multi-day freeze, is nearly always —
    and frequency is not adjacency: the two most-visited maps of a long stall are
    the hub and the destination, not the edge anyone is bouncing on. On the live
    Route 25 window it resolved to Cerulean City + Route 25, i.e. the only heal
    point and the grind route, three times running. wq#1119 fixed the classifier
    side of that ("an edge ban needs an edge") and this side kept manufacturing
    one. A window that does not collapse onto a small set does not name a loop,
    and the honest answer is no ban rather than a frequency guess.

    The second filter drops any map inside a stage the harness steers
    (M.stage_region). Those maps are the stage's own plan — heal hub, mart, grind
    routes — so banning one forbids a step the agent is simultaneously being told
    to take. The classifier already refuses ban-remedy modes there; this is the
    same rule applied where the ban list is actually built, so no future caller
    can route around it.
    """
    try:
        with open(WARP_HISTORY) as f:
            warps = json.load(f).get("warps", [])
    except Exception:
        return []
    # Ask at both of the classifier's own scopes, for wq#1119's reason: NAV_LOOP
    # fires on the 64-warp window and WARP_OSC on the last 16, so resolving only
    # at the wide scope leaves an oscillation ban naming a window the detector
    # never looked at.
    region = set(M.stage_region())
    for window in (warps[-M.WARP_WINDOW:], warps[-M.WARP_OSC_WINDOW:]):
        if not window:
            continue
        distinct = sorted(set(window))
        # Only resolve if the window genuinely collapses onto a small set
        if len(distinct) > M.NAV_LOOP_MAX_DISTINCT:
            continue
        bannable = [m for m in distinct if m not in region]
        if bannable:
            return bannable
    return []


def _map_label(mid):
    """Best-effort human label for a map id."""
    try:
        with open(NAMES_FILE) as f:
            names = json.load(f)
        return names.get(str(mid), f"map{mid}")
    except Exception:
        return f"map{mid}"


def _located(mid):
    """wq#1091: how a location id is spelled inside a pin — "Cerulean City
    (map3)", falling back to "map3". Always contains the raw id, so anything
    matching on the number still matches."""
    label = _map_label(mid)
    return label if label == f"map{mid}" else f"{label} (map{mid})"


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_ms():
    return datetime.now(timezone.utc).timestamp() * 1000


def load_log(path=LOG_PATH):
    try:
        j = json.load(open(path))
        if isinstance(j, dict) and isinstance(j.get("attempts"), list):
            return j
    except Exception:
        pass
    return {"v": 1, "attempts": []}


def save_log(log, path=LOG_PATH):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(log, f, indent=1)
    os.replace(tmp, path)


def _key(mode, location_id):
    return f"{mode}@{location_id}"


def _stall_started_ms(state):
    """When the CURRENT story-axis freeze began, in ms, or None if the state does
    not say. wq#673 already treats wq#671's `lastAdvanceAt` as the identity of an
    incident (`firstStalledAt`, "so a supervisor that starts late still computes
    the correct 3h mark"); the K budget is scoped to the same instant."""
    try:
        return datetime.fromisoformat(state["lastAdvanceAt"].replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return None


def _snapshot(state):
    """The before/after game-state slice worth logging per attempt — small,
    durable fields only, matching wq#671's own axis (story_score PRIMARY)."""
    return {"storyScore": state.get("storyScore"), "badges": state.get("badges"),
            "eventFlags": state.get("eventFlags"), "map": state.get("map")}


def resolve_pending(log, state):
    """Close out any open (afterState=None) attempts for keys OTHER than the
    current stall, or for the current key if state has actually advanced
    since that attempt was logged. Called on every decide() so the log never
    accumulates stale opens across an intervention that quietly worked.
    """
    cur_key = _key(state.get("mode"), state.get("modeLocation")) if state.get("stalled") else None
    now_snap = _snapshot(state)
    changed = False
    for entry in log["attempts"]:
        if entry.get("afterState") is not None:
            continue
        advanced = (
            (now_snap.get("storyScore") or 0) > (entry["beforeState"].get("storyScore") or 0)
            or (now_snap.get("badges") or 0) > (entry["beforeState"].get("badges") or 0)
            or (now_snap.get("eventFlags") or 0) > (entry["beforeState"].get("eventFlags") or 0)
        )
        moved_on = entry["locationKey"] != cur_key
        if advanced or moved_on:
            entry["afterState"] = now_snap
            entry["outcome"] = "advanced" if advanced else "superseded"
            changed = True
    return changed


def open_attempt_count(log, location_key, since_ms=None):
    """Attempts logged for this key during the CURRENT freeze that have not been
    resolved as 'advanced' — i.e. every try that either failed or is still
    pending, which is what K bounds. A 'superseded' close (agent moved to a
    different mode/location without advancing) does not reset the counter: it is
    not evidence the intervention worked, just that the incident's shape changed.

    wq#1149: `since_ms` is the instant the current stall began (wq#671's
    `lastAdvanceAt`), and without it the budget leaked permanently. An 'advanced'
    close is the only thing that frees a slot, and `resolve_pending` only ever
    sets it on an entry still open — so an entry closed 'superseded' can never
    afterwards become 'advanced', and went on occupying one of the key's three
    slots for the life of the log, across any number of later advances and fresh
    stalls. Three drifts and the key was spent forever, having never once been
    tested. The budget belongs to the incident, not to the file.
    """
    return sum(1 for e in log["attempts"]
               if e["locationKey"] == location_key and e.get("outcome") != "advanced"
               and (since_ms is None or (e.get("ts") or 0) >= since_ms))


def _terminal_directive(template, mode, location_id, location_key, prior, now_ms):
    """wq#1091: the directive written once the K budget is spent.

    Carries the same standing requirement as the attempts did, but labelled
    EXHAUSTED rather than "attempt 3/3" so the pin the agent reads stops
    claiming an intervention is in flight when none can be. gotoBan is
    deliberately empty: a ban is an active intervention, and the supervisor has
    stopped intervening on this key — only the guidance stands.
    """
    pin = template["notepadPin"].format(
        attempt=prior, k=K, location=_located(location_id),
        loop_maps="unknown", loop_labels="unknown maps",
        viable_pct=_viable_pct(), **_misty_gate())
    return {
        "v": 1,
        "generatedAt": _iso(now_ms),
        "mode": mode,
        "location": location_id,
        "locationKey": location_key,
        "attempt": prior,
        "k": K,
        "exhausted": True,
        "action": template["action"],
        "summary": template["summary"],
        "notepadPin": pin.replace(f"SUPERVISOR ({prior}/{K})",
                                  f"SUPERVISOR (EXHAUSTED after {prior}/{K})"),
        "gotoBan": [],
    }


def decide(state=None, log=None, now_ms=None):
    """Returns a dict: {intervened, mode, locationKey, attempt, k, directive,
    exhausted}. Persists the directive and appends to the log as a side
    effect unless the caller is only inspecting (see main() --dry-run)."""
    if state is None:
        state = M.compute()
    if not state.get("ok"):
        return {"intervened": False, "reason": state.get("reason")}
    if log is None:
        log = load_log()
    now_ms = now_ms if now_ms is not None else _now_ms()

    resolve_pending(log, state)

    if not state.get("stalled"):
        return {"intervened": False, "reason": "not stalled", "mode": None}

    mode = state["mode"]
    location_id = state.get("modeLocation")
    location_key = _key(mode, location_id)
    template = PRESCRIPTIONS.get(mode)

    prior = open_attempt_count(log, location_key, _stall_started_ms(state))
    attempt = prior + 1

    if template is None:
        return {"intervened": False, "reason": f"no prescription defined for mode {mode}",
                "mode": mode, "locationKey": location_key, "attempt": attempt, "k": K}

    if attempt > K:
        # wq#1091: exhausted still REFRESHES the directive on disk. It appends
        # nothing to the log — that invariant is what wq#673 keys its one
        # ticket off, and it is untouched — but leaving the file frozen at the
        # attempt-3 text meant the live agent read a stale "SUPERVISOR (3/3)"
        # pin indefinitely (33h on FIGHT_LOSS_LOOP@3) with no way for a
        # corrected prescription to ever reach it, since the key can never
        # intervene again. The requirement outlives the attempt budget.
        return {"intervened": False, "exhausted": True, "mode": mode,
                "locationKey": location_key, "attempts": prior, "k": K,
                "directive": _terminal_directive(template, mode, location_id,
                                                 location_key, prior, now_ms),
                "reason": f"{prior} attempts already logged for {location_key} — "
                          f"handing off to the wq#673 feedback loop"}

    # wq#724: resolve gotoBan — the old symbolic "last_loop_target" was never
    # consumed because it never named actual map IDs. Now we read the warp
    # history and extract the maps the agent is genuinely looping between.
    goto_ban = template["gotoBan"]
    # wq#1091: the harness's own gym-entry thresholds, so a pin that names a
    # level can only ever name the level the gate actually enforces. Templates
    # that reference none of these keys simply ignore them.
    fmt_extras = dict(_misty_gate())
    # wq#1091: "the gym fight at 3" is a bare map id sitting next to several
    # level numbers in the same sentence. Name it.
    fmt_extras["location"] = _located(location_id)
    # wq#1118: the resume picker's own viability bar, same read-don't-retype rule.
    fmt_extras["viable_pct"] = _viable_pct()
    if goto_ban == "__RESOLVE_FROM_WARPS__":
        loop_maps = _resolve_loop_maps()
        goto_ban = loop_maps if loop_maps else []
        fmt_extras["loop_maps"] = ",".join(f"map{m}" for m in loop_maps) if loop_maps else "unknown"
        fmt_extras["loop_labels"] = ", ".join(
            f"{_map_label(m)} (map{m})" for m in loop_maps) if loop_maps else "unknown maps"

    directive = {
        "v": 1,
        "generatedAt": _iso(now_ms),
        "mode": mode,
        "location": location_id,
        "locationKey": location_key,
        "attempt": attempt,
        "k": K,
        "action": template["action"],
        "summary": template["summary"],
        "notepadPin": template["notepadPin"].format(attempt=attempt, k=K, **fmt_extras),
        "gotoBan": goto_ban,
    }

    entry = {
        "ts": now_ms, "mode": mode, "locationKey": location_key, "attempt": attempt,
        "directive": directive, "beforeState": _snapshot(state), "afterState": None,
        "outcome": None,
    }
    log["attempts"].append(entry)

    return {"intervened": True, "mode": mode, "locationKey": location_key,
            "attempt": attempt, "k": K, "directive": directive, "exhausted": False}


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--json", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="decide only, write nothing")
    args = p.parse_args(argv)

    log = load_log()
    result = decide(log=log)

    if not args.dry_run:
        save_log(log)
        # wq#1091: persist whenever decide() produced a directive at all — that
        # is now the intervening path AND the exhausted path, which must be
        # able to correct a stale pin it can no longer replace via an attempt.
        if result.get("directive"):
            tmp = DIRECTIVE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(result["directive"], f, indent=1)
            os.replace(tmp, DIRECTIVE_PATH)

    if args.json:
        print(json.dumps(result, indent=1))
    elif result.get("intervened"):
        d = result["directive"]
        print(f"INTERVENE [{d['mode']}@{d['location']}] attempt {d['attempt']}/{d['k']}: {d['summary']}")
    elif result.get("exhausted"):
        print(f"EXHAUSTED [{result['mode']}@{result['locationKey']}]: {result['reason']}")
    else:
        print(f"no intervention: {result.get('reason')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
