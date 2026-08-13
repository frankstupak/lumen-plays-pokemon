#!/usr/bin/env python3
"""wq#487 live verification: transit policy impact, read straight off the event log.

Counts turns by class (brain / DET:transit / DET:other / AUTO), the transit
actions the harness took, and NET coordinate progress per map so a "grinding the
same corner" run is visibly distinguishable from a run that is crossing a floor.
Usage: verify_487.py <events/*.jsonl> [...]
"""
import json, sys

def load(path):
    out = []
    for line in open(path):
        try: out.append(json.loads(line))
        except Exception: pass
    return out

for path in sys.argv[1:]:
    evs = load(path)
    turns = [e for e in evs if e.get("kind") == "turn_summary" and e.get("line", "").startswith("T")]
    if not turns:
        continue
    brain = det_transit = det_other = auto = 0
    for e in turns:
        l = e["line"]
        if "DET:transit_" in l: det_transit += 1
        elif "DET:" in l: det_other += 1
        elif "AUTO:" in l: auto += 1
        else: brain += 1
    tool = {}
    for e in evs:
        if e.get("kind") == "tool_call" and e.get("src") == "transit":
            tool[e.get("tool")] = tool.get(e.get("tool"), 0) + 1
    # net displacement per map: first vs last position, plus total steps walked
    pos = [(e.get("map"), e.get("x"), e.get("y")) for e in evs
           if e.get("kind") == "state_read" and isinstance(e.get("map"), int)]
    permap = {}
    last = None
    for m, x, y in pos:
        d = permap.setdefault(m, {"first": (x, y), "last": (x, y), "steps": 0})
        d["last"] = (x, y)
        if last and last[0] == m:
            d["steps"] += abs(x - last[1]) + abs(y - last[2])
        last = (m, x, y)
    print(f"\n=== {path.split('/')[-1]}  turns={len(turns)}")
    print(f"  brain={brain}  DET:transit={det_transit}  DET:other={det_other}  AUTO={auto}"
          f"  brainPerTurn={brain/len(turns):.2f}")
    if tool: print(f"  transit actions: {tool}")
    for m, d in permap.items():
        fx, fy = d["first"]; lx, ly = d["last"]
        net = abs(lx - fx) + abs(ly - fy)
        print(f"  map{m}: ({fx},{fy}) -> ({lx},{ly})  net={net}  walked={d['steps']}"
              f"  efficiency={net/d['steps']:.2f}" if d["steps"] else
              f"  map{m}: ({fx},{fy}) -> ({lx},{ly})  net={net}  walked=0")
    for e in turns[-12:]:
        print("   ", e["t"][11:19], e["line"][:130])
