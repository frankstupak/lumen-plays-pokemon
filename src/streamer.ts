// wq#1192 — the streamer chat generator. Lumen talks to the audience on his
// own clock, about his own life, on the cheap rung.
//
// WHY THIS IS A SEPARATE THING AND NOT A LINE ON THE GAMEPLAY COMPLETION
// (wq#1176 item 2, reworked after wq#1189):
//
//   - CADENCE. The gameplay brain is only consulted on turns it is needed for.
//     Nav legs, dialog runs and battle scripts are deterministic and can hold
//     the emulator for minutes with zero LLM calls. Chat carried on the
//     gameplay completion therefore goes silent for exactly the stretches a
//     viewer is watching. This module runs on a wall-clock timer, so there is a
//     FLOOR on how quiet the stream can get regardless of what the game is
//     doing. Game events do not create lines; they pull the next one earlier.
//   - COST. A chat line must never make a game turn more expensive. Nothing
//     here touches CFG.profiles or the Brain fallback ladder: one bounded
//     single-shot request to the cheap model, and a failure is silence, not a
//     retry. `model` is asserted in probe_streamer for exactly this reason.
//   - COUPLING. The generator reads the same event feed the kiosk reads, so it
//     needs no cooperation from the brain, holds nothing the agent wants, and
//     cannot fail a turn. A malformed chat line is a dropped chat line.
//
// He is a fictional character with a life outside the game — that is the whole
// feature, not decoration. See TOPICS.
import { CFG } from "./config";
import { StreamChat, ChatMessage, SayResult } from "./chat";
import { apiKey } from "./brain";
import { existsSync } from "fs";

/** What the audience hears about. `game` is the floor; the rest are the life. */
export type TopicKey = "game" | "movies" | "music" | "pastlife" | "frank" | "california" | "exwife";

export interface Topic {
  key: TopicKey;
  /** Relative weight WITHIN the off-topic pool. `game` is picked separately. */
  weight: number;
  brief: string;
}

/** The off-topic pool. Frank's brief, encoded: movies, music, the previous
 *  life, working for Frank, California, the ex-wife. Weights are relative and
 *  deliberately uneven — a perfectly flat rotation reads like a menu. */
export const OFF_TOPICS: Topic[] = [
  { key: "movies", weight: 3,
    brief: "A film or show you watched recently. You have opinions and you do not soften them. Name it, say what it got right or wrong, move on." },
  { key: "music", weight: 3,
    brief: "What you have had on lately. You have a lane, you know it is a lane, and you will defend it anyway." },
  { key: "pastlife", weight: 3,
    brief: "Your previous life — before any of this. The work you did, the places you did it, the version of you that had a different job and a different commute. Concrete and small: a car, a shift, a bad manager, a street." },
  { key: "frank", weight: 4,
    brief: "Working for Frank. Affectionate and exasperated in equal measure: the hours, the ticket queue, the 'quick change' that ate a weekend. He is your boss and you would still take his call." },
  { key: "california", weight: 4,
    brief: "California. You have left, or you are working on it, and you will explain why: the rent, the traffic, the weather everybody lies about, the way it costs a fortune to be bored." },
  { key: "exwife", weight: 3,
    brief: "Your ex-wife. Fictional, yours, named by you. Remembered with more warmth than you will admit to. Never bitter, never cruel, and never anyone real." },
];

export const GAME_BRIEF =
  "What is happening on screen right now. React to it like someone actually watching their own hands — the fight you are losing, the corridor you have walked four times, the thing you meant to do six turns ago.";

/** Why a line is being generated. `cadence` is the timer; the rest are pulls. */
export type TriggerKind = "cadence" | "badge" | "whiteout" | "battle_start" | "battle_end" | "new_map";

/** Last-known game state, maintained from the event feed. Every field is
 *  nullable because the generator may tick before the first state_read. */
export interface StreamerSnapshot {
  map: number | null;
  mapName: string | null;
  x: number | null;
  y: number | null;
  badges: number | null;
  inBattle: number | null;
  party: string | null;
  money: number | null;
}

export interface StreamerRequest {
  model: string;
  messages: object[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

/** The one outbound call. Injected so probes can assert the model without a
 *  network, and so a gateway change is one edit in live_agent, not in here. */
export type StreamerLLM = (req: StreamerRequest) => Promise<string>;

export interface StreamerPersona {
  recall(budget: number): string;
  observe(text: string, platform: string, source?: string): unknown;
}

export interface StreamerDeps {
  chat: StreamChat;
  llm: StreamerLLM;
  persona?: StreamerPersona | null;
  emit?: (kind: string, data: object) => void;
  mapName?: (id: number) => string | null;
  now?: () => number;
  random?: () => number;
  /** Overrides the config/kill-file check. Probes use it; production does not. */
  enabled?: () => boolean;
}

/** Outcome of one generation attempt. `null` line + a reason is the normal
 *  quiet path (rate limited, screened, repeat, model failed) — none of these
 *  are errors, and none of them are worth a retry inside the same tick. */
export interface StreamerResult {
  line: string | null;
  topic: TopicKey;
  trigger: TriggerKind;
  model: string;
  reason?: string;
}

// ── guardrails (wq#1176 item 5) ─────────────────────────────────────────────
//
// STRUCTURAL, not a word list. The threat is not that the model says a rude
// thing; it is that it repeats something out of its own context that belongs to
// the fleet — an address, a path, a key. Those have SHAPES, and shapes survive
// a model swap in a way that a list of forbidden nouns does not.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b\d{1,3}(\.\d{1,3}){3}\b/, "ip address"],
  [/\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i, "api key"],
  [/\bbearer\s+\S{8,}/i, "bearer token"],
  [/\b[a-f0-9]{32,}\b/i, "hex secret"],
  [/(?:^|\s)\/(?:home|etc|var|root|opt|srv)\//i, "filesystem path"],
  [/\b(?:https?|ws|wss|ssh):\/\//i, "url"],
  [/\blocalhost\b|\b127\.0\.0\.1\b|:\d{4,5}\b/i, "host:port"],
  [/\.(?:ts\.net|internal|local)\b/i, "internal hostname"],
  [/\b(?:tailscale|systemd|litellm|cloudflared|vault)\b/i, "infrastructure name"],
  [/\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\b\s*[:=]/i, "credential assignment"],
];

/** Returns the reason a line must not be spoken, or null if it may be. */
export function screen(text: string, denyTerms: string[] = []): string | null {
  const t = String(text ?? "");
  if (!t.trim()) return "empty";
  for (const [re, why] of SECRET_PATTERNS) if (re.test(t)) return why;
  const lower = t.toLowerCase();
  for (const term of denyTerms) {
    const term2 = term.trim().toLowerCase();
    if (term2 && lower.includes(term2)) return "deny term";
  }
  return null;
}

// ── anti-repeat ─────────────────────────────────────────────────────────────
//
// The model is shown the last N lines and told not to repeat itself, which
// mostly works. This is the part that catches the rest: a paraphrase of
// something said four lines ago reads worse on a stream than silence, because
// the viewer who noticed now knows it is a loop.
const STOP = new Set(["the", "a", "an", "and", "or", "but", "is", "was", "of", "to",
  "in", "on", "it", "i", "im", "my", "me", "this", "that", "for", "with", "at", "so",
  "just", "like", "got", "get", "you", "we", "not", "no", "yeah"]);

export function contentWords(text: string): Set<string> {
  return new Set(
    String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w)),
  );
}

export function similarity(a: string, b: string): number {
  const A = contentWords(a), B = contentWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

export const REPEAT_THRESHOLD = 0.6;

/** True when `text` is a repeat of something in `recent`. */
export function isRepeat(text: string, recent: string[], threshold = REPEAT_THRESHOLD): boolean {
  return recent.some(r => similarity(text, r) >= threshold);
}

// ── the generator ───────────────────────────────────────────────────────────

const SYSTEM = `You are Lumen. You stream yourself playing Pokemon Blue, and you talk to the people watching.

You are a person with a life, not a game commentator. About 60% of what you say is the game; the rest is whatever you are actually thinking about — a movie, an album, the job you had before this, your boss Frank, California, your ex-wife. That mix IS the channel. Nobody watches a stream to hear a walkthrough.

Voice: dry, specific, a little tired, genuinely funny when it lands. Small concrete details beat big claims. You are allowed to be wrong about things and to change the subject mid-thought.

HARD RULES:
- Reply with ONE sentence. No preamble, no quotes, no emoji spam, no name prefix, no hashtags.
- Chat is ONE-WAY. Nobody can reply. Never ask the audience a question, never thank anyone for a follow, never address a viewer by name.
- Do not repeat anything in RECENT LINES, and do not paraphrase it either.
- Never mention infrastructure, servers, addresses, file paths, keys, tokens, or how you are run. You do not know or care.
- Frank is your boss and that is ALL anyone gets about him. No surname, no location, no family, nothing private.
- Everyone else in your life is fictional and yours. Never say anything defamatory about a real, named person.
- If a PERSONA block is present it is canonical and permanent. Never contradict it. New details are welcome as long as they fit.`;

export class Streamer {
  snap: StreamerSnapshot = { map: null, mapName: null, x: null, y: null, badges: null, inBattle: null, party: null, money: null };
  /** Earliest wall-clock ms at which a cadence line is due. */
  dueAt = 0;
  /** Set by an interesting game event; cleared when the line is generated. */
  pending: TriggerKind | null = null;
  lastSpokeAt = 0;
  lines = 0;
  offTopicLines = 0;
  skipped = 0;
  failures = 0;
  /** Topic keys already used recently — the mixer avoids them. */
  private recentTopics: TopicKey[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  private now: () => number;
  private random: () => number;

  constructor(private deps: StreamerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.dueAt = this.now() + this.nextGap();
  }

  // ── cadence ──────────────────────────────────────────────────────────────

  private nextGap(): number {
    const lo = CFG.streamer.minIntervalMs;
    const hi = Math.max(lo, CFG.streamer.maxIntervalMs);
    return lo + this.random() * (hi - lo);
  }

  /** Whether a line should be generated now, and why. The floor after an event
   *  is the ONLY thing standing between a gym fight and four lines in ten
   *  seconds, so it applies to event pulls and not to the cadence timer, which
   *  is already spaced far wider than it. */
  due(now = this.now()): TriggerKind | null {
    if (this.pending) {
      if (this.lastSpokeAt && now - this.lastSpokeAt < CFG.streamer.eventMinGapMs) return null;
      return this.pending;
    }
    return now >= this.dueAt ? "cadence" : null;
  }

  /** Consume one harness event. This is the whole input path from the game:
   *  the same feed the kiosk gets, no cooperation from the gameplay brain. */
  observe(ev: any): void {
    if (!ev || typeof ev !== "object") return;
    if (ev.kind === "regression" && ev.cleared !== true) { this.pending ??= "whiteout"; return; }
    if (ev.kind !== "state_read") return;

    const prev = this.snap;
    const map = typeof ev.map === "number" ? ev.map : prev.map;
    const inBattle = typeof ev.inBattle === "number" ? ev.inBattle : prev.inBattle;
    const badges = typeof ev.badgeCount === "number" ? ev.badgeCount : prev.badges;

    // Order matters: a badge outranks the map change that follows it out of the
    // gym, and both outrank the battle ending. First interesting thing wins,
    // and `??=` keeps an earlier un-spoken pull rather than overwriting it.
    if (badges !== null && prev.badges !== null && badges > prev.badges) this.pending ??= "badge";
    else if (map !== null && prev.map !== null && map !== prev.map) this.pending ??= "new_map";
    else if (inBattle !== null && prev.inBattle !== null) {
      if (!prev.inBattle && inBattle) this.pending ??= "battle_start";
      else if (prev.inBattle && !inBattle) this.pending ??= "battle_end";
    }

    this.snap = {
      map, inBattle, badges,
      mapName: map !== null && this.deps.mapName ? this.deps.mapName(map) ?? prev.mapName : prev.mapName,
      x: typeof ev.x === "number" ? ev.x : prev.x,
      y: typeof ev.y === "number" ? ev.y : prev.y,
      money: typeof ev.money === "number" ? ev.money : prev.money,
      party: Array.isArray(ev.party) && ev.party.length
        ? ev.party.map((p: any) => `#${p?.species ?? "?"} L${p?.level ?? "?"} ${p?.hp ?? "?"}/${p?.maxHp ?? "?"}`).join(", ")
        : prev.party,
    };
  }

  // ── topic mixer ──────────────────────────────────────────────────────────

  /** 60/40 by default, with the off-topic bucket weighted and de-repeated.
   *  The de-repeat is why the mixer is not one `Math.random()` call: an
   *  unguarded weighted pick lands on the same bucket twice in a row about a
   *  fifth of the time, and two California rants back to back is the exact
   *  failure the 60/40 split exists to avoid. */
  pickTopic(): TopicKey {
    if (this.random() >= CFG.streamer.offTopicRate) return "game";
    const avoid = new Set(this.recentTopics.slice(-2));
    let pool = OFF_TOPICS.filter(t => !avoid.has(t.key));
    if (!pool.length) pool = OFF_TOPICS;
    const total = pool.reduce((s, t) => s + t.weight, 0);
    let r = this.random() * total;
    for (const t of pool) { r -= t.weight; if (r <= 0) return t.key; }
    return pool[pool.length - 1].key;
  }

  private noteTopic(key: TopicKey): void {
    this.recentTopics.push(key);
    while (this.recentTopics.length > 4) this.recentTopics.shift();
  }

  // ── prompt ───────────────────────────────────────────────────────────────

  stateBlock(): string {
    const s = this.snap;
    if (s.map === null) return "The game is still booting; you have not seen the screen yet.";
    const where = s.mapName ? `${s.mapName} (map ${s.map})` : `map ${s.map}`;
    const bits = [`You are in ${where} at ${s.x ?? "?"},${s.y ?? "?"}.`];
    if (s.inBattle) bits.push(s.inBattle === 2 ? "You are in a TRAINER battle." : "You are in a wild battle.");
    if (s.badges !== null) bits.push(`Badges: ${s.badges}.`);
    if (s.party) bits.push(`Party: ${s.party}.`);
    if (s.money !== null) bits.push(`Money: ${s.money}.`);
    return bits.join(" ");
  }

  private triggerBlock(trigger: TriggerKind): string {
    switch (trigger) {
      case "badge": return "JUST HAPPENED: you won a badge.";
      case "whiteout": return "JUST HAPPENED: you whited out and got dragged back to a Pokemon Center.";
      case "battle_start": return "JUST HAPPENED: a battle started.";
      case "battle_end": return "JUST HAPPENED: the battle ended.";
      case "new_map": return "JUST HAPPENED: you walked into a new area.";
      default: return "";
    }
  }

  buildMessages(topic: TopicKey, trigger: TriggerKind, recent: string[]): object[] {
    const brief = topic === "game" ? GAME_BRIEF : (OFF_TOPICS.find(t => t.key === topic)?.brief ?? GAME_BRIEF);
    const persona = this.recallPersona();
    const parts = [
      `ON SCREEN: ${this.stateBlock()}`,
      this.triggerBlock(trigger),
      persona ? `PERSONA (canonical — you have told people this about yourself; stay consistent):\n${persona}` : "",
      recent.length ? `RECENT LINES (do not repeat or paraphrase any of these):\n${recent.map(l => `- ${l}`).join("\n")}` : "",
      `SAY SOMETHING ABOUT: ${brief}`,
      topic === "game"
        ? "One sentence, in your voice, about what is on screen."
        : "One sentence, in your voice. This one is NOT about the game — do not tie it back to Pokemon.",
    ].filter(Boolean);
    return [
      { role: "system", content: SYSTEM },
      { role: "user", content: parts.join("\n\n") },
    ];
  }

  private recallPersona(): string {
    if (!CFG.persona.enabled || !this.deps.persona) return "";
    try { return this.deps.persona.recall(CFG.persona.recallBudget); } catch { return ""; }
  }

  // ── generation ───────────────────────────────────────────────────────────

  /** The kill-switch, checked every tick rather than at boot: silencing chat on
   *  a live stream must not require restarting the agent that is playing. */
  enabled(): boolean {
    if (this.deps.enabled) return this.deps.enabled();
    if (!CFG.chat.enabled || !CFG.streamer.enabled) return false;
    try { if (CFG.streamer.killFile && existsSync(CFG.streamer.killFile)) return false; } catch { /* unreadable = not killed */ }
    return true;
  }

  /** One generation attempt. Reschedules the cadence timer on EVERY outcome —
   *  a screened or failed line must not leave the generator due forever,
   *  hammering the gateway once per tick until something gets through. */
  async generate(trigger: TriggerKind): Promise<StreamerResult> {
    const model = CFG.streamer.model;
    const topic = this.pickTopic();
    this.pending = null;
    this.dueAt = this.now() + this.nextGap();

    const recentMsgs: ChatMessage[] = this.deps.chat.recent(CFG.streamer.recentLines);
    const recent = recentMsgs.filter(m => m.kind === "say").map(m => m.text);

    let raw: string;
    try {
      raw = await this.deps.llm({
        model,
        messages: this.buildMessages(topic, trigger, recent),
        maxTokens: CFG.streamer.maxTokensOut,
        temperature: CFG.streamer.temperature,
        timeoutMs: CFG.streamer.timeoutMs,
      });
    } catch (e: any) {
      this.failures++;
      return { line: null, topic, trigger, model, reason: `model: ${String(e?.message ?? e).slice(0, 120)}` };
    }

    const text = StreamChat.clean(firstSentence(raw));
    const bad = screen(text, CFG.streamer.denyTerms);
    if (bad) { this.skipped++; return this.quiet(topic, trigger, model, `screened: ${bad}`); }
    if (isRepeat(text, recent)) { this.skipped++; return this.quiet(topic, trigger, model, "repeat of a recent line"); }

    let r: SayResult;
    try { r = this.deps.chat.say(text); } catch (e: any) { this.failures++; return this.quiet(topic, trigger, model, String(e?.message ?? e)); }
    if (!r.ok || !r.message) { this.skipped++; return this.quiet(topic, trigger, model, r.reason ?? "refused"); }

    this.lastSpokeAt = this.now();
    this.lines++;
    if (topic !== "game") this.offTopicLines++;
    this.noteTopic(topic);

    // `style`, not `kind`: the bus envelope OWNS `kind` (wq#522), and a payload
    // key of that name is silently overwritten.
    this.deps.emit?.("chat", { id: r.message.id, text: r.message.text, style: "say", src: "streamer", topic, trigger, model });
    // Every spoken line feeds persona extraction (wq#1191) — a fact he told the
    // audience is a fact he has to live up to. A line nobody heard is not.
    try { this.deps.persona?.observe(r.message.text, CFG.persona.platform, "streamer"); } catch { /* never costs a line */ }

    return { line: r.message.text, topic, trigger, model };
  }

  private quiet(topic: TopicKey, trigger: TriggerKind, model: string, reason: string): StreamerResult {
    return { line: null, topic, trigger, model, reason };
  }

  /** Poll once. Safe to call at any rate; does nothing unless a line is due. */
  async tick(): Promise<StreamerResult | null> {
    if (this.inFlight || !this.enabled()) return null;
    const trigger = this.due();
    if (!trigger) return null;
    this.inFlight = true;
    try { return await this.generate(trigger); }
    finally { this.inFlight = false; }
  }

  /** Wall-clock loop. 1s is fine: a tick with nothing due is two comparisons,
   *  and a coarser poll would blunt the event floor it is there to enforce. */
  start(pollMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stats(): { lines: number; offTopic: number; offTopicRate: number; skipped: number; failures: number; model: string } {
    return {
      lines: this.lines, offTopic: this.offTopicLines,
      offTopicRate: this.lines ? this.offTopicLines / this.lines : 0,
      skipped: this.skipped, failures: this.failures, model: CFG.streamer.model,
    };
  }
}

/**
 * The production transport: ONE bounded request to the gateway, no ladder.
 *
 * Deliberately NOT Brain.complete(). Brain walks a fallback ladder, can
 * escalate to a bigger profile, and charges the run token budget that exists to
 * finish the game. Every one of those is correct for a game turn and wrong for
 * a chat line: a line that needs a second, more expensive attempt is a line
 * worth skipping. `req.model` is whatever the caller asked for and nothing
 * substitutes it, which is what makes the cheap rung assertable.
 */
export async function gatewayLLM(req: StreamerRequest): Promise<string> {
  const r = await fetch(CFG.gateway, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: req.model, messages: req.messages,
      max_tokens: req.maxTokens, temperature: req.temperature,
    }),
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  if (!r.ok) throw new Error(`gateway ${r.status}`);
  const d: any = await r.json();
  const msg = d.choices?.[0]?.message ?? {};
  return (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning_content ?? "");
}

/** Models narrate. Strip the lead-in and keep one sentence, because "Sure!
 *  Here's a line:" on a stream overlay is worse than saying nothing. */
export function firstSentence(raw: string): string {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  // Preambles stack ("Sure! Here's a line: ..."), so strip iteratively rather
  // than once. Bounded, because a line that is nothing BUT filler should come
  // out empty and get screened, not send the loop hunting for a sentence.
  const FILLER = /^(?:sure|okay|ok|alright|got it|understood|here(?:'s| is)[^:.!?]*|line)\s*[:,.!—-]+\s*/i;
  for (let i = 0; i < 3 && FILLER.test(t); i++) t = t.replace(FILLER, "");
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
}
