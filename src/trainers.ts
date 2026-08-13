// wq#528: give the harness a CONCEPT OF A TRAINER, and give the brain one
// income/XP goal it can actually act on.
//
// DIAGNOSIS THIS MODULE ANSWERS (board 2026-08-13T14:02Z, all measured):
//   a. economyAdvice() (wq#516) terminates as a string in the prompt block.
//      Nothing consumes it, so "fight the trainers on your path" is advice the
//      agent has no machinery to follow.
//   b. WORSE: map.ts renders every sprite as an anonymous "N". The world model
//      has no concept of a trainer at all, so the brain cannot distinguish a
//      Rocket grunt from a shopkeeper even in principle.
//   c. The single trainer battle in the recorded history of this project was
//      walked into by accident at 06:00:04Z and reported to the brain as a
//      WILD encounter (agent.ts:190 has no inBattle discrimination). It paid
//      $360 -- the only income event in ~110h of play.
//   d. $3220 of trainer payouts stand unclaimed on the Mt Moon corridor.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO, and why -- read before extending:
// it does NOT hand the brain an unbounded "go fight things" instruction, and
// it does NOT chase money for its own sake. Money is currently UNSPENDABLE:
// ROM-decoded mart inventories say the nearest Repel is Cerulean and the
// nearest Poke Ball is Pewter, and both sit on the far side of the Mt Moon
// blocker. The justification for engaging a trainer today is EXPERIENCE toward
// MISTY_MIN_LEVEL, which is spendable anywhere. The cash is a side effect.
// If you are tempted to loosen the gates below "because we need money", check
// first whether a mart is reachable -- if it is not, the money buys nothing.
//
// PURE-BY-DEFAULT, like economy.ts and transit.ts: the SELECTION logic takes
// plain data and is exhaustively testable offline (src/probe_trainers528.ts).
// Only decodeTrainers() touches memory, and it is fail-closed.

import { Rom } from "./rom";
import { SymbolTable } from "./symbols";

/** Gen 1 stores trainer classes in map object data offset by 200; index 201 is
 *  the first real class and indexes every class-keyed ROM table at (cls-201). */
export const FIRST_TRAINER_CLASS = 201;

/**
 * Maps whose ROM trainer-header table we have DECODED AND VERIFIED. Absence is
 * meaningful: decodeTrainers() returns [] for any map not listed, so no goal is
 * ever offered on unverified ground. This is the fail-closed contract promised
 * on the board at 14:02Z -- the `flagBit == sprite index` identity below was
 * measured on exactly these two maps and is NOT assumed to generalise.
 * Extending = add the pret symbol here and extend probe_trainers528.
 */
export const MAP_TRAINER_HEADERS: Record<number, string> = {
  59: "MtMoon1TrainerHeaders",   // Mt Moon 1F  - 7 trainers, flags @0xd7f5 bits 1..7
  61: "MtMoon3TrainerHeaders",   // Mt Moon B2F - 4 Rockets,  flags @0xd7f6 bits 2..5
};

export interface TrainerObj {
  sprite: number;        // wSpriteStateData index; == its defeat flag bit on verified maps
  x: number; y: number;
  cls: number; roster: number; name: string;
  levels: number[];      // the trainer's party, in order
  baseMoney: number;     // BCD pair at TrainerPicAndMoneyPointers + 2
  payout: number;        // baseMoney * level of the LAST party member (Gen 1 rule)
  beaten: boolean;
}

/** Gen 1 name charset, terminator 0x50. Only the letter/space range occurs in
 *  TrainerNames; anything else renders "?" rather than throwing, because an
 *  unnameable entry must not be able to take down the state block. */
function decodeName(bytes: number[]): string {
  let s = "";
  for (const c of bytes) {
    if (c === 0x50) break;
    if (c >= 0x80 && c <= 0x99) s += String.fromCharCode(65 + c - 0x80);
    else if (c >= 0xa0 && c <= 0xb9) s += String.fromCharCode(97 + c - 0xa0);
    else if (c === 0x7f) s += " ";
    else s += "?";
  }
  return s;
}

/** TrainerNames is a flat run of 0x50-terminated strings, indexed by cls-201. */
export function trainerNames(rom: Rom, sym: SymbolTable, max = 47): string[] {
  const s = sym.sym("TrainerNames");
  const raw = rom.bytes(s.bank, s.addr, 700);
  const out: string[] = [];
  let cur: number[] = [];
  for (const b of raw) {
    if (b === 0x50) { out.push(decodeName(cur)); cur = []; if (out.length >= max) break; }
    else cur.push(b);
  }
  return out;
}

/**
 * Base prize money for a trainer class.
 *
 * THE TABLE IS TWO BCD BYTES, NOT THREE. Entries are 5 bytes (2-byte pic
 * pointer + money) and the obvious reading of "3 bytes of money" yields 3000
 * for ROCKET, which then predicts a $36000 payout for a fight that actually
 * paid $360. The x100 is the tell. Confirmed against the only income event on
 * record: ROCKET base 30 x last-mon L12 = $360, the exact purse delta at
 * 2026-08-13T06:03:23Z.
 */
export function baseMoney(rom: Rom, sym: SymbolTable, cls: number): number {
  const t = sym.sym("TrainerPicAndMoneyPointers");
  const b = rom.bytes(t.bank, t.addr + (cls - FIRST_TRAINER_CLASS) * 5 + 2, 2);
  return (((b[0] >> 4) * 10 + (b[0] & 15)) * 100) + ((b[1] >> 4) * 10 + (b[1] & 15));
}

/**
 * The Nth roster of a trainer class. Two encodings share the table: a leading
 * 0xFF means per-mon (level,species) pairs, anything else is a fixed level
 * followed by a species list. Both terminate on a 0 and rosters run back to
 * back, so reaching roster N means walking the N-1 before it.
 */
export function rosterLevels(rom: Rom, sym: SymbolTable, cls: number, n: number): number[] {
  const t = sym.sym("TrainerDataPointers");
  const dp = rom.bytes(t.bank, t.addr + (cls - FIRST_TRAINER_CLASS) * 2, 2);
  let off = dp[0] | (dp[1] << 8);
  for (let r = 1; r <= 24; r++) {
    const first = rom.byte(t.bank, off);
    const lv: number[] = [];
    if (first === 0xff) {
      off++;
      for (;;) { const l = rom.byte(t.bank, off); if (l === 0) break; lv.push(l); off += 2; }
      off++;
    } else {
      off++;
      for (;;) { const sp = rom.byte(t.bank, off); if (sp === 0) break; lv.push(first); off++; }
      off++;
    }
    if (r === n) return lv;
  }
  return [];
}

/**
 * Where a map keeps its "trainer defeated" bits. Header entries are 12 bytes:
 * [0] flag bit, [2..3] flag address (little endian), then four text pointers.
 * A [0] of 0x00 or 0xFF is the end of the table -- past it the bytes are code,
 * which is why the terminator check is not optional.
 *
 * PROVED, not assumed (board 14:02Z): diffing all 320 bytes of wEventFlags
 * across the checkpoint pair that straddles the $71 -> $431 battle flipped
 * EXACTLY ONE bit, 0xd7f6 bit 4, and MtMoon3TrainerHeaders hdr2 independently
 * declares flagBit 4 @ 0xd7f6. Sprite 4 on map61 is ROCKET #3, the tile
 * adjacent to where the player stood. Two derivations, same bit.
 */
export function trainerFlagAddr(rom: Rom, sym: SymbolTable, mapId: number):
    { addr: number; bits: number[] } | null {
  const label = MAP_TRAINER_HEADERS[mapId];
  if (!label || !sym.has(label)) return null;
  const s = sym.sym(label);
  let addr = 0; const bits: number[] = [];
  for (let i = 0; i < 12; i++) {
    const b = rom.bytes(s.bank, s.addr + i * 12, 12);
    if (b[0] === 0x00 || b[0] === 0xff) break;
    const a = b[2] | (b[3] << 8);
    // Every header on a map points at the same flag byte; a disagreement means
    // we have walked off the end of the table into code. Stop, do not guess.
    if (addr && a !== addr) break;
    addr = a; bits.push(b[0]);
  }
  return addr ? { addr, bits } : null;
}

/**
 * Every trainer object on the current map, with payout and defeat state.
 *
 * FAIL-CLOSED: returns [] for any map absent from MAP_TRAINER_HEADERS, and []
 * if the header table will not decode. A caller that gets [] offers no goal,
 * which is the correct behaviour on unverified ground -- three tickets today
 * were built on facts nobody checked.
 */
export function decodeTrainers(mem: ArrayLike<number>, rom: Rom, sym: SymbolTable,
                               mapId: number, names?: string[]): TrainerObj[] {
  const hdr = trainerFlagAddr(rom, sym, mapId);
  if (!hdr) return [];
  const nm = names ?? trainerNames(rom, sym);
  const n = mem[sym.addr("wNumSprites")];
  const extra = sym.addr("wMapSpriteExtraData");
  const d1 = sym.addr("wSpriteStateData1"), d2 = sym.addr("wSpriteStateData2");
  const out: TrainerObj[] = [];
  for (let i = 1; i <= n && i <= 15; i++) {
    const cls = mem[extra + (i - 1) * 2], roster = mem[extra + (i - 1) * 2 + 1];
    // extra[0] < 201 is an item id (ground Poke Ball sprites) or unused; a
    // roster of 0 is likewise not a trainer. Both must be excluded or the
    // TM01 lying on Mt Moon B2F reads as a trainer class.
    if (cls < FIRST_TRAINER_CLASS || roster === 0) continue;
    if (mem[d1 + i * 16] === 0 || mem[d1 + i * 16] === 0xff) continue;
    // Only trust the defeat bit for sprites the header table actually declares.
    // map61's SUPER NERD is a trainer object with NO header entry -- he is
    // driven by the fossil script -- and inventing a bit for him would silently
    // read somebody else's flag.
    if (!hdr.bits.includes(i)) continue;
    const levels = rosterLevels(rom, sym, cls, roster);
    if (!levels.length) continue;
    const bm = baseMoney(rom, sym, cls);
    out.push({
      sprite: i,
      y: mem[d2 + i * 16 + 4] - 4,
      x: mem[d2 + i * 16 + 5] - 4,
      cls, roster,
      name: nm[cls - FIRST_TRAINER_CLASS] ?? `class${cls}`,
      levels, baseMoney: bm,
      payout: bm * levels[levels.length - 1],
      beaten: ((mem[hdr.addr] >> i) & 1) === 1,
    });
  }
  return out;
}

/** Lead must outlevel the trainer's BEST mon by this much to be offered.
 *  Deliverable 4 of wq#528 is that whiteout risk goes DOWN, not up: a party of
 *  one with no potions cannot afford to lose, so the margin is deliberately
 *  wider than a human player would need. */
export const LEVEL_MARGIN = 6;
/** Below this lead HP fraction, engaging anything is a judgment call and the
 *  brain keeps it. Same spirit as transit.ts HP_FLOOR, set higher because this
 *  goal STARTS a fight rather than escaping one. */
export const ENGAGE_HP_FLOOR = 0.6;

/**
 * How many steps of approach the harness can realistically complete.
 *
 * This is the gate that keeps wq#528 from shipping wq#521's problem in new
 * clothes. rabbit15 measured the live floor at 2026-08-13T13:27Z: encounters
 * arrive every 2-4 steps and TRANSIT_RESUME_CAP resumes are all a goal gets, so
 * a goal longer than roughly cap*3 steps cannot finish -- the agent burns the
 * cap, hands back, and re-plans forever. Offering an 80-step trainer would look
 * like a feature and behave like the treadmill.
 */
export function engageBudget(resumeCap: number): number {
  return Math.max(1, Math.floor(resumeCap * 3));
}

export interface EngageCtx {
  leadLevel: number;
  hpFrac: number;
  money: number;
  ballPrice: number;
  gymMinLevel: number;
  resumeCap: number;
  /** Steps from astar to each trainer's tile; absent or null = unreachable. */
  steps: Map<number, number | null>;
}

export interface EngageChoice {
  target: TrainerObj | null;
  steps: number;
  why: string;
}

/**
 * At most ONE trainer to engage, or null with the reason it declined.
 *
 * Ordered by binding constraint, exactly like economyAdvice: the reason to
 * fight today is EXPERIENCE (lead L27 against MISTY_MIN_LEVEL 30), not cash --
 * see the module header. Among qualifying targets the richest wins, nearest
 * breaks ties, because every one of them is inside the same step budget and
 * therefore costs about the same to reach.
 */
export function pickEngageTarget(all: TrainerObj[], c: EngageCtx): EngageChoice {
  const none = (why: string): EngageChoice => ({ target: null, steps: -1, why });
  if (!all.length) return none("no decoded trainers on this map");

  const needXp = c.leadLevel > 0 && c.leadLevel < c.gymMinLevel;
  const broke = c.money < c.ballPrice;
  if (!needXp && !broke)
    return none("lead is at gym level and the purse is not binding - nothing to pursue");
  if (c.hpFrac < ENGAGE_HP_FLOOR)
    return none(`lead at ${Math.round(c.hpFrac * 100)}% HP - below the ${Math.round(ENGAGE_HP_FLOOR * 100)}% engage floor`);

  const budget = engageBudget(c.resumeCap);
  const live = all.filter(t => !t.beaten);
  if (!live.length) return none("every decoded trainer on this map is already beaten");

  const safe = live.filter(t => c.leadLevel >= Math.max(...t.levels) + LEVEL_MARGIN);
  if (!safe.length) return none(`no unbeaten trainer is L${LEVEL_MARGIN}+ below the lead (L${c.leadLevel})`);

  const near = safe
    .map(t => ({ t, s: c.steps.get(t.sprite) ?? null }))
    .filter((e): e is { t: TrainerObj; s: number } => e.s !== null && e.s <= budget);
  if (!near.length)
    return none(`no safe unbeaten trainer is within ${budget} steps (resume cap ${c.resumeCap} x ~3 steps per encounter)`);

  near.sort((a, b) => (b.t.payout - a.t.payout) || (a.s - b.s));
  const best = near[0];
  return { target: best.t, steps: best.s, why: `richest safe target inside the ${budget}-step budget` };
}

/**
 * The prompt line. Names the trainer, what it is worth, what it fields and the
 * literal call to make -- the brain already has goto, so this needs no new tool
 * and no new parser, which is also why it does not collide with wq#538.
 * Returns null when there is nothing worth saying.
 */
export function engageAdvice(ch: EngageChoice, leadLevel: number, needXp: boolean): string | null {
  const t = ch.target;
  if (!t) return null;
  const party = t.levels.length === 1 ? `one L${t.levels[0]}`
    : `${t.levels.length} mons, highest L${Math.max(...t.levels)}`;
  const why = needXp ? `EXPERIENCE toward the next gym (cash is a side effect - no mart is reachable yet)`
                     : `money, and it is the only source: wild Pokemon pay nothing in Gen 1`;
  return `! INCOME/XP TARGET: a ${t.name} stands at (${t.x},${t.y}), ${ch.steps} steps away,`
    + ` fielding ${party} against your L${leadLevel} lead. Beating it pays $${t.payout}.`
    + ` Engage it with goto(${t.x},${t.y}) - walking into a trainer's line of sight starts the`
    + ` fight. Reason: ${why}.`;
}
