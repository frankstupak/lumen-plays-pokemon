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
  ...". Before adding, `wq list --lane pokemon --status <s>` is scanned for
  that exact marker across every LIVE status; a hit means APPEND (fetch the
  existing detail via `wq show`, concatenate a new dated block, `wq edit
  --detail`) instead of filing a duplicate. This is read via the `wq` CLI,
  not the sqlite file directly, to stay inside the tool's own
  concurrency/locking contract.

  wq#1097: "live" means every non-terminal status, not just `open`. The
  original scan asked for `--status open` alone, so the moment a worker
  CLAIMED the incident's ticket it became invisible to the dedup and the next
  30-minute tick filed a second one. That is exactly how FIGHT_LOSS_LOOP@3
  produced wq#1091 and then wq#1097 — byte-identical titles, same live
  incident, the second one filed after the first was closed, with no pointer
  back to the work already done. A key whose only prior tickets are TERMINAL
  (done/rejected) may legitimately file a fresh ticket — the incident really
  did recur after someone closed it — but the new ticket now opens with a
  `prior-tickets:` line naming them, so the next worker starts from the last
  attempt instead of cold.

REPEAT SUPPRESSION AND DETAIL BOUND
  wq#1097: a tracked incident used to append a full REPEAT block on EVERY
  exhausted tick. At the supervisor's 30-minute period that is 48 blocks a
  day, each one differing from the last only in its timestamp and its
  `frozen=NN.Nh` counter, which advances by construction. wq#1097's own
  detail reached 26,925 characters (~48 near-identical blocks) and wq#676's
  12,732 the same way — a cost paid in full by every worker that reads the
  ticket. Two bounds now apply:

    * An append happens only when the report's MATERIAL content changed
      (mode, location, storyScore, badges, eventFlags, the freeze window's
      start, and the per-attempt outcomes — see report_signature; frozen
      HOURS are deliberately excluded, being the one field guaranteed to
      differ every tick), or when REPEAT_MIN_INTERVAL_H has elapsed since
      the last one, whichever comes first. Suppressed polls are counted and
      the count is folded into the next block that does land, so the ticket
      still says how long it sat unchanged.
    * Whatever the append rate, the stored detail is capped at
      MAX_DETAIL_CHARS by eliding the middle: the ORIGINAL block (the
      incident's first observation) and the newest KEEP_TAIL_BLOCKS survive,
      everything between collapses to a one-line count.

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

# wq#1097: statuses a ticket can hold while it is still somebody's problem.
# A hit in ANY of these is the incident's existing ticket — append to it.
LIVE_STATUSES = ("open", "claimed", "blocked", "frank_gated")
# Terminal statuses: a hit here does not block a fresh filing, but is carried
# into the new ticket's detail as prior context.
PRIOR_STATUSES = ("done", "rejected")

REPEAT_SEP = " || REPEAT "
REPEAT_MIN_INTERVAL_H = 6.0   # heartbeat floor when nothing material changed
MAX_DETAIL_CHARS = 4000       # stored-detail cap; middle blocks elide past it
KEEP_TAIL_BLOCKS = 3          # newest REPEAT blocks always kept when eliding
ELIDED_RE = re.compile(r" \|\| \[(\d+) earlier REPEAT block\(s\) elided[^\]]*\]")


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


def _ids_with_marker(location_key, wq_call, status):
    """Ticket ids in one status whose title carries this key's stuck marker.
    The marker sits in the title's first ~30 characters, so it survives the
    `wq list` column truncation the real CLI applies."""
    out = wq_call(["list", "--lane", "pokemon", "--status", status])
    found = []
    for line in out.splitlines():
        m = re.search(r"^\[\s*(\d+)\]", line)
        if not m:
            continue
        marker = MARKER_RE.search(line)
        if marker and marker.group(1) == location_key:
            found.append(int(m.group(1)))
    return found


def find_live_ticket(location_key, wq_call, statuses=LIVE_STATUSES):
    """Returns an id for this key's still-unfinished ticket, or None.

    wq#1097: scans every LIVE status, not `open` alone. A ticket a worker has
    CLAIMED is still that incident's ticket; treating it as absent is what let
    a second one get filed 30 minutes later."""
    for status in statuses:
        ids = _ids_with_marker(location_key, wq_call, status)
        if ids:
            return min(ids)   # oldest wins: that is the one carrying history
    return None


def find_prior_tickets(location_key, wq_call, statuses=PRIOR_STATUSES):
    """Ids of this key's already-CLOSED tickets, oldest first. Not a dedup
    bar — a recurrence after a close deserves its own ticket — but the new
    ticket must name them so the next worker inherits the prior diagnosis."""
    prior = []
    for status in statuses:
        prior.extend(_ids_with_marker(location_key, wq_call, status))
    return sorted(set(prior))


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


def report_signature(mode, location_key, state, intervention_log):
    """The report's MATERIAL content, as a comparable string (wq#1097).

    Everything build_report() prints EXCEPT `frozen=NN.Nh`, which advances on
    every tick by definition and so can never signal that anything changed.
    The freeze window's START (`lastAdvanceAt`) is kept: a new window means a
    genuinely different situation and deserves its own block."""
    attempts = [e for e in intervention_log.get("attempts", []) if e.get("locationKey") == location_key]
    return "|".join([
        str(mode), str(location_key), str(state.get("storyScore")), str(state.get("badges")),
        str(state.get("eventFlags")), str(state.get("lastAdvanceAt")),
        ",".join(f"{a.get('attempt')}:{a.get('outcome') or 'open'}" for a in attempts),
    ])


def elide_detail(detail, max_chars=MAX_DETAIL_CHARS, keep_tail=KEEP_TAIL_BLOCKS):
    """Cap a stuck ticket's stored detail (wq#1097). Keeps the head block —
    the incident's first observation, the only one carrying its origin — plus
    the newest `keep_tail` REPEAT blocks; the middle collapses to a count.
    Returns `detail` untouched when it is already inside the cap or has too
    few blocks to elide."""
    if len(detail) <= max_chars:
        return detail
    head, sep, rest = detail.partition(REPEAT_SEP)
    if not sep:
        return detail
    blocks = rest.split(REPEAT_SEP)
    dropped = len(blocks) - keep_tail
    if dropped <= 0:
        return detail
    # A previous elision left its note inside the head block. Absorb its count
    # and rewrite the note rather than appending a second one — stacking notes
    # is itself unbounded growth, just slower than the blocks it replaced.
    prior = ELIDED_RE.search(head)
    total = dropped + (int(prior.group(1)) if prior else 0)
    head = ELIDED_RE.sub("", head)
    return (f"{head} || [{total} earlier REPEAT block(s) elided — each one restated the same "
            f"unchanged stall; the first observation above and the newest {keep_tail} below are kept]"
            f"{REPEAT_SEP}{REPEAT_SEP.join(blocks[-keep_tail:])}")


def append_repeat(ticket_id, report, wq_call, now_ms):
    """Concatenate one dated REPEAT block onto a ticket, re-eliding the result
    so the stored detail stays under MAX_DETAIL_CHARS however long the
    incident runs."""
    old_detail = get_detail(ticket_id, wq_call)
    wq_call(["edit", str(ticket_id), "--detail",
             elide_detail(f"{old_detail}{REPEAT_SEP}{_iso(now_ms)}: {report}")])


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
    sig = report_signature(mode, location_key, state, intervention_log)

    if inc is None:
        existing_id = find_live_ticket(location_key, wq_call)
        first_stalled_ms = _parse_iso_ms(state["lastAdvanceAt"])
        if existing_id is not None:
            append_repeat(existing_id, report, wq_call, now_ms)
            ticket_id, action = existing_id, "appended"
        else:
            # Title is deterministic per location_key (mode+location only, no
            # timestamp), so `wq add`'s OWN exact-title duplicate guard
            # (cmd_add: refuses + prints "DUPLICATE -- task <id> ...") is a
            # second, race-safe backstop behind find_live_ticket() above —
            # if another supervisor tick beat this one to filing, we land in
            # the DUPLICATE branch instead of creating a second ticket. That
            # guard skips DONE tickets, which is why the prior-tickets line
            # below (not the guard) is what carries a recurrence's history.
            title = f"[lpp][stuck] {location_key} — {mode} unresolved after K interventions"
            detail = report
            prior = find_prior_tickets(location_key, wq_call)
            if prior:
                detail = (f"prior-tickets: {', '.join('wq#%d' % t for t in prior)} — already closed for "
                          f"this exact incident key; it recurred anyway. Read them (and any PR they "
                          f"landed) before re-diagnosing from scratch. " + report)
            out = wq_call(["add", "--lane", "pokemon", "--pri", "1", "--title", title,
                           "--detail", detail])
            added = re.search(r"added task (\d+)", out)
            dup = re.search(r"DUPLICATE\s*(?:—|--)\s*task (\d+)", out)
            if added:
                ticket_id, action = int(added.group(1)), "filed"
            elif dup:
                ticket_id, action = int(dup.group(1)), "appended"
                append_repeat(ticket_id, report, wq_call, now_ms)
            else:
                ticket_id, action = None, "filed"
        escal["incidents"][location_key] = {
            "ticketId": ticket_id, "firstStalledAt": first_stalled_ms, "ntfySentAt": None,
            "lastAppendAt": now_ms, "baselineStoryScore": state.get("storyScore"),
            "baselineBadges": state.get("badges"), "baselineEventFlags": state.get("eventFlags"),
            "lastReportSig": sig, "suppressedRepeats": 0, "lastSeenAt": now_ms,
        }
        return {"action": action, "ticketId": ticket_id}

    # Already tracked: a later exhaustion for the SAME incident appends to the
    # same ticket — never a second one. wq#1097: it appends only when the
    # report says something new, or once every REPEAT_MIN_INTERVAL_H as a
    # heartbeat. The supervisor ticks every 30 minutes and an unresolved stall
    # reports `exhausted` on every one of them, so an unconditional append here
    # is what grew this module's own tickets past 26k characters.
    changed = sig != inc.get("lastReportSig")
    since_h = (now_ms - (inc.get("lastAppendAt") or 0)) / 3.6e6
    if not changed and since_h < REPEAT_MIN_INTERVAL_H:
        inc["suppressedRepeats"] = inc.get("suppressedRepeats", 0) + 1
        inc["lastSeenAt"] = now_ms
        return {"action": "unchanged", "ticketId": inc.get("ticketId"),
                "suppressedRepeats": inc["suppressedRepeats"]}

    suppressed = inc.get("suppressedRepeats", 0)
    if suppressed:
        report += f" (+{suppressed} identical poll(s) suppressed since the previous block)"
    if inc.get("ticketId") is not None:
        append_repeat(inc["ticketId"], report, wq_call, now_ms)
    inc["lastAppendAt"] = now_ms
    inc["lastSeenAt"] = now_ms
    inc["lastReportSig"] = sig
    inc["suppressedRepeats"] = 0
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

    result = {"ok": True, "resolved": [], "filed": None, "suppressed": None, "ntfy": None}
    result["resolved"] = resolve_advanced(escal, state, wq_call, now_ms)

    if state.get("stalled"):
        mode = state["mode"]
        location = state.get("modeLocation")
        location_key = f"{mode}@{location}"
        decision = I.decide(state=state, log=intervention_log)
        if decision.get("exhausted"):
            outcome = maybe_file_or_append(
                escal, mode, location_key, location, state, intervention_log, wq_call, now_ms)
            # wq#1097: a suppressed repeat wrote nothing, so it must not read
            # as an action — tools/lpp-stuck-supervisor gates its whole log
            # line on `filed` being truthy and would otherwise print one every
            # 30 minutes for an incident nobody touched.
            if outcome["action"] == "unchanged":
                result["suppressed"] = outcome
            else:
                result["filed"] = outcome
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
        if result.get("suppressed"):
            s = result["suppressed"]
            print(f"TICKET unchanged wq#{s['ticketId']} ({s['suppressedRepeats']} poll(s) suppressed)")
        if result.get("ntfy"):
            print(f"NTFY sent={result['ntfy']['sent']}: {result['ntfy']['message']}")
        if not (result.get("resolved") or result.get("filed")
                or result.get("suppressed") or result.get("ntfy")):
            print("no escalation action")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
