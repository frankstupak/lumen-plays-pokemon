#!/usr/bin/env python3
"""verify_1136 — offline proof that tools/lpp-stuck-supervisor, the wrapper the
30min timer actually runs, persists an EXHAUSTED directive.

Run:  python3 tools/verify_1136.py
No service, no network, writes only into a temp dir.

verify_672.py covers lpp_stuck_intervene's decide()/main() and never imports the
production wrapper, which is how wq#1091/PR#78 shipped green while the timer
path kept the old `if decision.get("intervened")` gate and silently dropped
every exhausted refresh (wq#1136). This probe drives the wrapper's own main()
with a stubbed decide() so the assertion is about the wrapper's write block and
nothing else.
"""
import importlib.machinery, importlib.util, io, json, os, sys, tempfile, contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_intervene as I
import lpp_stuck_mode as M
import lpp_stuck_feedback as F

_WRAPPER = os.path.join(HERE, "lpp-stuck-supervisor")  # no .py suffix: needs an explicit loader
_spec = importlib.util.spec_from_file_location(
    "lpp_stuck_supervisor", _WRAPPER,
    loader=importlib.machinery.SourceFileLoader("lpp_stuck_supervisor", _WRAPPER))
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)

PASS = FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}{('  ' + detail) if detail else ''}")


STATE = {"ok": True, "stalled": True, "mode": "WARP_OSC", "modeLocation": 36,
         "frozenHours": 25.4, "storyScore": 10}


def run_wrapper(decision, state=STATE, directive_path=None):
    """Run the wrapper's main() for real, with only the three component modules
    stubbed out, and return whatever landed at DIRECTIVE_PATH (or None)."""
    saved = (M.compute, M.persist, I.decide, I.load_log, I.save_log,
             I.DIRECTIVE_PATH, F.load_state, F.run, F.save_state)
    try:
        M.compute = lambda: state
        M.persist = lambda st: None
        I.decide = lambda state=None, log=None: decision
        I.load_log = lambda: {"v": 1, "attempts": []}
        I.save_log = lambda log: None
        I.DIRECTIVE_PATH = directive_path
        F.load_state = lambda: {}
        F.run = lambda state=None, intervention_log=None, escal=None: ({}, {})
        F.save_state = lambda st: None
        with contextlib.redirect_stdout(io.StringIO()):
            S.main(["--json"])
    finally:
        (M.compute, M.persist, I.decide, I.load_log, I.save_log,
         I.DIRECTIVE_PATH, F.load_state, F.run, F.save_state) = saved
    if directive_path and os.path.exists(directive_path):
        with open(directive_path) as f:
            return json.load(f)
    return None


def directive(exhausted, attempt):
    return {"v": 1, "generatedAt": "2026-08-30T16:00:00Z", "mode": "WARP_OSC",
            "location": 36, "locationKey": "WARP_OSC@36", "attempt": attempt,
            "k": 3, "exhausted": exhausted, "action": "test",
            "summary": "test", "notepadPin": "!! pin", "gotoBan": []}


EXHAUSTED = {"intervened": False, "exhausted": True, "mode": "WARP_OSC",
             "locationKey": "WARP_OSC@36", "attempts": 3, "k": 3,
             "directive": directive(True, 3), "reason": "K exhausted"}
INTERVENING = {"intervened": True, "mode": "WARP_OSC", "locationKey": "WARP_OSC@36",
               "attempt": 2, "k": 3, "directive": directive(False, 2),
               "exhausted": False}
NO_DIRECTIVE = {"intervened": False, "reason": "not stalled", "mode": None}

with tempfile.TemporaryDirectory() as td:
    # ── 1. the wq#1136 regression: exhausted must still refresh the file ────
    print("\n-- exhausted path (the wq#1136 regression) --")
    p = os.path.join(td, "exhausted.json")
    got = run_wrapper(EXHAUSTED, directive_path=p)
    ok("wrapper writes the directive when decide() is exhausted, not intervening",
       got is not None, "nothing written — the intervened-only gate is back")
    ok("the written directive is the exhausted one",
       (got or {}).get("exhausted") is True, got)
    ok("the refreshed pin reaches the file the agent reads",
       (got or {}).get("notepadPin") == "!! pin", got)

    # a second cycle must keep refreshing, not freeze at the first write
    later = dict(EXHAUSTED, directive=dict(directive(True, 3),
                                           generatedAt="2026-08-30T16:30:00Z"))
    got2 = run_wrapper(later, directive_path=p)
    ok("a later timer cycle overwrites the previous exhausted directive",
       (got2 or {}).get("generatedAt") == "2026-08-30T16:30:00Z", got2)

    # ── 2. the intervening path must be unchanged ───────────────────────────
    print("\n-- intervening path (unchanged) --")
    p = os.path.join(td, "intervening.json")
    got = run_wrapper(INTERVENING, directive_path=p)
    ok("wrapper still writes the directive when intervening",
       (got or {}).get("attempt") == 2, got)
    ok("the intervening directive is not marked exhausted",
       (got or {}).get("exhausted") is False, got)

    # ── 3. no directive means no write — the file is never truncated ────────
    print("\n-- no-directive path --")
    p = os.path.join(td, "absent.json")
    got = run_wrapper(NO_DIRECTIVE, directive_path=p)
    ok("wrapper writes nothing when decide() produced no directive",
       got is None and not os.path.exists(p), "a directive-less decision wrote a file")

    p = os.path.join(td, "stale.json")
    with open(p, "w") as f:
        json.dump(directive(True, 3), f)
    got = run_wrapper(NO_DIRECTIVE, directive_path=p)
    ok("an existing directive survives a no-directive cycle",
       (got or {}).get("locationKey") == "WARP_OSC@36", got)

    # ── 4. dead upstream state short-circuits before any write ──────────────
    print("\n-- dead stuck-mode state --")
    p = os.path.join(td, "dead.json")
    got = run_wrapper(EXHAUSTED, state={"ok": False, "reason": "no snapshot"},
                      directive_path=p)
    ok("wrapper writes nothing when stuck-mode state is not ok",
       got is None and not os.path.exists(p), "wrote a directive off a dead state")

    # ── 5. --dry-run stays read-only on the exhausted path ──────────────────
    print("\n-- dry-run --")
    p = os.path.join(td, "dryrun.json")
    saved = (M.compute, I.decide, I.load_log, I.save_log, I.DIRECTIVE_PATH,
             F.load_state, F.run, F.save_state)
    try:
        M.compute = lambda: STATE
        I.decide = lambda state=None, log=None: EXHAUSTED
        I.load_log = lambda: {"v": 1, "attempts": []}
        I.save_log = lambda log: None
        I.DIRECTIVE_PATH = p
        F.load_state = lambda: {}
        F.run = lambda state=None, intervention_log=None, escal=None: ({}, {})
        F.save_state = lambda st: None
        with contextlib.redirect_stdout(io.StringIO()):
            S.main(["--dry-run", "--json"])
    finally:
        (M.compute, I.decide, I.load_log, I.save_log, I.DIRECTIVE_PATH,
         F.load_state, F.run, F.save_state) = saved
    ok("--dry-run writes no directive on the exhausted path",
       not os.path.exists(p), "dry-run touched the directive file")

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
