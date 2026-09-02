// wq#1181 (LPP roadmap item 6): the loss ledger, generalized engagement gates
// and the grind governor — the machinery that turns "we keep losing this exact
// fight" into "stop walking back into it, grind a bounded amount, then try
// again".
//
// WHY THIS EXISTS. FIGHT_LOSS_LOOP is the campaign's most expensive stall: walk
// into a gym, lose, walk to the center, walk back into the gym, lose. The
// existing counter is guidance.ts's mistyGymEntryRefusal — a HARDCODED gate for
// one leader with hardcoded thresholds. This module is the same idea with the
// leader's name taken out: any repeatedly-lost engagement (a gym, a specific
// trainer, a route's wild encounters) earns a gate keyed by a string the caller
// chooses.
//
// EVERY GATE EXPIRES — three independent ways, because wq#517 taught us that a
// gate with one release condition is a permanent gate the first time that
// condition is unreachable:
//   1. TIME. gateUntil is an absolute deadline. Past it, the gate is gone.
//   2. PROGRESS. The gate stores the progress signature that armed it; any
//      change (level, party size, badges, event count) releases it immediately —
//      the thing the gate asked for has happened.
//   3. ARM CAP. A key that has already armed `maxArms` gates never gates again.
//      If three grind cycles did not fix the matchup, the gate is not the
//      remedy and blocking further attempts is pure turn-waste.
// A win on the key also clears it outright.
//
// Everything here is pure except load()/save(); zero model calls by design.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface GateConfig {
  /** Losses on one key before a gate arms. */
  after: number;
  /** How long an armed gate holds before it expires on its own. */
  ttlMs: number;
  /** Hard cap on how many times ONE key may ever arm a gate. */
  maxArms: number;
  /** Losses older than this stop counting toward `after`. */
  windowMs: number;
}

export const DEFAULT_GATE: GateConfig = {
  after: 2,
  ttlMs: 45 * 60_000,
  maxArms: 3,
  windowMs: 3 * 60 * 60_000,
};

export interface LossEntry {
  key: string;
  /** Losses inside the current window — reset by a win or by an armed gate. */
  losses: number;
  totalLosses: number;
  firstAt: number;
  lastAt: number;
  /** Absolute epoch ms the gate expires; 0 when no gate is armed. */
  gateUntil: number;
  /** Progress signature captured when the gate armed. */
  sig: string;
  /** Gates ever armed on this key (never reset — it is the arm-cap counter). */
  arms: number;
  reason: string;
}

export interface GateVerdict {
  blocked: boolean;
  /** Why it is blocked, or why an existing gate just lifted. */
  reason: string;
  until: number;
  /** Set when this call released a gate, so the caller can log it once. */
  lifted?: "expired" | "progress" | "arm_cap" | "win";
}

/** Engagement keys are opaque strings; these builders keep them consistent so a
 *  loss recorded inside a gym and the re-entry check at its door agree on
 *  spelling. The MAP is the discriminator on purpose: FIGHT_LOSS_LOOP is a
 *  place-shaped stall (walk into map65, lose, walk back into map65), and the
 *  map id is the one identifier available both mid-battle and at the door. */
export const engagementKey = {
  trainerMap: (map: number) => `trainer:${map}`,
  wildMap: (map: number) => `wild:${map}`,
};

/** The progress signature a gate is measured against. Any change releases it,
 *  so it must contain exactly the things a grind can move. */
export function progressSig(p: { level: number; partyCount: number; badges: number; events: number }): string {
  return `L${p.level}/P${p.partyCount}/B${p.badges}/E${p.events}`;
}

export class LossLedger {
  readonly entries = new Map<string, LossEntry>();

  private entry(key: string, now: number): LossEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { key, losses: 0, totalLosses: 0, firstAt: now, lastAt: now,
            gateUntil: 0, sig: "", arms: 0, reason: "" };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Record a loss. Arms a gate once `cfg.after` losses land inside the window
   *  and the key still has arms left. Returns the updated entry. */
  noteLoss(key: string, now: number, sig: string, cfg: GateConfig = DEFAULT_GATE): LossEntry {
    const e = this.entry(key, now);
    if (now - e.lastAt > cfg.windowMs) e.losses = 0;   // stale run: start over
    e.losses++;
    e.totalLosses++;
    e.lastAt = now;
    if (e.losses >= cfg.after && e.gateUntil === 0 && e.arms < cfg.maxArms) {
      e.arms++;
      e.gateUntil = now + cfg.ttlMs;
      e.sig = sig;
      e.losses = 0;    // the gate IS the response to this run; start a fresh one
      e.reason = `lost ${cfg.after}x here without progress`;
    }
    return e;
  }

  /** A win clears the loss run and any gate: the matchup is beaten. */
  noteWin(key: string, now: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.losses = 0;
    e.lastAt = now;
    e.gateUntil = 0;
    e.reason = "";
  }

  /** Is this engagement gated right now? Also performs expiry — the three
   *  release paths live here so every caller gets them for free. */
  gate(key: string, now: number, sig: string, cfg: GateConfig = DEFAULT_GATE): GateVerdict {
    const e = this.entries.get(key);
    if (!e || e.gateUntil === 0) return { blocked: false, reason: "no gate", until: 0 };
    if (now >= e.gateUntil) {
      e.gateUntil = 0;
      return { blocked: false, reason: "gate expired on time", until: 0, lifted: "expired" };
    }
    if (sig && e.sig && sig !== e.sig) {
      e.gateUntil = 0;
      return { blocked: false, reason: `progress since the gate armed (${e.sig} -> ${sig})`, until: 0, lifted: "progress" };
    }
    // noteLoss already refuses to arm past the cap, so this only fires for a
    // ledger persisted under a larger maxArms and reloaded under a smaller one —
    // a config shrink must release the gates it just invalidated, not strand them.
    if (e.arms > cfg.maxArms) {
      e.gateUntil = 0;
      return { blocked: false, reason: `arm cap ${cfg.maxArms} reached - gating is not the remedy here`, until: 0, lifted: "arm_cap" };
    }
    const mins = Math.max(1, Math.ceil((e.gateUntil - now) / 60_000));
    return {
      blocked: true, until: e.gateUntil,
      reason: `${e.reason} (${e.totalLosses} total); gate ${e.arms}/${cfg.maxArms} holds ~${mins}min ` +
        `or until you level up / add a party member`,
    };
  }

  /** Drop entries untouched for `maxAgeMs`, so the file cannot grow forever. */
  prune(now: number, maxAgeMs = 24 * 60 * 60_000): void {
    for (const [k, e] of this.entries)
      if (now - e.lastAt > maxAgeMs && e.gateUntil === 0) this.entries.delete(k);
  }

  toJSON(): LossEntry[] { return [...this.entries.values()]; }

  static fromJSON(rows: unknown): LossLedger {
    const l = new LossLedger();
    if (!Array.isArray(rows)) return l;
    for (const r of rows) {
      if (!r || typeof r.key !== "string") continue;
      l.entries.set(r.key, {
        key: r.key,
        losses: Number(r.losses) || 0,
        totalLosses: Number(r.totalLosses) || 0,
        firstAt: Number(r.firstAt) || 0,
        lastAt: Number(r.lastAt) || 0,
        gateUntil: Number(r.gateUntil) || 0,
        sig: typeof r.sig === "string" ? r.sig : "",
        arms: Number(r.arms) || 0,
        reason: typeof r.reason === "string" ? r.reason : "",
      });
    }
    return l;
  }

  /** Best-effort persistence. A ledger failure must never take a turn down, so
   *  both directions swallow their errors and degrade to an empty ledger. */
  static load(file: string): LossLedger {
    try { return LossLedger.fromJSON(JSON.parse(readFileSync(file, "utf8"))); }
    catch { return new LossLedger(); }
  }

  save(file: string): void {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(this.toJSON(), null, 2));
    } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// GRIND GOVERNOR
//
// A gate without a bounded remedy is just a wall. When a gate arms, the governor
// starts a grind with an explicit finish line, and — this is the point — its own
// deadline. Grinding forever is the same turn-waste as losing forever; wq#517's
// lesson applies to the remedy exactly as it applies to the gate.

export interface GrindConfig {
  /** Levels above the starting level that finish the grind. */
  levels: number;
  /** Hard deadline. Past it the grind is done regardless of levels gained. */
  maxMs: number;
}

export const DEFAULT_GRIND: GrindConfig = { levels: 2, maxMs: 60 * 60_000 };

export interface GrindState {
  key: string;
  startedAt: number;
  startLevel: number;
  startParty: number;
}

export interface GrindStatus {
  done: boolean;
  reason: string;
  line: string;
}

export function startGrind(key: string, now: number, level: number, partyCount: number): GrindState {
  return { key, startedAt: now, startLevel: level, startParty: partyCount };
}

/** Has the grind earned its way out? Three exits, mirroring the gate: the level
 *  target, a new party member (the counter the gate usually wanted), or the
 *  deadline. */
export function grindStatus(g: GrindState, now: number, level: number, partyCount: number,
                            cfg: GrindConfig = DEFAULT_GRIND): GrindStatus {
  const target = g.startLevel + cfg.levels;
  if (partyCount > g.startParty)
    return { done: true, reason: "new party member", line: `GRIND DONE - party grew to ${partyCount}; re-engage ${g.key}` };
  if (level >= target)
    return { done: true, reason: "level target", line: `GRIND DONE - lead reached L${level} (target L${target}); re-engage ${g.key}` };
  if (now - g.startedAt >= cfg.maxMs)
    return { done: true, reason: "deadline", line: `GRIND DONE - ${Math.round(cfg.maxMs / 60_000)}min budget spent; re-engage ${g.key} and see what happens` };
  const mins = Math.max(1, Math.ceil((cfg.maxMs - (now - g.startedAt)) / 60_000));
  return {
    done: false, reason: "in progress",
    line: `GRIND IN PROGRESS for ${g.key}: lead L${level} -> L${target}, or catch a body ` +
      `(party ${partyCount} -> ${partyCount + 1}). ~${mins}min of budget left, then re-engage regardless.`,
  };
}
