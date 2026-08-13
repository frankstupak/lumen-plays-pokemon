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
  constructor(private dir: string, private runId: string) {
    mkdirSync(dir, { recursive: true });
    this.path = `${dir}/${runId}.jsonl`;
    this.retain();
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
  /** boot-time retention: keep newest KEEP_FILES .jsonl logs, drop the rest */
  private retain(): void {
    try {
      const logs = readdirSync(this.dir).filter(f => f.endsWith(".jsonl"))
        .map(f => ({ f, m: statSync(`${this.dir}/${f}`).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const { f } of logs.slice(KEEP_FILES)) unlinkSync(`${this.dir}/${f}`);
    } catch {}
  }
}
