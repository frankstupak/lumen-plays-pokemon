// JSONL event bus: every harness action is an event (drives kiosk + replay).
// S2 debt paid 2026-08-06: size-based rotation + boot-time retention so a
// multi-day run can never grow one unbounded log (87MB incident).
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";

export type EventKind = "state_read" | "think_chunk" | "tool_call" | "buttons"
  | "turn_summary" | "checkpoint" | "boot" | "verify" | "battle_softlock"
  | "regression"   // wq#477: whiteout/story-regression detected or cleared
  | "rule_violation"   // wq#488: brain tried to write borrowed content to notes
  | "oscillation";   // wq#517: warp-loop notice tripped (structured, so wq#515
                     // detectors and lpp-stats count trips without parsing prose)

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
    const e = { t: new Date().toISOString(), kind, ...data };
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
