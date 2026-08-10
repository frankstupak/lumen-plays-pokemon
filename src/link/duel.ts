// LPP Multiplayer — M4 DUEL: two brains, two BrainProfiles, one link cable.
//
// The point of the whole multiplayer track is MODEL-vs-MODEL: two independent
// Game Boys, each driven by its own model, fighting a real Gen1 link battle.
// This module is only the brain seam — the link itself is battle.ts, verified
// in M3 and unchanged here.
//
// Each side gets its own BrainProfile, configured entirely from the
// environment so a model swap never needs a code edit (the wq#426 rule):
//   LPP_DUEL_A_MODEL / LPP_DUEL_B_MODEL   e.g. qwen36-local, cerebras-oss-120b
//   LPP_DUEL_A_MAXTOK / LPP_DUEL_B_MAXTOK
//   LPP_DUEL_A_EFFORT / LPP_DUEL_B_EFFORT (low|medium|high|none)
//
// DESIGN RULE: a brain may only ever choose a move SLOT. It never touches keys,
// timing or the bus. Everything the link depends on — the no-input window
// during the selection exchange, the one-indexed move cursor, the staleness
// deadman — stays inside LinkBattleSession where it is verified. A confused or
// slow model can lose the battle; it cannot desync the cable.

import { BrainProfile } from "../config";
import { Brain } from "../brain";
import { EventBus } from "../events";
import { moveLabel } from "../moves";
import { BattleView } from "./battle";

export interface DuelBrainStats {
  tag: string;
  model: string;
  calls: number;
  parsed: number;      // replies that yielded a legal slot
  rejected: number;    // unparseable / out of range -> fell back
  picks: number[];     // slot histogram
  promptTokens: number;
  completionTokens: number;
  msTotal: number;
}

const envS = (k: string, d: string) => process.env[k] ?? d;
const envN = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const envEffort = (k: string): "low" | "medium" | "high" | undefined => {
  const v = process.env[k];
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
};

export function duelProfile(tag: "A" | "B", defModel: string): BrainProfile {
  return {
    model: envS(`LPP_DUEL_${tag}_MODEL`, defModel),
    maxTokensOut: envN(`LPP_DUEL_${tag}_MAXTOK`, 1200),
    reasoningEffort: envEffort(`LPP_DUEL_${tag}_EFFORT`) ?? "low",
  };
}

const SYSTEM =
  "You are playing a Pokemon Red/Blue LINK BATTLE against another AI over a Game Boy link cable. " +
  "Choose ONE move for this turn. Think briefly, then end your reply with a line of exactly this form:\n" +
  "MOVE <n>\n" +
  "where <n> is 1, 2, 3 or 4 — the move's position in your list. Nothing after that line.";

function prompt(v: BattleView): string {
  const moves = v.moves
    .map((id, i) => (id ? `  ${i + 1}. ${moveLabel(id)} (PP ${v.pp[i]})` : null))
    .filter(Boolean).join("\n");
  const foeLast = v.lastFoeMove ? `Opponent's last move: ${moveLabel(v.lastFoeMove)}.` : "First turn.";
  return [
    `Turn ${v.turn}.`,
    `You: ${v.myNick} (species #${v.mySpecies}) Lv${v.myLevel}, HP ${v.myHp}/${v.myMaxHp}.`,
    `Opponent: ${v.foeNick} (species #${v.foeSpecies}) Lv${v.foeLevel}, HP ${v.foeHp}/${v.foeMaxHp}.`,
    foeLast,
    "Your moves:",
    moves,
    "",
    "Pick the move most likely to win. Reply ending with: MOVE <n>",
  ].join("\n");
}

/**
 * Last MOVE line wins, so a model that reasons out loud about move 3 and then
 * concludes with move 1 is read as move 1. A bare digit anywhere is accepted as
 * a fallback because small local models drop the keyword; anything else is
 * rejected and the caller falls back to a static slot.
 */
export function parseSlot(text: string): number | null {
  const all = [...text.matchAll(/MOVE\s*([1-4])/gi)];
  if (all.length) return Number(all[all.length - 1][1]) - 1;
  const bare = text.trim().match(/([1-4])\s*$/);
  return bare ? Number(bare[1]) - 1 : null;
}

export class DuelBrain {
  readonly stats: DuelBrainStats;
  private brain: Brain;
  constructor(tag: "A" | "B", private profile: BrainProfile, bus: EventBus,
              private log: (s: string) => void = () => {}) {
    this.brain = new Brain(bus);
    this.stats = { tag, model: profile.model, calls: 0, parsed: 0, rejected: 0,
                   picks: [0, 0, 0, 0], promptTokens: 0, completionTokens: 0, msTotal: 0 };
  }

  /** Returns a slot 0-3, or -1 to tell the session to use its static fallback. */
  async pick(v: BattleView): Promise<number> {
    const t0 = Date.now();
    this.stats.calls++;
    try {
      const { text, usage } = await this.brain.complete(
        [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(v) }],
        this.profile);
      this.stats.promptTokens += usage.prompt ?? 0;
      this.stats.completionTokens += usage.completion ?? 0;
      const slot = parseSlot(text);
      if (slot === null || !v.moves[slot]) {
        this.stats.rejected++;
        // Log the reply, trimmed. A rejected pick is a PROMPT/model problem and
        // the only way to tell a truncated reasoning dump from a model that
        // simply answered in prose is to see what it actually said.
        this.log(`    ${this.stats.tag} (${this.profile.model}) unparseable reply -> fallback: ` +
          JSON.stringify(text.slice(-220)));
        return -1;
      }
      this.stats.parsed++;
      this.stats.picks[slot]++;
      this.log(`    ${this.stats.tag} (${this.profile.model}) turn ${v.turn}: ` +
        `${moveLabel(v.moves[slot])} [slot ${slot + 1}]`);
      return slot;
    } catch (e) {
      this.stats.rejected++;
      this.log(`    ${this.stats.tag} (${this.profile.model}) brain error: ${e}`);
      return -1;
    } finally {
      this.stats.msTotal += Date.now() - t0;
    }
  }
}
