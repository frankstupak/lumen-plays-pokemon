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

  wq#1867 is the same lesson one level up: not a wrong NUMBER in the pin but a
  wrong OBJECTIVE. The Cascade Badge landed at 2026-09-12T13:29:40Z and the
  classifier went on calling the aftermath FIGHT_LOSS_LOOP@65, so all three K
  attempts told an agent holding that badge to prepare for the fight that had
  won it. It obeyed — 26 turns north to the grind routes the pin names, while
  frontier.json's next milestone, Route 5, lay south, and its own ROUTE line
  said so every turn. A pin outranks the prompt it contradicts. The fix is in
  the classifier (see OBJECTIVE_DRIFT in lpp_stuck_mode), and the prescription
  it routes to here names no destination of its own: the goal comes from the
  frontier engine and the leg from route.ts's ROUTE line.

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

  wq#1846: and the budget is scoped to ONE STALL EPISODE, not to the key for
  all time. The count used to run over the key's whole history, so a key that
  spent K once was barred from issuing a numbered attempt ever again:
  FIGHT_LOSS_LOOP@65 spent its three on 2026-08-18 (all closed "superseded"
  when a checkpoint restore rolled the save back, eventFlags 43->39), and the
  unrelated freeze that began 2026-09-02 got ZERO interventions across 246h —
  decide() answered exhausted on its first tick and every tick after. An
  episode ends when the key stops being the live stall for longer than the
  classifier's own freeze clock can account for (see episode_start). That is
  the one boundary a mid-stall partial tick cannot manufacture, which is what
  keeps wq#1162's ladder shut while the 25-day-old spent key gets a fresh K.

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

# wq#1846: how long a key must stop being the live stall before its next freeze
# counts as a NEW episode, and therefore as a fresh K budget. Expressed in
# multiples of the classifier's own freeze window (lpp_stuck_mode's windowHours,
# 2h today) rather than as a bare hour count, so the two move together.
#
# WHY 12 WINDOWS AND NOT 1. A partial tick — eventFlags rising while story_score
# stays frozen — restarts that freeze clock (lpp_stuck_mode.advances), so the
# quiet a mid-stall tick can manufacture is bounded by one window plus the
# supervisor's own poll gap (~30min live). A boundary anywhere near one window
# would therefore re-open wq#1162: the live FIGHT_LOSS_LOOP@3 ladder re-froze on
# the SAME key 9.2h and 7.7h after its previous attempt
# (runtime/intervention_log.json, 2026-08-28T22:53 -> 08-29T08:05 -> 16:14) and
# every one of those re-freezes has to stay inside one episode. 24h clears the
# widest of them with room to spare, while the boundary this ticket exists to
# cross — FIGHT_LOSS_LOOP@65's last attempt 2026-08-18, next freeze 2026-09-02 —
# is 15 days, an order of magnitude past it.
EPISODE_GAP_WINDOWS = 12

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
    # wq#1867: the mode that exists because the FIGHT_LOSS_LOOP prescription
    # above was being handed to an agent that had ALREADY WON the fight. Three
    # attempts told it to prepare for Misty while the Cascade Badge was on its
    # card; it obeyed, walked 26 turns north to the grind routes the pin names,
    # came back, and the badge-shaped hole in the diagnosis was still there. So
    # this prescription prescribes no preparation at all: the blocker is gone,
    # and the only thing left to do is leave.
    #
    # It names no destination of its own. The goal comes from the frontier engine
    # (state["nextMilestone"]) and the leg from route.ts's own ROUTE line, for the
    # same reason _misty_gate reads guidance.ts: a target the supervisor invents
    # is a target the harness can disagree with, and the pin loses.
    "OBJECTIVE_DRIFT": {
        "action": "advance_to_next_objective",
        "summary": "Badge here is already won — stop orbiting the town, travel to the next objective.",
        "notepadPin": (
            "PIN: SUPERVISOR ({attempt}/{k}): the gym in {location} is ALREADY BEATEN — "
            "its badge is on your trainer card and the fight ledger holds the win. There "
            "is nothing left to prepare for here and no gate refusing you anything, so "
            "stop cycling this town's doors: re-entering the Pokecenter at full HP, the "
            "Mart with nothing to buy, or the gym you already cleared each cost a turn and "
            "move nothing. {next_objective} {leg}"
        ),
        "gotoBan": [],
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
FRONTIER_PATH = f"{BASE}/runtime/frontier.json"
NAMES_FILE = f"{os.path.join(HERE, 'map_names.json')}"

# wq#1563: the recovery-of-last-resort rung, and its kill-criteria.
#
# THE INCIDENT this rung exists for. FIGHT_LOSS_LOOP@3 sat frozen 167.9h on the
# story_score axis (runtime/stuck_escalation.json), and the FRONTIER axis had
# been frozen since 2026-08-16 — 582h. K was spent, so decide() returned a
# handoff that handed off to nothing, and the supervisor tick-looped forever.
# What the agent was actually doing, read off the live event log: 452 turns,
# 725 goto calls, ZERO battles entered, ZERO catches, dP flat at 0 new tiles,
# every sample on map 35. It was not losing fights at all. It was walking in
# circles on one route while the pin told it to go grind.
#
# WHY THIS RUNG AND NOT THE OTHER FOUR. The options weighed, and why each was
# rejected or folded in (kept here because the next person to look at a frozen
# incident will reach for the same list):
#   - forced flee/run: no mechanism and no target. This supervisor writes files
#     and never presses a button, and the agent enters no battles to flee from.
#   - forced heal-return-to-Pokecenter routing: this IS the failure mode. The
#     party is at full HP and the wq#1091 pin already had to tell the agent to
#     STOP warping to the centre to heal at full HP.
#   - checkpoint restore / soft-reset to the last frontier map: the destructive
#     one. It can regress story flags, and src/resume.ts's pickResume owns the
#     boot pick anyway (wq#1118) — a reset that lands back on the same state is
#     just RESUME_DEADEND, which already has its own mode. Rejected outright:
#     a recovery step that can lose progress is not a recovery step.
#   - blacklist the losing action: right idea, wrong granularity as it stands.
#     The existing gotoBan bans enter_warp INTO maps; here the agent is caged
#     ON one map, so banning map 35 would exile it from the only grass route it
#     needs. Banning the individual tiles is no better — the trailing window
#     covers 25 distinct tiles, and banning 25 tiles can make the map's own exit
#     unreachable, which turns a stall into a hard stop.
# What survives is the bounded explore-away directive: while the budget runs,
# goto is refused ON the stale map and the two EXIT primitives (leave_edge,
# enter_warp) stay open. It cannot corrupt a save, cannot regress the story,
# cannot loop resets, and kills the exact 725-goto thrash that was observed.
#
# KILL-CRITERIA, so it cannot thrash (each is asserted in tools/test_stuck1563.py):
#   1. anchor required — fires only when a full dP window of progress samples
#      sits on ONE map and adds no more than breakout_new_tile_max() tiles while
#      there. No anchor, no breakout; the rung never invents a target.
#   2. once per STALL EPISODE of a key — breakout_entry() finds the prior firing
#      within the live episode and decide() refuses a second, so the ladder
#      cannot cycle the way wq#1162 found the K budget cycling. Scoped to the
#      episode for the same reason K is (wq#1846): "ever" would mean a breakout
#      spent in a stall that finished months ago retires the rung permanently.
#   3. bounded — BREAKOUT_WINDOW_MULT dP windows of turns, then it expires.
#   4. it releases its own ban on expiry: the terminal handoff carries an empty
#      ban, so a failed breakout never leaves a live restriction behind.
#   5. it lifts free on success — the harness already clears any directive when
#      story advances past its baseline (src/agent.ts checkSupervisorLift).
BREAKOUT_WINDOW_MULT = 3   # budget = 3 dP windows; one window is the flatness
                           # test itself, so three gives two clear windows to
                           # show a new tile before the rung admits defeat.

# How many NEW tiles a full window may contain and still count as re-walking
# known ground. Measured, not guessed: on the live FIGHT_LOSS_LOOP@3 incident
# the three most recent 40-turn windows of runtime/progress.json contained 0, 2
# and 0 new tiles while touching 25 distinct positions — the agent was pacing a
# route it had already mapped. A tenth of the window is well above that and far
# below a real traversal, which adds tiles on most turns.
#
# The classifier's own dP `flat` flag was tried here first and rejected: it is
# computed off the composite P, so ONE new tile flips it false. The rung would
# have fired or not on a coin-flip between consecutive supervisor ticks — the
# live incident flipped flat true->false inside ten minutes while staying just
# as frozen. A rate, sampled over the same window, does not flap.
def breakout_new_tile_max(window):
    return max(1, window // 10)


def _frontier(path=None):
    return M.load_json(path or FRONTIER_PATH, {}) or {}


def breakout_anchor(state, samples=None, window=None, frontier=None):
    """The (stall_map, target_map, last_turn) a breakout would act on, or None.

    Kill-criterion 1. Two conditions, both read off files another module owns:
    the trailing window of runtime/progress.json (written by the wq#1179
    tracker) must sit entirely on ONE map, and must have added no more than
    breakout_new_tile_max() new tiles while there. The window length is
    src/novelty.ts's DP_WINDOW_TURNS, parsed not retyped, and the map to aim at
    is runtime/frontier.json's furthestMap.

    The caller has already established the other half of the case: decide()
    only reaches this rung when the classifier says stalled and K is spent.
    """
    dp = state.get("dP") or {}
    if not dp.get("ok"):
        return None                      # no novelty tracking: no honest anchor
    window = window or M.dp_window_turns()
    samples = samples if samples is not None else M.load_progress()
    tail = [s for s in samples[-window:] if s.get("map") is not None]
    if len(tail) < window:
        return None                      # not enough evidence to name a cage
    maps = {s["map"] for s in tail}
    if len(maps) != 1:
        return None                      # moving between maps: not map-local
    new_tiles = sum((s.get("newTiles") or 0) for s in tail)
    if new_tiles > breakout_new_tile_max(window):
        return None                      # genuinely exploring: leave it alone
    stall_map = tail[-1]["map"]
    fr = frontier if frontier is not None else _frontier()
    target = fr.get("furthestMap")
    if not isinstance(target, int) or target == stall_map:
        # Already parked on the frontier map: aim at any map this run has
        # reached that is not the stale one and not in the recent window.
        recent = {m.get("id") for m in (fr.get("recentMaps") or []) if isinstance(m, dict)}
        target = next((m for m in (fr.get("mapsEver") or [])
                       if isinstance(m, int) and m != stall_map and m not in recent), None)
    last_turn = tail[-1].get("turn")
    return {"stallMap": stall_map, "targetMap": target, "newTiles": new_tiles,
            "lastTurn": last_turn if isinstance(last_turn, int) else None,
            "budgetTurns": window * BREAKOUT_WINDOW_MULT}


def breakout_entry(log, location_key, since=None):
    """The live breakout logged for this key, or None (kill-criterion 2).

    Same accounting rule as open_attempt_count: a breakout that closed as
    'advanced' is a breakout that WORKED, and wq#1162 made 'advanced' mean the
    classifier itself stopped reporting the key. Letting that one keep the rung
    disabled would mean a stall could be broken once and never again; a
    'superseded' close, which is only evidence the incident changed shape, does
    keep it spent.

    `since` scopes the lookup to ONE stall episode, for the same reason
    open_attempt_count takes it (wq#1846): "once per incident" is the kill
    criterion, and a breakout spent in a long-finished stall must not disable
    the rung for a fresh one. Unscoped, a single 'superseded' breakout would
    retire the rung for that key permanently.
    """
    for e in log["attempts"]:
        if (e["locationKey"] == location_key and e.get("rung") == "breakout"
                and e.get("outcome") != "advanced"
                and (since is None or (e.get("ts") or 0) >= since)):
            return e
    return None


def breakout_expired(entry, samples=None):
    """Has a fired breakout run out its turn budget (kill-criterion 3)?

    Turns, not wall-clock: the budget is about how much the agent got to TRY,
    and a run that is down produces no turns and should not burn the budget.
    """
    d = entry.get("directive") or {}
    expires = d.get("expiresAtTurn")
    if not isinstance(expires, int):
        return True                      # unreadable budget fails closed
    samples = samples if samples is not None else M.load_progress()
    turns = [s.get("turn") for s in samples if isinstance(s.get("turn"), int)]
    if not turns:
        return False                     # no turn data yet: the budget still stands
    # progress.json is a rolling window and `turn` resets when the process
    # restarts, so a CURRENT turn below the recorded one means a new run began —
    # which is itself the end of the budget, since the directive it was written
    # for was consumed at that boot.
    return turns[-1] >= expires or turns[-1] < (d.get("issuedAtTurn") or 0)


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
    # "keys" (wq#1846) is the per-key episode/liveness block; it is additive and
    # optional, so a log written before it existed loads unchanged.
    return {"v": 1, "attempts": [], "keys": {}}


def save_log(log, path=LOG_PATH):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(log, f, indent=1)
    os.replace(tmp, path)


def persist_directive(directive, path=DIRECTIVE_PATH):
    """Write the pin the live agent reads. The ONE writer of DIRECTIVE_PATH.

    wq#1845: this used to be two copies — main() below and the same five lines
    inlined in tools/lpp-stuck-supervisor — and the copies drifted. wq#1091
    taught main() to persist on the exhausted path too (a key past K still has a
    standing requirement, and a pin frozen at "attempt 3/3" is worse than none);
    the supervisor's copy kept writing only when decide() said `intervened`.
    The supervisor is the copy the systemd timer runs, so in production the
    exhausted directive was computed on every tick and dropped on the floor,
    leaving the file at whatever a DIFFERENT incident last wrote. FIGHT_LOSS_LOOP@65
    spent 246h that way: the agent stood in Cerulean Gym losing to Misty while
    its every-turn pin described a warp oscillation on Route 25 (WARP_OSC@36,
    written 2026-09-12T10:55Z and never replaced).

    One writer, two callers, so the next rule about WHEN to write can only be
    written once.
    """
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(directive, f, indent=1)
    os.replace(tmp, path)


def _key(mode, location_id):
    return f"{mode}@{location_id}"


def _snapshot(state):
    """The before/after game-state slice worth logging per attempt — small,
    durable fields only, matching wq#671's own axis (story_score PRIMARY)."""
    return {"storyScore": state.get("storyScore"), "badges": state.get("badges"),
            "eventFlags": state.get("eventFlags"), "map": state.get("map")}


def _episode_gap_ms(state):
    """The quiet gap that ends an episode, in ms, read off the live classifier
    window the state was computed with (falling back to lpp_stuck_mode's own
    default when a caller hands us a state without one)."""
    try:
        window_h = float(state.get("windowHours"))
    except (TypeError, ValueError):
        window_h = M.DEFAULT_WINDOW_H
    if window_h <= 0:
        window_h = M.DEFAULT_WINDOW_H
    return EPISODE_GAP_WINDOWS * window_h * 3.6e6


def _attempt_cluster_start(log, location_key, now_ms, gap_ms):
    """Episode start inferred from attempt timestamps alone — the fallback for a
    key with no recorded liveness yet (a log written before wq#1846, or a key's
    first sighting in this log).

    Walks the key's attempts newest-first, keeping each one that lands within
    gap_ms of the one after it, and returns the oldest still in that run. None
    means even the newest attempt is older than gap_ms, i.e. nothing logged for
    this key belongs to the episode starting now.
    """
    stamps = sorted(e.get("ts") or 0 for e in log["attempts"]
                    if e.get("locationKey") == location_key)
    start, nxt = None, now_ms
    for ts in reversed(stamps):
        if nxt - ts > gap_ms:
            break
        start, nxt = ts, ts
    return start


def episode_start(log, location_key, now_ms, gap_ms):
    """When the stall episode this key is in RIGHT NOW began. Returns
    (started_at_ms, episode_number) and records the sighting.

    An EPISODE is one continuous run of the key being the live stall. It ends
    only when the key stops being the live stall for longer than gap_ms — the
    one boundary a mid-stall partial tick cannot manufacture. The obvious
    alternative, counting attempts made since state.lastAdvanceAt, re-opens
    wq#1162 exactly: advances() restarts the freeze clock on ANY of
    storyScore/badges/eventFlags rising, so a partial tick would refund K and
    the 1,2,3,2,3 ladder comes back.

    Liveness is heartbeated into log["keys"][key]["lastLiveAt"] on EVERY call,
    including the exhausted ticks that deliberately append no attempt (wq#673
    keys its one ticket off that invariant, so the heartbeat lives outside
    log["attempts"] and leaves it untouched). Without it, an unbroken freeze on
    an exhausted key would be indistinguishable — from the attempt timestamps
    alone — from a key that had been quiet for a month, and K would be refunded
    to a stall that never ended.
    """
    keys = log.get("keys")
    if not isinstance(keys, dict):
        keys = log["keys"] = {}
    st = keys.get(location_key)
    if not isinstance(st, dict):
        # No heartbeat to trust: believe what the attempts themselves say. A key
        # with attempts on record but none inside the window is on at least its
        # second episode — how many more, a log that predates the heartbeat
        # cannot say, so "2" is the honest floor.
        cluster = _attempt_cluster_start(log, location_key, now_ms, gap_ms)
        older = any(e.get("locationKey") == location_key for e in log["attempts"])
        st = {"episode": 1 if cluster is not None or not older else 2,
              "episodeStartedAt": now_ms if cluster is None else cluster}
    elif now_ms - (st.get("lastLiveAt") or 0) > gap_ms:
        st = {"episode": (st.get("episode") or 1) + 1, "episodeStartedAt": now_ms}
    st.setdefault("episode", 1)
    st.setdefault("episodeStartedAt", now_ms)
    st["lastLiveAt"] = now_ms
    keys[location_key] = st
    return st["episodeStartedAt"], st["episode"]


def resolve_pending(log, state, episode_start_ms=None):
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

    wq#1846: "still the live stall" is scoped to the CURRENT episode
    (`episode_start_ms`, from episode_start). An attempt left open by an EARLIER
    episode of the same key — the supervisor stopped ticking while the key was
    quiet, so nothing was ever there to close it — says nothing about the stall
    running now, and holding it open forever would leave exactly the stale opens
    this function exists to prevent.
    """
    cur_key = _key(state.get("mode"), state.get("modeLocation")) if state.get("stalled") else None
    now_snap = _snapshot(state)
    changed = False
    for entry in log["attempts"]:
        if entry.get("afterState") is not None:
            continue
        if entry["locationKey"] == cur_key and (
                episode_start_ms is None or (entry.get("ts") or 0) >= episode_start_ms):
            # Still the live stall, this episode. Whatever the counters read,
            # this attempt has not resolved anything — leave it open so it
            # keeps costing K.
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


def open_attempt_count(log, location_key, rev=None, since=None):
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

    wq#1846: `since` scopes the count to ONE stall episode — episode_start()'s
    timestamp. Without it the count runs over the key's entire lifetime, and a
    key that spent K in some long-finished stall can never issue a numbered
    attempt again (FIGHT_LOSS_LOOP@65, 246h of silence; see the module header).
    since=None counts every episode, for callers that want the history.
    """
    return sum(1 for e in log["attempts"]
               if e["locationKey"] == location_key and e.get("outcome") != "advanced"
               and (rev is None or e.get("rev", 1) == rev)
               and (since is None or (e.get("ts") or 0) >= since))


def _fmt_extras(location_id, state=None):
    """Every field a prescription template may name, resolved from live state.

    wq#1867: one home for this, shared by the attempt directives and the
    terminal one. Two things follow. An EXHAUSTED pin can no longer say
    something different from the attempts it succeeds (it used to rebuild the
    kwargs by hand), and a template that names a NEW field can no longer take
    the terminal path down with a KeyError — the field is defined once, for both.

    Mode-specific fields are defaults here; decide() overwrites the two that have
    something live to say (the WARP_OSC edge, the NAV_LOOP ban list).
    """
    state = state or {}
    # wq#1091: the harness's own gym-entry thresholds, so a pin that names a
    # level can only ever name the level the gate actually enforces.
    extras = dict(_misty_gate())
    # wq#1091: "the gym fight at 3" is a bare map id sitting next to several
    # level numbers in the same sentence. Name it.
    extras["location"] = _located(location_id)
    # wq#1118: the resume picker's own viability bar, same read-don't-retype rule.
    extras["viable_pct"] = _viable_pct()
    extras["loop_maps"] = "unknown"
    extras["loop_labels"] = "unknown maps"
    extras["osc_edge"] = "the same two maps"
    extras["osc_ban"] = "No map is banned."
    milestone = state.get("nextMilestone")
    extras["next_objective"] = (
        f"Your next objective is {milestone}." if milestone else
        "Your next objective is whatever your ROUTE line is pointing at.")
    # wq#1867: the local half. reach.ts has already told the agent, on every one
    # of these turns, that walking cannot leave the region it is standing in; a
    # pin that answers "walk to the next town" without this is prescribing the
    # move that just failed. Silent when the evidence is absent.
    # wq#1877: and the advice this used to give — "take one of the warps the
    # harness lists as reachable, a different door" — was the loop it was
    # written to break. On Cerulean every reachable warp is a shop whose only
    # door back is the one you walked in by; the region's one crossing is a door
    # an NPC is standing on, and the refusal itself now names it, names the NPC,
    # and names where the game clears that NPC (src/reach.ts blockedCrossings,
    # src/unblock.ts). A pin cannot know which of those applies today, so it
    # sends the agent to the answer instead of inventing one.
    extras["pocket"] = (
        "Note: the harness keeps answering that walking cannot leave the part of this map "
        "you are standing in. Its own goto/leave_edge refusal lists the ways out of it — the "
        "map edges that work from here, and the one door that crosses, with whatever is "
        "standing on it and where the game clears that. Do what THAT list says; the doors you "
        "have already used are the loop, not the exit."
        if (state.get("closedOffTurns") or 0) else "")
    # wq#1877: and while the pocket clause has something to say, the pin must
    # STOP ordering the leg. It spent its whole K budget telling an agent to
    # take a NEXT LEG (leave_edge(S) into Route 5) that starts in the half of
    # the map it cannot walk to — the wq#1091 footgun with a destination instead
    # of a level: obeyed perfectly, impossible anyway. The two halves are one
    # field so they cannot contradict each other.
    extras["leg"] = (
        "The ROUTE line in your prompt names that goal and the NEXT LEG that starts it — "
        "take that leg." if not extras["pocket"] else
        "The ROUTE line in your prompt names that goal, but the NEXT LEG it gives cannot be "
        "started from where you stand, so getting out of this pocket comes first. "
        + extras["pocket"])
    return extras


def _terminal_directive(template, mode, location_id, location_key, prior, now_ms, state=None):
    """wq#1091: the directive written once the K budget is spent.

    Carries the same standing requirement as the attempts did, but labelled
    EXHAUSTED rather than "attempt 3/3" so the pin the agent reads stops
    claiming an intervention is in flight when none can be. gotoBan is
    deliberately empty: a ban is an active intervention, and the supervisor has
    stopped intervening on this key — only the guidance stands.
    """
    extras = _fmt_extras(location_id, state)
    extras["osc_ban"] = "No map is banned: the supervisor has stopped intervening on this key."
    # .strip(): a template whose last field is conditional (OBJECTIVE_DRIFT's
    # {pocket}) would otherwise end in a space on every turn it has nothing to say.
    pin = template["notepadPin"].format(attempt=prior, k=K, **extras).strip()
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


def _breakout_directive(mode, location_id, location_key, prior, anchor, now_ms):
    """wq#1563 rung L4 — the bounded explore-away directive.

    `staleMapGotoBan` is a NEW field and deliberately not `gotoBan`: gotoBan
    means "refuse enter_warp INTO these maps", and this means "refuse goto
    WITHIN this map, exits excepted". Reusing the old name would have silently
    exiled the agent from the route it needs (see the rejected-options note).
    """
    stall, target = anchor["stallMap"], anchor["targetMap"]
    issued = anchor["lastTurn"]
    where = _located(stall)
    aim = (f"Head for {_located(target)}" if isinstance(target, int)
           else "Head for any map you have not stood on in the last hour")
    return {
        "v": 1,
        "generatedAt": _iso(now_ms),
        "mode": mode,
        "location": location_id,
        "locationKey": location_key,
        "attempt": prior + 1,
        "k": K,
        "rung": "breakout",
        "exhausted": True,     # the K ladder IS spent; this rung is what follows it
        "action": "breakout_leave_map",
        "summary": (f"K spent and {where} has produced no new tile in a full dP window — "
                    f"leave the map for {anchor['budgetTurns']} turns."),
        "notepadPin": (
            f"PIN: SUPERVISOR (BREAKOUT, after {prior}/{K}): you have spent a whole "
            f"progress window inside {where} without stepping on a single new tile, "
            f"and every earlier instruction has been tried. Walking around this map "
            f"again cannot help. LEAVE IT: use leave_edge at a map boundary, or "
            f"enter_warp through a door — goto is REFUSED on this map for the next "
            f"{anchor['budgetTurns']} turns, and those two are your way out. {aim}. "
            f"Once you are on a different map, resume the standing objective there."
        ),
        "gotoBan": [],
        "staleMapGotoBan": stall,
        "breakoutTargetMap": target,
        "budgetTurns": anchor["budgetTurns"],
        "issuedAtTurn": issued,
        "expiresAtTurn": (issued + anchor["budgetTurns"]) if isinstance(issued, int) else None,
    }


def _handoff_directive(mode, location_id, location_key, prior, now_ms, why):
    """wq#1563 rung L5 — the honest end of the ladder.

    Reached when the K budget AND the breakout are both spent, or when no
    breakout anchor exists to act on. Carries no ban of any kind (kill-criterion
    4: a failed breakout must not leave a live restriction behind) and says
    plainly that the machine is out of moves, so the pin the agent reads stops
    claiming a remedy is in flight. wq#1562 is the ticket that turns this into
    an aq row Frank triages; until it lands, this is still the correct on-disk
    state — a stale "attempt 3/3" pin was strictly worse.
    """
    return {
        "v": 1,
        "generatedAt": _iso(now_ms),
        "mode": mode,
        "location": location_id,
        "locationKey": location_key,
        "attempt": prior,
        "k": K,
        "rung": "handoff",
        "exhausted": True,
        "action": "handoff_operator",
        "summary": f"Every automatic rung is spent at {_located(location_id)} — {why}.",
        "notepadPin": (
            f"PIN: SUPERVISOR (HANDOFF): the supervisor has run out of automatic "
            f"remedies at {_located(location_id)} ({why}). No restriction is in force. "
            f"Play the standing objective as best you can; a human has been notified."
        ),
        "gotoBan": [],
        "handoff": {"reason": why, "locationKey": location_key},
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

    mode = state.get("mode")
    location_id = state.get("modeLocation")
    location_key = _key(mode, location_id) if state.get("stalled") else None

    # wq#1846: which episode of this key we are in has to be settled BEFORE
    # anything reads the log, because both readers below are scoped to it — the
    # resolver's "still the live stall" guard and the K count itself.
    ep_start, episode = ((None, None) if location_key is None else
                         episode_start(log, location_key, now_ms, _episode_gap_ms(state)))

    resolve_pending(log, state, episode_start_ms=ep_start)

    if not state.get("stalled"):
        return {"intervened": False, "reason": "not stalled", "mode": None}

    template = PRESCRIPTIONS.get(mode)

    rev = (template or {}).get("rev", 1)
    prior = open_attempt_count(log, location_key, rev, since=ep_start)
    attempt = prior + 1

    if template is None:
        return {"intervened": False, "reason": f"no prescription defined for mode {mode}",
                "mode": mode, "locationKey": location_key, "attempt": attempt, "k": K}

    if attempt > K:
        # wq#1091: exhausted still REFRESHES the directive on disk. It appends
        # nothing to the log — that invariant is what wq#673 keys its one
        # ticket off — but leaving the file frozen at the attempt-3 text meant
        # the live agent read a stale "SUPERVISOR (3/3)" pin indefinitely (33h
        # on FIGHT_LOSS_LOOP@3) with no way for a corrected prescription to
        # reach it. The requirement outlives the attempt budget.
        #
        # wq#1563 adds the two rungs BELOW that refresh, because "refresh the
        # same words forever" is not a recovery: FIGHT_LOSS_LOOP@3 sat here for
        # 167.9h re-rendering advice the agent had already failed to act on.
        # L4 BREAKOUT fires at most once, only on a real anchor, only for a
        # bounded number of turns. L5 HANDOFF is the honest end.
        prior_breakout = breakout_entry(log, location_key, since=ep_start)
        if prior_breakout is None:
            anchor = breakout_anchor(state)
            if anchor is not None:
                directive = _breakout_directive(mode, location_id, location_key,
                                                prior, anchor, now_ms)
                log["attempts"].append({
                    "ts": now_ms, "mode": mode, "locationKey": location_key,
                    "attempt": prior + 1, "rung": "breakout", "rev": rev,
                    "episode": episode, "directive": directive,
                    "beforeState": _snapshot(state), "afterState": None, "outcome": None,
                })
                return {"intervened": True, "exhausted": True, "rung": "breakout",
                        "mode": mode, "locationKey": location_key, "attempts": prior,
                        "k": K, "episode": episode, "directive": directive,
                        "reason": f"K spent at {location_key}; escalating to a bounded "
                                  f"{anchor['budgetTurns']}-turn breakout off "
                                  f"map{anchor['stallMap']}"}
            # Kill-criterion 1: no anchor means no honest target, so the rung
            # does not fire at all. Keep refreshing the standing requirement
            # rather than inventing a map to run to.
            return {"intervened": False, "exhausted": True, "rung": None, "mode": mode,
                    "locationKey": location_key, "attempts": prior, "k": K,
                    "episode": episode,
                    "directive": _terminal_directive(template, mode, location_id,
                                                     location_key, prior, now_ms, state),
                    "reason": f"{prior} attempts already logged for {location_key} in the "
                              f"stall episode running since {_iso(ep_start)} — "
                              f"no breakout anchor (progress is not map-local), "
                              f"handing off to the wq#673 feedback loop"}

        if not breakout_expired(prior_breakout):
            # In flight. Re-emit the SAME directive so a mid-flight supervisor
            # tick cannot shorten its own budget or restate it differently.
            return {"intervened": False, "exhausted": True, "rung": "breakout",
                    "mode": mode, "locationKey": location_key, "attempts": prior, "k": K,
                    "episode": episode,
                    "directive": prior_breakout["directive"],
                    "reason": f"breakout in flight at {location_key} until turn "
                              f"{prior_breakout['directive'].get('expiresAtTurn')}"}

        # Budget spent and the classifier still calls this key stalled, so the
        # breakout did not work. Kill-criterion 2 forbids a second one.
        return {"intervened": False, "exhausted": True, "rung": "handoff", "mode": mode,
                "locationKey": location_key, "attempts": prior, "k": K,
                "episode": episode,
                "directive": _handoff_directive(mode, location_id, location_key,
                                                prior, now_ms,
                                                "the bounded breakout also failed"),
                "reason": f"breakout spent at {location_key} without advancing — "
                          f"handing off to an operator"}

    # wq#724: resolve gotoBan — the old symbolic "last_loop_target" was never
    # consumed because it never named actual map IDs. Now we read the warp
    # history and extract the maps the agent is genuinely looping between.
    goto_ban = template["gotoBan"]
    # wq#1867: every field a template may name, resolved once (see _fmt_extras).
    # Templates that reference none of them simply ignore them.
    fmt_extras = _fmt_extras(location_id, state)
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
        "notepadPin": template["notepadPin"].format(attempt=attempt, k=K, **fmt_extras).strip(),
        "gotoBan": goto_ban,
    }

    entry = {
        "ts": now_ms, "mode": mode, "locationKey": location_key, "attempt": attempt,
        "rev": rev,  # wq#1826: which revision of the mode's prescription this tried
        # wq#1846: which stall episode of this key it belonged to. Forensic
        # only — the budget is scoped by the episode's START TIMESTAMP, since
        # entries written before this shipped carry no episode number at all.
        "episode": episode,
        "directive": directive, "beforeState": _snapshot(state), "afterState": None,
        "outcome": None,
    }
    log["attempts"].append(entry)

    return {"intervened": True, "mode": mode, "locationKey": location_key,
            "attempt": attempt, "k": K, "episode": episode,
            "directive": directive, "exhausted": False}


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
            persist_directive(result["directive"])

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
