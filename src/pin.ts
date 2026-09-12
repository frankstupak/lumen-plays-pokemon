// wq#1840: the supervisor directive's own expiry. src/agent.ts renders
// runtime/supervisor_directive.json's notepadPin as the "!!" line of every
// overworld state block, and wq#724's checkSupervisorLift() clears it on ONE
// condition: storyScore/badgeCount/eventCount rising past the baseline captured
// when it loaded.
//
// THAT IS A LIVENESS BUG, AND IT WAS MEASURED AT FOURTEEN DAYS.
// runtime/supervisor_directive.json held FIGHT_LOSS_LOOP@3, generatedAt
// 2026-08-29T16:44:34Z, attempt 3/3, and was still being printed on 2026-09-12
// with storyScore stuck at 10 since 09-02. The pin's remedy ("CATCH a Pokemon
// whose type is strong against the gym leader's", "WALK into the tall grass")
// is the story advance it is waiting for, so its only exit is the thing it is
// failing to produce. Three further facts make it worse than inert:
//
//   * ITS LADDER HAD ALREADY FINISHED. The supervisor prescribes at most K=3
//     attempts and re-affirms a live stall by REWRITING the file — the
//     WARP_OSC@36 attempts in runtime/intervention_log.json are 1837s apart. At
//     3/3 nothing will ever rewrite it, so an old generatedAt is not a
//     directive under way, it is the residue of one that stopped.
//   * ITS REMEDY WAS UNAFFORDABLE. wq#1829 measured $96 and zero balls across a
//     whole 318-turn run; progressBlock() now says CATCHING IS IMPOSSIBLE in
//     the same state block, two lines under a pin still ordering the catch.
//   * ITS GRASS WAS FORBIDDEN. wq#1731's escape walks the agent OUT of the
//     map35 x=4..5 strip and wq#1828's exclusion refuses goto back IN, while
//     the pin orders it in every turn — the brain cites the pin doing it
//     ("need to catch a Pokemon - priority per directives. I am standing in
//     tall grass", live-agent-1789079257449.jsonl @22:28:15Z).
//
// So a pin gets the shape every other harness override already has (the wq#1181
// ledger's three expiries, wq#1828's exclusion): it RETIRES on age, it is
// SUPPRESSED while the live bag refutes its remedy, and it is QUALIFIED rather
// than left to contradict a live exclusion. Pure and clock-injected so
// src/probe_pin1840.ts can assert every branch with no ROM and no filesystem.

export interface PinCfg {
  /** Hours after `generatedAt` a directive retires, story advance or not. 0 = off. */
  maxHours: number;
  /** Overworld turns a directive with NO parseable `generatedAt` survives. 0 = off. */
  maxTurns: number;
  /** Suppress a pin whose remedy the live bag refutes. */
  contradiction: boolean;
}

/** The directive as loaded, plus when the agent picked it up. `pin` may be
 *  empty — a ban-only directive ages on exactly the same clock, for the same
 *  reason. `loadedTurn` is per-Agent and RESETS on every
 *  gameplay continue (live_agent constructs a fresh Agent in its outer loop —
 *  four `supervisor_directive_loaded` events inside one run file on 2026-09-12),
 *  which is exactly why the wall clock, not the turn counter, is the primary
 *  expiry. The turn cap is the fallback for a file with no timestamp. */
export interface PinnedDirective {
  pin: string;
  mode: string;
  generatedAt?: string;
  loadedTurn: number;
  loadedMs: number;
}

/** The live bag, as the pin's remedy needs it. Required, not defaulted, for
 *  wq#1829's reason: the bug being fixed is a catch directive rendered by code
 *  that had no idea whether catching was possible, and a default preserves it. */
export interface PinRam {
  balls: number;
  money: number;
  ballPrice: number;
}

/** wq#1828's exclusion, as much of it as a pin needs to defer to. */
export interface PinExclusion {
  tiles: number;
  map: number;
  untilTurn: number;
}

/** A pin ordering a CATCH. The FIGHT_LOSS_LOOP prescription is the only one of
 *  the six in tools/lpp_stuck_intervene.py that does, and it says "CATCH an
 *  Oddish/Bellsprout/Paras/Geodude". Exported so the probe pins the match
 *  against that exact wording rather than against a paraphrase of it. */
export const PIN_CATCH_RE = /\bcatch(?:es|ing)?\b/i;

/** A pin ordering the agent into tall grass ("use goto() to WALK into the tall
 *  grass to trigger wild battles"). */
export const PIN_GRASS_RE = /\btall grass\b/i;

const hours = (ms: number) => ms / 3_600_000;

/** Age of the directive in hours, or null when `generatedAt` is missing or
 *  unparseable. A future timestamp reads as age 0, never as a negative age that
 *  would make a clock-skewed file immortal. */
export function pinAgeHours(d: Pick<PinnedDirective, "generatedAt">, nowMs: number): number | null {
  if (!d.generatedAt) return null;
  const t = Date.parse(d.generatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, hours(nowMs - t));
}

/** Why the directive is retired, or null while it is still live.
 *
 *  RETIRED MEANS THE WHOLE ARTIFACT — pin AND gotoBan. They share one
 *  generatedAt and one K-attempt ladder, and a ban that outlives its ladder
 *  wedges the same way the pin does (the live file bans map88, the only door
 *  back off Route 25). The supervisor re-detecting a genuine stall rewrites the
 *  file within ~30 minutes, which resets this clock; nothing rewrites residue. */
export function pinExpiry(d: PinnedDirective, now: { turn: number; ms: number },
                          cfg: PinCfg): string | null {
  const age = pinAgeHours(d, now.ms);
  if (age !== null) {
    if (cfg.maxHours > 0 && age >= cfg.maxHours)
      return `directive is ${age.toFixed(1)}h old (generated ${d.generatedAt}, cap ${cfg.maxHours}h) ` +
             `and its K-attempt ladder has stopped rewriting it`;
    return null;
  }
  // No usable timestamp: fall back to turns since this Agent picked it up.
  const turns = now.turn - d.loadedTurn;
  if (cfg.maxTurns > 0 && turns >= cfg.maxTurns)
    return `directive has no parseable generatedAt and has been pinned for ${turns} turns (cap ${cfg.maxTurns})`;
  return null;
}

/** The pin's remedy, refuted by the live bag — or null when nothing refutes it.
 *
 *  Only the catch remedy has a resource precondition the RAM can settle, so
 *  only the catch remedy is checked. A pin that orders something the agent
 *  cannot do competes with the one action that would relieve the constraint
 *  (wq#1829), which is why this suppresses the pin for the turn instead of
 *  printing both halves of the contradiction and letting the brain pick. */
export function pinContradiction(pin: string, ram: PinRam, cfg: PinCfg): string | null {
  if (!cfg.contradiction || !pin) return null;
  if (!PIN_CATCH_RE.test(pin)) return null;
  if (ram.balls > 0 || ram.money >= ram.ballPrice) return null;
  return `SUPERVISOR PIN SUPPRESSED: it orders you to CATCH, and you are carrying ` +
    `${ram.balls} balls with $${ram.money} against a $${ram.ballPrice} Poke Ball — its remedy is ` +
    `impossible in this state, so the harness is withholding it rather than making you re-derive ` +
    `that every turn. Earn $${ram.ballPrice} from TRAINER battles and the pin comes back by itself.`;
}

/** The half-sentence that stops a grass pin from arguing with a live exclusion.
 *  Appended, never substituted: the rest of the pin (the gym gate, the "do not
 *  warp into a house" clauses) is still the supervisor's live guidance. */
export function pinQualifier(pin: string, ex: PinExclusion | null): string | null {
  if (!pin || !ex || !PIN_GRASS_RE.test(pin)) return null;
  return `PIN QUALIFIED: the grass it means is NOT the ${ex.tiles}-tile patch on map${ex.map} ` +
    `the harness escape just walked you out of — goto refuses that patch until turn ${ex.untilTurn}. ` +
    `Grass anywhere else, or on the other side of the map, still counts.`;
}

/** The "!!" lines for this turn's state block, or null to print nothing.
 *  Every line is "!!"-prefixed by the caller's existing convention, so this
 *  returns the text only. */
export function renderPin(pin: string, ram: PinRam, ex: PinExclusion | null,
                          cfg: PinCfg): { text: string; suppressed: string | null } | null {
  if (!pin) return null;
  const bad = pinContradiction(pin, ram, cfg);
  if (bad) return { text: bad, suppressed: bad };
  const q = pinQualifier(pin, ex);
  return { text: q ? `${pin}\n!! ${q}` : pin, suppressed: null };
}
