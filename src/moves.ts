// Gen 1 move metadata and the shared battle-move pickers.
//
// wq#1180: THE TABLE IS NOW READ OUT OF THE ROM. This file used to carry a
// hand-typed table of 25 moves and told the picker to assume "power 30" for the
// other 140 — a mis-read generator aimed squarely at the rest of the campaign,
// since every TM and every level-up move past Cerulean fell in the guessed set.
// romtables.ts decodes all 165 from pokeblue.gb through the pret symbol table;
// this file keeps only what is HARNESS POLICY rather than ROM fact: which moves
// cost the agent a menu, and how a slot gets chosen.
//
// The hand-typed table did not vanish, it was DEMOTED: it lives in
// romtables.ts as GOLDEN_MOVES, where its two remaining jobs are to catch a
// misaligned decode and to be the fallback when it catches one. Nothing in the
// harness reads it as truth any more, and it must not grow.
//
// FAIL-CLOSED, same contract as trainers.ts: until installRomMoves() succeeds,
// every accessor here answers out of the golden fallback — the same 25 moves,
// the same "power 30" for everything else. A boot that cannot read the ROM
// degrades to exactly the behaviour that shipped before this ticket: worse
// coverage, never wrong coverage.
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";
import {
  GOLDEN_LOCK_IN, GOLDEN_MOVES, RomMove, RomTables, loadRomTables,
} from "./romtables";

/** What every consumer of this module actually needs. accuracy/pp are present
 *  only on the ROM path — the golden fallback never carried them, and inventing
 *  values there would be the hand-typed guess this ticket removed. */
export interface MoveMeta {
  name: string;
  type: string;
  power: number;
  lockIn: boolean;
  accuracy?: number;
  pp?: number;
}

/**
 * Power assumed for a move id that resolves to nothing.
 *
 * wq#587 set this to cover the 131 moves the hand-typed table omitted. With the
 * ROM table installed the entire 1..165 range resolves, so this now fires only
 * for an id that is NOT A MOVE — a torn RAM read mid-animation, or a slot in a
 * party struct that was never written. Treating that as a mid-power attacker
 * keeps the picker from preferring a genuine status move over garbage, which is
 * the same reason the constant existed.
 */
export const UNKNOWN_POWER = 30;

const FALLBACK: Record<number, MoveMeta> = Object.fromEntries(
  Object.entries(GOLDEN_MOVES).map(([id, g]) =>
    [Number(id), { ...g, lockIn: GOLDEN_LOCK_IN.includes(Number(id)) }]));

let romMoves: Record<number, RomMove> | null = null;

/**
 * Decode the ROM tables and install the move table, once per process.
 *
 * Returns the whole RomTables result rather than just the moves, because the
 * caller that has a `rom` and a `sym` to hand is also the caller that wants the
 * type chart and base stats — and because `problems` is what belongs in the
 * boot log. Safe to call repeatedly; a failed install leaves the fallback in
 * place and is retried on the next call.
 */
export function installRomMoves(rom: Rom, sym: SymbolTable): RomTables {
  const t = loadRomTables(rom, sym);
  if (t.moves) romMoves = t.moves;
  return t;
}

/** Install a decoded table directly, or null to force the fallback path.
 *  Exists for probes: exercising the fallback must not require a broken ROM. */
export function setMoveTable(t: Record<number, RomMove> | null): void { romMoves = t; }

/** "rom" once a verified decode is installed, "fallback" until then. */
export function moveTableSource(): "rom" | "fallback" { return romMoves ? "rom" : "fallback"; }

/** How many moves the active table knows. 165 on the ROM path. */
export function moveTableSize(): number {
  return Object.keys(romMoves ?? FALLBACK).length;
}

/** Metadata for an internal move id, or undefined when the id is in neither the
 *  ROM table nor the fallback (i.e. it is not a move). */
export function moveMeta(id: number): MoveMeta | undefined {
  return romMoves?.[id] ?? FALLBACK[id];
}

/** wq#587: ONE picker for every deterministic fight path (unwedge,
 *  plannedAuto, transit) — previously three identical inline copies, which is
 *  how a policy bug ships thrice. Strongest damaging move with PP, except
 *  lock-in moves lose to ANY non-lock attacker regardless of power: the
 *  harness cannot steer a menu that never comes back. Order of preference:
 *    1. best non-lock move with power > 0 (unresolvable ids count as UNKNOWN_POWER)
 *    2. best lock-in attacker (only damage left - RAGE as the last resort
 *       the ticket asks for; still better than a status stall)
 *    3. first non-lock status move
 *    4. slot fallback (all-zero PP: Gen 1 auto-Struggles, selection is moot)
 *
 *  wq#1180 widened rule 2 without changing it: lockIn is now derived from the
 *  ROM effect byte, so all fifteen menu-less moves are covered rather than the
 *  three that were typed in by hand. FLY and SOLARBEAM used to read as ordinary
 *  70/120-power attackers.
 */
export function pickBestMove(moves: number[], pp: number[]): number {
  let atk = -1, atkPow = -1, lock = -1, lockPow = -1, status = -1;
  moves.forEach((mid, i) => {
    if (!mid || (pp[i] & 0x3f) <= 0) return;
    const meta = moveMeta(mid);
    const pow = meta?.power ?? UNKNOWN_POWER;
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
    const pow = meta?.power ?? UNKNOWN_POWER;
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
  return m ? `${m.name}[${m.type}${m.power ? " " + m.power : " status"}]` : `MOVE${id}`;
}
