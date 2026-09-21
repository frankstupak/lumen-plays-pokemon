#!/usr/bin/env python3
"""test_isis2389 — the out-of-process half of the isis_alert consumer.

Run:  python3 tools/test_isis2389.py
No service, no network, no real ntfy: a scratch events dir, every timestamp
explicit, the publisher injected.

THE HOLE (wq#2389): `tool=isis_alert, level=critical` had no reader anywhere —
not in src, tools, ops, /home/lumen/bin, the foreman harness or kb. The page
fired into events/*.jsonl and stderr and stopped there. src/isis_page.ts pages
from inside the run; this module is the audit that catches what that pager
could not deliver (ntfy down for the minute it tried, or the process gone
before curl returned), replays it, and fails red while anything is unpaged.

Sections: A the key is character-identical to the TypeScript pager's, or the
two halves dedup against different strings. B an alert with no delivery is
UNPAGED. C a delivery behind it clears, including across a -pN rotation of the
same run, and NOT across a different run. D the settle window keeps an in-flight
page from being double-sent. E --send pages, records, and never re-pages; a
failed send stays red so the next run retries. F exit codes.
"""
import json, os, sys, tempfile, time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="isis2389-")
os.environ["LPP_EVENTS_DIR"] = TMP    # must precede the import: paths bake at import time
os.environ["LPP_ISIS_AUDIT_LOG"] = f"{TMP}/isis_audit.jsonl"
sys.path.insert(0, HERE)
import lpp_isis_audit as A

passed = failed = 0
def chk(name, ok, detail=""):
    global passed, failed
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" :: {detail}" if detail else ""))
    if ok: passed += 1
    else: failed += 1

NOW = time.time()

def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

def write(name, rows):
    with open(os.path.join(TMP, name), "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")

def alert_row(msg, age_sec=3600, source="brain"):
    return {"t": iso(NOW - age_sec), "tool": "isis_alert", "level": "critical",
            "source": source, "msg": msg, "kind": "tool_call"}

def page_row(msg, ok=True, age_sec=3599, source="brain"):
    return {"t": iso(NOW - age_sec), "tool": "isis_page", "level": "info",
            "source": "isis_page", "ok": ok, "rc": 0 if ok else 1,
            "key": A.page_key(source, msg), "alert": msg, "kind": "tool_call"}

def clear():
    for f in os.listdir(TMP):
        os.remove(os.path.join(TMP, f))

BRAIN_MSG = "LPP primary brain (isis-local) failed 3 turns in 10min — last: rung dead: 401"
LOOP_MSG = ("LPP has taken 0 turns across 7 consecutive agent reboots (last error: 401); "
            "backing off 40s before the next attempt.")

# --- A. key parity with src/isis_page.ts --------------------------------
# The literal below is what the TypeScript pager emitted for BRAIN_MSG when
# src/probe_isis2389.ts ran. If either side's normalisation drifts, the audit
# stops matching the pager's own delivery rows and re-pages what already went.
chk("the audit key is byte-identical to the pager's",
    A.page_key("brain", BRAIN_MSG) ==
    "brain:LPP primary brain (isis-local) failed # turns in #min — last: rung dead: #",
    A.page_key("brain", BRAIN_MSG))
chk("dead-loop alerts that differ only in their counts share one key",
    A.page_key("live_agent", LOOP_MSG) ==
    A.page_key("live_agent", LOOP_MSG.replace("7 ", "91 ").replace("40s", "300s")))

# --- B. an alert with nothing behind it is UNPAGED ----------------------
write("live-agent-1000.jsonl", [alert_row(BRAIN_MSG), {"t": iso(NOW), "kind": "turn_summary", "line": "noise"}])
und, stats = A.scan(TMP)
chk("a fired alert with no delivery is reported", stats["undelivered"] == 1 and
    und[0]["msg"] == BRAIN_MSG, json.dumps(stats))
chk("...and the report names the run that produced it", und[0]["run"] == "live-agent-1000", und[0]["run"])

# --- C. a delivery behind it clears it ----------------------------------
write("live-agent-1000.jsonl", [alert_row(BRAIN_MSG), page_row(BRAIN_MSG)])
_, stats = A.scan(TMP)
chk("a successful isis_page in the same run clears the alert", stats["undelivered"] == 0, json.dumps(stats))

write("live-agent-1000.jsonl", [alert_row(BRAIN_MSG), page_row(BRAIN_MSG, ok=False)])
_, stats = A.scan(TMP)
chk("a FAILED isis_page does not clear it", stats["undelivered"] == 1, json.dumps(stats))

clear()
write("live-agent-1000-p1.jsonl", [alert_row(BRAIN_MSG)])
write("live-agent-1000.jsonl", [page_row(BRAIN_MSG)])
_, stats = A.scan(TMP)
chk("rotation is not a new run: -p1 alert, base-file delivery, still clear",
    stats["undelivered"] == 0, json.dumps(stats))

clear()
write("live-agent-1000.jsonl", [page_row(BRAIN_MSG)])
write("live-agent-2000.jsonl", [alert_row(BRAIN_MSG)])
_, stats = A.scan(TMP)
chk("a LATER run hitting the same fault is a new incident, not a delivered one",
    stats["undelivered"] == 1, json.dumps(stats))

# --- D. the settle window -----------------------------------------------
clear()
write("live-agent-3000.jsonl", [alert_row(BRAIN_MSG, age_sec=5)])
_, stats = A.scan(TMP)
chk("an alert younger than the settle window is left to the live pager",
    stats["undelivered"] == 0, json.dumps(stats))

# --- E. --send: page, record, never re-page -----------------------------
clear()
write("live-agent-4000.jsonl", [alert_row(BRAIN_MSG), alert_row(LOOP_MSG, source="live_agent")])
calls = []
def fake_ntfy(rc):
    def call(args):
        calls.append(args)
        return rc, "ntfy-send: delivered [primary=200]" if rc == 0 else "DELIVERY FAILED"
    return call

und, _ = A.scan(TMP)
rows = [A.send(a, ntfy_call=fake_ntfy(0)) for a in und]
chk("--send pages every unpaged alert once", len(calls) == 2 and all(r["sent"] for r in rows),
    json.dumps(calls[:1]))
chk("the page carries priority, topic and title, and says it is a replay",
    calls[0][:6] == ["-p", "high", "-t", "lumen-fleet", "-T", "LPP CRITICAL"] and
    "replayed from live-agent-4000" in calls[0][6], json.dumps(calls[0]))
_, stats = A.scan(TMP)
chk("a sent page clears the alert on the next scan", stats["undelivered"] == 0, json.dumps(stats))
before = len(calls)
for a in A.scan(TMP)[0]:
    A.send(a, ntfy_call=fake_ntfy(0))
chk("a second --send does not re-page what it already paged", len(calls) == before, str(len(calls)))

clear()
write("live-agent-5000.jsonl", [alert_row(BRAIN_MSG)])
und, _ = A.scan(TMP)
row = A.send(und[0], ntfy_call=fake_ntfy(1))
chk("a failed replay is recorded as unsent", row["sent"] is False and row["rc"] == 1, json.dumps(row))
_, stats = A.scan(TMP)
chk("...and the alert stays unpaged, so the next run retries it",
    stats["undelivered"] == 1, json.dumps(stats))

# --- F. exit codes -------------------------------------------------------
chk("an unpaged alert exits red", A.main(["--events-dir", TMP, "--quiet"]) == 1)
clear()
write("live-agent-6000.jsonl", [alert_row(BRAIN_MSG), page_row(BRAIN_MSG)])
chk("a fully delivered window exits green", A.main(["--events-dir", TMP, "--quiet"]) == 0)
clear()
chk("no alerts at all exits green", A.main(["--events-dir", TMP, "--quiet"]) == 0)

print(f"\n{passed} PASS / {failed} FAIL")
sys.exit(1 if failed else 0)
