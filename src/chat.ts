// wq#1176 — STREAMER CHAT, one way: Lumen talks to the audience.
//
// ONE-WAY IS A PROPERTY OF THE CODE, NOT A POLICY NOTE. There is no method on
// this class that accepts audience input, the store has no author field to
// spoof, and the HTTP surface in stream.ts answers GET only (405 otherwise).
// Two-way is a later ticket, and it arrives by ADDING an inbound path — not by
// someone discovering that one was already half-wired.
//
// The rate limit is the load-bearing knob. The emulator runs many turns a
// minute, so an unthrottled line-per-turn is a wall of text nobody can read on
// a stream. minIntervalMs spaces them; refusals are cheap and reported back to
// the brain rather than silently swallowed.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export const MAX_TEXT = 240;

export interface ChatMessage {
  id: number;
  t: string;                 // ISO
  text: string;
  kind: "say" | "system";    // say = Lumen; system = harness milestone line
}

export interface ChatState { v: 1; nextId: number; messages: ChatMessage[] }

export interface SayResult {
  ok: boolean;
  reason?: string;           // why a refused line was refused (fed back to the brain)
  message?: ChatMessage;
}

export interface ChatOptions {
  ring?: number;             // messages kept for the overlay
  minIntervalMs?: number;    // spacing between Lumen's own lines
}

export class StreamChat {
  messages: ChatMessage[] = [];
  ring: number;
  minIntervalMs: number;
  refused = 0;
  private nextId = 1;
  private lastSayAt = 0;
  private path: string | null = null;
  /** Injected so probes can drive the rate limiter without sleeping. */
  now: () => number = () => Date.now();

  constructor(opts: ChatOptions = {}) {
    this.ring = Math.max(1, opts.ring ?? 60);
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 45_000);
  }

  bind(path: string): void {
    this.path = path;
    try {
      if (existsSync(path)) {
        const j = JSON.parse(readFileSync(path, "utf8")) as ChatState;
        if (Array.isArray(j.messages)) {
          this.messages = j.messages
            .filter(m => m && typeof m.text === "string")
            .map((m): ChatMessage => ({
              id: Number(m.id) || 0, t: String(m.t ?? ""), text: String(m.text),
              kind: m.kind === "system" ? "system" : "say",
            }))
            .slice(-this.ring);
        }
        this.nextId = Number.isFinite(j.nextId) ? Math.max(1, Math.floor(j.nextId)) : this.messages.length + 1;
      } else {
        mkdirSync(dirname(path), { recursive: true });
      }
    } catch { /* unreadable log = start with an empty panel, never crash */ }
  }

  /** Lumen speaks. Rate-limited and deduped; refusals carry a reason. */
  say(text: string): SayResult {
    const clean = StreamChat.clean(text);
    if (!clean) return this.refuse("empty");
    const last = this.messages[this.messages.length - 1];
    if (last && last.kind === "say" && last.text === clean) return this.refuse("duplicate of your last line");
    const now = this.now();
    const wait = this.minIntervalMs - (now - this.lastSayAt);
    if (this.lastSayAt && wait > 0) {
      return this.refuse(`too soon — chat is rate limited, ${Math.ceil(wait / 1000)}s left`);
    }
    this.lastSayAt = now;
    return { ok: true, message: this.push(clean, "say") };
  }

  /** Harness-authored line (milestones, boot). Not rate limited: the harness
   *  posts on events, not on turns, and it is styled apart on the overlay. */
  system(text: string): SayResult {
    const clean = StreamChat.clean(text);
    if (!clean) return this.refuse("empty");
    return { ok: true, message: this.push(clean, "system") };
  }

  private refuse(reason: string): SayResult {
    this.refused++;
    return { ok: false, reason };
  }

  private push(text: string, kind: ChatMessage["kind"]): ChatMessage {
    const m: ChatMessage = { id: this.nextId++, t: new Date(this.now()).toISOString(), text, kind };
    this.messages.push(m);
    while (this.messages.length > this.ring) this.messages.shift();
    this.save();
    return m;
  }

  /** Newest last, oldest first — the overlay reverses for display. */
  recent(n = 20): ChatMessage[] { return this.messages.slice(-Math.max(1, n)); }

  static clean(text: string): string {
    return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  toJSON(): ChatState { return { v: 1, nextId: this.nextId, messages: this.messages }; }

  save(): void {
    if (!this.path) return;
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify(this.toJSON()));
      renameSync(this.path + ".tmp", this.path);
    } catch { /* the panel is best-effort; a write failure must not kill a turn */ }
  }
}
