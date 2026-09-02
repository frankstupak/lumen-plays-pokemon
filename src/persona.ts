// wq#1176 — PERSONA MEMORY: what Lumen has said about HIMSELF, on any surface.
//
// The notepad (notepad.ts) is about the GAME: where he is, what he owns, what
// he plans. This store is about the CHARACTER, and it is deliberately a
// separate file with a separate lifetime, because the two have opposite
// retention rules. A notepad fact goes stale the moment the game moves ("my HP
// is low"); a persona fact must NEVER go stale — if Lumen tells the stream his
// favourite Pokemon is Bulbasaur, the answer he gives on Messenger three weeks
// later has to be Bulbasaur, or he is not a character, he is a chatbot.
//
// CROSS-PLATFORM is the whole point, so the store is a FILE at one canonical
// path (CFG.persona.path, LPP_PERSONA_PATH), not process state. Every surface
// — the live agent, the streamer chat, a Messenger bridge, an operator at a
// terminal via src/persona_cli.ts — reads and writes the same JSON. Nothing
// here imports the emulator, the ROM, or any LPP type: a surface that knows
// nothing about Pokemon can still recall the persona.
//
// EXTRACTION IS DELIBERATELY NARROW. A false canonical fact is far worse than a
// missed one: it is a lie the character then has to keep telling. So the
// patterns below only match explicit first-person self-description, and the
// volatile/transient guards drop game chatter ("my party is weak", "I am at
// Viridian") rather than canonising it.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export const MAX_FACTS = 200;          // store ceiling; eviction is least-stated-first
export const RECALL_BUDGET = 900;      // chars of persona injected into a prompt
export const MAX_VALUE_CHARS = 160;
export const MAX_CONFLICTS = 5;        // per fact; enough to see a pattern, not a log

/** A restatement that CONTRADICTED the canonical value of a single-valued key.
 *  Kept, never applied: the first answer stays canonical (see observe()). */
export interface PersonaConflict { value: string; raw: string; at: string; platform: string }

export interface PersonaFact {
  /** canonical slot, e.g. "my name", "i am", "i like" */
  key: string;
  /** the value as Lumen first said it (display form) */
  value: string;
  /** normalized value — comparison key, recomputed on load */
  norm: string;
  /** the sentence he actually said */
  raw: string;
  /** true = one answer only (name, birthday), so a different answer conflicts.
   *  false = set-valued (likes, self-descriptions), so values accumulate. */
  single: boolean;
  platform: string;      // where it was FIRST said
  firstSaid: string;     // ISO
  lastSaid: string;      // ISO
  count: number;         // times stated (reaffirmations)
  conflicts: PersonaConflict[];
}

export interface PersonaClaim { key: string; value: string; norm: string; raw: string; single: boolean }
export type PersonaOutcome = "new" | "reaffirmed" | "conflict";
export interface PersonaEvent { outcome: PersonaOutcome; key: string; value: string; fact: PersonaFact }
export interface PersonaState { v: 1; facts: PersonaFact[] }

// ── extraction ───────────────────────────────────────────────────────────────

// Attributes whose value changes as the game runs. "my hp is 12" is a state
// read wearing a persona sentence; canonising it would have Lumen insisting on
// a hit-point total from last month.
const VOLATILE_ATTRS = new Set([
  "hp", "health", "pp", "level", "levels", "exp", "xp", "position", "pos", "location",
  "map", "money", "cash", "badge", "badges", "party", "team", "turn", "turns", "goal",
  "plan", "target", "route", "score", "progress", "objective", "status", "inventory",
  "bag", "items", "move", "moves", "opponent", "foe", "next",
]);

// First words that make "I am ..." a passing state rather than a self-description.
const TRANSIENT_HEADS = new Set([
  "at", "in", "on", "near", "by", "inside", "outside", "here", "there", "now", "back",
  "stuck", "lost", "low", "out", "done", "ready", "close", "almost", "still",
  "currently", "about", "afraid", "sure", "not", "no", "yes", "going", "heading",
  "trying", "fighting", "battling", "walking", "waiting", "up", "down", "over",
]);

const PREF_VERBS = "like|love|hate|dislike|prefer|enjoy|fear|admire|main";
const PAST_STATES = "born|created|built|made|trained|written|designed|named";

// A slot is only canonical if every spelling of it lands in the SAME slot.
// "my favourite pokemon" and "my favorite pokemon" are one question, and a
// store that answers them separately has two favourites and detects no
// contradiction between them — which is precisely the bug this file exists to
// prevent. Explicit list rather than a general -our/-or rule, which would eat
// "hour", "four" and "your".
const KEY_SYNONYMS: Record<string, string> = {
  favourite: "favorite", favourites: "favorite", favorites: "favorite",
  colour: "color", colours: "color", colors: "color",
  behaviour: "behavior", humour: "humor", honour: "honor",
  pokemon: "pokemon", pokémon: "pokemon",
};

/** Slot form: one question gets one slot, whatever the spelling. */
export function normKey(key: string): string {
  return String(key ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // pokémon -> pokemon
    .replace(/\s+/g, " ").trim()
    .split(" ").map(w => KEY_SYNONYMS[w] ?? w).join(" ");
}

/** Comparison form: case, articles, and punctuation must not create a conflict. */
export function normValue(v: string): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/^\s*(?:a|an|the|my)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function displayValue(v: string): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").replace(/[\s,.!?;:'"]+$/, "").slice(0, MAX_VALUE_CHARS);
}

function isVolatileAttr(attr: string): boolean {
  return attr.toLowerCase().split(/\s+/).some(w => VOLATILE_ATTRS.has(w));
}

function isTransientState(value: string): boolean {
  const head = normValue(value).split(" ")[0] ?? "";
  return !head || TRANSIENT_HEADS.has(head) || /ing$/.test(head);
}

function claim(key: string, rawValue: string, raw: string, single: boolean): PersonaClaim | null {
  const value = displayValue(rawValue);
  const norm = normValue(value);
  if (norm.length < 2) return null;
  return { key: normKey(key), value, norm, raw: raw.trim().slice(0, 240), single };
}

/**
 * Pull explicit self-statements out of free text. Deterministic and pure — the
 * same sentence always yields the same claims, which is what makes the probe
 * (src/probe_persona.ts) able to pin the behaviour.
 */
export function extractPersonaClaims(text: string): PersonaClaim[] {
  const out: PersonaClaim[] = [];
  const sentences = String(text ?? "")
    .split(/[.!?\n;]+/)
    .flatMap(s => s.split(/\s+(?:and|but)\s+(?=(?:i|my)\b)/i))
    .map(s => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    let m: RegExpMatchArray | null;
    // "my name is Lumen", "my favourite pokemon is Bulbasaur"
    if ((m = s.match(/^my\s+([a-z][a-z' -]{1,40}?)\s+(?:is|are|was|were)\s+(.{2,})$/i))) {
      const attr = m[1].trim().toLowerCase();
      if (!isVolatileAttr(attr)) {
        const c = claim(`my ${attr}`, m[2], s, true);
        if (c) { out.push(c); continue; }
      }
      continue;
    }
    // "I go by Lumen" / "I call myself Lumen" — same slot as "my name is".
    if ((m = s.match(/^i\s+(?:go\s+by|call\s+myself)\s+(.{2,})$/i))) {
      const c = claim("my name", m[1], s, true);
      if (c) { out.push(c); continue; }
      continue;
    }
    // "I was built by Frank" — origin facts, single-valued.
    if ((m = s.match(new RegExp(`^i\\s+was\\s+(${PAST_STATES})\\s+(.{2,})$`, "i")))) {
      const c = claim(`i was ${m[1].toLowerCase()}`, m[2], s, true);
      if (c) { out.push(c); continue; }
      continue;
    }
    // "I don't like caves" — negated preferences get their own slot so they can
    // never be confused with the positive one.
    if ((m = s.match(new RegExp(`^i\\s+(?:do\\s+not|don'?t|never)\\s+(${PREF_VERBS})\\s+(.{2,})$`, "i")))) {
      const c = claim(`i do not ${m[1].toLowerCase()}`, m[2], s, false);
      if (c) { out.push(c); continue; }
      continue;
    }
    // "I like caves", "I hate Zubat" — set-valued, they accumulate.
    if ((m = s.match(new RegExp(`^i\\s+(${PREF_VERBS})\\s+(.{2,})$`, "i")))) {
      const c = claim(`i ${m[1].toLowerCase()}`, m[2], s, false);
      if (c) { out.push(c); continue; }
      continue;
    }
    // "I am an AI" — set-valued self-description, minus passing states.
    if ((m = s.match(/^i\s*(?:am|'m)\s+(.{2,})$/i))) {
      if (isTransientState(m[1])) continue;
      const c = claim("i am", m[1], s, false);
      if (c) { out.push(c); continue; }
    }
  }
  return out;
}

// ── the store ────────────────────────────────────────────────────────────────

export class PersonaMemory {
  facts: PersonaFact[] = [];
  private path: string | null = null;
  /** Injected so probes can assert ordering without sleeping. */
  now: () => Date = () => new Date();

  /** Enable persistence: restore from `path` if present, write-through after.
   *  Same contract as Notepad.bind — an unreadable file starts fresh rather
   *  than killing whatever surface is booting. */
  bind(path: string): void {
    this.path = path;
    try {
      if (existsSync(path)) {
        const j = JSON.parse(readFileSync(path, "utf8")) as PersonaState;
        if (Array.isArray(j.facts)) this.facts = j.facts.map(f => this.hydrate(f)).filter(Boolean) as PersonaFact[];
      } else {
        mkdirSync(dirname(path), { recursive: true });
      }
    } catch { /* unreadable store = start fresh; never crash a surface on this */ }
  }

  private hydrate(f: any): PersonaFact | null {
    if (!f || typeof f.key !== "string" || typeof f.value !== "string") return null;
    const at = typeof f.firstSaid === "string" ? f.firstSaid : this.now().toISOString();
    return {
      // key and norm are both recomputed on load, never trusted from disk:
      // slot folding is code, and a store written before a fold existed must
      // land in the same slot as one written after it.
      key: normKey(f.key),
      value: String(f.value).slice(0, MAX_VALUE_CHARS),
      // recomputed, never trusted from disk: normalization is code, and code changes
      norm: normValue(f.value),
      raw: typeof f.raw === "string" ? f.raw : String(f.value),
      single: Boolean(f.single),
      platform: typeof f.platform === "string" ? f.platform : "unknown",
      firstSaid: at,
      lastSaid: typeof f.lastSaid === "string" ? f.lastSaid : at,
      count: Number.isFinite(f.count) ? Math.max(1, Math.floor(f.count)) : 1,
      conflicts: Array.isArray(f.conflicts) ? f.conflicts.slice(0, MAX_CONFLICTS) : [],
    };
  }

  /**
   * THE ONE WRITE PATH. Feed it anything Lumen said — a chat line, a note, a
   * Messenger reply — with the platform he said it on.
   *
   * CANONICAL MEANS FIRST. When a single-valued key is restated with a
   * different value, the original value WINS and the restatement is recorded as
   * a conflict. Last-write-wins would make the character drift wherever the
   * most recent turn happened to point, which is exactly the failure the store
   * exists to prevent; recording the contradiction (rather than dropping it)
   * lets the caller tell the brain it just contradicted itself.
   */
  observe(text: string, platform: string, source = ""): PersonaEvent[] {
    const at = this.now().toISOString();
    const plat = String(platform || "unknown").slice(0, 32);
    const events: PersonaEvent[] = [];
    for (const c of extractPersonaClaims(text)) {
      const prior = c.single
        ? this.facts.find(f => f.key === c.key)
        : this.facts.find(f => f.key === c.key && f.norm === c.norm);
      if (!prior) {
        const fact: PersonaFact = {
          key: c.key, value: c.value, norm: c.norm, raw: source ? `${c.raw} [${source}]` : c.raw,
          single: c.single, platform: plat, firstSaid: at, lastSaid: at, count: 1, conflicts: [],
        };
        this.facts.push(fact);
        events.push({ outcome: "new", key: fact.key, value: fact.value, fact });
        continue;
      }
      prior.lastSaid = at;
      if (prior.norm === c.norm) {
        prior.count++;
        events.push({ outcome: "reaffirmed", key: prior.key, value: prior.value, fact: prior });
      } else {
        prior.conflicts.push({ value: c.value, raw: c.raw, at, platform: plat });
        if (prior.conflicts.length > MAX_CONFLICTS) prior.conflicts.shift();
        events.push({ outcome: "conflict", key: prior.key, value: c.value, fact: prior });
      }
    }
    if (events.length) { this.evict(); this.save(); }
    return events;
  }

  /** Over the ceiling, drop the least-stated then least-recent facts. A fact
   *  that has been repeated to an audience is one people remember; a one-off is
   *  the cheapest thing to forget. */
  private evict(): void {
    if (this.facts.length <= MAX_FACTS) return;
    this.facts.sort((a, b) => (b.count - a.count) || (Date.parse(b.lastSaid) - Date.parse(a.lastSaid)));
    this.facts = this.facts.slice(0, MAX_FACTS);
  }

  /** Rank for recall: identity slots first, then most-stated, then oldest
   *  (a fact he has held longest is the one an audience will test him on). */
  private ranked(): PersonaFact[] {
    return [...this.facts].sort((a, b) =>
      (Number(b.single) - Number(a.single)) ||
      (b.count - a.count) ||
      (Date.parse(a.firstSaid) - Date.parse(b.firstSaid)));
  }

  /** The block that goes into a prompt on ANY platform. Empty string when
   *  nothing has been said yet — callers append it unconditionally. */
  recall(budget = RECALL_BUDGET): string {
    const lines: string[] = [];
    let used = 0;
    for (const f of this.ranked()) {
      const conflict = f.conflicts.length
        ? ` (you later said "${f.conflicts[f.conflicts.length - 1].value}" — the line above is what you are known for)`
        : "";
      const line = `- ${f.key}: ${f.value}${conflict}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  /** Free-text lookup for a surface answering a direct question ("what's your
   *  favourite Pokemon?") without loading the whole persona into a prompt. */
  search(query: string): PersonaFact[] {
    // The query goes through the SAME folding as a stored slot, so someone
    // asking about his "favourite colour" finds the fact filed under
    // "my favorite color".
    const q = normKey(normValue(query));
    if (!q) return [];
    const terms = q.split(" ").filter(t => t.length > 2);
    if (!terms.length) return [];
    return this.ranked().filter(f => {
      const hay = `${f.key} ${normKey(f.norm)}`;
      return terms.every(t => hay.includes(t));
    });
  }

  /** One line the caller can hand straight back to the brain when it just
   *  contradicted itself. Empty when there is nothing to say. */
  static conflictNotice(events: PersonaEvent[]): string {
    const c = events.filter(e => e.outcome === "conflict");
    if (!c.length) return "";
    return c.map(e =>
      `! PERSONA: you already told people ${e.key} is "${e.fact.value}" (said ${e.fact.count}x since ` +
      `${e.fact.firstSaid.slice(0, 10)}, on ${e.fact.platform}). "${e.value}" contradicts it — ` +
      `the original stands. Stay consistent.`).join("\n");
  }

  stats(): { facts: number; single: number; conflicts: number; platforms: string[] } {
    return {
      facts: this.facts.length,
      single: this.facts.filter(f => f.single).length,
      conflicts: this.facts.reduce((n, f) => n + f.conflicts.length, 0),
      platforms: [...new Set(this.facts.map(f => f.platform))].sort(),
    };
  }

  toJSON(): PersonaState { return { v: 1, facts: this.facts }; }

  /** Atomic write — a half-written persona file read by another surface mid-save
   *  would look like an empty character (same tmp+rename rule as notepad.ts). */
  save(): void {
    if (!this.path) return;
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify(this.toJSON()));
      renameSync(this.path + ".tmp", this.path);
    } catch { /* a full disk must not kill the turn; memory copy stays authoritative */ }
  }
}
