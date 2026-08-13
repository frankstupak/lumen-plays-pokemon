#!/usr/bin/env python3
# wq#489 verification: synthesise a pathological event log from a REAL captured
# log's shape, then assert lpp-sentinel fires each check and dedupes.
# Read-only against live data; writes only to /tmp.
import json, os, subprocess, sys, time

SENT = "/home/lumen/pokemon/tools/lpp-sentinel"
TMP = "/tmp/lpp_sentinel_test"
os.makedirs(TMP, exist_ok=True)
PASS = FAIL = 0

def ok(name, cond, note=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"PASS {name} :: {note}")
    else:
        FAIL += 1; print(f"FAIL {name} :: {note}")

def run(log, extra=()):
    """run the sentinel dry (no board write, no ntfy) against a synthetic log"""
    cmd = [SENT, "--dry-run", "--events", log, *extra]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    return p.stdout + p.stderr

def write(name, events):
    path = f"{TMP}/{name}"
    with open(path, "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    return path

# ---- 1. positional loop: 20 turns, same map, 2-tile box ----
loop = []
for i in range(20):
    loop.append({"kind": "state_read", "map": 59, "x": 14 + (i % 2), "y": 35, "storyScore": 6})
out = run(write("loop.jsonl", loop))
ok("positional loop fires", "loop_position" in out and "map59" in out, out.strip().splitlines()[-1][:80])

# ---- 2. healthy movement does NOT fire ----
walk = [{"kind": "state_read", "map": 59, "x": i, "y": 10 + i, "storyScore": 6} for i in range(20)]
out = run(write("walk.jsonl", walk))
ok("healthy movement does not fire", "loop_position" not in out, "clear" if "all checks clear" in out else out[:60])

# ---- 3. map changes do NOT fire even if positions are tight ----
hop = [{"kind": "state_read", "map": 59 + (i % 3), "x": 5, "y": 5, "storyScore": 6} for i in range(20)]
out = run(write("hop.jsonl", hop))
ok("multi-map window does not fire", "loop_position" not in out, "clear")

# ---- 4. identical action+result repetition ----
rep = []
for i in range(8):
    rep.append({"kind": "tool_call", "src": "brain", "tool": "goto", "args": [16, 17]})
    rep.append({"kind": "turn_summary", "line": f"T{i} [map59 14,35] goto(16,17) => goto -> stuck now {{}}"})
    rep.append({"kind": "state_read", "map": 59, "x": 14, "y": 35 - i, "storyScore": 6})
out = run(write("repeat.jsonl", rep))
ok("identical action+result repetition fires", "loop_repeat" in out, [l for l in out.splitlines() if "loop_repeat" in l][:1])

# ---- 5. varied actions do NOT fire ----
var = []
for i in range(8):
    var.append({"kind": "tool_call", "src": "brain", "tool": "goto", "args": [i, i]})
    var.append({"kind": "turn_summary", "line": f"T{i} [map59 {i},{i}] goto({i},{i}) => arrived"})
out = run(write("varied.jsonl", var))
ok("varied actions do not fire", "loop_repeat" not in out, "clear")

# ---- 6. stall: flat storyScore + step-budget SOFT alarm ----
stall = [{"kind": "state_read", "map": 59, "x": 3 * (i % 5), "y": 20 + i, "storyScore": 6} for i in range(20)]
stall.append({"kind": "turn_summary", "line": "step budget SOFT alarm on map59 (420 steps, budget 200) - stop exploring"})
out = run(write("stall.jsonl", stall))
ok("stall fires (flat score + soft alarm)", "stall" in out and "storyScore flat" in out, [l for l in out.splitlines() if "STALL" in l][:1])

# ---- 7. rule_violation surfacing ----
rv = [{"kind": "state_read", "map": 59, "x": i, "y": i, "storyScore": 6} for i in range(20)]
rv.append({"kind": "rule_violation", "rule": "no_borrowed_content", "reason": "note rejected: contains guidance markers"})
out = run(write("rv.jsonl", rv))
ok("rule_violation surfaces", "rule_violation" in out and "borrow-guard" in out, [l for l in out.splitlines() if "RULE VIOL" in l][:1])

# ---- 8. DEDUPE: same alert twice within the hour fires once ----
# Uses a scratch HOME-free copy of the state file: point the tool at a temp
# state by running it for real (not --dry-run) against a temp board/state.
# The sentinel's dedupe state lives in runtime/sentinel_state.json; to avoid
# touching live state we exercise emit() directly with a temp state dict.
sys.path.insert(0, "/home/lumen/pokemon/tools")
import importlib.util
spec = importlib.util.spec_from_loader("lppsent", None)
src = open(SENT).read().replace('if __name__ == "__main__":\n    sys.exit(main())', "")
mod = type(sys)("lppsent")
mod.__dict__["__name__"] = "lppsent"
exec(compile(src, SENT, "exec"), mod.__dict__)

class Args:
    dry_run = True      # dry: no board write, no ntfy, but dedupe logic runs
    quiet = False
state = {}
a = [("loop_position", "LOOP: synthetic")]
first = mod.emit(a, Args(), state)
second = mod.emit(a, Args(), state)
ok("dedupe: first emit fires", len(first) == 1, str(first)[:60])
ok("dedupe: repeat within the hour suppressed", len(second) == 0, f"second={second}")
# after the window expires it fires again
state["last_fired"]["loop_position"] -= (mod.DEDUPE_SEC + 1)
third = mod.emit(a, Args(), state)
ok("dedupe: fires again after the window", len(third) == 1, str(third)[:60])

# ---- 9. notepad checks degrade gracefully / catch a guidance leak ----
real = mod.NOTEPAD
mod.NOTEPAD = "/tmp/lpp_sentinel_test/does_not_exist.txt"
ok("notepad check degrades gracefully when absent", mod.check_notepad() == [], "no alerts")
leak = "/tmp/lpp_sentinel_test/notepad_leak.txt"
json.dump({"v": 1, "pinned": [], "summary": "", "rolling": ["[[CERULEAN]] copied pack"]}, open(leak, "w"))
mod.NOTEPAD = leak
keys = [k for k, _ in mod.check_notepad()]
ok("notepad guidance leak detected", "notepad_guidance_leak" in keys, str(keys))
big = "/tmp/lpp_sentinel_test/notepad_big.txt"
json.dump({"v": 1, "pinned": ["x" * 1600], "summary": "", "rolling": ["y" * 5000]}, open(big, "w"))
mod.NOTEPAD = big
keys = [k for k, _ in mod.check_notepad()]
ok("notepad size + pin budget breaches detected", "notepad_size" in keys and "notepad_pins" in keys, str(keys))
mod.NOTEPAD = real

# ---- 10. read-only guarantee: no writes outside /tmp during dry runs ----
board_mtime = os.path.getmtime(mod.BOARD)
run(write("loop2.jsonl", loop))
ok("dry-run leaves the board untouched", os.path.getmtime(mod.BOARD) == board_mtime, "board mtime unchanged")

print(f"\n{PASS} PASS / {FAIL} FAIL")
sys.exit(1 if FAIL else 0)
