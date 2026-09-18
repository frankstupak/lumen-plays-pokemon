#!/usr/bin/env python3
"""test_stuck1845 — the exhausted directive must reach the file the agent reads.

Run:  python3 tools/test_stuck1845.py
No service, no network, no wq. LPP_BASE is pointed at a temp tree before the
supervisor's modules are imported, and the feedback layer (the only component
that shells out to `wq`/`ntfy-send`) is stubbed for every section, so nothing
here touches real runtime state or files a ticket.

The stall: FIGHT_LOSS_LOOP@65 frozen 246.3h (2026-09-02 -> 2026-09-12), filed as
"unresolved after K interventions". Two defects, one chain:

  1. The key's K=3 was spent on 2026-08-18 — before a checkpoint restore rolled
     the save back (eventFlags 43 -> 39) and before this freeze even began. The
     2026-09 freeze therefore got ZERO interventions: decide() answered
     `exhausted` on its first tick and every tick after.
  2. Exhausted is not supposed to mean silent. wq#1091 made decide() keep
     producing a terminal directive past K precisely so the standing requirement
     still reaches the agent — and taught `lpp_stuck_intervene.main()` to persist
     it. The systemd timer does not run main(); it runs tools/lpp-stuck-supervisor,
     whose own inlined copy of that write still fired only on `intervened`. So
     the terminal pin was computed every 30 minutes for 246h and thrown away,
     leaving runtime/supervisor_directive.json at WARP_OSC@36 (written
     2026-09-12T10:55Z): the agent losing to Misty in Cerulean Gym read a pin
     about warp-oscillating between Route 25 and Bill's House, every turn.

And the ticket that reported it printed the three 2026-08-18 attempts as this
freeze's "interventions+outcomes", which is why three redispatches went looking
for a harder grind instead of at the plumbing.
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
tmpdir = tempfile.mkdtemp(prefix="stuck1845-")
os.makedirs(os.path.join(tmpdir, "runtime"))
os.environ["LPP_BASE"] = tmpdir          # before the imports read it

sys.path.insert(0, HERE)
import lpp_stuck_intervene as I          # noqa: E402
import lpp_stuck_feedback as F           # noqa: E402
import lpp_stuck_mode as M               # noqa: E402

_SUP = os.path.join(HERE, "lpp-stuck-supervisor")   # no .py extension: name the loader
_spec = importlib.util.spec_from_file_location(
    "lpp_stuck_supervisor", _SUP,
    loader=importlib.machinery.SourceFileLoader("lpp_stuck_supervisor", _SUP))
sup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sup)

assert I.BASE == tmpdir and F.BASE == tmpdir, "sandbox: modules must read the temp base"

# runtime/supervisor_directive.json verbatim at the moment wq#1845 was filed:
# a DIFFERENT incident's pin, 2.5h stale, describing maps the agent is not on.
STALE_WARP_PIN = {
    "v": 1, "generatedAt": "2026-09-12T10:55:35Z", "mode": "WARP_OSC",
    "location": 36, "locationKey": "WARP_OSC@36", "attempt": 2, "k": 3,
    "action": "checkpoint_restore_then_goto_ban",
    "summary": "Two-map warp oscillation detected — ban the far side of the bounce edge.",
    "notepadPin": "PIN: SUPERVISOR (2/3): warp oscillation at Route 25 (map36).",
    "gotoBan": [88],
}


def stalled_state(mode, location, last_advance="2026-09-02T07:12:03Z"):
    return {"ok": True, "stalled": True, "mode": mode, "modeLocation": location,
            "storyScore": 10, "badges": 1, "eventFlags": 48, "map": location,
            "frozenHours": 246.3, "lastAdvanceAt": last_advance,
            "generatedAt": "2026-09-12T13:28:56Z"}


def spent_log(key="FIGHT_LOSS_LOOP@65", mode="FIGHT_LOSS_LOOP", ts=1787060000000.0):
    """The three 2026-08-18 attempts, closed `superseded` by the rollback."""
    return {"v": 1, "attempts": [
        {"ts": ts + n, "mode": mode, "locationKey": key, "attempt": n, "rev": 1,
         "directive": {"action": "grind_sub_objective"},
         "beforeState": {"storyScore": 10, "badges": 1, "eventFlags": 43, "map": 35},
         "afterState": {"storyScore": 10, "badges": 1, "eventFlags": 39, "map": 3},
         "outcome": "superseded"} for n in (1, 2, 3)]}


def spent_this_freeze():
    """The same three attempts, spent inside the freeze that is running NOW.

    wq#1846 scopes K to one stall episode, so "this key's budget is spent" is a
    claim about the current stall, not about the key's whole history: the
    2026-08-18 stamps that used to produce an exhausted key now (correctly)
    refund it. Stamped relative to now rather than to a fixed date, so the
    sections below keep testing the exhausted path tomorrow as well as today.
    The 2026-08-18 log stays where the report sections need it — G and I test
    that boundary itself.
    """
    return spent_log(ts=I._now_ms() - 3 * 3.6e6)


def seed(directive=STALE_WARP_PIN, log=None):
    with open(I.DIRECTIVE_PATH, "w") as f:
        json.dump(directive, f)
    I.save_log(log if log is not None else spent_this_freeze())


def directive_on_disk():
    return json.load(open(I.DIRECTIVE_PATH))


def run_supervisor(state, argv=("--json",)):
    """One timer tick, with the wq/ntfy half of the pipeline stubbed out."""
    M.compute, M.persist = (lambda *a, **k: state), (lambda *a, **k: None)
    F.load_state, F.save_state = (lambda *a, **k: {}), (lambda *a, **k: None)
    F.run = lambda *a, **k: ({"filed": None, "ntfy": None, "resolved": None}, {})
    with contextlib.redirect_stdout(io.StringIO()):      # the tick's own report
        return sup.main(list(argv))


# ---------------------------------------------------------------- A
# decide() itself was never the broken half — wq#1091's terminal directive is
# produced exactly as designed. The loss happened downstream of this return.
r = I.decide(state=stalled_state("FIGHT_LOSS_LOOP", 65), log=spent_this_freeze())
assert r.get("exhausted") is True, "A1: K spent during this freeze bars the key"
assert r.get("intervened") is not True, "A2: and it does not intervene"
assert r.get("directive"), "A3: but it still carries a directive to write"
assert "EXHAUSTED" in r["directive"]["notepadPin"], "A4: labelled EXHAUSTED, not 'attempt 3/3'"
assert r["directive"]["gotoBan"] == [], "A5: guidance only — no active ban past K"
print("A: decide() past K yields a terminal directive (unchanged, wq#1091)")

# ---------------------------------------------------------------- B
# The regression: one supervisor tick on an exhausted key must land that
# directive on disk. Before the fix the tick wrote nothing and the stale pin
# from another incident survived — 246h of it.
seed()
run_supervisor(stalled_state("FIGHT_LOSS_LOOP", 65))
d = directive_on_disk()
assert d["locationKey"] == "FIGHT_LOSS_LOOP@65", \
    f"B1: the tick must replace the stale pin, got {d['locationKey']}"
assert d.get("exhausted") is True, "B2: and mark it exhausted"
assert "EXHAUSTED" in d["notepadPin"], "B3: so the agent stops waiting on an attempt"
assert "Route 25" not in d["notepadPin"], "B4: the other incident's text is gone"
print("B: the supervisor persists the exhausted directive (the wq#1845 fix)")

# ---------------------------------------------------------------- C
# Exhaustion appends nothing to the log — wq#673 keys its one ticket off that
# invariant, and the fix must not disturb it.
seed()
run_supervisor(stalled_state("FIGHT_LOSS_LOOP", 65))
assert len(I.load_log()["attempts"]) == 3, "C1: no 4th attempt is logged past K"
print("C: exhausted still appends nothing to the intervention log")

# ---------------------------------------------------------------- D
# The intervening path keeps working: a key with budget left writes attempt 1.
seed(log={"v": 1, "attempts": []})
run_supervisor(stalled_state("FIGHT_LOSS_LOOP", 65))
d = directive_on_disk()
assert d["attempt"] == 1 and not d.get("exhausted"), f"D1: fresh key intervenes, got {d}"
assert len(I.load_log()["attempts"]) == 1, "D2: and the attempt is logged"
print("D: an unspent key still intervenes and logs (no regression)")

# ---------------------------------------------------------------- E
# --dry-run is the operator's read-only probe; it must stay read-only on the
# exhausted path too, which now has something it could have written.
seed()
run_supervisor(stalled_state("FIGHT_LOSS_LOOP", 65), argv=("--json", "--dry-run"))
assert directive_on_disk()["locationKey"] == "WARP_OSC@36", "E1: --dry-run writes no directive"
assert len(I.load_log()["attempts"]) == 3, "E2: and no log entry"
print("E: --dry-run stays read-only")

# ---------------------------------------------------------------- F
# A state with no live stall must not rewrite the pin either.
seed()
run_supervisor({"ok": True, "stalled": False, "mode": None, "modeLocation": None})
assert directive_on_disk()["locationKey"] == "WARP_OSC@36", "F1: not stalled, nothing written"
print("F: an unstalled tick leaves the directive alone")

# ---------------------------------------------------------------- G
# The report half. Attempts that predate the freeze the report dates itself to
# must not be presented as remedies this stall resisted.
state = stalled_state("FIGHT_LOSS_LOOP", 65)
rep = F.build_report("FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", "Cerulean Gym (map65)",
                     state, spent_log(), 1789219736507)
assert "since 2026-09-02T07:12:03Z" in rep, "G1: the report still dates the freeze"
assert "attempt 1: grind_sub_objective (superseded)" not in rep, \
    "G2: 2026-08-18 attempts are not this freeze's interventions"
assert "(none tried against this freeze)" in rep, "G3: say so plainly"
assert "+3 earlier attempt(s)" in rep, "G4: the spent budget is still disclosed"
# wq#1846: the bracket used to add "and still hold its K budget". Once K is
# scoped to a stall episode, attempts this old do NOT bar the key, and a ticket
# body that says they do sends the next reader after the wrong thing again.
assert "K budget" not in rep, "G5: and makes no claim about K it cannot see"
print("G: the report no longer credits a prior freeze's attempts to this one")

# ---------------------------------------------------------------- H
# Attempts made DURING the freeze are reported exactly as before — the filter
# is a boundary, not a mute button.
during = spent_log(ts=1789200000000.0)   # 2026-09-12, inside the freeze
rep = F.build_report("FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", "Cerulean Gym (map65)",
                     state, during, 1789219736507)
assert "attempt 1: grind_sub_objective (superseded)" in rep, "H1: in-freeze attempts still listed"
assert "earlier attempt(s)" not in rep, "H2: and nothing is flagged stale"
mixed = {"v": 1, "attempts": spent_log()["attempts"] + during["attempts"]}
rep = F.build_report("FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", "Cerulean Gym (map65)",
                     state, mixed, 1789219736507)
assert "attempt 1: grind_sub_objective (superseded)" in rep and "+3 earlier attempt(s)" in rep, \
    "H3: a mixed log reports both halves, each as what it is"
print("H: attempts inside the freeze are reported unchanged")

# ---------------------------------------------------------------- I
# wq#1162's append guard: only the wall-clock duration is masked, so the
# corrected wording still earns exactly one append and then goes quiet.
a = F.build_report("FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", "Cerulean Gym (map65)",
                   dict(state, frozenHours=246.3), spent_log(), 1)
b = F.build_report("FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", "Cerulean Gym (map65)",
                   dict(state, frozenHours=249.9), spent_log(), 1)
assert F.report_signature(a) == F.report_signature(b), "I1: a ticking clock alone adds nothing"
assert F.report_signature(a) != F.report_signature(
    F.build_report("FIGHT_LOSS_LOOP", "FIGHT_LOSS_LOOP@65", "Cerulean Gym (map65)",
                   state, during, 1)), "I2: a real change in the attempt list still appends"
print("I: report_signature still masks the clock and only the clock")

print("\ntest_stuck1845: 9 sections A-I OK")
