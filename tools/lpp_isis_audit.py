#!/usr/bin/env python3
"""lpp_isis_audit — did the critical page actually go out? (wq#2389)

WHY THIS EXISTS
  wq#1584 made the primary-brain page able to fire; wq#2389 gave it a reader
  (src/isis_page.ts, attached by the live service) that publishes it through
  /home/lumen/bin/ntfy-send. That reader lives INSIDE the process the alert is
  about, which is the right place to page from and the wrong place to audit
  from: if ntfy was down for the one minute the page was sent, or the process
  died between the alert and the publish, the only surviving record is the
  event log — and an unread event log is exactly the hole this ticket names.

  So this is the out-of-process half. It reads events/*.jsonl, pairs every
  `tool_call {tool:"isis_alert", level:"critical"}` with the
  `tool_call {tool:"isis_page", ok:true}` the pager writes after a successful
  publish, and reports every alert with no delivery behind it. `--send` pages
  those through the same ntfy-send path, so a page lost to a transient ntfy
  outage is recovered rather than discovered months later in a log.

  Read-only without `--send`. It never touches the game, the service or the
  work queue, and it writes exactly one file of its own (below).

DEDUP
  Per RUN — the run id is the event-log stem with any `-pN` rotation suffix
  removed — and per KEY, where the key is the producer plus the alert text with
  digit runs collapsed to `#`. That is character-for-character the key
  src/isis_page.ts computes, because the alert live_agent re-emits on every
  dead reboot carries the reboot count in its text and would otherwise read as
  a new alert on every cycle. Deliveries are matched within the same run for
  the same reason the in-process pager latches per run: a NEW run that hits the
  same fault is a new incident and deserves its own page.

STATE
  runtime/isis_audit.jsonl — one row per page THIS tool sent
  ({t, run, key, alert, sent, rc, detail}). Written only under `--send`, and
  read on every run so a repeat `--send` never re-pages what it already paged.
  The live pager's own deliveries are read from the run logs, never from here.
  It lives in runtime/ rather than events/ because events/*.jsonl is swept by
  retainEventLogs() at every service boot — dedup state in there would be
  deleted by the log retention and replayed pages would start doubling.

EXIT
  0 = every critical alert in the window has a delivery behind it (or there
  were none). 1 = at least one did not. 2 = bad usage.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

BASE = os.environ.get("LPP_BASE", "/home/lumen/pokemon")
EVENTS_DIR = os.environ.get("LPP_EVENTS_DIR", f"{BASE}/events")
AUDIT_LOG = os.environ.get("LPP_ISIS_AUDIT_LOG", f"{BASE}/runtime/isis_audit.jsonl")
NTFY = os.environ.get("LPP_NTFY_BIN", "/home/lumen/bin/ntfy-send")
NTFY_TOPIC = os.environ.get("LPP_NTFY_TOPIC", "lumen-fleet")
NTFY_PRIORITY = os.environ.get("LPP_ISIS_PRIORITY", "high")
# An alert younger than this may still have a publish in flight in the live
# process; paging it here would double-page the same incident.
SETTLE_SEC = int(os.environ.get("LPP_ISIS_SETTLE_SEC", "120"))
ROTATION_RE = re.compile(r"-p\d+$")


def page_key(source, msg):
    """The dedup key. Mirrors pageKey() in src/isis_page.ts exactly."""
    return "%s:%s" % (source, re.sub(r"\d+", "#", msg)[:200])


def run_id(filename):
    return ROTATION_RE.sub("", os.path.basename(filename)[: -len(".jsonl")])


def _ts(row):
    try:
        return datetime.fromisoformat(str(row.get("t", "")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def event_logs(events_dir=EVENTS_DIR, since_hours=24.0):
    """Run logs touched within the window, oldest first. The audit log itself is
    not a run log — excluded by name so a --send row can never be mistaken for
    a live delivery."""
    cutoff = time.time() - since_hours * 3600
    out = []
    try:
        names = os.listdir(events_dir)
    except OSError:
        return out
    for name in sorted(names):
        if not name.endswith(".jsonl") or name == os.path.basename(AUDIT_LOG):
            continue
        path = os.path.join(events_dir, name)
        try:
            if os.path.getmtime(path) < cutoff:
                continue
        except OSError:
            continue
        out.append(path)
    return out


def scan(events_dir=EVENTS_DIR, since_hours=24.0, audit_log=AUDIT_LOG, now=None):
    """Returns (undelivered, stats). `undelivered` is one dict per alert that
    has no successful delivery behind it, newest last."""
    now = time.time() if now is None else now
    alerts, delivered = {}, set()
    for path in event_logs(events_dir, since_hours):
        run = run_id(path)
        with open(path, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or '"isis_' not in line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue      # a torn last line in a log being written
                if e.get("kind") != "tool_call":
                    continue
                tool = e.get("tool")
                if tool == "isis_alert" and e.get("level") == "critical":
                    msg = str(e.get("msg") or "")
                    if not msg:
                        continue
                    key = page_key(str(e.get("source") or "unknown"), msg)
                    # First sighting wins: later re-emits are the same incident.
                    alerts.setdefault((run, key), {
                        "run": run, "key": key, "source": e.get("source"),
                        "msg": msg, "t": e.get("t"), "ts": _ts(e),
                    })
                elif tool == "isis_page" and e.get("ok") is True:
                    delivered.add((run, str(e.get("key"))))
    for row in _audit_rows(audit_log):
        if row.get("sent"):
            delivered.add((str(row.get("run")), str(row.get("key"))))
    undelivered = [a for k, a in sorted(alerts.items(), key=lambda kv: kv[1]["ts"])
                   if k not in delivered and now - a["ts"] >= SETTLE_SEC]
    return undelivered, {"alerts": len(alerts), "delivered": len(delivered),
                         "undelivered": len(undelivered)}


def _audit_rows(audit_log=AUDIT_LOG):
    try:
        with open(audit_log, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
    except OSError:
        return


def _default_ntfy_call(args, ntfy_bin=NTFY):
    p = subprocess.run([ntfy_bin, *args], capture_output=True, text=True, timeout=45)
    return p.returncode, (p.stdout + p.stderr).strip()[:300]


def send(alert, ntfy_call=None, audit_log=AUDIT_LOG, priority=NTFY_PRIORITY,
         topic=NTFY_TOPIC, ntfy_bin=NTFY):
    """Page one undelivered alert and record what happened. A failed publish is
    recorded with sent=False, which leaves it undelivered for the next run to
    retry — the same contract the in-process pager keeps."""
    ntfy_call = ntfy_call or (lambda args: _default_ntfy_call(args, ntfy_bin))
    text = "[%s] %s (unpaged at the time — replayed from %s)" % (
        alert.get("source"), alert.get("msg"), alert.get("run"))
    rc, detail = ntfy_call(["-p", priority, "-t", topic, "-T", "LPP CRITICAL", text])
    row = {"t": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "run": alert["run"], "key": alert["key"], "alert": alert["msg"],
           "sent": rc == 0, "rc": rc, "detail": detail}
    try:
        os.makedirs(os.path.dirname(audit_log) or ".", exist_ok=True)
        with open(audit_log, "a") as fh:
            fh.write(json.dumps(row) + "\n")
    except OSError as e:
        print("isis-audit: cannot write %s: %s" % (audit_log, e), file=sys.stderr)
    return row


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--events-dir", default=EVENTS_DIR)
    ap.add_argument("--since-hours", type=float, default=24.0)
    ap.add_argument("--send", action="store_true",
                    help="page every undelivered alert through ntfy-send")
    ap.add_argument("--max-send", type=int, default=3,
                    help="stop after N pages in one run (default 3) — a backlog "
                         "is one incident, not N reasons to buzz a phone")
    ap.add_argument("--quiet", action="store_true", help="print only failures")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    # Overrides, so a dry end-to-end run of the real publisher (min priority,
    # an invisible topic, a scratch audit log) needs no environment juggling.
    ap.add_argument("--ntfy-bin", default=NTFY)
    ap.add_argument("--priority", default=NTFY_PRIORITY)
    ap.add_argument("--topic", default=NTFY_TOPIC)
    ap.add_argument("--audit-log", default=AUDIT_LOG)
    a = ap.parse_args(argv)

    undelivered, stats = scan(a.events_dir, a.since_hours, a.audit_log)
    sent_rows = []
    if a.send:
        for alert in undelivered[: max(0, a.max_send)]:
            sent_rows.append(send(alert, audit_log=a.audit_log, priority=a.priority,
                                  topic=a.topic, ntfy_bin=a.ntfy_bin))

    if a.json:
        print(json.dumps({"stats": stats, "undelivered": undelivered, "sent": sent_rows}, indent=1))
    elif undelivered:
        for alert in undelivered:
            print("UNPAGED %s %s [%s] %s" % (alert["t"], alert["run"], alert["source"], alert["msg"]))
        for row in sent_rows:
            print("%s %s" % ("PAGED" if row["sent"] else "PAGE FAILED rc=%s" % row["rc"], row["key"]))
    elif not a.quiet:
        print("isis-audit: %(alerts)d critical alert(s) in window, %(delivered)d delivered, none unpaged" % stats)

    # --send that delivered everything it found is a clean exit: the hole is
    # closed. Anything still unpaged is a red audit.
    return 1 if len(undelivered) > len([r for r in sent_rows if r["sent"]]) else 0


if __name__ == "__main__":
    sys.exit(main())
