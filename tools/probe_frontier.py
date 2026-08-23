#!/usr/bin/env python3
"""probe_frontier — offline proof for the wq#515 cross-run frontier detector.

Run:  python3 tools/probe_frontier.py
No service, no network (compute(live=False)), no writes outside a temp dir.

The interesting half of this probe is the FALSE-POSITIVE guards. A stall
detector that cries wolf gets muted, and a muted detector is exactly the state
this ticket exists to fix. So the synthetic histories below include several
that MUST stay silent: steady progress, a genuinely slow 9-hour corridor, a
campaign that is advancing while wandering into side rooms.
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_frontier as F

PASS = FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}{('  ' + detail) if detail else ''}")


def eq(label, got, want):
    ok(label, got == want, f"got={got!r} want={want!r}")


H = 3_600_000        # one hour in ms
T0 = 1_786_000_000_000


def fixture(points, runs=()):
    """Build a temp LPP tree. points = [(hours_from_T0, map, badges, events)]."""
    d = tempfile.mkdtemp(prefix="frontier_probe_")
    os.makedirs(f"{d}/checkpoints", exist_ok=True)
    os.makedirs(f"{d}/events", exist_ok=True)
    for i, (h, m, b, e) in enumerate(points):
        json.dump({"v": 1, "kind": "map", "map": m, "badges": b, "events": e,
                   "ts": int(T0 + h * H)},
                  open(f"{d}/checkpoints/auto-p{i:03d}-map{m}.json", "w"))
    for i, r in enumerate(runs):
        json.dump(r, open(f"{d}/events/run-summary-r{i:03d}.json", "w"))
    return d


def state(d, at_h, window=12.0, rule="strict"):
    return F.compute(base=d, window_h=window, now_ms=T0 + at_h * H,
                     rule=rule, live=False)


# ── 1. the rank table is ROM-grounded, not typed from memory ──────────────
print("\n-- critical path / naming --")
names = F.load_map_names()
ok("map_names.json loaded", len(names) > 200, f"got {len(names)} entries")
bad = [(m, lbl, names.get(m)) for m, lbl in F.CRITICAL_PATH if names.get(m) != lbl]
ok("every CRITICAL_PATH label matches the ROM-derived name", not bad, str(bad))
ids = [m for m, _ in F.CRITICAL_PATH]
eq("no duplicate map ids on the path", len(ids), len(set(ids)))
ok("ranks are dense and ordered", list(F.RANK.values()) == list(range(len(ids))))

# Route 4 (map 15) is ONE id on BOTH sides of Mt Moon. Ranking it above the
# mountain would let the west side falsely claim "past Mt Moon". This is the
# geography decision the detector rests on, so it gets a test, not a comment.
ok("Route 4 ranks BELOW Mt Moon 1F", F.RANK[15] < F.RANK[59])
ok("Mt Moon floors are ordered 1F < B1F < B2F",
   F.RANK[59] < F.RANK[60] < F.RANK[61])
ok("Cerulean City ranks above all of Mt Moon", F.RANK[3] > F.RANK[61])
ok("off-path interiors carry NO rank (gym/mart/centre/museum/houses)",
   all(m not in F.RANK for m in (52, 53, 54, 55, 56, 57, 58, 64, 65, 67, 68)))
eq("map_label falls back to the raw id, never a guess", F.map_label(11), "map11")
eq("map_label uses the ROM name when known", F.map_label(59), "Mt Moon 1F")

# The committed table must still match the ROM the game actually runs. If the
# ROM changes under us this fails loudly instead of mislabelling the alert.
print("\n-- map_names.json is current vs the ROM --")
try:
    gen = subprocess.run(["npx", "tsx", "tools/dump_map_names.ts", "--json"],
                         cwd="/home/lumen/pokemon", capture_output=True,
                         text=True, timeout=180)
    if gen.returncode == 0:
        live_names = {int(k): v for k, v in json.loads(gen.stdout).items()}
        eq("regenerated table == committed table", live_names, names)
    else:
        ok("regenerated table == committed table", False,
           f"generator exited {gen.returncode}: {gen.stderr[-200:]}")
except Exception as e:
    ok("regenerated table == committed table", False, f"{type(e).__name__}: {e}")


# ── 2. what counts as an advance ───────────────────────────────────────────
print("\n-- advance detection --")
# steady forward walk: Pallet -> Route 1 -> Viridian -> Route 2
d = fixture([(0, 0, 0, 10), (1, 12, 0, 10), (2, 1, 0, 10), (3, 13, 0, 10)])
adv = F.advances(F.evidence(d))
eq("three advances after the baseline", len(adv), 3)
ok("advance names the map reached", "Route 1" in adv[0]["why"], adv[0]["why"])

d = fixture([(0, 13, 0, 10), (1, 13, 1, 10)])
adv = F.advances(F.evidence(d))
eq("badge gain is an advance", len(adv), 1)
ok("badge advance is labelled", "badges 0->1" in adv[0]["why"], adv[0]["why"])

# backtracking and revisiting are NOT progress -- this is the whole thesis
d = fixture([(0, 59, 1, 20), (1, 60, 1, 20), (2, 59, 1, 20), (3, 15, 1, 20),
             (4, 60, 1, 20)])
adv = F.advances(F.evidence(d))
eq("walking back to a lower-ranked map is not an advance", len(adv), 1)
ok("...and the one advance is the deepest map", "Mt Moon B1F" in adv[0]["why"])

# ── 3. FALSE-POSITIVE GUARDS: these must stay SILENT ───────────────────────
print("\n-- false-positive guards (must NOT alert) --")
# (a) steady progress every 4h, checked 2h after the latest advance
d = fixture([(0, 0, 0, 10), (4, 12, 0, 10), (8, 1, 0, 10), (12, 13, 0, 10),
             (16, 51, 0, 10), (20, 2, 1, 11)])
ok("steady progress does not alert", not state(d, 22)["stalled"])

# (b) a genuinely hard corridor: 9h between real advances. The real Mt Moon
#     descent on 2026-08-08 took 8.97h and was legitimate work. Checked DURING
#     the quiet stretch (h=8.5), which is when a too-tight window misfires.
d = fixture([(0, 59, 1, 20), (9, 60, 1, 20)])
ok("mid-corridor at 8.5h quiet: no alert at the 12h window",
   not state(d, 8.5, window=12.0)["stalled"])
ok("...but the 8h window the ticket suggested DOES misfire there "
   "(evidence the suggested default was too tight)",
   state(d, 8.5, window=8.0)["stalled"])
ok("...and once the corridor completes, the clock resets",
   not state(d, 10, window=8.0)["stalled"])
# point-in-time replay: asking about h=8.5 must not see the h=9 advance, or the
# backtest and every synthetic history below would be reading the future
eq("evidence after the asked-about instant is excluded",
   state(d, 8.5)["furthestLabel"], "Mt Moon 1F")
eq("...and is included once time passes it",
   state(d, 10)["furthestLabel"], "Mt Moon B1F")

# (c) progress continues while the agent also dips into side rooms
d = fixture([(0, 2, 1, 20), (1, 54, 1, 20), (2, 56, 1, 20), (3, 14, 1, 21),
             (4, 58, 1, 21), (5, 15, 1, 21)])
ok("side-room detours alongside real progress do not alert",
   not state(d, 6)["stalled"])


# ── 4. FALSE-NEGATIVE GUARDS: these must FIRE ──────────────────────────────
print("\n-- stall detection (must alert) --")
# the shape of the real failure: brisk movement across four maps, forever
loop = [(0, 15, 1, 24)]
for i in range(1, 40):
    loop.append((i, [59, 60, 61, 15][i % 4], 1, 24))
d = fixture(loop)
st = state(d, 40)
ok("a 4-map loop with no depth gain alerts", st["stalled"])
key, msg = F.format_alert(st)
eq("alert key", key, "frontier_stall")
ok("alert names the frozen badge count", "badges 1" in msg, msg)
ok("alert names how long it has been frozen",
   f"FROZEN {st['frozenHours']:.1f}h" in msg, msg)
ok("alert names the NEXT milestone", "NEXT = Cerulean City" in msg, msg)
ok("alert shows the loop shape", "->" in msg.split("Recent maps:")[-1], msg)

# side maps must NOT rescue a stall (the ticket's suggested new-map rule)
d = fixture(loop + [(20.5, 52, 1, 24), (30.5, 55, 1, 24)])
ok("never-before-seen SIDE maps do not reset the clock (strict)",
   state(d, 40)["stalled"])
ok("...whereas the newmap rule is rescued by them, which is the bug",
   not state(d, 40, rule="newmap")["stalled"])

# rising raw event flags must NOT rescue a stall either
d = fixture([(i, [59, 60, 61, 15][i % 4], 1, 24 + i // 15) for i in range(40)])
ok("rising event-flag count does not reset the clock (strict)",
   state(d, 40)["stalled"])
ok("...whereas the events rule is rescued by it, which is the bug",
   not state(d, 40, rule="events")["stalled"])

# ── 5. degradation: a monitor must not fail silently ───────────────────────
print("\n-- degradation --")
empty = tempfile.mkdtemp(prefix="frontier_empty_")
os.makedirs(f"{empty}/checkpoints", exist_ok=True)
os.makedirs(f"{empty}/events", exist_ok=True)
st = F.compute(base=empty, live=False)
ok("no evidence -> ok=False with a reason, not a crash",
   st.get("ok") is False and st.get("reason"))

d = fixture([(0, 4, 1, 30)])          # Lavender Town == last ranked milestone
st = state(d, 1)
ok("reaching the end of the path table is flagged", st["pathExhausted"])
eq("...under its own alert key, not frontier_stall",
   F.format_alert(st)[0], "frontier_path_end")


# ── 6. persistence never regresses ─────────────────────────────────────────
print("\n-- persistence (merge-max) --")
pd = tempfile.mkdtemp(prefix="frontier_persist_")
p = f"{pd}/frontier.json"
F.persist({"ok": True, "maxBadges": 2, "furthestRank": 11, "maxEventFlags": 30,
           "mapsEverCount": 20, "furthestLabel": "Cerulean City",
           "furthestMap": 3, "generatedAt": "2026-08-13T00:00:00Z"}, p)
# now a run where the old checkpoints have been archived away
m = F.persist({"ok": True, "maxBadges": 1, "furthestRank": 8, "maxEventFlags": 24,
               "mapsEverCount": 4, "furthestLabel": "Mt Moon 1F",
               "furthestMap": 59, "generatedAt": "2026-08-13T06:00:00Z"}, p)
eq("badges never regress", m["maxBadges"], 2)
eq("path depth never regresses", m["furthestRank"], 11)
eq("...and the label follows the kept rank", m["furthestLabel"], "Cerulean City")
eq("firstSeenAt is preserved", m["firstSeenAt"], "2026-08-13T00:00:00Z")

# ── 7. the backtest against REAL campaign history IS the acceptance gate ───
print("\n-- backtest vs real history (the acceptance evidence) --")
ev = F.evidence()          # the live /home/lumen/pokemon tree
ok("real evidence is present", len(ev) > 100, f"{len(ev)} points")
adv, closed, trailing = F.gaps_for(ev, "strict")
worst_ok = max((g[0] for g in closed), default=0)
ok("longest slow-but-progressing stretch is under the 12h window",
   worst_ok < F.DEFAULT_WINDOW_H, f"worst legit gap {worst_ok:.2f}h")
ok("the real freeze is far past the window",
   trailing and trailing[0] > 48, f"trailing {trailing[0]:.2f}h")
fp12 = [g for g in closed if g[0] > 12]
eq("strict @12h: zero false alerts across the whole campaign", len(fp12), 0)
ok("strict @12h catches the real freeze", trailing[0] > 12)
# the two rules the ticket suggested, measured on the same history
for rule, label in (("newmap", "any-new-map"), ("events", "event-flag-count")):
    _, c2, t2 = F.gaps_for(ev, rule)
    ok(f"{label} rule DOES produce false alerts @12h "
       f"(why it is not shipped)", len([g for g in c2 if g[0] > 12]) > 0)


# ── 8. restart-loop detector (wq#515 absorbed scope, was wq#504 MISS 2) ────
# The frontier says "nothing moved". This says WHY, and says it on the second
# boot rather than after a 12h window. Both halves get red AND green cases:
# a detector that only ever fires is as useless as one that never does.
print("\n-- restart loop: must alert --")

def boot(started_h, save, maps, turns=10):
    return {"startedAt": F._iso(int(T0 + started_h * H)), "resumedFrom": save,
            "mapsSeen": maps, "turns": turns, "badges": 1, "wallMs": 600000}

# three boots, same save, each re-walking and losing Mt Moon
loop_runs = [boot(0, "auto-aaa-map15.state.gz", [15, 59], 20),
             boot(2, "auto-aaa-map15.state.gz", [15, 59, 60], 30),
             boot(4, "auto-aaa-map15.state.gz", [15, 59, 60, 61], 40)]
d = fixture([(0, 15, 1, 5)], runs=loop_runs)
rl = F.restart_loop(base=d)
ok("three boots on one save is a loop", rl["looping"] is True)
eq("streak length", rl["streak"], 3)
eq("streak names the save", rl["streakSave"], "auto-aaa-map15.state.gz")
key, msg = F.format_restart_alert(rl)
eq("alert key", key, "restart_loop")
ok("alert names the save", "auto-aaa-map15.state.gz" in msg)
ok("alert names the streak length", "3 consecutive boots" in msg)

# turnsDiscardedInStreak counts the streak's OWN boots minus the live one.
# REGRESSION: the first draft summed a rewind list that is not index-aligned
# with the streak and produced a plausible-looking wrong number (301 vs 185).
eq("turns discarded = streak boots except the running one", rl["turnsDiscardedInStreak"], 50)

# REGRESSION: the first draft labelled this "Deepest discarded" while actually
# taking the most RECENT rewind. Confident text that does not match what the
# code computes is the exact failure this project keeps paying for.
deep_runs = [boot(0, "auto-aaa-map15.state.gz", [15, 59, 60, 61], 90),   # reached B2F
             boot(2, "auto-aaa-map15.state.gz", [15, 59], 10),           # rewind from B2F
             boot(4, "auto-aaa-map15.state.gz", [15], 5)]                # shallower loss
d2 = fixture([(0, 15, 1, 5)], runs=deep_runs)
rl2 = F.restart_loop(base=d2)
eq("deepest rewind is the DEEPEST, not the latest", rl2["deepestRewind"]["lostFromLabel"], "Mt Moon B2F")
ok("alert says 'deepest loss on record'", "Deepest loss on record" in F.format_restart_alert(rl2)[1])

print("\n-- restart loop: must NOT alert --")
good = [boot(0, "auto-aaa-map15.state.gz", [15, 59], 20),
        boot(2, "auto-bbb-map59.state.gz", [59, 60], 30),
        boot(4, "auto-ccc-map61.state.gz", [61, 3], 40)]
d3 = fixture([(0, 15, 1, 5)], runs=good)
rl3 = F.restart_loop(base=d3)
ok("advancing saves are not a loop", rl3["looping"] is False)
eq("streak of one", rl3["streak"], 1)
eq("forward boots produce no rewinds", rl3["rewinds"], [])

# a boot resuming DEEPER than the last run reached is progress, not a rewind
fwd = [boot(0, "auto-aaa-map15.state.gz", [15, 59], 20),
       boot(2, "auto-bbb-map61.state.gz", [61], 30)]
ok("resuming deeper than the previous run is not a rewind",
   F.restart_loop(base=fixture([(0, 15, 1, 5)], runs=fwd))["rewinds"] == [])

# min_streak is a policy knob, not a magic number
eq("min_streak=4 keeps a 3-boot streak quiet",
   F.restart_loop(base=d, min_streak=4)["looping"], False)

print("\n-- restart loop: degradation and grounding --")
eq("no run summaries -> ok=False with a reason, not a crash",
   F.restart_loop(base=fixture([(0, 15, 1, 5)]))["ok"], False)
weird = [boot(0, None, [15], 5), boot(2, "no-map-id-here.gz", [15], 5)]
rlw = F.restart_loop(base=fixture([(0, 15, 1, 5)], runs=weird))
ok("unparseable resumedFrom degrades instead of crashing", rlw["ok"] is True)
ok("...and yields no false rewind", rlw["rewinds"] == [])

# The map id parsed out of a checkpoint filename is only trustworthy because it
# matches the RAM-read map inside the sidecar. Proved against the REAL tree.
import glob as _g, re as _re
match = mismatch = 0
for _p in _g.glob(f"{F.BASE}/checkpoints/**/*.json", recursive=True):
    _m = _re.search(r"-map(\d+)\.", os.path.basename(_p))
    try:
        _j = json.load(open(_p))
    except Exception:
        continue
    if not _m or _j.get("map") is None:
        continue
    if int(_m.group(1)) == _j["map"]:
        match += 1
    else:
        mismatch += 1
ok("checkpoint FILENAME map id == RAM map id on the real tree",
   mismatch == 0 and match > 0, f"{match} match / {mismatch} mismatch")

print("\n-- resume map resolution: sidecar RAM beats the filename --")
# Only 46 of 192 real checkpoints are -map<N> named; 139 are -t<N> and carry no
# map id at all. The filename parse alone went blind on 72% of the set the
# moment wq#518 started selecting t-named saves.
_idx = F._sidecar_map_index()
ok("sidecar index is populated from the real tree", len(_idx) > 20, f"{len(_idx)} sidecars")

_t_named = [k for k in _idx if __import__("re").search(r"-t\d+$", k)]
ok("t-named checkpoints exist and resolve via sidecar", len(_t_named) > 0, f"{len(_t_named)} t-named")
if _t_named:
    _k = _t_named[0]
    eq("a t-named save resolves to its RAM map", F.resume_map(_k + ".state.gz"), _idx[_k])

_d = tempfile.mkdtemp(prefix="resmap_")
os.makedirs(f"{_d}/checkpoints", exist_ok=True)
eq("unknown stem falls back to the filename parse",
   F.resume_map("auto-zzz-map61.state.gz", base=_d), 61)
eq("unknown stem with no map id yields None",
   F.resume_map("auto-zzz-t50.state.gz", base=_d), None)
eq("empty resumedFrom yields None", F.resume_map(None, base=_d), None)

# Coverage on the REAL boot set: every boot should name a place, not "?".
_boots = F.load_boots()
_unresolved = [b for b in _boots if b.get("resumeMap") is None and b.get("resumedFrom")]
# A boot whose checkpoint has since been pruned or archived can NEVER resolve,
# and demanding it would be demanding that history never be cleaned up. The
# invariant is that resolution works wherever the evidence still exists.
_idx_now = F._sidecar_map_index()
_stem = lambda f: os.path.basename(f).replace(".state.gz", "").replace(".gz", "")
_should = [b for b in _boots if b.get("resumedFrom") and _stem(b["resumedFrom"]) in _idx_now]
_missed = [b for b in _should if b.get("resumeMap") is None]
ok("every boot whose checkpoint STILL EXISTS resolves", len(_missed) == 0,
   f"{len(_missed)} missed of {len(_should)} resolvable")
ok("the NEWEST boot resolves (the one any live alert will name)",
   _boots[-1].get("resumeMap") is not None,
   f"{_boots[-1].get('resumedFrom')}")
print(f"   (unresolvable by pruning: {len(_unresolved)} of {len(_boots)} boots, all pre-dating cleanup)")

print("\n-- restart loop: the real campaign --")
real = F.restart_loop()
ok("real history is readable", real.get("ok") is True)
# NOTE (2026-08-13): the first version of this block asserted that the real
# campaign IS looping and that the streak save is the map15 one. Those passed
# only while the wq#518 resume trap was live, and they FAILED the moment the
# fix landed and the streak dropped 10 -> 1. A test that only passes while the
# system is broken is not a test of the detector; it is a test of the outage.
# The detector's proof lives in the synthetic fixtures above, which contain a
# known-looping history. Here we assert only invariants that hold either way.
ok("streak is a positive count", isinstance(real.get("streak"), int) and real["streak"] >= 1,
   str(real.get("streak")))
ok("looping is consistent with the streak and the threshold",
   real.get("looping") == (real["streak"] >= real["minStreak"] and bool(real.get("streakSave"))))
ok("rewind history is a list and never negative",
   isinstance(real.get("rewinds"), list) and len(real["rewinds"]) >= 0)
print(f"   (live campaign right now: streak={real.get('streak')} "
      f"save={real.get('streakSave')} looping={real.get('looping')})")


# ── 9. deploy drift (wq#515, folded in 06:03Z) ────────────────────────────
print("\n-- deploy drift --")

def gitrepo():
    """A throwaway repo with three commits an hour apart.

    The commits MUST be spaced: git reflog timestamps have one-SECOND
    resolution, so three commits made in the same second are indistinguishable
    to any at-or-before lookup. The first version of this fixture committed as
    fast as the loop would run and the resolution test failed for that reason
    alone -- the fixture was wrong, not the check. Real restarts and pulls are
    seconds to minutes apart (the live case resolved on a 6-second gap), but
    the limitation is documented in docs/FRONTIER.md rather than hidden here.
    """
    d = tempfile.mkdtemp(prefix="drift_probe_")
    cfg = ["-c", "user.email=p@x", "-c", "user.name=probe"]
    subprocess.run(["git", "-C", d, "init", "-q", "-b", "main"], check=True)
    shas, times = [], []
    base_epoch = int(__import__("time").time()) - 10 * 3600
    for i in range(3):
        stamp = base_epoch + i * 3600
        env = dict(os.environ, GIT_COMMITTER_DATE=f"{stamp} +0000",
                   GIT_AUTHOR_DATE=f"{stamp} +0000")
        os.makedirs(f"{d}/src", exist_ok=True)
        open(f"{d}/src/f{i}.ts", "w").write(f"// {i}\n")
        subprocess.run(["git", "-C", d, *cfg, "add", "-A"], check=True, env=env)
        subprocess.run(["git", "-C", d, *cfg, "commit", "-qm", f"c{i}"], check=True, env=env)
        shas.append(subprocess.run(["git", "-C", d, "rev-parse", "HEAD"],
                                   capture_output=True, text=True).stdout.strip())
        times.append(stamp)
    return d, shas, times

gd, shas, gtimes = gitrepo()
now_ms = __import__("time").time() * 1000
dr = F.deploy_drift(base=gd, started_ms=now_ms)
ok("clean repo, service started after HEAD -> no drift", dr["drifted"] is False, str(dr))
eq("running == HEAD when nothing moved after start", dr["running"], shas[-1])

# a process that started BEFORE the last two commits is running older code --
# this is the 62fa545 misreport, reproduced deterministically.
# A process that started 30 minutes after the FIRST commit was reading the
# tree as it stood then -- two commits before HEAD. This is the 62fa545
# misreport reproduced deterministically.
old_dr = F.deploy_drift(base=gd, started_ms=(gtimes[0] + 1800) * 1000)
eq("running sha comes from the reflog AT PROCESS START, not from HEAD",
   old_dr["running"], shas[0])
ok("...so the tree is reported ahead of the live process",
   old_dr["commitsTreeAheadOfRunning"] == 2, str(old_dr["commitsTreeAheadOfRunning"]))
ok("...and it is flagged as drift", old_dr["drifted"] is True)
ok("alert names both shas",
   shas[0][:7] in F.format_drift_alert(old_dr)[1] and shas[-1][:7] in F.format_drift_alert(old_dr)[1])
eq("alert key", F.format_drift_alert(old_dr)[0], "deploy_drift")

open(f"{gd}/src/dirty.ts", "w").write("// uncommitted\n")
dd = F.deploy_drift(base=gd, started_ms=now_ms)
ok("uncommitted code path is drift (a restart would deploy it)", dd["drifted"] is True)
ok("...and the alert names the file", "src/dirty.ts" in F.format_drift_alert(dd)[1])

open(f"{gd}/notes.md", "w").write("not code\n")
dn = F.deploy_drift(base=gd, started_ms=now_ms)
ok("non-code dirt does not count as deploy drift",
   all("notes.md" not in p for p in dn["dirtyCodePaths"]))

eq("not a git repo -> ok=False with a reason, not a crash",
   F.deploy_drift(base=tempfile.mkdtemp(), started_ms=now_ms)["ok"], False)

real_d = F.deploy_drift()
ok("real repo is readable", real_d.get("ok") is True)
ok("real running sha resolves from the reflog",
   real_d.get("runningFrom") == "reflog@process-start", str(real_d.get("runningFrom")))

# ---- wq#862: plausibility filter ----
ok("coords_plausible rejects map88 at (45,3) (torn read)",
   not F.coords_plausible(88, 45, 3))
ok("coords_plausible accepts map88 at (2,7) (inside 8x8)",
   F.coords_plausible(88, 2, 7))
ok("coords_plausible accepts map36 at (45,3) (Route 25, 60x18)",
   F.coords_plausible(36, 45, 3))
ok("coords_plausible accepts unknown map id",
   F.coords_plausible(999, 0, 0))
h88 = F.rom_map_header(88)
ok("rom_map_header(88) reads Bill's house dims",
   h88 is not None and h88[1] == 4 and h88[2] == 4,
   str(h88))
ok("rom_map_header(999) returns None for out-of-range",
   F.rom_map_header(999) is None)

# synthetic sidecar with implausible coords should be excluded
pdir = tempfile.mkdtemp()
os.makedirs(f"{pdir}/checkpoints", exist_ok=True)
os.makedirs(f"{pdir}/events", exist_ok=True)
now_p = int(F.datetime.now(F.timezone.utc).timestamp() * 1000)
json.dump({"ts": now_p - 3600_000, "map": 88, "x": 45, "y": 3, "badges": 1},
          open(f"{pdir}/checkpoints/torn.json", "w"))
json.dump({"ts": now_p - 7200_000, "map": 36, "x": 45, "y": 3, "badges": 1},
          open(f"{pdir}/checkpoints/good.json", "w"))
sides = F.load_sidecars(pdir)
ok("load_sidecars excludes implausible sidecar",
   len(sides) == 1 and sides[0]["map"] == 36,
   f"got {len(sides)} sidecar(s)")

print(f"\n{PASS} passed, {FAIL} failed")
for d in (pd, pdir):
    shutil.rmtree(d, ignore_errors=True)
sys.exit(1 if FAIL else 0)
