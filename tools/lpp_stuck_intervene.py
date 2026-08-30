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
    "RESUME_DEADEND": {
        "action": "alternate_checkpoint",
        "summary": "Same checkpoint booted twice in a row — resume from a different one.",
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): the last two boots resumed from the same "
            "checkpoint near {location} with no progress between them. Resume from a "
            "different, earlier checkpoint next boot instead of the same one."
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
    """Extract the distinct map IDs from the recent warp history — these are
    the maps the agent is looping between. Returns a sorted list of ints."""
    try:
        with open(WARP_HISTORY) as f:
            warps = json.load(f).get("warps", [])
    except Exception:
        return []
    # Use the same window the classifier does (last 64 warps)
    window = warps[-64:]
    if not window:
        return []
    distinct = sorted(set(window))
    # Only resolve if the window genuinely collapses onto a small set
    if len(distinct) <= 3:
        return distinct
    # Fallback: take the top-2 most frequent maps in the window
    from collections import Counter
    counts = Counter(window)
    return sorted(m for m, _ in counts.most_common(2))


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


def _snapshot(state):
    """The before/after game-state slice worth logging per attempt — small,
    durable fields only, matching wq#671's own axis (story_score PRIMARY)."""
    return {"storyScore": state.get("storyScore"), "badges": state.get("badges"),
            "eventFlags": state.get("eventFlags"), "map": state.get("map")}


# wq#1097: which snapshot fields count as the prescription having WORKED.
# An intervention is prescribed to unstick story progress, so only story
# progress closes it out. eventFlags is excluded deliberately — see
# resolve_pending.
STORY_KEYS = ("storyScore", "badges")


def _rose(now_snap, before, keys):
    return any((now_snap.get(k) or 0) > (before.get(k) or 0) for k in keys)


def resolve_pending(log, state):
    """Close out any open (afterState=None) attempts for keys OTHER than the
    current stall, or for the current key if state has actually advanced
    since that attempt was logged. Called on every decide() so the log never
    accumulates stale opens across an intervention that quietly worked.

    wq#1097: "advanced" means the STORY axis rose (storyScore or badges), not
    any axis. The old test also accepted an eventFlags rise, and eventFlags is
    the noisy one — it ticks for an item pickup or an NPC line. On
    FIGHT_LOSS_LOOP@3 that single difference made K unbounded in practice: one
    flag tick closed the open attempts as "advanced", open_attempt_count fell
    back to 1, and decide() re-prescribed the identical grind pin. The logged
    outcomes read 1(superseded), 2(advanced), 3(advanced), 2(advanced),
    3(advanced), 2, 3 — a ladder oscillating between 2 and 3 for 47 supervisor
    ticks, never reaching attempt 1 again and never exhausting for good, while
    storyScore sat at 10 and badges at 1 the entire time. A flags-only rise now
    leaves the attempt OPEN: it keeps counting against K, and it stays eligible
    to close as "advanced" if the story really does move later.
    """
    cur_key = _key(state.get("mode"), state.get("modeLocation")) if state.get("stalled") else None
    now_snap = _snapshot(state)
    changed = False
    for entry in log["attempts"]:
        if entry.get("afterState") is not None:
            continue
        advanced = _rose(now_snap, entry["beforeState"], STORY_KEYS)
        moved_on = entry["locationKey"] != cur_key
        if advanced or moved_on:
            entry["afterState"] = now_snap
            entry["outcome"] = "advanced" if advanced else "superseded"
            changed = True
    return changed


def open_attempt_count(log, location_key, state=None):
    """Attempts logged for this key SINCE its last genuine resolution — i.e.
    every try that either failed or is still pending, which is what K bounds.
    A 'superseded' close (agent moved to a different mode/location without
    advancing) does not reset the counter: it is not evidence the intervention
    worked, just that the incident's shape changed.

    wq#1097: "since its last resolution" is what this module's header always
    claimed and what the count now implements. It previously summed EVERY
    non-advanced attempt ever logged for the key, with no notion of "since",
    so one superseded attempt from a long-finished incident occupied a slot
    forever — the reason FIGHT_LOSS_LOOP@3 could never return to attempt 1
    even across genuine story progress. Two things retire an attempt and
    everything logged before it: the attempt itself closing as 'advanced', and
    (when `state` is supplied) the story axis having risen at all since that
    attempt was prescribed. The second case is what catches attempts that were
    already closed as 'superseded' before the advance landed — resolve_pending
    never revisits a closed entry, so without it those slots leak.
    """
    now_snap = _snapshot(state) if state is not None else None
    spent = 0
    for e in log["attempts"]:
        if e["locationKey"] != location_key:
            continue
        if e.get("outcome") == "advanced":
            spent = 0
        elif now_snap is not None and _rose(now_snap, e["beforeState"], STORY_KEYS):
            spent = 0
        else:
            spent += 1
    return spent


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
        loop_maps="unknown", loop_labels="unknown maps", **_misty_gate())
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

    prior = open_attempt_count(log, location_key, state)
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


def persist_directive(result, path=DIRECTIVE_PATH):
    """Write the directive decide() produced, if it produced one. Returns
    whether it wrote.

    wq#1097: shared by main() and tools/lpp-stuck-supervisor so the two can
    never again disagree about when the pin is refreshed. BOTH the intervening
    and the exhausted path produce a directive, and only the exhausted path
    has no other way to correct a stale pin — an exhausted key can never
    intervene again (wq#1091). Persisting on `intervened` alone, which is what
    the supervisor entrypoint did, freezes the agent's pin at the attempt-3
    text for the entire life of the incident.
    """
    directive = (result or {}).get("directive")
    if not directive:
        return False
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(directive, f, indent=1)
    os.replace(tmp, path)
    return True


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
        persist_directive(result)

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
