import json, sys, glob
"""Per-turn wall-clock by turn class (brain vs DET:transit) for wq#487."""
rows = []
for path in sys.argv[1:]:
    for p in sorted(glob.glob(path)):
        prev = None
        for line in open(p):
            try: e = json.loads(line)
            except Exception: continue
            if e.get("kind") != "turn_summary" or not str(e.get("line", "")).startswith("T"):
                continue
            t = e["t"]
            cls = "DET:transit" if "DET:transit" in e["line"] else ("DET" if "DET:" in e["line"] else ("AUTO" if "AUTO:" in e["line"] else "brain"))
            if prev:
                from datetime import datetime
                d = (datetime.fromisoformat(t.replace("Z", "+00:00")) -
                     datetime.fromisoformat(prev.replace("Z", "+00:00"))).total_seconds()
                rows.append((cls, d, p.split("/")[-1]))
            prev = t
agg = {}
for cls, d, _ in rows:
    a = agg.setdefault(cls, [])
    a.append(d)
print(f"{'class':14} {'turns':>6} {'median s':>9} {'mean s':>8} {'total s':>9}")
for cls, ds in sorted(agg.items()):
    ds_s = sorted(ds)
    med = ds_s[len(ds_s)//2]
    print(f"{cls:14} {len(ds):>6} {med:>9.1f} {sum(ds)/len(ds):>8.1f} {sum(ds):>9.1f}")
