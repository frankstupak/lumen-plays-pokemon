// Move metadata and the harness's move pickers.
//
// wq#1180 (roadmap item 4) RETIRED THE HAND-TYPED TABLE. Until this ticket,
// MOVES was 25 entries somebody typed in from memory, keyed by internal move id
// with a STRING type name, no accuracy, no PP and no effect byte — and every
// consumer read it directly. The cartridge has all 165 moves with all six
// fields; romtables.decodeMoves() reads them, agent.ts installs them at boot,
// and everything below now goes through moveMeta().
//
// FALLBACK_MOVES is what is left of the old table, and it is now exactly one
// thing: the answer when the ROM decode failed or disagreed with the golden set
// (romtables.loadRomTables). It is no longer a source of truth and must not grow
// — a move missing from it is a move the ROM already knows.
//
// The hand-typed entries were cross-checked against roms/pokeblue.gb before
// being demoted: all 25 agree with the cartridge on name, type and power, so
// this demotion changes no behaviour on the moves the run has actually seen. It
// adds the other 140.

import { RomMove, TYPE, TYPE_NAME } from "./romtables";

export interface MoveMeta {
  id: number;
  name: string;
  type: number;         // Gen 1 internal type id (romtables.TYPE)
  power: number;
  /** ROM-only fields; undefined on a fallback entry. */
  accuracy?: number;
  pp?: number;
  effect?: number;
  /** wq#587: commits one or more MENU-LESS turns. The harness drives every
   *  battle through the menu, so a locked menu is a wedge risk, not a damage
   *  upgrade, and the pickers below treat these as last resort. ROM-derived
   *  from the effect byte since wq#1180 — see romtables.LOCK_IN_EFFECTS. */
  lockIn?: boolean;
}

/** FALLBACK ONLY. See the module header: this is the ROM-decode-failed path,
 *  not a table to extend. */
export const FALLBACK_MOVES: Record<number, MoveMeta> = {
  1:  { id: 1,   name: "POUND",        type: TYPE.NORMAL,  power: 40 },
  10: { id: 10,  name: "SCRATCH",      type: TYPE.NORMAL,  power: 40 },
  33: { id: 33,  name: "TACKLE",       type: TYPE.NORMAL,  power: 35 },
  28: { id: 28,  name: "SAND-ATTACK",  type: TYPE.NORMAL,  power: 0 },
  31: { id: 31,  name: "FURY ATTACK",  type: TYPE.NORMAL,  power: 15 },
  40: { id: 40,  name: "POISON STING", type: TYPE.POISON,  power: 15 },
  43: { id: 43,  name: "LEER",         type: TYPE.NORMAL,  power: 0 },
  45: { id: 45,  name: "GROWL",        type: TYPE.NORMAL,  power: 0 },
  52: { id: 52,  name: "EMBER",        type: TYPE.FIRE,    power: 40 },
  55: { id: 55,  name: "WATER GUN",    type: TYPE.WATER,   power: 40 },
  64: { id: 64,  name: "PECK",         type: TYPE.FLYING,  power: 35 },
  71: { id: 71,  name: "ABSORB",       type: TYPE.GRASS,   power: 20 },
  74: { id: 74,  name: "GROWTH",       type: TYPE.NORMAL,  power: 0 },
  77: { id: 77,  name: "POISONPOWDER", type: TYPE.POISON,  power: 0 },
  78: { id: 78,  name: "STUN SPORE",   type: TYPE.GRASS,   power: 0 },
  79: { id: 79,  name: "SLEEP POWDER", type: TYPE.GRASS,   power: 0 },
  81: { id: 81,  name: "STRING SHOT",  type: TYPE.BUG,     power: 0 },
  91: { id: 91,  name: "DIG",          type: TYPE.GROUND,  power: 100, lockIn: true },
  93: { id: 93,  name: "CONFUSION",    type: TYPE.PSYCHIC, power: 50 },
  98: { id: 98,  name: "QUICK ATTACK", type: TYPE.NORMAL,  power: 40 },
  99: { id: 99,  name: "RAGE",         type: TYPE.NORMAL,  power: 20,  lockIn: true },
  106:{ id: 106, name: "HARDEN",       type: TYPE.NORMAL,  power: 0 },
  111:{ id: 111, name: "DEFENSE CURL", type: TYPE.NORMAL,  power: 0 },
  116:{ id: 116, name: "FOCUS ENERGY", type: TYPE.NORMAL,  power: 0 },
  117:{ id: 117, name: "BIDE",         type: TYPE.NORMAL,  power: 0,   lockIn: true },
};

let romMoves: Map<number, RomMove> | null = null;

/** wq#1180: hand the harness THIS cartridge's move table. Called once at boot
 *  (agent.ts) with the output of romtables.loadRomTables(); a null/failed decode
 *  simply never calls it and every reader below stays on FALLBACK_MOVES. */
export function installRomMoves(table: Map<number, RomMove> | null): boolean {
  if (!table || table.size === 0) return false;
  romMoves = table;
  return true;
}

/** Which table the pickers are currently reading, for logs and probes. */
export function moveTableInfo(): { source: "rom" | "fallback"; entries: number } {
  return romMoves
    ? { source: "rom", entries: romMoves.size }
    : { source: "fallback", entries: Object.keys(FALLBACK_MOVES).length };
}

/** THE accessor. ROM first, hand-typed fallback second, undefined if neither
 *  knows the id — callers distinguish "weak move" from "unknown move", which is
 *  what lets the winnability verdict know whether it is allowed to make a claim
 *  (calc.ts UNKNOWN_POWER). */
export function moveMeta(id: number): MoveMeta | undefined {
  const r = romMoves?.get(id);
  if (r) return { id: r.id, name: r.name, type: r.type, power: r.power,
                  accuracy: r.accuracy, pp: r.pp, effect: r.effect, lockIn: r.lockIn };
  return FALLBACK_MOVES[id];
}

/** wq#587: ONE picker for every deterministic fight path (unwedge,
 *  plannedAuto, transit) — previously three identical inline copies, which is
 *  how a policy bug ships thrice. Strongest damaging move with PP, except
 *  lock-in moves lose to ANY non-lock attacker regardless of power: the
 *  harness cannot steer a menu that never comes back. Order of preference:
 *    1. best non-lock move with power > 0 (unknown moves count as power 30)
 *    2. best lock-in attacker (only damage left - RAGE as the last resort
 *       the ticket asks for; still better than a status stall)
 *    3. first non-lock status move (never reached with today's movesets)
 *    4. slot fallback (all-zero PP: Gen 1 auto-Struggles, selection is moot)
 */
export function pickBestMove(moves: number[], pp: number[]): number {
  let atk = -1, atkPow = -1, lock = -1, lockPow = -1, status = -1;
  moves.forEach((mid, i) => {
    if (!mid || (pp[i] & 0x3f) <= 0) return;
    const meta = moveMeta(mid);
    const pow = meta?.power ?? 30;       // unknown move: assume mid-power attacker
    if (meta?.lockIn) { if (pow > lockPow) { lockPow = pow; lock = i; } }
    else if (pow > 0) { if (pow > atkPow) { atkPow = pow; atk = i; } }
    else if (status < 0) status = i;
  });
  if (atk >= 0) return atk;
  if (lock >= 0) return lock;
  if (status >= 0) return status;
  const any = moves.findIndex(m => !!m);
  return any >= 0 ? any : 0;
}

/** wq#696: weakest non-lock damaging move — for catch weakening without KO.
 *  Falls back to a status move (0 power, never KOs) then any move, same
 *  priority chain as pickBestMove but ascending power. */
export function pickWeakestMove(moves: number[], pp: number[]): number {
  let atk = -1, atkPow = Infinity, status = -1;
  moves.forEach((mid, i) => {
    if (!mid || (pp[i] & 0x3f) <= 0) return;
    const meta = moveMeta(mid);
    if (meta?.lockIn) return;           // never lock in during a catch
    const pow = meta?.power ?? 30;
    if (pow > 0) { if (pow < atkPow) { atkPow = pow; atk = i; } }
    else if (status < 0) status = i;
  });
  if (status >= 0) return status;       // prefer status: zero KO risk
  if (atk >= 0) return atk;
  const any = moves.findIndex(m => !!m);
  return any >= 0 ? any : 0;
}

export function moveLabel(id: number): string {
  const m = moveMeta(id);
  if (!m) return `MOVE${id}`;
  const type = TYPE_NAME[m.type] ?? `T${m.type}`;
  return `${m.name}[${type}${m.power ? " " + m.power : " status"}]`;
}
