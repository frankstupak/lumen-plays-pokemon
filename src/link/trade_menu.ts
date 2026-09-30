// wq#484 — the trade-menu state a side can read out of its OWN RAM.
//
// Extracted from TradeSession (trade.ts, M3) because M5d needs the same reading
// from a process that can see only one core. Two copies of this decode would
// drift, and a divergence between how the in-process trade and the cross-process
// trade read the same menu is indistinguishable from a link fault.
//
// wMenuWatchedKeys ($CC29) is set distinctly by every menu on the trade screen,
// so it identifies the active menu unambiguously AND states which keys are legal
// there. Values decoded from the ROM (bank 1, scan for `ld [$CC29],a`):
//   $5561 .enemyMonMenu           $A1 = DOWN|LEFT|A   maxItem = wEnemyPartyCount
//   $55E5 .playerMonMenu          $91 = DOWN|RIGHT|A  maxItem = wPartyCount
//   $56A6 .displayStatsTradeMenu  $13 = RIGHT|B|A     maxItem = 0  (HORIZONTAL)
//   $56CA .selectedCancelMenuItem $23 = LEFT|B|A
// Neither party list watches UP, so the cursor is DOWN-only and wraps.
import { KEYS } from "../emulator";

export type Phase = "stats" | "enemyList" | "playerList" | "submenu" | "cancelbox" | "other";

/** wMenuWatchedKeys, wCurrentMenuItem, wMaxMenuItem. */
export const MENU = { watchedKeys: 0xCC29, currentItem: 0xCC26, maxItem: 0xCC28 } as const;

/** The stats page is not a menu, so it is the one phase read from screen text;
 *  every consequence of it is still checked against RAM. */
export const STATS_MARKER = "STATUS/OK";

export function phaseOf(mem: number[] | Uint8Array, grid: string): Phase {
  if (grid.includes(STATS_MARKER)) return "stats";
  switch (mem[MENU.watchedKeys] & 0xFF) {
    case 0xA1: return "enemyList";
    case 0x91: return "playerList";
    case 0x13: return "submenu";
    case 0x23: return "cancelbox";
    default: return "other";
  }
}

export function cursorOf(mem: number[] | Uint8Array): number { return mem[MENU.currentItem] & 0xFF; }
export function maxItemOf(mem: number[] | Uint8Array): number { return mem[MENU.maxItem] & 0xFF; }

/**
 * DOWN until the cursor sits on `want`, then A. Never counts presses blind: the
 * cursor is read back from wCurrentMenuItem every call, so a dropped or doubled
 * input self-corrects instead of selecting the wrong slot — or CANCEL, which
 * aborts the whole session (wLinkState 50 -> 1). `want` is clamped below
 * wMaxMenuItem because the last entry IS CANCEL.
 */
export function cursorKeyFor(mem: number[] | Uint8Array, want: number): number {
  const max = maxItemOf(mem);
  const target = Math.max(0, Math.min(want, Math.max(0, max - 1)));
  return cursorOf(mem) === target ? KEYS.A : KEYS.DOWN;
}
