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
  story_score/badges/event-flags actually advance, with the advance itself
  recorded as evidence on the ticket.

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

READ+WRITE. Reads runtime/stuck_mode.json state (recomputed live),
runtime/intervention_log.json (wq#672, for cost/attempts detail on the
ticket), calls the `wq` and `ntfy-send` CLIs. Writes only
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
NTFY = os.environ.get("LPP_NTFY_BIN", "/home/lumen/bin/ntfy-send")
NTFY_TOPIC = "lumen-fleet"
ESCALATE_AFTER_H = 3.0
# wq#1097: minimum gap between two REPEAT appends that say the same thing.
# The dedup rule below already forbids a second ticket per incident, but
# nothing bounded how often the SAME report was appended to it: `run()` calls
# maybe_file_or_append on every tick where the decision is `exhausted`, and
# exhausted is a steady state, not an edge. FIGHT_LOSS_LOOP@3 collected 47
# byte-identical REPEAT blocks over 25h at one per supervisor tick, each
# costing a `wq show` + `wq edit` and burying the original report. A changed
# report still appends immediately; only an unchanged one waits.
APPEND_COOLDOWN_H = 6.0
MARKER_RE = re.compile(r"\[lpp\]\[stuck\]\s+(\S+)\s+—")


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


def _attempt_outcomes(location_key, intervention_log):
    attempts = [e for e in intervention_log.get("attempts", []) if e.get("locationKey") == location_key]
    return "; ".join(
        f"attempt {a['attempt']}: {a['directive']['action']} "
        f"({'advanced' if a.get('outcome') == 'advanced' else a.get('outcome') or 'no result yet'})"
        for a in attempts
    ) or "(no logged attempts)"


def report_signature(mode, location_key, state, intervention_log):
    """The substance of a report, minus its clock. Two reports with the same
    signature tell a reader nothing new; wq#1097 uses that to stop appending
    the identical block to the same ticket every supervisor tick."""
    return "|".join(str(x) for x in (
        mode, location_key, state.get("storyScore"), state.get("badges"),
        state.get("eventFlags"), state.get("map"),
        ",".join(state.get("frozenAxes") or []),
        _attempt_outcomes(location_key, intervention_log),
    ))


def build_report(mode, location_key, location, state, intervention_log, now_ms):
    frozen = state.get("frozenHours", 0.0)
    # wq#1097: `frozen_axis=story_score` used to be a hardcoded string printed
    # next to an any-axis clock, so the ticket could claim the story axis was
    # frozen for 2.9h when what had actually moved 2.9h ago was one event flag
    # and the story axis had been frozen for 42h. Both numbers are now real and
    # both are named.
    # "unknown" rather than "none" when the key is absent entirely: a state
    # dict written by a pre-wq#1097 detector has no frozenAxes, and printing
    # "none" would assert nothing is frozen on a report filed because
    # something is.
    axes = state.get("frozenAxes")
    frozen_axes = "unknown" if axes is None else ("+".join(axes) or "none")
    story_frozen = state.get("storyFrozenHours", frozen)
    story_since = state.get("storyStalledSince") or state.get("lastAdvanceAt")
    prescription = I.PRESCRIPTIONS.get(mode)
    proposed = prescription["summary"] if prescription else "(no automated prescription for this mode)"
    return (
        f"mode={mode} location={location} frozen_axes={frozen_axes} "
        f"(storyScore={state.get('storyScore')}, badges={state.get('badges')}, "
        f"eventFlags={state.get('eventFlags')}) "
        f"story frozen={story_frozen:.1f}h since {story_since}; "
        f"any-axis frozen={frozen:.1f}h since {state.get('lastAdvanceAt')}. "
        f"interventions+outcomes: {_attempt_outcomes(location_key, intervention_log)}. "
        f"proposed-resolution: {proposed}"
    )


def resolve_advanced(escal, state, wq_call, now_ms):
    """Auto-resolve: any tracked incident whose baseline the CURRENT state has
    since exceeded gets its ticket closed and is dropped from tracked state."""
    closed = []
    for key, inc in list(escal["incidents"].items()):
        # wq#1097: story axis only. Closing a stuck ticket because one event
        # flag ticked marks an unresolved incident `done` while the agent is
        # still standing in front of the same gym — and then re-files or
        # re-appends the moment the 2h window lapses again, which is the churn
        # this ticket is made of.
        advanced = (
            (state.get("storyScore") or 0) > (inc.get("baselineStoryScore") or 0)
            or (state.get("badges") or 0) > (inc.get("baselineBadges") or 0)
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
        closed.append({"locationKey": key, "ticketId": inc.get("ticketId"), "evidence": evidence})
        del escal["incidents"][key]
    return closed


def maybe_file_or_append(escal, mode, location_key, location, state, intervention_log, wq_call, now_ms):
    inc = escal["incidents"].get(location_key)
    report = build_report(mode, location_key, location, state, intervention_log, now_ms)
    sig = report_signature(mode, location_key, state, intervention_log)

    if inc is None:
        existing_id = find_open_ticket(location_key, wq_call)
        # wq#1097: the incident began when its OWN axis froze. Taking the
        # any-axis lastAdvanceAt let an event-flag tick reset the 3h clock, so
        # Frank's one page could be deferred indefinitely on a stall that had
        # in fact been running for days.
        first_stalled_ms = _parse_iso_ms(state.get("storyStalledSince") or state["lastAdvanceAt"])
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
            "lastAppendAt": now_ms, "lastReportSig": sig,
            "baselineStoryScore": state.get("storyScore"),
            "baselineBadges": state.get("badges"), "baselineEventFlags": state.get("eventFlags"),
        }
        return {"action": action, "ticketId": ticket_id}

    # Already tracked: a later exhaustion for the SAME incident appends again
    # (dedup — never a second ticket). wq#1097: and only if it has something
    # new to say. The comment that used to sit here claimed the caller invoked
    # this "on a fresh `exhausted` decision, not every idle poll" — no such
    # guard existed, and `exhausted` is a level, not an edge, so every tick
    # appended. Either a changed report or APPEND_COOLDOWN_H of silence earns
    # the next block; anything else is suppressed.
    since_h = (now_ms - (inc.get("lastAppendAt") or 0)) / 3.6e6
    if sig == inc.get("lastReportSig") and since_h < APPEND_COOLDOWN_H:
        return {"action": "suppressed", "ticketId": inc.get("ticketId"),
                "reason": f"report unchanged and last append was {since_h:.1f}h ago "
                          f"(< {APPEND_COOLDOWN_H:.0f}h cooldown)"}

    old_detail = get_detail(inc["ticketId"], wq_call) if inc.get("ticketId") is not None else ""
    if inc.get("ticketId") is not None:
        wq_call(["edit", str(inc["ticketId"]), "--detail",
                 f"{old_detail} || REPEAT {_iso(now_ms)}: {report}"])
    inc["lastAppendAt"] = now_ms
    inc["lastReportSig"] = sig
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


def run(state=None, intervention_log=None, escal=None, wq_call=None, ntfy_call=None, now_ms=None):
    state = state if state is not None else M.compute()
    if not state.get("ok"):
        return {"ok": False, "reason": state.get("reason")}
    intervention_log = intervention_log if intervention_log is not None else I.load_log()
    escal = escal if escal is not None else load_state()
    wq_call = wq_call or _default_wq_call
    ntfy_call = ntfy_call or _default_ntfy_call
    now_ms = now_ms if now_ms is not None else _now_ms()

    result = {"ok": True, "resolved": [], "filed": None, "ntfy": None}
    result["resolved"] = resolve_advanced(escal, state, wq_call, now_ms)

    if state.get("stalled"):
        mode = state["mode"]
        location = state.get("modeLocation")
        location_key = f"{mode}@{location}"
        decision = I.decide(state=state, log=intervention_log)
        if decision.get("exhausted"):
            result["filed"] = maybe_file_or_append(
                escal, mode, location_key, location, state, intervention_log, wq_call, now_ms)
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
        if result.get("resolved"):
            for r in result["resolved"]:
                print(f"RESOLVED {r['locationKey']} (wq#{r['ticketId']})")
        if result.get("filed"):
            print(f"TICKET {result['filed']['action']} wq#{result['filed']['ticketId']}")
        if result.get("ntfy"):
            print(f"NTFY sent={result['ntfy']['sent']}: {result['ntfy']['message']}")
        if not (result.get("resolved") or result.get("filed") or result.get("ntfy")):
            print("no escalation action")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
