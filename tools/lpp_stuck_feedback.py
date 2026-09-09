#!/usr/bin/env python3
"""lpp_stuck_feedback — auto-ticket + single 3h Frank escalation (wq#673).

WHY THIS EXISTS
  wq#671 detects WHAT KIND of stuck; wq#672 prescribes and bounds (K=3) WHAT
  TO TRY. This module closes the loop: once K attempts are exhausted for one
  (mode, location) incident, file exactly ONE work-queue ticket (dedup on
  mode+location — a repeat exhaustion APPENDS to the existing open ticket,
  never opens a second one for the same incident), and send exactly ONE
  ntfy page to Frank at the 3h mark of that incident — never hourly, never
  again after the first page for the same incident. The incident
  auto-resolves (ticket closed, escalation state cleared) the moment
  story_score/badges/event-flags actually advance PAST the incident — never
  while the classifier still names that same key as the live stall (wq#1162) —
  with the advance itself recorded as evidence on the ticket.

  Anti-footgun (spec section 4, echoed verbatim in the ticket): "Supervisor
  NEVER autospawns fix-workers: file ONE ticket + page Frank; orch/Frank
  decide." This module's only side effects are `wq add`/`wq edit`/`wq done`
  and one `ntfy-send` call. It never claims a ticket, never starts an agent,
  never touches the game or the service.

STATE
  runtime/stuck_escalation.json — one record per currently-open incident,
  keyed by the same (mode, location) key wq#671/#672 already use:
    {"incidents": {"FIGHT_LOSS_LOOP@65": {
        "ticketId": 676, "firstStalledAt": <ms>, "ntfySentAt": <ms|null>,
        "lastAppendAt": <ms>, "baselineStoryScore": 10, "baselineBadges": 1,
        "baselineEventFlags": 37}}}
  `firstStalledAt` is taken from wq#671's own `lastAdvanceAt` (the instant
  the CURRENT stall period actually began) the first time this key is seen
  exhausted, not from "when this script first noticed" — so a supervisor
  that starts late, or that was down for a while, still computes the correct
  3h mark instead of restarting the clock at its own boot.

TICKET DEDUP AND APPEND
  Title carries a stable, greppable marker: "[lpp][stuck] MODE@LOCATION —
  ...". Before adding, `wq list --lane pokemon --status open` is scanned for
  that exact marker; a hit means APPEND (fetch the existing detail via
  `wq show`, concatenate a new dated block, `wq edit --detail`) instead of
  filing a duplicate. This is read via the `wq` CLI, not the sqlite file
  directly, to stay inside the tool's own concurrency/locking contract.

  An exhausted key stays exhausted, so every later poll reaches the append
  path. wq#1162 gates it on report_signature(): the append lands only when the
  report differs from the last one on something other than the frozen-hours
  count, so a standing stall adds a block when its facts change and nothing
  while it merely gets older.

NTFY ESCALATION
  Exactly once per incident, the FIRST time `now - firstStalledAt >= 3h`
  AND a ticket exists for the incident. `-p high` (this codebase's sentinel
  never passes a priority override — this is the first caller that does,
  per the spec's explicit "priority=high ONCE at 3h, not hourly").

AUTO-RESOLVE
  On every run, before deciding anything new: for each tracked incident, if
  the CURRENT state shows storyScore/badges/eventFlags above the incident's
  own baseline, the ticket is marked `wq done` with the advance as evidence
  and the incident is dropped from tracked state. This runs even if the
  current MODE is no longer stalled at all, or stalled under a different
  mode/location — either way, the specific incident that was tracked is over.

ALERT QUEUE (wq#1562)
  The wq ticket above is filed once and then only touched again when the
  report signature changes (wq#1162) — exactly the behavior that let
  FIGHT_LOSS_LOOP@3 tick-loop 167.9h silently once Frank (or anyone) closed
  wq#1162 out from under it: nothing re-opens a closed ticket, so an
  incident that is still exhausted goes dark except for the one 3h ntfy.
  `aq` (/home/lumen/bin/aq) is a separate, persistent triage queue Frank
  actually works from, and its own `add` is an upsert keyed on (source,key)
  — a repeat `aq add lpp stuck:<mode>@<loc> ...` while the row is still
  `open` just bumps count/last_ts/message, it never inserts a duplicate. So
  every tick where decide() says exhausted calls `aq add lpp
  stuck:<mode>@<loc>` unconditionally (no report_signature gate needed —
  aq's dedup already IS the refresh-not-duplicate contract), and
  resolve_advanced() calls `aq resolve <id>` alongside `wq done` once the
  incident's counters actually move past baseline.

READ+WRITE. Reads runtime/stuck_mode.json state (recomputed live),
runtime/intervention_log.json (wq#672, for cost/attempts detail on the
ticket), calls the `wq`, `aq`, and `ntfy-send` CLIs. Writes only
runtime/stuck_escalation.json.
"""
import json, os, re, subprocess, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lpp_stuck_mode as M
import lpp_stuck_intervene as I

BASE = os.environ.get("LPP_BASE", "/home/lumen/pokemon")
STATE_PATH = f"{BASE}/runtime/stuck_escalation.json"
WQ = os.environ.get("LPP_WQ_BIN", "/home/lumen/bin/wq")
AQ = os.environ.get("LPP_AQ_BIN", "/home/lumen/bin/aq")
NTFY = os.environ.get("LPP_NTFY_BIN", "/home/lumen/bin/ntfy-send")
NTFY_TOPIC = "lumen-fleet"
ESCALATE_AFTER_H = 3.0
MARKER_RE = re.compile(r"\[lpp\]\[stuck\]\s+(\S+)\s+—")
AQ_ID_RE = re.compile(r"queued id=(\d+)")


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_ms():
    return datetime.now(timezone.utc).timestamp() * 1000


def _parse_iso_ms(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000


def load_state(path=STATE_PATH):
    try:
        j = json.load(open(path))
        if isinstance(j, dict) and isinstance(j.get("incidents"), dict):
            return j
    except Exception:
        pass
    return {"v": 1, "incidents": {}}


def save_state(st, path=STATE_PATH):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, path)


def _default_wq_call(args):
    p = subprocess.run([WQ, *args], capture_output=True, text=True, timeout=30)
    return p.stdout + p.stderr


def _default_ntfy_call(args):
    p = subprocess.run([NTFY, *args], capture_output=True, text=True, timeout=20)
    return p.returncode


def _default_aq_call(args):
    p = subprocess.run([AQ, *args], capture_output=True, text=True, timeout=20)
    return p.stdout + p.stderr


def find_open_ticket(location_key, wq_call):
    """Returns an existing OPEN ticket id carrying this key's marker, or None."""
    out = wq_call(["list", "--lane", "pokemon", "--status", "open"])
    for line in out.splitlines():
        m = re.search(r"^\[\s*(\d+)\]", line)
        if not m:
            continue
        marker = MARKER_RE.search(line)
        if marker and marker.group(1) == location_key:
            return int(m.group(1))
    return None


def get_detail(ticket_id, wq_call):
    out = wq_call(["show", str(ticket_id)])
    for line in out.splitlines():
        if line.startswith("detail"):
            return line.split(":", 1)[1].strip()
    return ""


def build_report(mode, location_key, location, state, intervention_log, now_ms):
    attempts = [e for e in intervention_log.get("attempts", []) if e.get("locationKey") == location_key]
    frozen = state.get("frozenHours", 0.0)
    outcomes = "; ".join(
        f"attempt {a['attempt']}: {a['directive']['action']} "
        f"({'advanced' if a.get('outcome') == 'advanced' else a.get('outcome') or 'no result yet'})"
        for a in attempts
    ) or "(no logged attempts)"
    prescription = I.PRESCRIPTIONS.get(mode)
    proposed = prescription["summary"] if prescription else "(no automated prescription for this mode)"
    return (
        f"mode={mode} location={location} frozen_axis=story_score "
        f"(storyScore={state.get('storyScore')}, badges={state.get('badges')}, "
        f"eventFlags={state.get('eventFlags')}) frozen={frozen:.1f}h since {state.get('lastAdvanceAt')}. "
        f"interventions+outcomes: {outcomes}. "
        f"proposed-resolution: {proposed}"
    )


FROZEN_RE = re.compile(r"frozen=[\d.]+h ")


def report_signature(report):
    """The report with the one field that changes on EVERY tick stripped out.

    wq#1162: maybe_file_or_append used to claim it appended "only if we haven't
    just appended for this exact exhaustion", crediting the guard to a caller
    that "only invokes this on a fresh `exhausted` decision". No such caller
    exists — `run()` calls it on every poll where decide() says exhausted, and
    once K is spent decide() says exhausted forever. FIGHT_LOSS_LOOP@3 collected
    seven REPEAT blocks in 2.6h whose only difference was `frozen=2.4h` counting
    up to `frozen=5.0h`; the detail grows without bound and the reader has to
    diff paragraphs to find out that nothing changed.

    So compare on content instead of on cadence. Everything a later poll could
    genuinely add — a new attempt, a changed outcome, moved counters, a
    `since <lastAdvanceAt>` that jumped because the freeze clock restarted —
    survives into the signature and still earns its append. Only the wall-clock
    duration is masked, because it is a restatement of `since` plus now.
    """
    return FROZEN_RE.sub("frozen=<h> ", report)


def resolve_advanced(escal, state, wq_call, now_ms, aq_call=None):
    """Auto-resolve: any tracked incident whose baseline the CURRENT state has
    since exceeded gets its ticket closed and is dropped from tracked state.

    wq#1162: except the incident that is stalled RIGHT NOW. The baseline test
    below is the same three-counter comparison wq#672's resolve_pending used to
    misread, and it fails the same way — a partial tick (eventFlags 45->48 with
    story_score frozen) clears the baseline while the agent is still losing the
    same fight in the same room. Closing the ticket there would retract the
    escalation on a stall the classifier is reporting live in this very call,
    and the next tick would file it again from scratch. An incident the
    classifier still names is not resolved, whatever the counters read.
    """
    live_key = (f"{state.get('mode')}@{state.get('modeLocation')}"
                if state.get("stalled") else None)
    closed = []
    for key, inc in list(escal["incidents"].items()):
        if key == live_key:
            continue
        advanced = (
            (state.get("storyScore") or 0) > (inc.get("baselineStoryScore") or 0)
            or (state.get("badges") or 0) > (inc.get("baselineBadges") or 0)
            or (state.get("eventFlags") or 0) > (inc.get("baselineEventFlags") or 0)
        )
        if not advanced:
            continue
        evidence = (
            f"AUTO-RESOLVED {_iso(now_ms)}: story advanced "
            f"storyScore {inc.get('baselineStoryScore')}->{state.get('storyScore')}, "
            f"badges {inc.get('baselineBadges')}->{state.get('badges')}, "
            f"eventFlags {inc.get('baselineEventFlags')}->{state.get('eventFlags')}"
        )
        if inc.get("ticketId") is not None:
            wq_call(["done", str(inc["ticketId"]), "--notes", evidence])
        if inc.get("aqId") is not None and aq_call is not None:
            aq_call(["resolve", str(inc["aqId"]), evidence])
        closed.append({"locationKey": key, "ticketId": inc.get("ticketId"), "aqId": inc.get("aqId"), "evidence": evidence})
        del escal["incidents"][key]
    return closed


def maybe_file_or_append(escal, mode, location_key, location, state, intervention_log, wq_call, now_ms, report=None):
    inc = escal["incidents"].get(location_key)
    if report is None:
        report = build_report(mode, location_key, location, state, intervention_log, now_ms)

    if inc is None:
        existing_id = find_open_ticket(location_key, wq_call)
        first_stalled_ms = _parse_iso_ms(state["lastAdvanceAt"])
        if existing_id is not None:
            old_detail = get_detail(existing_id, wq_call)
            wq_call(["edit", str(existing_id), "--detail",
                     f"{old_detail} || REPEAT {_iso(now_ms)}: {report}"])
            ticket_id, action = existing_id, "appended"
        else:
            # Title is deterministic per location_key (mode+location only, no
            # timestamp), so `wq add`'s OWN exact-title duplicate guard
            # (cmd_add: refuses + prints "DUPLICATE -- task <id> ...") is a
            # second, race-safe backstop behind find_open_ticket() above —
            # if another supervisor tick beat this one to filing, we land in
            # the DUPLICATE branch instead of creating a second ticket.
            title = f"[lpp][stuck] {location_key} — {mode} unresolved after K interventions"
            out = wq_call(["add", "--lane", "pokemon", "--pri", "1", "--title", title,
                           "--detail", report])
            added = re.search(r"added task (\d+)", out)
            dup = re.search(r"DUPLICATE\s*(?:—|--)\s*task (\d+)", out)
            if added:
                ticket_id, action = int(added.group(1)), "filed"
            elif dup:
                ticket_id, action = int(dup.group(1)), "appended"
                old_detail = get_detail(ticket_id, wq_call)
                wq_call(["edit", str(ticket_id), "--detail",
                         f"{old_detail} || REPEAT {_iso(now_ms)}: {report}"])
            else:
                ticket_id, action = None, "filed"
        escal["incidents"][location_key] = {
            "ticketId": ticket_id, "firstStalledAt": first_stalled_ms, "ntfySentAt": None,
            "lastAppendAt": now_ms, "baselineStoryScore": state.get("storyScore"),
            "baselineBadges": state.get("badges"), "baselineEventFlags": state.get("eventFlags"),
            "reportSig": report_signature(report),
        }
        return {"action": action, "ticketId": ticket_id}

    # Already tracked: a later exhaustion for the SAME incident appends again
    # (dedup — never a second ticket), but only when the report actually says
    # something the ticket does not already carry (wq#1162). An incident
    # tracked before this guard shipped has no stored signature, so it earns
    # exactly one more append and then goes quiet.
    sig = report_signature(report)
    if inc.get("reportSig") == sig:
        return {"action": "unchanged", "ticketId": inc.get("ticketId")}
    old_detail = get_detail(inc["ticketId"], wq_call) if inc.get("ticketId") is not None else ""
    if inc.get("ticketId") is not None:
        wq_call(["edit", str(inc["ticketId"]), "--detail",
                 f"{old_detail} || REPEAT {_iso(now_ms)}: {report}"])
    inc["reportSig"] = sig
    inc["lastAppendAt"] = now_ms
    return {"action": "appended", "ticketId": inc.get("ticketId")}


def maybe_escalate_ntfy(escal, location_key, state, ntfy_call, now_ms):
    inc = escal["incidents"].get(location_key)
    if inc is None or inc.get("ntfySentAt") is not None:
        return None
    age_h = (now_ms - inc["firstStalledAt"]) / 3.6e6
    if age_h < ESCALATE_AFTER_H:
        return None
    msg = (f"LPP stuck {ESCALATE_AFTER_H:.0f}h+: {location_key} — wq#{inc['ticketId']} — "
           f"storyScore={state.get('storyScore')} badges={state.get('badges')} "
           f"frozen={state.get('frozenHours', 0):.1f}h")
    rc = ntfy_call(["-t", NTFY_TOPIC, "-p", "high", "-T", f"LPP stuck: {location_key}", msg])
    inc["ntfySentAt"] = now_ms
    return {"sent": rc == 0, "returncode": rc, "message": msg}


def maybe_alert_aq(escal, mode, location_key, state, aq_call, now_ms, report):
    """Open/refresh the aq row for this incident. Called every tick decide()
    says exhausted — safe because aq's own `add` is an upsert on
    (source,key): while the row is still `open`, a repeat call bumps
    count/last_ts/message instead of inserting a duplicate (see aq's own
    ingest()). No report_signature gate here on purpose — unlike the wq
    ticket, this row is meant to visibly age (count, last_ts) as long as the
    incident stays exhausted, so Frank's triage view shows it is still live
    rather than going quiet the way the wq-only path did (wq#1562).
    """
    key = f"stuck:{location_key}"
    title = f"[lpp][stuck] {location_key} — {mode} unresolved after K interventions"
    out = aq_call(["add", "lpp", key, title, report])
    m = AQ_ID_RE.search(out)
    inc = escal["incidents"].get(location_key)
    aq_id = int(m.group(1)) if m else (inc.get("aqId") if inc else None)
    if inc is not None:
        inc["aqId"] = aq_id
    return {"aqId": aq_id, "key": key}


def run(state=None, intervention_log=None, escal=None, wq_call=None, ntfy_call=None, aq_call=None, now_ms=None):
    state = state if state is not None else M.compute()
    if not state.get("ok"):
        return {"ok": False, "reason": state.get("reason")}
    intervention_log = intervention_log if intervention_log is not None else I.load_log()
    escal = escal if escal is not None else load_state()
    wq_call = wq_call or _default_wq_call
    ntfy_call = ntfy_call or _default_ntfy_call
    aq_call = aq_call or _default_aq_call
    now_ms = now_ms if now_ms is not None else _now_ms()

    result = {"ok": True, "resolved": [], "filed": None, "ntfy": None, "aq": None}
    result["resolved"] = resolve_advanced(escal, state, wq_call, now_ms, aq_call=aq_call)

    if state.get("stalled"):
        mode = state["mode"]
        location = state.get("modeLocation")
        location_key = f"{mode}@{location}"
        decision = I.decide(state=state, log=intervention_log)
        if decision.get("exhausted"):
            report = build_report(mode, location_key, location, state, intervention_log, now_ms)
            result["filed"] = maybe_file_or_append(
                escal, mode, location_key, location, state, intervention_log, wq_call, now_ms, report=report)
            result["aq"] = maybe_alert_aq(escal, mode, location_key, state, aq_call, now_ms, report)
        if location_key in escal["incidents"]:
            result["ntfy"] = maybe_escalate_ntfy(escal, location_key, state, ntfy_call, now_ms)

    return result, escal


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--json", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    escal = load_state()
    result, escal = run(escal=escal)
    if not args.dry_run:
        save_state(escal)

    if args.json:
        print(json.dumps(result, indent=1))
    else:
        filed = result.get("filed")
        # "unchanged" is the standing-stall steady state (wq#1162): the ticket
        # already says everything this poll would have said, so it is not an
        # action and must not print like one.
        acted = filed is not None and filed["action"] != "unchanged"
        if result.get("resolved"):
            for r in result["resolved"]:
                print(f"RESOLVED {r['locationKey']} (wq#{r['ticketId']})")
        if acted:
            print(f"TICKET {filed['action']} wq#{filed['ticketId']}")
        if result.get("aq"):
            print(f"AQ queued id={result['aq']['aqId']} key={result['aq']['key']}")
        if result.get("ntfy"):
            print(f"NTFY sent={result['ntfy']['sent']}: {result['ntfy']['message']}")
        if not (result.get("resolved") or acted or result.get("aq") or result.get("ntfy")):
            print("no escalation action")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
