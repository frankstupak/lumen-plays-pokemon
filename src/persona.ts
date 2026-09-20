// wq#1176/wq#1191 — PERSONA MEMORY: what Lumen has said about HIMSELF, on any
// surface.
//
// The notepad (notepad.ts) is about the GAME: where he is, what he owns, what he
// plans. This store is about the CHARACTER, and the two have opposite retention
// rules. A notepad fact goes stale the moment the game moves ("my HP is low"); a
// persona fact stays true until he genuinely changes his mind about it — if
// Lumen tells the stream his favourite Pokemon is Bulbasaur, the answer he gives
// on Messenger three weeks later has to be Bulbasaur, or he is not a character,
// he is a chatbot.
//
// CROSS-PLATFORM is the whole point, so the facts live in lumen_state, the
// FLEET's bi-temporal store (persona_store.ts), under subject `lumen-persona`.
// Every surface — the live agent, the streamer chat, a Messenger bridge, an
// operator running `lumen_state.py current lumen-persona` — reads the same rows.
// wq#1176 kept them in a JSON file inside this repo, which is precisely the
// single-platform silo the requirement forbids.
//
// TWO WRITES ARE NOT THE SAME WRITE. Contradicting a fact he stated TODAY is a
// character breaking, and it is refused and reported back to the brain. Stating
// something different about a slot he set on an EARLIER DAY is a change of mind,
// which is a legitimate thing for a character to do: it becomes a new row with a
// new valid-from, the new value is current, and the old one stays queryable as
// what was true then. wq#1176 had no valid-from dimension at all, so its first
// answer was frozen forever and nothing could ever be revised.
//
// EXTRACTION IS NARROW BY POLICY, NOT BY MECHANISM. The mechanism is a model
// (persona_llm.ts) asked whether a line asserted a durable self-fact; the policy
// is the guards below, which every proposal — regex or model — must pass. A
// false canonical fact is far worse than a missed one: it is a lie the character
// then has to keep telling.
import { readFileSync, renameSync, existsSync } from "fs";
import { CFG } from "./config";
import { isMetaText } from "./meta_text";
import {
  LumenStateStore, MemoryPersonaStore, PersonaStore,
  decodePredicate, decodeSource, encodePredicate, encodeSource, today,
} from "./persona_store";

export const MAX_FACTS = 200;          // recall-view ceiling; the store keeps everything
export const RECALL_BUDGET = 900;      // chars of persona injected into a prompt
export const MAX_VALUE_CHARS = 160;
export const MAX_CONFLICTS = 5;        // per fact; enough to see a pattern, not a log
export const MAX_KEY_CHARS = 48;
/** Values kept per SET-VALUED slot in the recall view. "i am" is a slot whose
 *  members accumulate, and a slot that accumulated freely spent the whole
 *  900-char recall budget on itself — 36 rows of it, in the first live week. */
export const MAX_SET_MEMBERS = 6;

/** A restatement that CONTRADICTED a fact stated the SAME day. Kept locally,
 *  never ingested: the canonical value stands (see observe()). */
export interface PersonaConflict { value: string; raw: string; at: string; platform: string }

export interface PersonaFact {
  /** canonical slot, e.g. "my name", "i am", "i like" */
  key: string;
  /** the lumen_state predicate this fact lives at */
  predicate: string;
  /** the currently-true value (display form) */
  value: string;
  /** normalized value — comparison key, recomputed on load */
  norm: string;
  /** the sentence he actually said. Session-local: lumen_state stores facts,
   *  not transcripts. */
  raw: string;
  /** true = one answer only (name, birthday), so a different answer is either a
   *  contradiction or a change of mind. false = set-valued (likes,
   *  self-descriptions), so values accumulate. */
  single: boolean;
  platform: string;      // where the CURRENT value was said
  /** the day this value became true, from lumen_state. A change of mind moves it. */
  validFrom: string;     // YYYY-MM-DD
  lastSaid: string;      // ISO, session-local
  count: number;         // times stated this session (reaffirmations)
  conflicts: PersonaConflict[];
}

export interface PersonaClaim { key: string; value: string; norm: string; raw: string; single: boolean }
export type PersonaOutcome = "new" | "reaffirmed" | "conflict" | "updated";
export interface PersonaEvent { outcome: PersonaOutcome; key: string; value: string; fact: PersonaFact }
export interface PersonaState { v: 2; subject: string; facts: PersonaFact[] }

/** wq#1176's on-disk shape, read once by the migration and never written again. */
interface LegacyFact {
  key?: unknown; value?: unknown; single?: unknown; platform?: unknown; firstSaid?: unknown;
}

// ── the narrowness guards ────────────────────────────────────────────────────

// Attributes whose value changes as the game runs. "my hp is 12" is a state read
// wearing a persona sentence; canonising it would have Lumen insisting on a
// hit-point total from last month.
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
// "my favourite pokemon" and "my favorite pokemon" are one question, and a store
// that answers them separately has two favourites and detects no contradiction
// between them — which is precisely the bug this file exists to prevent.
// Explicit list rather than a general -our/-or rule, which would eat "hour",
// "four" and "your".
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
    .replace(/[^a-z0-9\s'-]/g, " ")                     // no underscores: they mark set members
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

/**
 * The one gate every proposed fact passes, whoever proposed it. Returns null
 * for anything that is not a durable first-person claim.
 *
 * The transient-state guard applies only to the copular slot ("i am"), because
 * that is the only slot where a preposition means a passing state: "I am at
 * Viridian" is where he is standing, while "i was built: by Frank" is an origin
 * and must survive.
 */
export function buildClaim(key: string, rawValue: string, raw: string, single: boolean): PersonaClaim | null {
  const k = normKey(key);
  if (!k || k.length > MAX_KEY_CHARS) return null;
  if (!/^(?:my|i)\b/.test(k)) return null;                  // first person or nothing
  const attr = k.replace(/^(?:my|i)\s+/, "");
  if (isVolatileAttr(attr) || isVolatileAttr(k)) return null;
  if ((k === "i am" || k === "i") && isTransientState(rawValue)) return null;
  const value = displayValue(rawValue);
  const norm = normValue(value);
  if (norm.length < 2) return null;
  // A model restating its own instructions is not Lumen telling you something
  // about himself, and canonising it is how lumen-persona ended up holding
  // "i am: Lumen, a Pokemon streamer, dry and tired, one sentence about a film
  // or show I watched recently, not tied to the game" (wq#1176). The gate is on
  // the VALUE and the KEY, not the surrounding sentence: extraction hands us
  // fragments, and the fragment is what becomes the fact.
  if (isMetaText(value) || isMetaText(k)) return null;
  // Run-on self-description, same root cause seen from the other side: a
  // legitimate copular fact is short ("an AI", "a dry, tired streamer"). Five
  // clauses of adjectives is the system prompt being read back, and every
  // rephrasing of it opens ANOTHER set-valued row (36 of them, before this).
  if (!single && isSelfDescription(k) && isRunOn(value)) return null;
  return { key: k, value, norm, raw: String(raw ?? "").trim().slice(0, 240), single };
}

/** The copular slot: "i am X" / "i'm X". The one slot whose values are adjective
 *  piles rather than distinct claims, which is why it needs its own rules. */
export function isSelfDescription(key: string): boolean {
  return key === "i am" || key === "i";
}

/** Too many clauses to be one thing he believes about himself. */
export function isRunOn(value: string): boolean {
  const commas = (value.match(/,/g) ?? []).length;
  return commas >= 3 || normValue(value).split(" ").length > 9;
}

/**
 * ZERO-COST FAST PATH. The four sentence shapes wq#1176 shipped, kept because
 * they are free and deterministic — a plain "My name is Lumen" never needs a
 * model. They are no longer the whole mechanism: persona_llm.ts asks the real
 * question about everything they miss.
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
      const c = buildClaim(`my ${m[1].trim()}`, m[2], s, true);
      if (c) out.push(c);
      continue;
    }
    // "I go by Lumen" / "I call myself Lumen" — same slot as "my name is".
    if ((m = s.match(/^i\s+(?:go\s+by|call\s+myself)\s+(.{2,})$/i))) {
      const c = buildClaim("my name", m[1], s, true);
      if (c) out.push(c);
      continue;
    }
    // "I was built by Frank" — origin facts, single-valued.
    if ((m = s.match(new RegExp(`^i\\s+was\\s+(${PAST_STATES})\\s+(.{2,})$`, "i")))) {
      const c = buildClaim(`i was ${m[1]}`, m[2], s, true);
      if (c) out.push(c);
      continue;
    }
    // "I don't like caves" — negated preferences get their own slot so they can
    // never be confused with the positive one.
    if ((m = s.match(new RegExp(`^i\\s+(?:do\\s+not|don'?t|never)\\s+(${PREF_VERBS})\\s+(.{2,})$`, "i")))) {
      const c = buildClaim(`i do not ${m[1]}`, m[2], s, false);
      if (c) out.push(c);
      continue;
    }
    // "I like caves", "I hate Zubat" — set-valued, they accumulate.
    if ((m = s.match(new RegExp(`^i\\s+(${PREF_VERBS})\\s+(.{2,})$`, "i")))) {
      const c = buildClaim(`i ${m[1]}`, m[2], s, false);
      if (c) out.push(c);
      continue;
    }
    // "I am an AI" — set-valued self-description, minus passing states.
    if ((m = s.match(/^i\s*(?:am|'m)\s+(.{2,})$/i))) {
      const c = buildClaim("i am", m[1], s, false);
      if (c) out.push(c);
    }
  }
  return out;
}

/** Same fact said two ways. Word-set equality catches "a red Camaro" vs "red
 *  Camaro" and "Mt Moon" vs "mt. moon" after normalization; anything looser
 *  would merge "caves" into "caves at night", which are different claims. */
export function nearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = a.split(" ").filter(Boolean).sort();
  const tb = b.split(" ").filter(Boolean).sort();
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

/**
 * Two values in the SAME set-valued slot that are the same claim.
 *
 * Word-set equality (nearDuplicate) is the general rule and stays deliberately
 * tight: "caves" and "caves at night" are different things to like. The copular
 * slot is the exception, because its values are adjective piles rather than
 * distinct claims — "a dry, tired streamer" and "a dry, tired Pokemon streamer"
 * are one self-description said twice, and filing them separately is how one
 * slot grew 36 rows. There, containment in either direction is sameness.
 */
export function sameSetMember(key: string, a: string, b: string): boolean {
  if (nearDuplicate(a, b)) return true;
  if (!isSelfDescription(key)) return false;
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

/** Model-backed extraction, injected by the surface (live_agent, persona_cli).
 *  persona.ts must not import persona_llm: the LLM path is optional and the
 *  store has to work on a machine with no gateway at all. */
export type PersonaExtractor = (text: string) => Promise<PersonaClaim[]>;

// ── the store ────────────────────────────────────────────────────────────────

export class PersonaMemory {
  /** The recall view: lumen_state's open rows plus session-local metadata.
   *  A cache, never the source of truth (see refresh). */
  facts: PersonaFact[] = [];
  /** Unbound instances are process-local on purpose — a PersonaMemory that
   *  spawned python at construction would put probe facts in fleet state. */
  store: PersonaStore = new MemoryPersonaStore();
  /** Injected so probes can pin bi-temporal behaviour without waiting a day. */
  now: () => Date = () => new Date();
  /** Set by the surface to enable model extraction; null = regex fast path only. */
  extractor: PersonaExtractor | null = null;
  /** Reads that failed (store unreachable). Visible in stats() rather than
   *  swallowed: a persona that has quietly stopped reading fleet state looks
   *  exactly like a persona with nothing to say. */
  storeErrors = 0;
  /** Rows the last read held back: scaffolding, run-on self-description, or a
   *  set slot over its ceiling. Nonzero is not an error — it is the guard
   *  working — but a number that climbs says the writer upstream is sick. */
  suppressed = 0;
  private lastRead = 0;
  private cacheTtlMs = CFG.persona.cacheTtlMs;

  /**
   * Attach the FLEET store and load it. `legacyPath` is wq#1176's JSON file: if
   * it is still there its facts are migrated into lumen_state once and the file
   * is renamed aside, so the character does not lose everything he said before
   * this rework.
   *
   * Same contract as Notepad.bind — an unreachable store starts empty rather
   * than killing whatever surface is booting.
   */
  bind(legacyPath = CFG.persona.path): void {
    this.store = new LumenStateStore();
    this.refresh(true);
    // One bounded read decides whether Minerva is actually there — an adapter
    // file that exists proves nothing about the interpreter, the module or the
    // database behind it. A failure leaves the fleet store attached rather than
    // falling back to something process-local: an outage should heal on the
    // next refresh, not quietly turn the character into a silo again.
    if (this.storeErrors > 0) return;
    try { this.migrateLegacy(legacyPath); } catch { /* never block a boot on a migration */ }
    this.refresh(true);
  }

  /** Explicit store, for probes and for a surface that already has one. */
  useStore(store: PersonaStore): void {
    this.store = store;
    this.facts = [];
    this.refresh(true);
  }

  /**
   * wq#1176 -> wq#1191, once. Each legacy fact is ingested at the day it was
   * FIRST said, so the fleet store inherits a real history rather than a wall of
   * facts that all became true the day of the migration. The file is renamed
   * (not deleted) afterwards: the rename is the idempotency marker, and a human
   * can still read what was there.
   */
  migrateLegacy(path: string): number {
    if (!path || !existsSync(path)) return 0;
    let legacy: LegacyFact[] = [];
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      legacy = Array.isArray(j?.facts) ? j.facts : [];
    } catch { return 0; }
    let n = 0;
    for (const f of legacy) {
      if (typeof f?.key !== "string" || typeof f?.value !== "string") continue;
      const c = buildClaim(f.key, f.value, String(f.value), f.single !== false);
      if (!c) continue;
      const at = typeof f.firstSaid === "string" && /^\d{4}-\d{2}-\d{2}/.test(f.firstSaid)
        ? f.firstSaid.slice(0, 10) : today(this.now());
      try {
        this.store.ingest({
          predicate: encodePredicate(c.key, c.single, c.norm),
          value: c.value,
          validFrom: at,
          source: encodeSource(typeof f.platform === "string" ? f.platform : "unknown"),
        });
        n++;
      } catch { return n; }     // store is down: leave the file for the next boot
    }
    try { renameSync(path, `${path}.migrated-${today(this.now())}`); } catch { /* re-migrating is a no-op */ }
    return n;
  }

  /**
   * Pull the open rows and rebuild the recall view. Session-local metadata
   * (restatement count, refused contradictions, the raw sentence) is carried
   * across, because lumen_state stores facts and none of that is a fact.
   */
  refresh(force = false): void {
    const now = this.now().getTime();
    if (!force && now - this.lastRead < this.cacheTtlMs) return;
    let rows;
    this.lastRead = now;    // set BEFORE the read: a store that is down must cost
                            // one bounded subprocess per TTL, not one per recall
    try {
      rows = this.store.current();
    } catch { this.storeErrors++; return; }
    const prior = new Map(this.facts.map(f => [f.predicate, f]));
    this.facts = rows.map(r => {
      const { key, single } = decodePredicate(r.predicate);
      const p = prior.get(r.predicate);
      const changed = p ? p.value !== r.value : true;
      return {
        key: normKey(key),
        predicate: r.predicate,
        value: r.value,
        // recomputed, never trusted from the store: normalization is code, and
        // code changes.
        norm: normValue(r.value),
        raw: p && !changed ? p.raw : r.value,
        single,
        platform: decodeSource(r.source),
        validFrom: r.validFrom,
        lastSaid: p && !changed ? p.lastSaid : `${r.validFrom}T00:00:00.000Z`,
        count: p && !changed ? p.count : 1,
        conflicts: p && !changed ? p.conflicts : [],
      };
    });
    this.facts = this.quarantine(this.facts);
    this.trimView();
  }

  /**
   * The READ-SIDE half of the scaffolding guard.
   *
   * buildClaim stops new junk being written, but lumen_state already holds a
   * week of it — 36 `i_am__*` rows, several of them the topic mixer's
   * instructions in a fact's clothes — and those rows are loaded into the
   * generator prompt and the Messenger prompt on every single call. Filtering
   * on READ fixes both surfaces immediately and without touching fleet state:
   * nothing is deleted, the rows stay queryable for an audit, and if this
   * judgement is ever wrong the fix is a deploy, not a restore.
   *
   * Also the per-slot ceiling: a set-valued slot is allowed to accumulate, but
   * not to eat the recall budget. Shortest values first (a clean descriptor is
   * what a persona slot is for), then the ones he has held longest.
   */
  private quarantine(facts: PersonaFact[]): PersonaFact[] {
    const kept: PersonaFact[] = [];
    let dropped = 0;
    for (const f of facts) {
      if (isMetaText(f.value) || (isSelfDescription(f.key) && isRunOn(f.value))) { dropped++; continue; }
      kept.push(f);
    }
    this.suppressed = dropped;

    const sets = new Map<string, PersonaFact[]>();
    const out: PersonaFact[] = [];
    for (const f of kept) {
      if (f.single) { out.push(f); continue; }
      const arr = sets.get(f.key);
      if (arr) arr.push(f); else sets.set(f.key, [f]);
    }
    for (const arr of sets.values()) {
      arr.sort((a, b) => a.value.length - b.value.length ||
        (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
      this.suppressed += Math.max(0, arr.length - MAX_SET_MEMBERS);
      out.push(...arr.slice(0, MAX_SET_MEMBERS));
    }
    return out;
  }

  /**
   * THE ONE WRITE PATH. Feed it anything Lumen said — a chat line, a note, a
   * Messenger reply — with the platform he said it on.
   *
   * Async because extraction asks a model (persona_llm.ts). With no extractor
   * wired it still resolves on the regex fast path alone, so a surface with no
   * gateway keeps working.
   */
  async observe(text: string, platform: string, source = ""): Promise<PersonaEvent[]> {
    const claims = await this.claims(text);
    return this.apply(claims, platform, source);
  }

  /** Fast path first, model second; the deterministic claim wins a tie, so
   *  turning the model on can add facts but can never change what the regexes
   *  already decided about a slot. */
  private async claims(text: string): Promise<PersonaClaim[]> {
    const fast = extractPersonaClaims(text);
    if (!this.extractor) return fast;
    let modelled: PersonaClaim[] = [];
    try { modelled = await this.extractor(text); } catch { modelled = []; }
    const out = [...fast];
    for (const c of modelled) {
      if (out.some(f => f.key === c.key && (f.single || nearDuplicate(f.norm, c.norm)))) continue;
      out.push(c);
    }
    return out;
  }

  private apply(claims: PersonaClaim[], platform: string, source: string): PersonaEvent[] {
    if (!claims.length) return [];
    this.refresh();
    const day = today(this.now());
    const at = this.now().toISOString();
    const plat = String(platform || "unknown").slice(0, 32);
    const events: PersonaEvent[] = [];
    for (const c of claims) {
      const prior = c.single
        ? this.facts.find(f => f.key === c.key && f.single)
        : this.facts.find(f => f.key === c.key && !f.single && sameSetMember(f.key, f.norm, c.norm));
      const predicate = encodePredicate(c.key, c.single, c.norm);

      if (!prior) {
        const fact = this.write(c, predicate, day, plat, source, at);
        if (fact) events.push({ outcome: "new", key: fact.key, value: fact.value, fact });
        continue;
      }
      if (nearDuplicate(prior.norm, c.norm) || (!c.single && sameSetMember(prior.key, prior.norm, c.norm))) {
        // Reaffirmation. No write: the value in the store is already this one,
        // persona predicates carry no half-life, so an identical ingest would
        // buy nothing but a subprocess on the turn loop.
        prior.count++;
        prior.lastSaid = at;
        events.push({ outcome: "reaffirmed", key: prior.key, value: prior.value, fact: prior });
        continue;
      }
      if (prior.validFrom >= day) {
        // SAME DAY, DIFFERENT ANSWER. He is contradicting something he just
        // said; that is the character breaking, not a change of mind. Refused,
        // recorded, and handed back to the brain by conflictNotice().
        prior.conflicts.push({ value: c.value, raw: c.raw, at, platform: plat });
        if (prior.conflicts.length > MAX_CONFLICTS) prior.conflicts.shift();
        events.push({ outcome: "conflict", key: prior.key, value: c.value, fact: prior });
        continue;
      }
      // A DIFFERENT DAY. People change their minds, and a character who cannot
      // is a bug. New valid-from: the new value is current from today, the old
      // one stays true of the days it was true (lumen_state history/asof).
      const fact = this.write(c, predicate, day, plat, source, at, prior);
      if (fact) events.push({ outcome: "updated", key: fact.key, value: fact.value, fact });
    }
    if (events.length) this.trimView();
    return events;
  }

  /** Ingest, then mirror into the view. A write that did not reach lumen_state
   *  did not happen: caching it locally is how a store becomes a silo again. */
  private write(c: PersonaClaim, predicate: string, day: string, platform: string,
                source: string, at: string, prior?: PersonaFact): PersonaFact | null {
    try {
      this.store.ingest({ predicate, value: c.value, validFrom: day, source: encodeSource(platform) });
    } catch { this.storeErrors++; return null; }
    const fact: PersonaFact = {
      key: c.key, predicate, value: c.value, norm: c.norm,
      raw: source ? `${c.raw} [${source}]` : c.raw,
      single: c.single, platform, validFrom: day, lastSaid: at, count: 1,
      conflicts: prior ? prior.conflicts : [],
    };
    if (prior) this.facts[this.facts.indexOf(prior)] = fact;
    else this.facts.push(fact);
    return fact;
  }

  /** Over the ceiling, drop the least-stated then least-recent facts FROM THE
   *  VIEW. Nothing is deleted from lumen_state — the fleet store is not the
   *  thing under memory pressure, a 900-char prompt block is. */
  private trimView(): void {
    if (this.facts.length <= MAX_FACTS) return;
    this.facts.sort((a, b) => (b.count - a.count) || (Date.parse(b.lastSaid) - Date.parse(a.lastSaid)));
    this.facts = this.facts.slice(0, MAX_FACTS);
  }

  /** Rank for recall: identity slots first, then most-stated, then oldest (a
   *  fact he has held longest is the one an audience will test him on). */
  private ranked(): PersonaFact[] {
    return [...this.facts].sort((a, b) =>
      (Number(b.single) - Number(a.single)) ||
      (b.count - a.count) ||
      (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  }

  /** The block that goes into a prompt on ANY platform. Empty string when
   *  nothing has been said yet — callers append it unconditionally. */
  recall(budget = RECALL_BUDGET): string {
    this.refresh();
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
    this.refresh();
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
   *  contradicted itself. Empty when there is nothing to say — a change of mind
   *  on a later day is not a contradiction and produces no notice. */
  static conflictNotice(events: PersonaEvent[]): string {
    const c = events.filter(e => e.outcome === "conflict");
    if (!c.length) return "";
    return c.map(e =>
      `! PERSONA: you already told people ${e.key} is "${e.fact.value}" (said ${e.fact.count}x since ` +
      `${e.fact.validFrom.slice(0, 10)}, on ${e.fact.platform}). "${e.value}" contradicts it — ` +
      `the original stands. Stay consistent.`).join("\n");
  }

  stats(): { facts: number; single: number; conflicts: number; platforms: string[]; store: string; storeErrors: number; suppressed: number } {
    return {
      facts: this.facts.length,
      single: this.facts.filter(f => f.single).length,
      conflicts: this.facts.reduce((n, f) => n + f.conflicts.length, 0),
      platforms: [...new Set(this.facts.map(f => f.platform))].sort(),
      store: this.store.kind,
      storeErrors: this.storeErrors,
      suppressed: this.suppressed,
    };
  }

  toJSON(): PersonaState { return { v: 2, subject: CFG.persona.subject, facts: this.facts }; }
}
