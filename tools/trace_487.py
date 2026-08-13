import json, sys, glob
f = sorted(glob.glob(sys.argv[1]))[0]
since = sys.argv[2] if len(sys.argv) > 2 else "00:00:00"
for line in open(f):
    try: e = json.loads(line)
    except Exception: continue
    t = e["t"][11:19]
    if t < since: continue
    k = e.get("kind")
    if k == "state_read":
        p = (e.get("party") or [{}])[0]
        print(t, "state map", e.get("map"), e.get("x"), e.get("y"),
              "inBattle", e.get("inBattle"), "hp", p.get("hp"), "/", p.get("maxHp"), "pp", p.get("pp"))
    elif k == "tool_call":
        print(t, "tool", e.get("tool"), "src", e.get("src"), "args", str(e.get("args"))[:40])
    elif k == "turn_summary":
        print(t, "TURN", e.get("line", "")[:130])
    elif k == "think_chunk" and e.get("think"):
        print(t, "think", str(e.get("think"))[:110])
