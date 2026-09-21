// wq#2389: the CONSUMER for tool=isis_alert.
//
// wq#1584 made the primary-brain page able to FIRE. Nothing read it. Both
// producers — brain.ts trackPrimaryFail (primary down N turns in the window)
// and live_agent's dead-cycle branch (0 turns across N reboots) — emitted
// `tool_call {tool:"isis_alert", level:"critical"}` on the bus and printed a
// CRITICAL line to stderr, and a grep across src, tools, ops, /home/lumen/bin,
// the foreman harness and kb found ZERO readers of either: events/*.jsonl has
// no watcher, and the unit journal has no alerting tail. litellm-auth-alert,
// spend-alert.py and alert-deadman-beat.sh all page for their own subsystems
// and none of them reads an LPP event log. So the most critical line this
// process can produce reached nobody. This module is the missing reader.
//
// DELIVERY PATH: /home/lumen/bin/ntfy-send — the fleet publisher whose health
// alert-deadman-beat.sh checks before it beats the off-fleet dead man's switch,
// and the single chokepoint where the fleet alert gate (operator silences +
// burst grouping, aq_gate.py) applies. Publishing here means a page obeys a
// standing silence instead of bypassing it, and an LPP outage during a fleet
// alert storm gets grouped like everything else.
//
// PRIORITY `high`, not `urgent`: ntfy-send escalates configured priorities to
// the out-of-band (wakes-Frank-anywhere) endpoint, and this project's other
// escalation — tools/lpp_stuck_feedback.py's 3h stall page — settled on `high`
// for exactly this class of "the run is dead, look at it when you wake up".
// LPP_ISIS_PRIORITY overrides it for an incident that deserves more.
//
// ATTACHMENT IS EXPLICIT (live_agent.ts calls attachIsisPager once). ~20 probes
// and tools in this repo construct a Brain, which means they can emit
// isis_alert; none of them attaches a pager, so none of them can page Frank
// from a test run. There is no env flag to get wrong.
import { execFile } from "child_process";
import type { EventBus } from "./events";

const NTFY_BIN = process.env.LPP_NTFY_BIN ?? "/home/lumen/bin/ntfy-send";
const NTFY_TOPIC = process.env.LPP_NTFY_TOPIC ?? "lumen-fleet";
const NTFY_PRIORITY = process.env.LPP_ISIS_PRIORITY ?? "high";
const NTFY_TITLE = "LPP CRITICAL";
// ntfy-send runs curl -m 10 against the primary endpoint and again against the
// out-of-band one, so 30s is "both legs timed out", not "the network is slow".
const SEND_TIMEOUT_MS = Number(process.env.LPP_ISIS_SEND_TIMEOUT_MS ?? 30_000);
const LPP_BASE = process.env.LPP_BASE ?? "/home/lumen/pokemon";
const AUDIT_BIN = process.env.LPP_ISIS_AUDIT_BIN ?? `${LPP_BASE}/tools/lpp_isis_audit.py`;
const SWEEP_MS = Number(process.env.LPP_ISIS_SWEEP_MS ?? 15 * 60_000);

interface IsisAlert { source: string; msg: string }

/** The bus hands listeners a bare object; this is the boundary check. */
function readCriticalAlert(e: unknown): IsisAlert | null {
  if (typeof e !== "object" || e === null) return null;
  const r = e as Record<string, unknown>;
  if (r.kind !== "tool_call" || r.tool !== "isis_alert" || r.level !== "critical") return null;
  const msg = typeof r.msg === "string" ? r.msg : "";
  if (!msg) return null;
  return { source: typeof r.source === "string" ? r.source : "unknown", msg };
}

/** Dedup key: the source plus the message with every run of digits collapsed.
 *
 *  Not the raw text, because live_agent's dead-cycle alert RE-EMITS on every
 *  reboot once deadCycles >= DEAD_CYCLE_ALERT and its text carries the cycle
 *  count and the backoff seconds (live_agent.ts:792). Exact-text dedup would
 *  therefore page once per reboot — a page storm at the exact moment the loop
 *  is spinning fastest. brain.ts latches its own alert per outage already; this
 *  key makes BOTH producers safe without either having to know about paging. */
export function pageKey(source: string, msg: string): string {
  return `${source}:${msg.replace(/\d+/g, "#").slice(0, 200)}`;
}

interface SendResult { ok: boolean; rc: number; detail: string }

/** execFile reports a non-zero EXIT as a numeric `code` and a failure to spawn
 *  at all (missing binary, not executable) as a string one — and types both as
 *  string. -1 is "it never ran", which is a different incident from "it ran and
 *  said no". */
function exitCode(err: unknown): number {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : err ? -1 : 0;
}

function sendPage(text: string): Promise<SendResult> {
  return new Promise(resolve => {
    execFile(NTFY_BIN, ["-p", NTFY_PRIORITY, "-t", NTFY_TOPIC, "-T", NTFY_TITLE, text],
      { timeout: SEND_TIMEOUT_MS }, (err, stdout, stderr) => {
        const detail = `${stdout ?? ""} ${stderr ?? ""}${err ? " " + err.message : ""}`
          .replace(/\s+/g, " ").trim().slice(0, 300);
        resolve({ ok: !err, rc: exitCode(err), detail });
      });
  });
}

export interface IsisPager {
  /** Keys whose page this run has DELIVERED. A failed send is not in here. */
  readonly delivered: ReadonlySet<string>;
  /** Settles when every in-flight send has finished. For probes — the live
   *  service never waits on a page. */
  drain(): Promise<void>;
}

export function attachIsisPager(bus: EventBus): IsisPager {
  const delivered = new Set<string>();
  const inflight = new Set<Promise<void>>();

  bus.on(e => {
    const alert = readCriticalAlert(e);
    if (!alert) return;
    const key = pageKey(alert.source, alert.msg);
    if (delivered.has(key)) return;
    // Claimed BEFORE the send so a second alert arriving while curl is still
    // running cannot double-page; released below if the send fails.
    delivered.add(key);
    const p = sendPage(`[${alert.source}] ${alert.msg}`).then(r => {
      // A page that did not leave the box is not a page. Releasing the key lets
      // the next identical alert retry instead of the run going quiet on the
      // strength of a delivery that never happened.
      if (!r.ok) {
        delivered.delete(key);
        console.error(`[isis] PAGE DELIVERY FAILED (rc=${r.rc}) ${r.detail} :: ${alert.msg}`);
      }
      // On the bus too, so tools/lpp_isis_audit.py can pair an alert with its
      // delivery from events/*.jsonl alone and name what never went out.
      // WITHOUT the publisher's output: stream.ts renders every event's JSON
      // into the public kiosk feed (stream.ts:121), and ntfy-send's failure
      // text quotes the whole command line — fleet topic included. The topic is
      // not a credential, but it is a publish target for Frank's phone and it
      // does not belong on a stream anyone can watch. `rc` is enough to audit
      // by; the full text is on stderr, in the unit journal, where wq#1578 put
      // the rest of this incident class.
      bus.emit("tool_call", {
        tool: "isis_page", level: r.ok ? "info" : "critical", source: "isis_page",
        ok: r.ok, rc: r.rc, key, alert: alert.msg,
      });
    }).catch((err: unknown) => {
      delivered.delete(key);
      console.error(`[isis] pager threw: ${String(err)}`);
    });
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  });

  return {
    delivered,
    async drain() { while (inflight.size) await Promise.all([...inflight]); },
  };
}

/** The retry neither producer can perform for itself.
 *
 *  brain.ts LATCHES its alert for the whole outage (`st.alerted` stays true
 *  until the primary serves a turn again), so an isis_alert whose publish lost
 *  a race with a 30-second ntfy hiccup is never re-emitted: the run goes unpaged
 *  to the end of the outage, which is the wq#1578 shape all over again. This
 *  hands events/*.jsonl to tools/lpp_isis_audit.py every SWEEP_MS, which pairs
 *  each critical alert with its isis_page receipt and republishes what nothing
 *  delivered — including pages a previous run died holding.
 *
 *  Bounded by construction: the audit sends at most one page per sweep, dedups
 *  against its own runtime/isis_audit.jsonl and the receipts above, and ignores
 *  alerts younger than its settle window, so a sweep that finds nothing costs
 *  one short-lived process and pages nobody. LPP_ISIS_SWEEP_MS=0 disables it. */
export function startUnpagedSweep(): NodeJS.Timeout | null {
  if (!(SWEEP_MS > 0)) return null;
  const sweep = () => execFile(AUDIT_BIN,
    ["--send", "--quiet", "--since-hours", "6", "--max-send", "1"],
    { timeout: SEND_TIMEOUT_MS * 2 }, (err, stdout, stderr) => {
      // exit 1 = "something is still unpaged", which the next sweep retries;
      // only a broken invocation (missing file, not executable) is worth noise.
      if (err && exitCode(err) !== 1) console.error(`[isis] unpaged sweep failed: ${err.message}`);
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
      if (out) console.error(`[isis] unpaged sweep: ${out.slice(0, 300)}`);
    });
  const t = setInterval(sweep, SWEEP_MS);
  t.unref();   // a sweep timer must never be the reason this process stays up
  return t;
}
