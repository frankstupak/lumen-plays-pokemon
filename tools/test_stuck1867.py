#!/usr/bin/env python3
"""test_stuck1867 — a gym you already beat is not a gym you are losing to.

Run:  python3 tools/test_stuck1867.py
No service, no network, no live state: every call passes its warps, its ledger,
its badge count and its now_ms explicitly.

THE STALL. 2026-09-12T13:29:40Z the run won the Cascade Badge (badges 1->2,
runtime/stuck_mode.json's own lastAdvanceWhy). The freeze clock started on that
instant, and for the next three hours lpp_stuck_mode classified the aftermath as
FIGHT_LOSS_LOOP@65 — "stuck losing the gym fight at Cerulean Gym" — because two
warps to map65 still sat in the 64-warp window. They were the winning visit's own
way in and way out. All three K attempts prescribed the Misty grind pin, the live
brain read it every turn (28 renders in events/live-agent-1789229078967.jsonl,
one of them reasoning "SUPERVISOR (2/3) says stuck at Cerulean gym needing
conditions"), and it spent 26 turns walking north to the grind routes the pin
names while frontier.json's next milestone, Route 5, lay south.

The fix is not a better pin for that mode. It is that the mode cannot be true:
src/ledger.ts's fight ledger holds a WIN on map65 at a lower badge count than the
player now holds. Sections A-D pin the classifier, E-F the anchor, G-I the
prescription that replaces it, and J (wq#1872) the case none of them reach: a
window spanning TWO towns, where the gym already beaten and the gym the run is
stalled at are different gyms. K (wq#1874) holds that window to the harder
ratio — the town just left still owning most of the warps, which is what the
ordinary "arrived and was gated on the spot" stall looks like.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_mode as M
import lpp_stuck_intervene as I

SRC = os.path.join(os.path.dirname(HERE), "src")
NAMES = M.load_map_names()
PASS = FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}  {detail}")


# Live evidence, verbatim from runtime/warp_history.json at 2026-09-12T16:36Z.
# map3 Cerulean City, 64 Pokecenter, 67 Mart, 65 Gym, 35/36 Routes 24/25,
# 88 Bills House, 230 Cerulean Badge House.
LIVE_WARPS = [64, 3, 64, 3, 64, 3, 67, 3, 64, 3, 67, 3, 67, 3, 64, 3, 65, 67, 3, 64,
              3, 65, 3, 64, 3, 67, 3, 36, 3, 230, 3, 88, 36, 36, 3, 64, 3, 3, 64, 3,
              3, 67, 3, 67, 3, 64, 3, 64, 3, 3, 3, 67, 3, 64, 3, 67, 3, 67, 3, 67, 3,
              67, 3, 3]
# Live evidence, verbatim: the only record in runtime/fight_ledger.json.
WIN65 = {"ts": 1789219927404, "turn": 31, "outcome": "win", "opponent": 235,
         "trainerNo": 1, "map": 65, "levelSum": 62, "badges": 1}
BADGES = 2       # live state_read: badges bitmask 3, badgeCount 2
NOW = 1789230652749.0   # 2026-09-12T16:30:52Z, the tick that filed wq#1867

CLEARED = M.cleared_gyms([WIN65], BADGES, NAMES)

# ── A. the live window, with the ledger consulted ────────────────────────────
print("-- A. the live stall reclassifies --")
mode, ev, loc = M.classify_mode(LIVE_WARPS, [], NAMES, cleared=CLEARED,
                                badges=BADGES, next_milestone="Route 5")
ok("A1: not FIGHT_LOSS_LOOP any more", mode == "OBJECTIVE_DRIFT", f"got {mode}")
ok("A2: anchored on the town, not the gym", loc == 3, f"got {loc}")
ok("A3: the evidence names the won badge", "ALREADY WON" in ev, ev)
ok("A4: and names where the run is meant to go", "Route 5" in ev, ev)

# ── B. the same window before the badge landed ───────────────────────────────
print("\n-- B. an unbeaten gym keeps its diagnosis --")
# The win is recorded at badges=1 and the player still holds 1: nothing cleared.
mode, ev, loc = M.classify_mode(LIVE_WARPS, [], NAMES,
                                cleared=M.cleared_gyms([WIN65], 1, NAMES), badges=1)
ok("B1: still FIGHT_LOSS_LOOP", mode == "FIGHT_LOSS_LOOP", f"got {mode}")
ok("B2: still anchored on the gym", loc == 65, f"got {loc}")

# ── C. no ledger at all ──────────────────────────────────────────────────────
print("\n-- C. a missing ledger degrades to the old behaviour --")
for label, records in (("empty", []), ("missing", None), ("junk", [None, 7, {}])):
    mode, _ev, loc = M.classify_mode(LIVE_WARPS, [], NAMES,
                                     cleared=M.cleared_gyms(records, BADGES, NAMES),
                                     badges=BADGES)
    ok(f"C: {label} ledger -> FIGHT_LOSS_LOOP@65",
       (mode, loc) == ("FIGHT_LOSS_LOOP", 65), f"got {mode}@{loc}")

# ── D. what does and does not clear a gym ────────────────────────────────────
print("\n-- D. cleared_gyms is a badge test, not a win test --")
junior = dict(WIN65, badges=BADGES)   # a win on the gym map at the CURRENT count:
                                      # a gym's junior trainer, leader still unbeaten
ok("D1: beating a gym trainer does not clear the gym",
   M.cleared_gyms([junior], BADGES, NAMES) == {}, M.cleared_gyms([junior], BADGES, NAMES))
ok("D2: a loss never clears it",
   M.cleared_gyms([dict(WIN65, outcome="loss")], BADGES, NAMES) == {})
ok("D3: a win somewhere that is not a gym never clears one",
   M.cleared_gyms([dict(WIN65, map=3)], BADGES, NAMES) == {})
ok("D4: a checkpoint restore that rolls the badge back un-clears it",
   M.cleared_gyms([WIN65], 1, NAMES) == {})
ok("D5: the live pair does clear map65",
   CLEARED == {65: "Cerulean Gym"}, CLEARED)

# ── E. the readiness-stall path ──────────────────────────────────────────────
print("\n-- E. the hub-orbit diagnosis defers too --")
# The last 16 warps hold no gym warp at all — the shape _readiness_stall reads as
# "a gate is refusing gym entry". With the badge won there is no such gate.
tight = LIVE_WARPS[-M.WARP_OSC_WINDOW:]
ok("E0: the slice really has no gym warp in it",
   not [m for m in tight if M.is_gym(m, NAMES)], tight)
ok("E1: on its own it still reads as a readiness stall",
   M._readiness_stall(tight, NAMES)[0] == "FIGHT_LOSS_LOOP")
mode, ev, loc = M.classify_mode(tight, [], NAMES, cleared=CLEARED, badges=BADGES,
                                next_milestone="Route 5")
ok("E2: through the classifier it is drift", mode == "OBJECTIVE_DRIFT", f"got {mode}")
ok("E3: matched by town, with no gym warp to go on", loc == 3, f"got {loc}")

# ── F. one incident, one key ─────────────────────────────────────────────────
print("\n-- F. the anchor does not move as the gym warps age out --")
wide = M.classify_mode(LIVE_WARPS, [], NAMES, cleared=CLEARED, badges=BADGES)
narrow = M.classify_mode(tight, [], NAMES, cleared=CLEARED, badges=BADGES)
ok("F1: both paths agree on mode and location", wide[0::2] == narrow[0::2],
   f"{wide[0]}@{wide[2]} vs {narrow[0]}@{narrow[2]}")
ok("F2: so the dedup key is stable", I._key(*wide[0::2]) == "OBJECTIVE_DRIFT@3",
   I._key(*wide[0::2]))

# ── G. the prescription ──────────────────────────────────────────────────────
print("\n-- G. what the agent is told instead --")
STATE = {"ok": True, "stalled": True, "mode": "OBJECTIVE_DRIFT", "modeLocation": 3,
         "storyScore": 11, "badges": BADGES, "eventFlags": 50, "map": 3,
         "windowHours": 2.0, "nextMilestone": "Route 5", "closedOffTurns": 26}
log = {"v": 1, "attempts": []}
res = I.decide(state=STATE, log=log, now_ms=NOW)
pin = res["directive"]["notepadPin"]
ok("G1: an attempt is prescribed", res.get("intervened") and res["attempt"] == 1, res)
ok("G2: the action is to move on, not to prepare",
   res["directive"]["action"] == "advance_to_next_objective", res["directive"]["action"])
ok("G3: the pin says the badge is won", "ALREADY BEATEN" in pin, pin)
ok("G4: it names the frontier's milestone, not one of its own",
   "Route 5" in pin and "Route 24" not in pin, pin)
ok("G5: it names the town it is orbiting", "Cerulean City (map3)" in pin, pin)
ok("G6: no grind remedy survives into it",
   not re.search(r"grind|Oddish|Bellsprout|Geodude|level >=", pin, re.I), pin)
ok("G7: it bans nothing — the hub and its heal point are not bannable",
   res["directive"]["gotoBan"] == [], res["directive"]["gotoBan"])
# src/pin.ts renders a CATCH pin with a can-I-afford-a-ball qualifier
# (PIN_CATCH_RE) and a grass pin with an exclusion qualifier (PIN_GRASS_RE).
# This pin orders neither, so it must trip neither.
ok("G8: does not read as a catch order (src/pin.ts PIN_CATCH_RE)",
   not re.search(r"\bcatch(?:es|ing)?\b", pin, re.I), pin)
ok("G9: does not read as a grass order (src/pin.ts PIN_GRASS_RE)",
   not re.search(r"\btall grass\b", pin, re.I), pin)
pin_ts = open(os.path.join(SRC, "pin.ts")).read()
ok("G10: and those two regexes are still the ones pin.ts matches on",
   r"/\bcatch(?:es|ing)?\b/i" in pin_ts and r"/\btall grass\b/i" in pin_ts)

# ── H. the local blocker, only when the evidence is there ────────────────────
print("\n-- H. the closed-off pocket clause --")
ok("H1: present while the harness keeps refusing that way",
   "walking cannot leave the part of this map" in pin, pin)
# wq#1877: the clause used to answer "try a different door", which on the map it
# was written for is the loop itself — every reachable warp there is a shop that
# returns you to the tile you left. It may point at the refusal; it may not
# prescribe a door of its own.
ok("H1b: and it prescribes no door of its own",
   "enter_warp" not in pin.lower().replace("warps", "")
   and not re.search(r"take one of the warps|a different door from", pin, re.I), pin)
quiet = I.decide(state=dict(STATE, closedOffTurns=0), log={"v": 1, "attempts": []},
                 now_ms=NOW)["directive"]["notepadPin"]
ok("H2: absent when it is not happening", "walking cannot leave" not in quiet, quiet)
ok("H3: and the pin stays a whole sentence either way, with no dangling space",
   quiet.endswith("take that leg.") and "  " not in quiet, repr(quiet[-60:]))
reach_ts = open(os.path.join(SRC, "reach.ts")).read()
# wq#1877: assert against the phrases reach.ts emits TODAY. This check was
# already red on main — wq#1870 rewrote both refusals and the counter kept
# reading for the pre-wq#1870 sentence, so the clause was dark for the whole
# freeze that produced wq#1877.
ok("H4: reach.ts still emits the phrases closed_off_turns counts",
   "this map is SPLIT" in reach_ts and "no opening on the ${dir} edge" in reach_ts)
# Every live shape, verbatim: the turn_summary line is truncated to a fixed
# width (200 chars), so a phrase near the end of the refusal survives on some
# renders and not on others. The counter must see all of them.
ok("H5: and the counter reads every truncation out of turn summaries",
   M.closed_off_turns([
       "T49 [map3 25,26] goto(2,35) => goto -> stuck now {\"map\":3,\"x\":25,\"y\":26} — no "
       "path to (2,35) from where you stand; you are in a closed-off part of this",
       "T52 [map3 25,26] goto(25,30) => goto -> stuck now {\"map\":3,\"x\":25,\"y\":26} — no "
       "path to (25,30) from where you stand: this map is SPLIT and (25,30) is in a part",
       "T5 [map3 19,18] leave_edge(S) => leave_edge -> stuck now {\"map\":3,\"x\":19,\"y\":18}"
       " — no opening on the S edge is reachable from where you stand: this map i",
       "T51 [map3 25,26] leave_edge(S) => leave_edge -> stuck"]) == 3)

# ── I. the exhausted directive ───────────────────────────────────────────────
print("\n-- I. the terminal directive formats for the new mode --")
spent = {"v": 1, "attempts": [
    {"ts": NOW - (3 - n) * 1800e3, "mode": "OBJECTIVE_DRIFT",
     "locationKey": "OBJECTIVE_DRIFT@3", "attempt": n, "rev": 1,
     "directive": {"action": "advance_to_next_objective"},
     "beforeState": {"storyScore": 11, "badges": 2, "eventFlags": 50, "map": 3},
     "afterState": None, "outcome": None} for n in (1, 2, 3)]}
term = I.decide(state=STATE, log=spent, now_ms=NOW)
ok("I1: K is spent, no fourth attempt", term.get("exhausted") is True, term.get("reason"))
tpin = term["directive"]["notepadPin"]
ok("I2: the standing requirement still reaches the agent",
   "Route 5" in tpin and "ALREADY BEATEN" in tpin, tpin)
ok("I3: labelled EXHAUSTED, not attempt 3/3", "EXHAUSTED after 3/3" in tpin, tpin)
ok("I4: every other mode's terminal pin still formats",
   all(I._terminal_directive(t, m, 3, f"{m}@3", 3, NOW, STATE)["notepadPin"]
       for m, t in I.PRESCRIPTIONS.items() if t))

# ── J. two towns in one window ───────────────────────────────────────────────
print("\n-- J. a cleared gym in ANOTHER town does not clear this one --")
# wq#1872. Every window above lives in one town, so the town fallback in
# _drift_diagnosis could match "any town anywhere in the 64-warp window" and
# still ship green. A window that spans the town just cleared and the town the
# run has moved on to is the case that tells them apart: the run holds the
# Cascade Badge (Cerulean, map65) and is now stalled at the UNBEATEN Vermilion
# Gym, with a handful of stale Cerulean warps still in scope. There is a real
# fight-readiness gate refusing entry here — map92's badge is not won.
TWO_TOWN = ([3, 64, 3, 64, 3, 3, 64, 3] +
            [5, 89, 5, 89, 5, 5, 89, 5, 5, 89, 5, 89, 5, 5, 89, 5, 5, 89, 5, 89, 5, 5, 89, 5])
ok("J0: the slice really spans two towns and holds no gym warp",
   {M.town_of(M.map_label(m, NAMES)) for m in TWO_TOWN} == {"cerulean", "vermilion"}
   and not [m for m in TWO_TOWN if M.is_gym(m, NAMES)], TWO_TOWN)
mode, ev, loc = M.classify_mode(TWO_TOWN, [], NAMES, cleared=CLEARED, badges=BADGES,
                                next_milestone="Route 11")
ok("J1: the unbeaten gym's stall keeps its readiness diagnosis",
   mode == "FIGHT_LOSS_LOOP", f"got {mode}: {ev}")
ok("J2: anchored on the town it is actually stalled in", loc == 5, f"got {loc}")
vpin = I.decide(state=dict(STATE, mode=mode, modeLocation=loc, map=5,
                           nextMilestone="Route 11", closedOffTurns=0),
                log={"v": 1, "attempts": []}, now_ms=NOW)["directive"]["notepadPin"]
ok("J3: so no pin tells the run the Thunder Badge is already won",
   "ALREADY BEATEN" not in vpin, vpin)
# The true positive the fallback exists for must survive: same window, and the
# gym the loop orbits is the one whose badge IS won.
vermilion_cleared = M.cleared_gyms([dict(WIN65, map=92)], BADGES, NAMES)
ok("J4: the cleared gym in THIS town still reads as drift",
   M.classify_mode(TWO_TOWN, [], NAMES, cleared=vermilion_cleared,
                   badges=BADGES)[0::2] == ("OBJECTIVE_DRIFT", 5),
   M.classify_mode(TWO_TOWN, [], NAMES, cleared=vermilion_cleared, badges=BADGES))
# And so must the wq#1867 shape when the stale warps point the other way: the
# loop is in Cerulean, the strays are from Vermilion.
STRAY = [5, 89] + LIVE_WARPS[-M.WARP_OSC_WINDOW:]
ok("J5: stale warps from a town the run has left do not block the real drift",
   M.classify_mode(STRAY, [], NAMES, cleared=CLEARED, badges=BADGES)[0::2]
   == ("OBJECTIVE_DRIFT", 3),
   M.classify_mode(STRAY, [], NAMES, cleared=CLEARED, badges=BADGES))
# The invariant behind all five: a drift verdict names one town twice — the hub
# it anchors on and the gym its evidence calls already-won — so they must be the
# same town, or the pin is asserting a badge the run does not hold.
for label, warps, cl in (("live", LIVE_WARPS, CLEARED), ("tight", tight, CLEARED),
                         ("two-town", TWO_TOWN, vermilion_cleared),
                         ("stray", STRAY, CLEARED)):
    m, e, l = M.classify_mode(warps, [], NAMES, cleared=cl, badges=BADGES)
    if m != "OBJECTIVE_DRIFT":
        continue
    hub_town = M.town_of(M.map_label(l, NAMES))
    ok(f"J6 ({label}): anchor town and won-badge town agree",
       any(M.town_of(lbl) == hub_town and lbl in e for lbl in cl.values()), f"{e} @{l}")

# ── K. which of the two towns, when the counts point the other way ───────────
print("\n-- K. the town the run is in NOW, not the town it warped most --")
# wq#1874. Section J spans two towns only in the direction the majority vote
# happens to get right: 24 Vermilion warps against 8 Cerulean. The ordinary
# shape of a stall is the opposite one — the run ARRIVES somewhere and is gated
# on the spot, so the town it just left still owns most of the window. Same
# ledger as A (Cascade Badge won, Cerulean map65 cleared), same real readiness
# gate at the unbeaten Vermilion Gym; only the ratio is flipped.
ARRIVED = [3, 64, 3, 64, 3, 64, 3, 64, 3] + [5, 89, 5, 89, 5]
ok("K0: the cleared town really does outnumber the stalled one",
   ARRIVED.count(3) > ARRIVED.count(5) and not [m for m in ARRIVED if M.is_gym(m, NAMES)],
   ARRIVED)
mode, ev, loc = M.classify_mode(ARRIVED, [], NAMES, cleared=CLEARED, badges=BADGES,
                                next_milestone="Route 11")
ok("K1: a minority of fresh warps still locates the stall",
   (mode, loc) == ("FIGHT_LOSS_LOOP", 5), f"got {mode}@{loc}: {ev}")
ok("K2: no badge the run already holds is offered as its resolution",
   "ALREADY WON" not in ev, ev)
kpin = I.decide(state=dict(STATE, mode=mode, modeLocation=loc, map=5,
                           nextMilestone="Route 11", closedOffTurns=0),
                log={"v": 1, "attempts": []}, now_ms=NOW)["directive"]["notepadPin"]
ok("K3: so the pin does not tell the run the Thunder Badge is won",
   "ALREADY BEATEN" not in kpin, kpin)
# An exact tie is the same question with the arithmetic taken away: the window
# is oldest-first, so most_common resolved a tie to the town left EARLIER.
TIED = [3, 64, 3, 64, 3, 64, 3, 64, 3] + [5, 89, 5, 89, 5, 89, 5, 89, 5]
ok("K4: a tied window resolves to the later town, not the earlier one",
   TIED.count(3) == TIED.count(5)
   and M.classify_mode(TIED, [], NAMES, cleared=CLEARED, badges=BADGES)[0::2]
   == ("FIGHT_LOSS_LOOP", 5),
   M.classify_mode(TIED, [], NAMES, cleared=CLEARED, badges=BADGES))
# The fix is recency, not a blanket distrust of the newer town: with the badge
# for THIS town in the bag, the same minority window is a real drift.
ok("K5: the arrived-at town's own cleared gym still reads as drift",
   M.classify_mode(ARRIVED, [], NAMES, cleared=vermilion_cleared, badges=BADGES)[0::2]
   == ("OBJECTIVE_DRIFT", 5),
   M.classify_mode(ARRIVED, [], NAMES, cleared=vermilion_cleared, badges=BADGES))
# And the drift the count vote MISSED: the run came back to the town it has
# already cleared, so the town it spent longest in is not the town it is in.
RETURNED = [5, 89, 5, 89, 5, 89, 5, 89, 5] + [3, 64, 3, 64, 3]
ok("K6: a return to the cleared town is drift, however stale the counts",
   RETURNED.count(5) > RETURNED.count(3)
   and M.classify_mode(RETURNED, [], NAMES, cleared=CLEARED, badges=BADGES)[0::2]
   == ("OBJECTIVE_DRIFT", 3),
   M.classify_mode(RETURNED, [], NAMES, cleared=CLEARED, badges=BADGES))
# J6's invariant, over the windows the count vote broke it on.
for label, warps, cl in (("arrived", ARRIVED, vermilion_cleared),
                         ("returned", RETURNED, CLEARED)):
    m, e, l = M.classify_mode(warps, [], NAMES, cleared=cl, badges=BADGES)
    ok(f"K7 ({label}): anchor town and won-badge town agree",
       m == "OBJECTIVE_DRIFT"
       and any(M.town_of(lbl) == M.town_of(M.map_label(l, NAMES)) and lbl in e
               for lbl in cl.values()), f"{m}: {e} @{l}")

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
