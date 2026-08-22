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


def resolve_advanced(escal, state, wq_call, now_ms):
    """Auto-resolve: any tracked incident whose baseline the CURRENT state has
    since exceeded gets its ticket closed and is dropped from tracked state."""
    closed = []
    for key, inc in list(escal["incidents"].items()):
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
        closed.append({"locationKey": key, "ticketId": inc.get("ticketId"), "evidence": evidence})
        del escal["incidents"][key]
    return closed


def maybe_file_or_append(escal, mode, location_key, location, state, intervention_log, wq_call, now_ms):
    inc = escal["incidents"].get(location_key)
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
        }
        return {"action": action, "ticketId": ticket_id}

    # Already tracked: a later exhaustion for the SAME incident appends again
    # (dedup — never a second ticket) but only if we haven't just appended
    # for this exact exhaustion (guarded by the caller only invoking this on
    # a fresh `exhausted` decision, not every idle poll).
    old_detail = get_detail(inc["ticketId"], wq_call) if inc.get("ticketId") is not None else ""
    if inc.get("ticketId") is not None:
        wq_call(["edit", str(inc["ticketId"]), "--detail",
                 f"{old_detail} || REPEAT {_iso(now_ms)}: {report}"])
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
