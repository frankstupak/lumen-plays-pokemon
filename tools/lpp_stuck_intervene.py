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
  key since the key's last resolution and returns exhausted=True once the
  count reaches K, WITHOUT prescribing a 4th — the signal wq#673 uses to file
  (or append to) its one ticket and stop trying locally.

  wq#1162: "the key's last resolution" means the classifier stopped calling
  that key the live stall — not merely that some counter ticked up. Crediting
  a raw counter tick refunded the budget mid-stall and made K unbounded in
  practice; see resolve_pending's own note for the failure it produced.

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
        "summary": "Two-map warp oscillation detected — ban the far side of the bounce edge, try a different warp.",
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): warp oscillation at {location}. Your "
            "last several warps alternate between {osc_edge}. {osc_ban} Stop "
            "re-entering the doorway you just came out of: goto a tile away from "
            "the warp first, then pursue the objective on foot. If the map you are "
            "standing on has no other warp, resume from an earlier checkpoint."
        ),
        "gotoBan": "__RESOLVE_FROM_WARPS__",
        # wq#1826: rev 2 — the ban is now the detected edge's far side, not the
        # wide window's top-2 maps. The three attempts WARP_OSC@36 spent under
        # rev 1 banned Cerulean City and Route 25 against evidence that read
        # "Route 25 <-> Bills House"; they do not count against the corrected
        # remedy's K budget.
        "rev": 2,
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


def _warp_history():
    """The raw warp list, newest-last, or [] if unreadable."""
    try:
        with open(WARP_HISTORY) as f:
            return json.load(f).get("warps", []) or []
    except Exception:
        return []


def _resolve_loop_maps():
    """NAV_LOOP's ban list: the distinct map IDs the recent warp history
    collapses onto — the maps the agent is looping between. Returns a sorted
    list of ints. WARP_OSC does NOT use this; see _resolve_osc_ban (wq#1826)."""
    # Use the same window the classifier does (last 64 warps)
    window = _warp_history()[-64:]
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


def _resolve_osc_ban(location_id, warps=None):
    """wq#1826: WARP_OSC's ban list — the FAR endpoint of the A<->B edge the
    classifier actually detected, and nothing else.

    Returns (ban, here, there): `here` is the endpoint the agent last warped to
    (its current map, and the incident's location), `there` is the one it keeps
    bouncing back into, `ban` is `[there]` or `[]` when there is nothing safe to
    ban. Two rules, both learned from WARP_OSC@36 sitting frozen 242h:

    1. **The ban is the edge.** This used to call _resolve_loop_maps(), which
       reads a 4x wider window (64 warps) than detect_warp_osc (16) and, when
       that window holds more than 3 maps, falls back to its two most FREQUENT
       ids. Those need not be — and live, were not — the endpoints of the
       oscillation: the directive's own evidence read "Route 25 <-> Bills House"
       while its gotoBan read [Cerulean City, Route 25]. So the harness banned
       the town it must heal and fight Misty in, never banned map 88 (the
       doorway actually being re-entered), and the bounce continued through all
       three K attempts. wq#1119 taught the classifier to demand a real edge;
       this is the other half — the ban has to BE that edge.
    2. **One side, never both.** The ban is a hard enter_warp refusal
       (`src/agent.ts` supervisorBans) that lifts only on story advance, so
       banning both endpoints seals the agent inside whichever one it is
       standing in: from inside Bills House the only exit warp lands on Route
       25, refused, and no story can advance from in there to lift it. Banning
       the far side alone breaks the loop and leaves the agent free to walk.

    A far side that is the town/heal hub is dropped rather than banned — the
    wq#1081/#1084 rule that the mandatory hub and only heal point can never be
    the answer. The directive then stands on its pin alone.
    """
    warps = _warp_history() if warps is None else warps
    hit, here, there, _alt = M.detect_warp_osc(warps)
    if not hit or here is None or there is None or here == there:
        return [], here, there
    if location_id is not None and here != location_id:
        # The history has moved on since the classification this ban is being
        # prescribed for; banning off a window that no longer describes the
        # incident is the wq#1119 scope-mismatch bug in a new place.
        return [], here, there
    if M.is_heal_or_city(there, M.load_map_names()):
        return [], here, there
    return [there], here, there


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


def resolve_pending(log, state):
    """Close out any open (afterState=None) attempts the current stall has
    moved past. Called on every decide() so the log never accumulates stale
    opens across an intervention that quietly worked.

    wq#1162: an attempt is only closed once the classifier STOPS reporting its
    own key as the live stall. While `mode@location` is still stalled, no
    counter reading can close an attempt prescribed for it, because the one
    authority on whether that stall is over already said it is not.

    The old rule closed an attempt as "advanced" whenever any of
    storyScore/badges/eventFlags had risen above the attempt's own beforeState,
    regardless of what the classifier currently said. That is a strictly weaker
    test than the classifier's: `advances()` in lpp_stuck_mode restarts the
    freeze clock on the same three counters, so a partial tick (eventFlags
    45->48 while story_score sits at 10) resets the clock, the stall re-freezes
    on the SAME key two hours later, and by then the open attempts compare
    favourably against their stale beforeState and close as wins. Each false
    win refunded the K budget, so the ladder ran 1,2,3,2,3,2,3... and the same
    grind prescription reissued indefinitely instead of exhausting once and
    handing off to wq#673. FIGHT_LOSS_LOOP@3 spent 4.9h and seven supervisor
    ticks in that shape.
    """
    cur_key = _key(state.get("mode"), state.get("modeLocation")) if state.get("stalled") else None
    now_snap = _snapshot(state)
    changed = False
    for entry in log["attempts"]:
        if entry.get("afterState") is not None:
            continue
        if entry["locationKey"] == cur_key:
            # Still the live stall. Whatever the counters read, this attempt
            # has not resolved anything — leave it open so it keeps costing K.
            continue
        advanced = (
            (now_snap.get("storyScore") or 0) > (entry["beforeState"].get("storyScore") or 0)
            or (now_snap.get("badges") or 0) > (entry["beforeState"].get("badges") or 0)
            or (now_snap.get("eventFlags") or 0) > (entry["beforeState"].get("eventFlags") or 0)
        )
        entry["afterState"] = now_snap
        entry["outcome"] = "advanced" if advanced else "superseded"
        changed = True
    return changed


def open_attempt_count(log, location_key, rev=None):
    """Attempts logged for this key that have NOT yet been resolved as
    'advanced' — i.e. every try that either failed or is still pending,
    which is what K bounds. A 'superseded' close (agent moved to a different
    mode/location without advancing) does not reset the counter: it is not
    evidence the intervention worked, just that the incident's shape changed.

    wq#1826: with `rev` given, only attempts made under that revision of the
    mode's prescription count. K bounds tries of a remedy, and WARP_OSC@36 spent
    all three of its on a ban that named the wrong maps (see _resolve_osc_ban):
    a corrected remedy that can never be issued because the broken one used up
    the budget is not a fix. Bumping a prescription's `rev` is therefore the
    deliberate act of refunding K for that mode alone — entries written under
    the old rev stay in the log as history, and every other mode's budget is
    untouched. rev=None counts every entry (callers that only want the history).
    """
    return sum(1 for e in log["attempts"]
               if e["locationKey"] == location_key and e.get("outcome") != "advanced"
               and (rev is None or e.get("rev", 1) == rev))


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
        osc_edge="the same two maps",
        osc_ban="No map is banned: the supervisor has stopped intervening on this key.",
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

    rev = (template or {}).get("rev", 1)
    prior = open_attempt_count(log, location_key, rev)
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
    if goto_ban == "__RESOLVE_FROM_WARPS__" and mode == "WARP_OSC":
        # wq#1826: the oscillation's own edge, not the wide window's top-2 maps.
        goto_ban, here, there = _resolve_osc_ban(location_id)
        fmt_extras["osc_edge"] = (f"{_located(here)} <-> {_located(there)}"
                                  if here is not None and there is not None and here != there
                                  else "the same two maps")
        fmt_extras["osc_ban"] = (
            f"{_located(goto_ban[0])} is BANNED by the harness until story advances — "
            f"do not enter_warp back into it." if goto_ban else
            "No map is banned: the far side of the bounce is one the run cannot do "
            "without, so the loop is yours to break on foot.")
    elif goto_ban == "__RESOLVE_FROM_WARPS__":
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
        "rev": rev,  # wq#1826: which revision of the mode's prescription this tried
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
