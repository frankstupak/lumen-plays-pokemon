// wq#503 — the DERIVED half of the kiosk trainer-stats panel.
//
// The RAM half (map, position, party, badges, money, Pokedex, play time) rides
// the existing state_read event and is rendered by the page directly. This
// module owns the four things that need memory across turns or a second
// source: last milestone, the stuck signal, the corridor objective, and the
// turn-economics rates.
//
// House rule for everything here: if a value is not available, return null.
// The page renders "--" for null. Nothing in this file may invent a number.
import { execFile } from "child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export interface Milestone {
  flag: string;         // raw STORY_FLAGS name, e.g. EVENT_BEAT_BROCK
  label: string;        // display form, e.g. "Beat Brock"
  firstSeen: string;    // ISO — when THIS tracker first observed the flag set
  seeded: boolean;      // true = already set when the tracker first looked, so
                        // firstSeen is an observation time, not an event time
}

export interface TrainerProgress {
  storyScore: number | null;
  objective: string | null;
  milestone: Milestone | null;
  rates: { turnsPerH: number | null; brainPerH: number | null; at: string | null };
  stuck: { active: boolean; reasons: string[] };
  loop: { turns: number; spanX: number; spanY: number; map: number } | null;
  sentinel: { key: string; agoSec: number }[];
  at: string;
}

/** EVENT_BEAT_BROCK -> "Beat Brock". Short tokens (SS, HM) stay uppercase. */
export function prettifyFlag(flag: string): string {
  return flag.replace(/^EVENT_/, "").split("_")
    .map(w => (w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(" ");
}

/** Milestone ledger. A milestone is a STORY_FLAGS bit turning on — never a
 *  dialog line and never a brain claim, which is the whole wq#488 lesson.
 *
 *  Persisted to runtime/ so a service restart does not erase the history. On
 *  the tracker's FIRST look, flags that are already set are recorded as
 *  `seeded` — their timestamp is when this code first saw them, not when the
 *  player earned them, and the page labels them accordingly. Inventing an
 *  earn-time for a flag set weeks ago would be exactly the kind of confident
 *  lie this ticket exists to remove. */
export class MilestoneLog {
  private seen = new Map<string, Milestone>();
  private order: string[] = [];
  private path: string | null = null;
  private primed = false;

  bind(path: string): void {
    this.path = path;
    try {
      if (existsSync(path)) {
        const j = JSON.parse(readFileSync(path, "utf8")) as { v: number; log: Milestone[] };
        for (const m of j.log ?? []) {
          if (!m || typeof m.flag !== "string" || this.seen.has(m.flag)) continue;
          this.seen.set(m.flag, m);
          this.order.push(m.flag);
        }
        this.primed = this.order.length > 0;
      }
    } catch { /* corrupt file: start clean rather than crash the live agent */ }
  }

  /** Feed the CURRENT set of set flags (StateReader.storyFlagsSet()).
   *  `seeded` forces the "already true when first observed" marking — the
   *  caller passes true right after loading a snapshot, because flags that
   *  arrive with a resumed save were earned some time ago, not just now. */
  observe(flags: string[], now = new Date(), seeded?: boolean): Milestone | null {
    let latest: Milestone | null = null;
    for (const flag of flags) {
      if (this.seen.has(flag)) continue;
      const m: Milestone = {
        flag, label: prettifyFlag(flag),
        firstSeen: now.toISOString(), seeded: seeded ?? !this.primed,
      };
      this.seen.set(flag, m);
      this.order.push(flag);
      latest = m;
    }
    this.primed = true;
    if (latest) this.persist();
    return latest;
  }

  last(): Milestone | null {
    const f = this.order[this.order.length - 1];
    return f ? this.seen.get(f) ?? null : null;
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, log: this.order.map(f => this.seen.get(f)!) }));
      renameSync(tmp, this.path);
    } catch { /* a kiosk nicety must never take the agent down */ }
  }
}

/** Jay's explicit ask: make "he is stuck" visible at a glance. Same shape as
 *  the wq#489 sentinel's `loop` check (same map + position bbox <= 3 tiles
 *  across the last 20 turns) so the tablet and the ntfy alert never disagree
 *  about what stuck means. Battle-only state_reads carry no map/x/y and are
 *  skipped — standing still through a long battle is not a loop. */
export const LOOP_WINDOW = 20;
export const LOOP_SPAN = 3;

export class StuckWatch {
  private buf: { map: number; x: number; y: number }[] = [];

  observe(map: number, x: number, y: number): void {
    this.buf.push({ map, x, y });
    if (this.buf.length > LOOP_WINDOW) this.buf.shift();
  }

  /** null until the window is full; otherwise the current box, whose
   *  `spanX`/`spanY` the caller compares against LOOP_SPAN. */
  state(): { turns: number; spanX: number; spanY: number; map: number; looping: boolean } | null {
    if (this.buf.length < LOOP_WINDOW) return null;
    const map = this.buf[0].map;
    if (!this.buf.every(p => p.map === map)) return null;
    const xs = this.buf.map(p => p.x), ys = this.buf.map(p => p.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    return { turns: this.buf.length, spanX, spanY, map, looping: spanX <= LOOP_SPAN && spanY <= LOOP_SPAN };
  }
}

/** Alerts the wq#489 sentinel fired recently. Its dedupe window is one hour,
 *  so "fired within DEDUPE_SEC" is exactly "still alerting". Read-only: the
 *  sentinel owns this file, the panel only looks. */
export const SENTINEL_DEDUPE_SEC = 3600;

export function sentinelAlerts(path: string, now = Date.now()): { key: string; agoSec: number }[] {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { last_fired?: Record<string, number> };
    return Object.entries(j.last_fired ?? {})
      .map(([key, at]) => ({ key, agoSec: Math.round(now / 1000 - at) }))
      .filter(a => a.agoSec >= 0 && a.agoSec < SENTINEL_DEDUPE_SEC)
      .sort((a, b) => a.agoSec - b.agoSec);
  } catch { return []; }
}

/** First GOAL: line in the harness->brain guidance channel. That channel is
 *  the only place a corridor objective is authored, so the tablet shows the
 *  same objective the brain was handed this turn. */
export function objectiveFrom(guidance: string): string | null {
  for (const raw of guidance.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("GOAL:")) return line.slice(5).trim() || null;
  }
  return null;
}

/** Pull a displayable pace out of `lpp-stats --json`, or null when there is
 *  not one yet.
 *
 *  A run that has recorded no turns reports 0 turns/h, because the arithmetic
 *  is 0 divided by the wall clock. That is the ABSENCE of a measurement, not a
 *  measurement of zero, and "0 t/h" on a screen across the room reads as
 *  "stalled" when the truth is "restarted forty seconds ago". Returning null
 *  keeps the panel on "--" until the first metrics flush lands. */
export function paceFrom(raw: unknown): { turnsPerH: number | null; brainPerH: number | null; at: string | null } | null {
  const j = raw as { current?: { turnsPerH?: number; brainPerH?: number; turns?: number }; generatedAt?: string } | null;
  const c = j?.current;
  if (!c || typeof c.turnsPerH !== "number" || typeof c.brainPerH !== "number") return null;
  if (!c.turns) return null;
  return { turnsPerH: c.turnsPerH, brainPerH: c.brainPerH, at: typeof j?.generatedAt === "string" ? j.generatedAt : null };
}

/** turns/h and brain-calls/h come from tools/lpp-stats --json. The ticket is
 *  explicit: reuse it, do not reimplement it. Two implementations of the same
 *  rate is how the tablet ends up contradicting the board.
 *
 *  Refreshed on a timer, never on the request path — a stalled subprocess must
 *  not stall the kiosk. Failure leaves the previous value in place and, if
 *  there has never been one, nulls (page shows "--"). */
export class RatesCache {
  private value: { turnsPerH: number | null; brainPerH: number | null; at: string | null } =
    { turnsPerH: null, brainPerH: null, at: null };
  private inflight = false;

  constructor(private cli: string, private cwd: string) {}

  get(): { turnsPerH: number | null; brainPerH: number | null; at: string | null } { return this.value; }

  refresh(): void {
    if (this.inflight) return;
    this.inflight = true;
    execFile("python3", [this.cli, "--json", "--no-enrich", "--window", "12"],
      { cwd: this.cwd, timeout: 20000, maxBuffer: 4 << 20 }, (err, stdout) => {
        this.inflight = false;
        if (err) return;                       // keep the last good value
        try {
          const v = paceFrom(JSON.parse(stdout));
          if (v) this.value = v;
        } catch { /* malformed output: keep the last good value */ }
      });
  }

  /** Refresh now and every `everyMs`. Returns the timer so callers can unref. */
  start(everyMs = 60000): NodeJS.Timeout {
    this.refresh();
    const t = setInterval(() => this.refresh(), everyMs);
    t.unref?.();
    return t;
  }
}
