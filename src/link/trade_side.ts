// wq#484 (M5d) — selection -> confirm -> swap, driven from ONE side.
//
// M3's TradeSession (trade.ts) drives this phase with both cores in hand: it
// waits until BOTH sides report the STATS|TRADE submenu and only then presses
// RIGHT+A, "parking whoever arrives first". A remote side cannot do that — it
// cannot read the peer's menu at all. So this driver does what a human player
// does: walk its OWN menu to the wanted slot, select TRADE, and then HOLD STILL
// while Serial_SyncAndExchangeNybble ($00:227F) converges. That quiet phase is
// load-bearing, not politeness: a keypress knocks a waiting side out of the sync
// loop at $226E and the two selections never agree.
//
// The pair must still be CONSISTENT — Gen1 exchanges one agreed pair, so what we
// offer has to be what the peer asked for. That agreement is configuration, not
// something either side can negotiate over the wire, which is why `offer`/`want`
// are inputs here and the orchestrator sets them on both sides.
import { KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Phase, phaseOf, cursorKeyFor } from "./trade_menu";
import { ADDR, IdentityPatch, NAME_LENGTH } from "./identity";
import { BLOCK, MonOffsets } from "./invariants";

/**
 * Named identity patches, applied to exactly one side before any link traffic.
 *
 * Both sides boot the same snapshot, so without this the two parties are
 * byte-identical and a completed trade leaves RAM unchanged — a swap between
 * clones cannot be distinguished from a failed swap (trade.ts's header, M3's
 * blind-run rule). The patch is NAMED and fixed rather than random because the
 * unpatched side has to be able to predict exactly which block bytes may differ;
 * see expectedAsymSections.
 */
export const ASYM_PATCHES: Record<string, IdentityPatch> = {
  bob: { playerName: "BOB", playerID: 0x1122, mon1Level: 25, mon1Nick: "BOBMON" },
};

/**
 * The block sections a given patch is ALLOWED to move, as `sectionOf` labels.
 *
 * Derived from the patch fields and the symbol table, never from remembered
 * offsets: writeIdentity couples playerName -> mon1OT and playerID -> mon1OTID
 * (that is what "originally caught by this trainer" means), so the set is wider
 * than the patch literal looks. Anything differing OUTSIDE this set, in a pair
 * that booted one snapshot, is a lost or shifted byte.
 */
export function expectedAsymSections(sym: SymbolTable, patch: IdentityPatch): string[] {
  const base = sym.addr("wPartyMon1");
  const monField = (addr: number) => `mon0+${addr - base}`;
  const spread = (prefix: string) => Array.from({ length: NAME_LENGTH }, (_, i) => `${prefix}+${i}`);
  const out = new Set<string>();
  if (patch.playerName !== undefined) {
    spread("name").forEach(s => out.add(s));
    if (patch.mon1OT === undefined) spread("ot0").forEach(s => out.add(s));
  }
  if (patch.playerID !== undefined) { out.add(monField(ADDR.mon1OTID)); out.add(monField(ADDR.mon1OTID + 1)); }
  if (patch.mon1Level !== undefined) out.add(monField(ADDR.mon1Level));
  if (patch.mon1OT !== undefined) spread("ot0").forEach(s => out.add(s));
  if (patch.mon1Nick !== undefined) spread("nick0").forEach(s => out.add(s));
  return [...out];
}

/** Sanity bound: the patch must stay inside the party tail this block carries. */
export function assertPatchInBlock(sym: SymbolTable, o: MonOffsets): void {
  const base = sym.addr("wPartyMon1");
  for (const addr of [ADDR.mon1OTID, ADDR.mon1Level]) {
    const off = addr - base;
    if (off < 0 || off >= o.stride)
      throw new Error(`trade_side: $${addr.toString(16)} is offset ${off}, outside the ${o.stride}-byte party struct`);
  }
  if (BLOCK.nameLen !== NAME_LENGTH)
    throw new Error(`trade_side: block name field ${BLOCK.nameLen} != identity NAME_LENGTH ${NAME_LENGTH}`);
}

export interface OneSidedTradeDeps {
  mem: () => number[];
  grid: () => string;
  /** Step n frames, optionally holding `key`. MUST pace the link itself. */
  step: (n: number, key?: number) => Promise<void>;
  /** Has our own party changed in the slot we offered? Read from our RAM only. */
  swapped: () => boolean;
  closed: () => boolean;
  /** doFrame divisor for this phase; one slice ~= one transfer window. */
  fine: number;
  offer: number;
  want: number;
  maxIterations?: number;
  /** Quiet slices spent inside one nybble sync before re-reading our phase. */
  quietRounds?: number;
  log?: (s: string) => void;
}

export interface OneSidedTradeOut {
  swapped: boolean;
  iterations: number;
  /** Times we selected TRADE in the submenu. The first attempt need not land. */
  confirms: number;
  phases: Partial<Record<Phase, number>>;
  /** Phase we were in when the swap landed — evidence the swap came from the menu. */
  swappedFrom?: Phase;
  note: string;
}

const KEY_FOR: Partial<Record<Phase, number>> = {
  stats: KEYS.B,        // back out of a stats page
  cancelbox: KEYS.B,    // and out of the cancel box: CANCEL ends the session
  other: KEYS.A,        // blank/transition frames still need input or we deadlock
};

export async function driveTradeConfirm(d: OneSidedTradeDeps): Promise<OneSidedTradeOut> {
  const fine = d.fine;
  const maxIterations = d.maxIterations ?? 80;
  const quietRounds = d.quietRounds ?? 14;
  const log = d.log ?? (() => {});
  const phases: Partial<Record<Phase, number>> = {};
  let confirms = 0, k = 0, swappedFrom: Phase | undefined;

  for (; k < maxIterations && !d.swapped() && !d.closed(); k++) {
    const p = phaseOf(d.mem(), d.grid());
    phases[p] = (phases[p] ?? 0) + 1;
    if (p === "submenu") {
      confirms++;
      // The submenu is HORIZONTAL: RIGHT reaches TRADE, A dispatches to
      // .choseTrade ($01:56F9). DOWN is not in its watch mask ($13).
      await d.step(6 * fine, KEYS.RIGHT);
      await d.step(8 * fine);
      await d.step(8 * fine, KEYS.A);
      for (let q = 0; q < quietRounds && !d.swapped() && !d.closed(); q++) await d.step(30 * fine);
      if (d.swapped()) { swappedFrom = p; break; }
      log(`  confirm #${confirms}: selection sent, sync did not converge in ${quietRounds} quiet rounds`);
      continue;
    }
    const key = p === "enemyList" ? cursorKeyFor(d.mem(), d.want)
      : p === "playerList" ? cursorKeyFor(d.mem(), d.offer)
      : KEY_FOR[p];
    await d.step(8 * fine, key);
    await d.step(16 * fine);
    if (d.swapped()) { swappedFrom = p; break; }
  }

  // Let the trade animation run out before anyone reads the party: a sample
  // taken mid-animation shows a half-written slot.
  if (!d.closed()) await d.step(60 * fine);

  const swapped = d.swapped();
  return {
    swapped, iterations: k, confirms, phases, swappedFrom,
    note: swapped ? `swap landed after ${confirms} confirm attempt(s)`
      : d.closed() ? "peer closed the link before the swap"
      : `no swap in ${k} iterations (${confirms} confirm attempts)`,
  };
}
