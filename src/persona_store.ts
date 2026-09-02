// wq#1191 — the STORAGE layer under persona memory.
//
// wq#1176 shipped the persona as a private JSON file inside this repo. That is
// the single-platform silo the feature exists to avoid: a fact Lumen states on
// stream has to be canonical on Messenger, in a shell, and to any other fleet
// agent, and none of those can read an LPP-local file. lumen_state IS the
// fleet's cross-platform store, so persona facts live there — subject
// `lumen-persona`, one predicate per slot — and everything here is the adapter
// that gets them in and out.
//
// It is also BI-TEMPORAL, which the JSON store had no axis for. lumen_state
// closes the open row and opens a new one whenever a predicate's value changes,
// so "my favourite Pokemon was Bulbasaur until 2026-09-02, Charmander since" is
// a representable, queryable thing rather than a conflict log. The policy over
// that mechanism — when a restatement is a change of mind and when it is a
// contradiction to refuse — lives in persona.ts; this file only reads and
// writes rows.
import { spawnSync, spawn } from "child_process";
import { existsSync } from "fs";
import { CFG } from "./config";

/** One open (currently-true) persona row. `validFrom` is a date, not a
 *  timestamp: see persona.ts on why the day is the unit of a change of mind. */
export interface PersonaRow {
  predicate: string;
  value: string;
  validFrom: string;     // YYYY-MM-DD
  source: string;        // "lpp:<platform>"
}

export interface PersonaWrite {
  predicate: string;
  value: string;
  validFrom: string;
  source: string;
}

/** What persona.ts needs from a store. Two implementations: lumen_state (real,
 *  cross-platform) and in-memory (probes, and the default for a PersonaMemory
 *  nobody bound — a store that spawns python from a unit test is a footgun). */
export interface PersonaStore {
  /** Every open row for the persona subject. Throws if the store is unreachable
   *  — the caller decides whether that is fatal (it is not: see refresh()). */
  current(): PersonaRow[];
  /** Supersede or insert. Same value as the open row = evidence refresh. */
  ingest(w: PersonaWrite): void;
  /** Human label for stats/logs. */
  readonly kind: string;
}

// ── predicate encoding ───────────────────────────────────────────────────────
// lumen_state holds ONE open row per (subject, predicate), which is exactly
// right for a single-valued slot ("my name") and exactly wrong for a set-valued
// one ("i like"), where a second value must not evict the first. So a set
// member carries its value in the predicate: `i_like__caves`. The `__` marker is
// safe because a persona key is letters, spaces, apostrophes and hyphens only
// (see normKey in persona.ts), so it can never contain an underscore.
const SET_MARK = "__";
export const MAX_PREDICATE_CHARS = 120;

const slug = (s: string) => s.trim().replace(/\s+/g, "_");

export function encodePredicate(key: string, single: boolean, norm: string): string {
  const p = single ? slug(key) : `${slug(key)}${SET_MARK}${slug(norm)}`;
  return p.slice(0, MAX_PREDICATE_CHARS).toLowerCase();
}

export function decodePredicate(predicate: string): { key: string; single: boolean } {
  const i = predicate.indexOf(SET_MARK);
  if (i < 0) return { key: predicate.replace(/_/g, " "), single: true };
  return { key: predicate.slice(0, i).replace(/_/g, " "), single: false };
}

/** Platform round-trips through source_ref so a fact restored after a restart
 *  still knows which surface Lumen first said it on. */
export const encodeSource = (platform: string) => `lpp:${String(platform || "unknown").slice(0, 32)}`;
export const decodeSource = (source: string) => (source ?? "").startsWith("lpp:") ? source.slice(4) : "unknown";

/** The day a fact became true. Dates, not timestamps, because valid-from is a
 *  world-truth boundary and lumen_state compares them as strings. */
export const today = (now: Date = new Date()) => now.toISOString().slice(0, 10);

// ── lumen_state ──────────────────────────────────────────────────────────────

export interface LumenStateOptions {
  python?: string;
  adapter?: string;      // tools/lumen_state_json.py
  subject?: string;
  regen?: string;        // state-regen; "" disables
  db?: string;           // alternate sqlite file (probes only)
  timeoutMs?: number;
  regenMinIntervalMs?: number;
}

/**
 * lumen_state via a subprocess. Every call is bounded and every failure is the
 * caller's to see: a store that silently swallowed a failed write would let the
 * character drift with no signal, which is the wq#1176 failure one layer down.
 */
export class LumenStateStore implements PersonaStore {
  readonly kind = "lumen_state";
  private python: string;
  private adapter: string;
  private subject: string;
  private regenPath: string;
  private db: string;
  private timeoutMs: number;
  private regenMinIntervalMs: number;
  private lastRegen = 0;

  constructor(o: LumenStateOptions = {}) {
    this.python = o.python ?? CFG.persona.python;
    this.adapter = o.adapter ?? CFG.persona.adapter;
    this.subject = o.subject ?? CFG.persona.subject;
    this.regenPath = o.regen ?? CFG.persona.stateRegen;
    this.db = o.db ?? CFG.persona.stateDb;
    this.timeoutMs = o.timeoutMs ?? CFG.persona.stateTimeoutMs;
    this.regenMinIntervalMs = o.regenMinIntervalMs ?? CFG.persona.regenMinIntervalMs;
  }

  /** True when the adapter and interpreter are actually present. Lets a surface
   *  (or a probe on a machine without Minerva) degrade instead of throwing. */
  available(): boolean {
    return existsSync(this.adapter);
  }

  private run(args: string[]): any {
    const argv = this.db ? [this.adapter, ...args, "--db", this.db] : [this.adapter, ...args];
    const r = spawnSync(this.python, argv, { encoding: "utf8", timeout: this.timeoutMs });
    if (r.error) throw new Error(`lumen_state: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`lumen_state exit ${r.status}: ${String(r.stderr ?? "").trim().slice(0, 200)}`);
    try {
      return JSON.parse(String(r.stdout ?? "").trim());
    } catch {
      throw new Error(`lumen_state: unparseable output: ${String(r.stdout ?? "").trim().slice(0, 120)}`);
    }
  }

  current(): PersonaRow[] {
    const j = this.run(["current", this.subject]);
    const rows: PersonaRow[] = [];
    for (const r of (Array.isArray(j?.rows) ? j.rows : [])) {
      if (typeof r?.predicate !== "string" || typeof r?.value !== "string") continue;
      rows.push({
        predicate: r.predicate,
        value: r.value,
        validFrom: String(r.valid_from ?? "").slice(0, 10),
        source: String(r.source_ref ?? ""),
      });
    }
    return rows;
  }

  ingest(w: PersonaWrite): void {
    this.run(["ingest", this.subject, w.predicate, w.value, "--valid-from", w.validFrom, "--source", w.source]);
    this.regen();
  }

  /**
   * Rebuild the rendered fleet-state docs other agents read. Detached and
   * debounced on purpose: this is a turn-loop caller, and a persona fact is not
   * worth blocking a Pokemon turn on. Skipped entirely against a test DB, where
   * regenerating from the REAL database would be both wrong and a side effect.
   */
  private regen(): void {
    if (!this.regenPath || this.db) return;
    const now = Date.now();
    if (now - this.lastRegen < this.regenMinIntervalMs) return;
    this.lastRegen = now;
    try {
      const p = spawn(this.regenPath, [], { detached: true, stdio: "ignore" });
      p.on("error", () => {});     // a missing regen must not kill a turn
      p.unref();
    } catch { /* same */ }
  }
}

// ── in-memory ────────────────────────────────────────────────────────────────

/**
 * The same bi-temporal supersession rules, in process, with no subprocess and
 * no shared file. This is what an unbound PersonaMemory uses and what the pure
 * probes assert against; probe_persona_state.ts covers the real one.
 */
export class MemoryPersonaStore implements PersonaStore {
  readonly kind = "memory";
  /** Closed rows are kept so a probe can assert the bi-temporal history. */
  rows: { predicate: string; value: string; validFrom: string; validTo: string | null; source: string }[] = [];

  current(): PersonaRow[] {
    return this.rows.filter(r => r.validTo === null)
      .map(r => ({ predicate: r.predicate, value: r.value, validFrom: r.validFrom, source: r.source }));
  }

  ingest(w: PersonaWrite): void {
    const open = this.rows.find(r => r.predicate === w.predicate && r.validTo === null);
    if (open && open.value === w.value) return;          // evidence refresh, no new row
    if (open) open.validTo = w.validFrom;
    this.rows.push({ predicate: w.predicate, value: w.value, validFrom: w.validFrom, validTo: null, source: w.source });
  }

  history(predicate: string) {
    return this.rows.filter(r => r.predicate === predicate);
  }
}
