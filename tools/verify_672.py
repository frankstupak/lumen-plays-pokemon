#!/usr/bin/env python3
"""verify_672 — offline proof for the wq#672 bounded intervention layer
(tools/lpp_stuck_intervene.py).

Run:  python3 tools/verify_672.py
No service, no network, no writes outside a temp dir. Every call passes an
explicit `log` dict and never touches the live runtime/intervention_log.json
or runtime/supervisor_directive.json, mirroring how verify_489.py exercises
lpp-sentinel's emit() directly against a throwaway state dict rather than the
real runtime/sentinel_state.json.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_intervene as I
import lpp_stuck_mode as M

PASS = FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}{('  ' + detail) if detail else ''}")


def stalled_state(mode, location, story=10, badges=1, events=37, ts=1_786_000_000_000):
    return {"ok": True, "stalled": True, "mode": mode, "modeLocation": location,
            "storyScore": story, "badges": badges, "eventFlags": events, "map": location,
            "generatedAt": "2026-08-17T20:00:00Z"}


def healthy_state(story=11, badges=1, events=38, location=3):
    return {"ok": True, "stalled": False, "mode": None, "modeLocation": None,
            "storyScore": story, "badges": badges, "eventFlags": events, "map": location}


# ── 1. no intervention when not stalled ────────────────────────────────────
print("\n-- basic gating --")
log = {"v": 1, "attempts": []}
r = I.decide(state=healthy_state(), log=log)
ok("healthy state does not intervene", r["intervened"] is False and not log["attempts"], json.dumps(r))

log = {"v": 1, "attempts": []}
r = I.decide(state=stalled_state("IDLE", None), log=log)
ok("IDLE has no prescription, does not intervene", r["intervened"] is False, json.dumps(r))
ok("IDLE does not raise for locationKey formatting with location=None", "reason" in r, r)

# ── 2. FIGHT_LOSS_LOOP fires and logs before/after ─────────────────────────
print("\n-- FIGHT_LOSS_LOOP: fires, logs, before/after --")
log = {"v": 1, "attempts": []}
state = stalled_state("FIGHT_LOSS_LOOP", 65)
r = I.decide(state=state, log=log)
ok("first attempt intervenes", r["intervened"] is True, json.dumps(r))
ok("attempt number is 1", r["attempt"] == 1, r["attempt"])
ok("directive names the gym as location", r["directive"]["location"] == 65, r["directive"])
ok("directive action is grind_sub_objective", r["directive"]["action"] == "grind_sub_objective", r["directive"])
ok("notepadPin mentions the location", "65" in r["directive"]["notepadPin"], r["directive"]["notepadPin"])
ok("log gained exactly one entry", len(log["attempts"]) == 1, len(log["attempts"]))
ok("beforeState captured on the entry", log["attempts"][0]["beforeState"]["storyScore"] == 10, log["attempts"][0])
ok("afterState starts unresolved", log["attempts"][0]["afterState"] is None, log["attempts"][0])

# ── 3. K=3 bound: 3 attempts succeed, 4th is exhausted, not a 4th log entry ─
print("\n-- K=3 bound --")
log = {"v": 1, "attempts": []}
attempts = []
for i in range(4):
    r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log)
    attempts.append(r)
ok("attempts 1-3 all intervene", all(a["intervened"] for a in attempts[:3]),
   [a["intervened"] for a in attempts[:3]])
ok("attempt numbers are 1,2,3", [a["attempt"] for a in attempts[:3]] == [1, 2, 3],
   [a.get("attempt") for a in attempts[:3]])
ok("4th call is exhausted, not a 4th intervention", attempts[3]["intervened"] is False and attempts[3].get("exhausted"),
   json.dumps(attempts[3]))
ok("exhausted call does NOT append a 4th log entry", len(log["attempts"]) == 3, len(log["attempts"]))

# ── 4. resolution: a story_score advance closes the pending entry and resets K
print("\n-- resolution on advance --")
log = {"v": 1, "attempts": []}
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=10), log=log)
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=10), log=log)
ok("2 attempts open before the win", len(log["attempts"]) == 2, len(log["attempts"]))
# story_score rises -> the mode clears (healthy_state) on the NEXT read
r = I.decide(state=healthy_state(story=12), log=log)
ok("advance closes without a new attempt", r["intervened"] is False, r)
resolved = [e for e in log["attempts"] if e.get("outcome") == "advanced"]
ok("both prior attempts resolved as 'advanced'", len(resolved) == 2, log["attempts"])
# a FRESH stall at the same location afterwards starts back at attempt 1
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=12), log=log)
ok("K resets after a real advance", r["attempt"] == 1, r)

# ── 5. a DIFFERENT location gets an independent K counter ──────────────────
print("\n-- independent counters per (mode, location) --")
log = {"v": 1, "attempts": []}
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log)  # Cerulean Gym, attempt 1
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=log)  # attempt 2
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 92), log=log)  # a DIFFERENT gym (Vermilion)
ok("a different gym starts its own counter at 1", r["attempt"] == 1, r)
ok("the first gym's open attempts are untouched", I.open_attempt_count(log, "FIGHT_LOSS_LOOP@65") == 2,
   I.open_attempt_count(log, "FIGHT_LOSS_LOOP@65"))

# ── 6. superseded (mode/location changed without advancing) doesn't reset K,
#      and doesn't get counted as a win either ─────────────────────────────
print("\n-- superseded attempts --")
log = {"v": 1, "attempts": []}
I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65, story=10), log=log)
# same location, still stalled, story_score unchanged, but the agent has
# since drifted into a NAV_LOOP shape instead -- not an advance.
r = I.decide(state=stalled_state("NAV_LOOP", 3, story=10), log=log)
superseded = [e for e in log["attempts"] if e.get("outcome") == "superseded"]
ok("mode change without advance marks the prior entry superseded", len(superseded) == 1, log["attempts"])
ok("superseded (not advanced) still counts toward the OLD key's K",
   I.open_attempt_count(log, "FIGHT_LOSS_LOOP@65") == 1, log["attempts"])

# ── 7. every mode except IDLE has a prescription; the directive always
#      round-trips through json (no non-serialisable objects) ─────────────
print("\n-- all modes --")
for mode in M.MODES:
    log = {"v": 1, "attempts": []}
    r = I.decide(state=stalled_state(mode, 3), log=log)
    if mode == "IDLE":
        ok(f"{mode} has no prescription", not r["intervened"], r)
    else:
        ok(f"{mode} produces a directive", r["intervened"] is True, r)
        json.dumps(r["directive"])  # raises if not serialisable
        ok(f"{mode} directive round-trips through json", True)


# ── 8. wq#1091: the FIGHT_LOSS_LOOP pin must agree with the harness gate ───
#      The original pin said "grind to roughly L18-21" — Misty's OWN team
#      levels — while src/guidance.ts refuses gym entry below L30 + potions +
#      roster + a Grass/Rock counter. An agent obeying that pin exactly could
#      never clear the gate, which is how three K attempts on
#      FIGHT_LOSS_LOOP@3 burned 33h without moving story_score.
print("\n-- wq#1091: pin agrees with guidance.ts's entry gate --")
gate = I._misty_gate()
ok("gate parsed from src/guidance.ts, not the fallback",
   os.path.exists(I.GUIDANCE_TS), I.GUIDANCE_TS)
ok("parsed min level matches guidance.ts MISTY_MIN_LEVEL",
   gate["min_level"] == 30, gate)
ok("parsed potions/roster match guidance.ts",
   gate["min_potions"] == 3 and gate["min_roster"] == 2, gate)
ok("a missing guidance.ts degrades to the fallback instead of raising",
   I._misty_gate(path="/nonexistent/guidance.ts") == I.GATE_FALLBACK,
   I._misty_gate(path="/nonexistent/guidance.ts"))

log = {"v": 1, "attempts": []}
pin = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log)["directive"]["notepadPin"]
ok("pin names the gate's level, not the opposing team's levels",
   f">= {gate['min_level']}" in pin, pin)
ok("pin no longer prescribes the L18-21 target the gate rejects",
   "18-21" not in pin and "L18" not in pin, pin)
ok("pin states the potion and roster conditions the gate also enforces",
   f">= {gate['min_potions']} potions" in pin and f">= {gate['min_roster']} party" in pin, pin)
ok("pin states the type counter as required, not preferred",
   "Grass or Rock" in pin and "Prefer" not in pin, pin)
ok("pin names the location instead of a bare id next to the level numbers",
   "Cerulean City (map3)" in pin, pin)
ok("pin keeps the live hot-patch's grind mechanics (grass via goto, no warp-in)",
   "tall grass" in pin and "goto()" in pin and "enter_warp" in pin, pin)
ok("pin keeps the live hot-patch's no-heal-at-full-HP instruction",
   "full HP" in pin, pin)
ok("an unknown map id still renders, and still carries the raw id",
   I._located(60001) == "map60001", I._located(60001))

# ── 9. wq#1091: exhausted refreshes the directive but still logs nothing ───
#      Without this the pin on disk stays frozen at the attempt-3 text
#      forever: the key can never intervene again, so no corrected
#      prescription could ever reach the live agent.
print("\n-- wq#1091: exhausted still refreshes the directive --")
log = {"v": 1, "attempts": []}
for _ in range(3):
    I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log)
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 3), log=log)
ok("4th call is still exhausted and still not an intervention",
   r.get("exhausted") is True and r["intervened"] is False, r)
ok("exhausted STILL appends no log entry (wq#673's ticket signal is intact)",
   len(log["attempts"]) == 3, len(log["attempts"]))
ok("exhausted now carries a directive to persist", bool(r.get("directive")), r)
ok("exhausted directive is marked exhausted, not a 4th attempt",
   r["directive"]["exhausted"] is True and r["directive"]["attempt"] == 3, r["directive"])
ok("exhausted pin says EXHAUSTED instead of claiming an attempt is in flight",
   "EXHAUSTED after 3/3" in r["directive"]["notepadPin"], r["directive"]["notepadPin"])
ok("exhausted pin still carries the standing gate requirement",
   f">= {gate['min_level']}" in r["directive"]["notepadPin"], r["directive"]["notepadPin"])
ok("exhausted directive drops any ban — the supervisor stopped intervening",
   r["directive"]["gotoBan"] == [], r["directive"])
json.dumps(r["directive"])  # raises if not serialisable
ok("exhausted directive round-trips through json", True)

# every mode's template must survive the terminal-directive format() call,
# including the NAV_LOOP/WARP_OSC pins that reference {loop_maps}/{loop_labels}
for mode in M.MODES:
    if mode == "IDLE":
        continue
    log = {"v": 1, "attempts": []}
    for _ in range(4):
        r = I.decide(state=stalled_state(mode, 3), log=log)
    ok(f"{mode} exhausted directive formats without KeyError",
       bool(r.get("directive", {}).get("notepadPin")), r)

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
