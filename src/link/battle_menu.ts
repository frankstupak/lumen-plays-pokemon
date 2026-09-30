// wq#3201 — the link-battle state a side can read out of its OWN RAM.
//
// Extracted from LinkBattleSession (battle.ts, M3/M4) for the same reason
// trade_menu.ts was extracted from TradeSession: the two-process driver
// (battle_side.ts) can see one core only, and two copies of this decode would
// drift until the in-process and cross-process battles disagreed about a menu,
// which is indistinguishable from a link fault.
import { KEYS } from "../emulator";
import { SymbolTable } from "../symbols";

export const COLOSSEUM_MAP = 0xF0;
export const LINK_STATE_START_BATTLE = 3;
export const LINK_STATE_BATTLING = 4;

export const BATTLE_ADDR = {
  curMap: 0xD35E,
  linkState: 0xD12B,
  menuCursor: 0xCC26,
  menuMax: 0xCC28,
  menuKeys: 0xCC29,
  playerMove: 0xCCDC,
  enemyMove: 0xCCDD,
  rngList: 0xD148,
  rngListLen: 9,
} as const;

/** What a brain is shown when it is asked to choose a move. */
export interface BattleView {
  tag: string;
  turn: number;
  myNick: string; foeNick: string;
  mySpecies: number; myLevel: number; myHp: number; myMaxHp: number;
  foeSpecies: number; foeLevel: number; foeHp: number; foeMaxHp: number;
  moves: number[]; pp: number[];
  lastFoeMove: number;
}

export type BattlePhase = "moveMenu" | "battleMenu" | "text";

type Mem = number[] | Uint8Array;
const u8 = (m: Mem, a: number) => m[a] & 0xFF;
const u16 = (m: Mem, a: number) => (u8(m, a) << 8) | u8(m, a + 1);

export const hpOf = (m: Mem, sym: SymbolTable) => u16(m, sym.addr("wBattleMonHP"));
export const foeHpOf = (m: Mem, sym: SymbolTable) => u16(m, sym.addr("wEnemyMonHP"));
export const inBattleOf = (m: Mem, sym: SymbolTable) => u8(m, sym.addr("wIsInBattle"));
export const cursorOf = (m: Mem) => u8(m, BATTLE_ADDR.menuCursor);
export const rngListOf = (m: Mem) =>
  Array.from({ length: BATTLE_ADDR.rngListLen }, (_, i) => u8(m, BATTLE_ADDR.rngList + i));
export const movesOf = (m: Mem, sym: SymbolTable, name = "wBattleMonMoves") =>
  [0, 1, 2, 3].map(i => u8(m, sym.addr(name) + i));

/** The battle menu is on screen; the move list is identified by its TYPE/PP box. */
export function battlePhaseOf(grid: string): BattlePhase {
  if (grid.includes("TYPE/") || grid.includes("PP")) return "moveMenu";
  if (grid.includes("FIGHT")) return "battleMenu";
  return "text";
}

/**
 * The key a side presses on a menu that is waiting for it, and whether that
 * press COMMITS the turn. Cursor read back every call, never counted:
 *   battle menu — 2x2 grid, FIGHT top-left, wCurrentMenuItem tracks the row.
 *   move menu   — MEASURED one-indexed: cursor 1..4 maps to the four moves, so
 *                 targeting slot 0 walks the cursor forever. Watched keys $C3.
 * Text returns no key: link battles scroll their own narration
 * (ManualTextScroll.inLinkBattle), so a press there is at best wasted.
 */
export function menuKeyFor(phase: BattlePhase, cursor: number, slot: number): { key?: number; commits: boolean } {
  if (phase === "battleMenu") return { key: cursor === 0 ? KEYS.A : KEYS.UP, commits: false };
  if (phase === "moveMenu") return cursor === slot + 1 ? { key: KEYS.A, commits: true } : { key: KEYS.DOWN, commits: false };
  return { commits: false };
}

/** Gen1 text codec, enough for a nickname: $80-$99 = A-Z, $50 terminates. */
export function nameAt(m: Mem, addr: number): string {
  let out = "";
  for (let i = 0; i < 11; i++) {
    const c = u8(m, addr + i);
    if (c === 0x50) break;
    out += c >= 0x80 && c <= 0x99 ? String.fromCharCode(65 + c - 0x80) : c === 0x7F ? " " : "";
  }
  return out || "?";
}

export function readBattleView(m: Mem, sym: SymbolTable, tag: string, turn: number): BattleView {
  const pp = sym.addr("wBattleMonPP");
  return {
    tag, turn,
    myNick: nameAt(m, sym.addr("wBattleMonNick")),
    foeNick: nameAt(m, sym.addr("wEnemyMonNick")),
    mySpecies: u8(m, sym.addr("wBattleMonSpecies")),
    myLevel: u8(m, sym.addr("wBattleMonLevel")),
    myHp: hpOf(m, sym), myMaxHp: u16(m, sym.addr("wBattleMonMaxHP")),
    foeSpecies: u8(m, sym.addr("wEnemyMonSpecies")),
    foeLevel: u8(m, sym.addr("wEnemyMonLevel")),
    foeHp: foeHpOf(m, sym), foeMaxHp: u16(m, sym.addr("wEnemyMonMaxHP")),
    moves: movesOf(m, sym),
    pp: [0, 1, 2, 3].map(i => u8(m, pp + i) & 0x3F),
    lastFoeMove: u8(m, BATTLE_ADDR.enemyMove),
  };
}
