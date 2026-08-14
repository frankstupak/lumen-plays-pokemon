// JSONL event bus: every harness action is an event (drives kiosk + replay).
// S2 debt paid 2026-08-06: size-based rotation + boot-time retention so a
// multi-day run can never grow one unbounded log (87MB incident).
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";

export type EventKind = "state_read" | "think_chunk" | "tool_call" | "buttons"
  | "turn_summary" | "checkpoint" | "boot" | "verify" | "battle_softlock"
  | "regression"   // wq#477: whiteout/story-regression detected or cleared
  | "rule_violation"   // wq#488: brain tried to write borrowed content to notes
  | "oscillation"   // wq#517: warp-loop notice tripped (structured, so wq#515
                     // detectors and lpp-stats count trips without parsing prose)
  | "retention"    // wq#551: the one place log deletion is recorded. Retention
                   // used to run from the EventBus CONSTRUCTOR inside a bare
                   // `catch {}`, so files vanished with no record anywhere. Now
                   // deletion happens once, on request, and says so on the bus.
  | "nav_trace";   // wq#542: per-step path intent vs actual displacement inside
                   // nav.goto. The turn-level log records position ONCE PER TURN,
                   // POST-ACTION, which makes every decision inside a journey
                   // invisible and has now defeated three separate attempts to
                   // measure why the agent does not cross Mt Moon B2F.

const ROTATE_BYTES = Number(process.env.LPP_EVENTS_ROTATE_BYTES ?? 25 * 1024 * 1024);
const KEEP_FILES = Number(process.env.LPP_EVENTS_KEEP_FILES ?? 30);

export class EventBus {
  private path: string;
  private bytes = 0;
  private part = 0;
  private listeners: ((e: object) => void)[] = [];
  // wq#551: CONSTRUCTING A BUS IS SIDE-EFFECT-FREE ON EXISTING FILES. This used
  // to call this.retain(), which unlinked every .jsonl past the newest
  // KEEP_FILES. Instantiating a class is the single most common thing a probe,
  // tool or one-off script does, so history was destroyed by ordinary
  // development activity — no run, no write, no flag, and silently, because
  // retain()'s whole body sat in a bare `catch {}`. 51 of 61 runs lost their
  // per-turn event logs that way. Retention is now retainEventLogs() below:
  // explicit, opt-in, called by exactly ONE owner (live_agent.ts at boot).
  constructor(private dir: string, private runId: string) {
    mkdirSync(dir, { recursive: true });
    this.path = `${dir}/${runId}.jsonl`;
  }
  emit(kind: EventKind, data: object) {
    // wq#522: the ENVELOPE WINS. This used to be `{ t, kind, ...data }`, so any
    // payload carrying its own `kind` silently rewrote the event kind. That is
    // not hypothetical: writeCheckpoint spreads a sidecar whose own `kind` is
    // "periodic" | "map" | "milestone", so EVERY checkpoint event in this
    // project's history was emitted as kind="periodic". metrics.ts switches on
    // "checkpoint", which therefore never matched, and maxEventCount read 0 in
    // every run summary ever written. Spreading data FIRST and pinning the
    // envelope last makes that class of collision impossible rather than
    // fixing one instance of it.
    // NOTE: pinning `kind` alone was not enough — my own probe caught that a
    // payload `t` could still rewrite the timestamp. No current emitter
    // sends one (verified: 0 of 443 on-disk events carry a bad `t`), but it is
    // the identical latent collision and costs one line to close. The `t: ""`
    // placeholder exists only to PIN KEY ORDER so log lines still lead with the
    // timestamp; its value is overwritten immediately below.
    const e: any = { t: "", ...data, kind };
    e.t = new Date().toISOString();
    const line = JSON.stringify(e) + "\n";
    if (this.bytes + line.length > ROTATE_BYTES) {
      this.part++;
      this.path = `${this.dir}/${this.runId}-p${this.part}.jsonl`;
      this.bytes = 0;
    }
    appendFileSync(this.path, line);
    this.bytes += line.length;
    for (const fn of this.listeners) fn(e);
  }
  on(fn: (e: object) => void) { this.listeners.push(fn); }
}

export interface RetentionResult {
  dir: string;
  keep: number;
  scanned: number;      // .jsonl files present before the sweep
  kept: number;
  deleted: string[];    // filenames actually unlinked
  failed: string[];     // "name: message" — an unlink that did NOT happen
}

/** THE ONLY CODE IN THIS REPO THAT DELETES AN EVENT LOG (wq#551).
 *
 *  Keeps the newest `keep` .jsonl files in `dir` by mtime and unlinks the rest.
 *
 *  It is a free function rather than a method BY DESIGN. A method is reachable
 *  from any instance, and this project has ~60 places that construct an
 *  EventBus; a free function has to be imported and called on purpose, so the
 *  destructive path cannot be reached by accident. Exactly one caller does:
 *  live_agent.ts at boot. Probes, tools and link drivers never call it, which
 *  is what makes them physically unable to delete history.
 *
 *  It is also LOUD. The old version wrapped everything in `catch {}`, which hid
 *  both errors and the deletions themselves. Every unlink is logged and
 *  returned; failures are collected and returned rather than swallowed, so a
 *  caller can emit a countable `retention` event (live_agent.ts does). */
export function retainEventLogs(dir: string, keep: number = KEEP_FILES): RetentionResult {
  const res: RetentionResult = { dir, keep, scanned: 0, kept: 0, deleted: [], failed: [] };
  let logs: { f: string; m: number }[] = [];
  try {
    logs = readdirSync(dir).filter(f => f.endsWith(".jsonl"))
      .map(f => {
        let m = 0;
        try { m = statSync(`${dir}/${f}`).mtimeMs; } catch { /* raced away */ }
        return { f, m };
      })
      .sort((a, b) => b.m - a.m);
  } catch (e: any) {
    res.failed.push(`readdir ${dir}: ${e?.message ?? e}`);
    console.error(`[retention] cannot read ${dir}: ${e?.message ?? e}`);
    return res;
  }
  res.scanned = logs.length;
  const doomed = logs.slice(keep);
  res.kept = res.scanned - doomed.length;
  for (const { f } of doomed) {
    try {
      unlinkSync(`${dir}/${f}`);
      res.deleted.push(f);
      console.warn(`[retention] deleted ${f} (keep=${keep}, scanned=${res.scanned})`);
    } catch (e: any) {
      res.failed.push(`${f}: ${e?.message ?? e}`);
      console.error(`[retention] FAILED to delete ${f}: ${e?.message ?? e}`);
    }
  }
  if (doomed.length === 0) {
    console.log(`[retention] nothing to delete (${res.scanned} logs, keep=${keep})`);
  }
  return res;
}
