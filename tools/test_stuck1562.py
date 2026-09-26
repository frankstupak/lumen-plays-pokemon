#!/usr/bin/env python3
"""test_stuck1562 — past K, the supervisor keeps ONE aq row per incident.

Run:  python3 tools/test_stuck1562.py
Scratch AQ_DB and LPP_BASE, no service, no network.

A  helper: first exhaust inserts one open row source='lpp' key='stuck:<mode>@<loc>'.
B  helper: repeat exhaust bumps count on the SAME row (refresh, not dupe).
C  helper: a new mode/location opens a new row and resolves the old one.
D  helper: resolve_stuck_aq_rows edge-clears; a later incident is a NEW row.
E  the row is never source='probe' (wq#965 responder must not double-page).
F  supervisor main(): K-exhaust x3 ticks -> exactly one open row, count=3;
   an unstalled tick resolves it; --dry-run writes nothing.
"""
import importlib.machinery, importlib.util, os, sqlite3, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="stuck1562-")
os.environ["LPP_BASE"] = TMP
os.environ["AQ_DB"] = DB = f"{TMP}/alerts.db"
sys.path.insert(0, HERE)
import lpp_stuck_mode as M

passed = failed = 0
def chk(name, ok, detail=""):
    global passed, failed
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" :: {detail}" if detail else ""))
    if ok: passed += 1
    else: failed += 1

def rows(where="1=1"):
    c = sqlite3.connect(DB)
    r = c.execute(f"SELECT id,source,key,count,status FROM alerts WHERE {where} ORDER BY id").fetchall()
    c.close()
    return r

A = {"ok": True, "stalled": True, "mode": "FIGHT_LOSS_LOOP", "modeLocation": 3,
     "frozenHours": 167.9, "storyScore": 40, "modeEvidence": "3 losses at map 3"}
B = dict(A, mode="NAV_LOOP", modeLocation=59)

i1 = M.open_stuck_aq_row(A)
r = rows()
chk("A1 one row inserted", len(r) == 1 and r[0][0] == i1, str(r))
chk("A2 source/key/status", r[0][1:] == ("lpp", "stuck:FIGHT_LOSS_LOOP@3", 1, "open"), str(r[0]))

i2 = M.open_stuck_aq_row(A); i3 = M.open_stuck_aq_row(A)
r = rows()
chk("B1 same id on repeat", i1 == i2 == i3, f"{i1},{i2},{i3}")
chk("B2 count bumped, no dupes", len(r) == 1 and r[0][3] == 3, str(r))

j1 = M.open_stuck_aq_row(B)
chk("C1 new incident new row", j1 != i1 and rows("status='open'") == [(j1, "lpp", "stuck:NAV_LOOP@59", 1, "open")],
    str(rows()))
chk("C2 old row resolved", rows(f"id={i1}")[0][4] == "resolved", str(rows(f"id={i1}")))

cleared = M.resolve_stuck_aq_rows()
chk("D1 resolve clears the open row", cleared == [j1] and not rows("status='open'"), str(rows()))
chk("D2 resolve on nothing open is a no-op", M.resolve_stuck_aq_rows() == [])
k1 = M.open_stuck_aq_row(B)
chk("D3 recurrence is a NEW row", k1 not in (i1, j1), str(rows()))
M.resolve_stuck_aq_rows()

chk("E1 never source=probe", not rows("source='probe'"), str(rows("source='probe'")))

# --- F: through the real supervisor entrypoint, components stubbed ---------
loader = importlib.machinery.SourceFileLoader("sup", os.path.join(HERE, "lpp-stuck-supervisor"))
spec = importlib.util.spec_from_loader("sup", loader)
S = importlib.util.module_from_spec(spec); loader.exec_module(S)

cur = {"state": A, "exhausted": True}
S.M.compute = lambda: dict(cur["state"])
S.M.persist = lambda st: None
S.M.resolve_aq_row = lambda: None
S.I.load_log = lambda: {}
S.I.save_log = lambda log: None
S.I.persist_directive = lambda d: None
S.I.decide = lambda state, log: {"intervened": False, "mode": state.get("mode"), "attempt": 3, "k": 3,
                                 "exhausted": cur["exhausted"] and state.get("stalled"), "rung": None}
S.F.load_state = lambda: {}
S.F.save_state = lambda e: None
S.F.run = lambda state, intervention_log, escal: ({"ok": True, "resolved": [], "filed": None, "ntfy": None}, escal)

base = len(rows())
for _ in range(3):
    S.main(["--quiet"])
op = rows("status='open'")
chk("F1 3 exhausted ticks -> exactly one open row, count 3",
    len(op) == 1 and op[0][2] == "stuck:FIGHT_LOSS_LOOP@3" and op[0][3] == 3, str(op))
chk("F2 only one row added", len(rows()) == base + 1, str(rows()))

n = len(rows()); cnt = op[0][3]
S.main(["--dry-run", "--quiet"])
chk("F3 --dry-run writes nothing", len(rows()) == n and rows("status='open'")[0][3] == cnt, str(rows()))

cur["state"] = dict(A, stalled=False, mode=None); cur["exhausted"] = False
S.main(["--quiet"])
chk("F4 recovered tick resolves it", not rows("status='open'"), str(rows()))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
