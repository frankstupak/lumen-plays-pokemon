// wq#1877: what makes a toggleable NPC step aside, read out of the ROM.
//
// THE STALL THIS ANSWERS. Cerulean City is two walkable regions (wq#1870); the
// player's owns the N and W edges, and the region holding the Route 5 and
// Route 9 exits is reachable only through the Trashed House door at (27,11).
// Object 11, a STAY guard, stands on (27,12) — that door's ONLY approach cell.
// So the harness could tell the brain "this map is split, here are your edges"
// and be perfectly true and perfectly useless: the one thing that would change
// the situation was not on the list, because the door is unreachable and every
// crossing test in reach.ts started from a reachable warp.
//
// The missing half is WHO MOVES THE GUARD, and the ROM says so plainly. A Gen 1
// script hides a toggleable object with
//
//     ld a, <global id>            ; 3E xx
//     ld [wToggleableObjectIndex], a ; EA 4D CC
//     predef HideObject            ; 3E <predef id> / CD <Predef>
//
// so scanning for that byte sequence and naming the label it lands inside finds
// every place in the game that clears a given object. For Cerulean's guard
// (global id 9) there are exactly two: BillsHouseBillSSTicketText — Bill handing
// over the S.S. Ticket, on Route 25 — and CeruleanHideRocket. That is the real
// next objective, and nothing in the harness knew it.
//
// Everything here is read, never retyped: the predef id comes from the ROM's own
// PredefPointers table, the WRAM address from the symbol file, and the place name
// from the map header the label belongs to.
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";

export interface ClearSite {
  bank: number;
  addr: number;
  /** The routine the call sits in, e.g. "BillsHouseBillSSTicketText". */
  symbol: string;
  /** The map whose header label prefixes that routine, when there is one. */
  mapId: number | null;
}

/** Index of HideObject in the ROM's predef table (pokered's HIDE_OBJECT).
 *
 *  The table's length cannot come from nextAddr the way other ROM tables do:
 *  pokered labels EVERY predef entry, and the first of them shares an address
 *  with PredefPointers itself, so "the next symbol" is entry 1. Walk instead
 *  while the entries still look like `db bank / dw addr` triples pointing into
 *  a real ROM bank, and stop at the first that does not. */
function hideObjectPredef(rom: Rom, sym: SymbolTable): number {
  const t = sym.sym("PredefPointers");
  const target = sym.sym("HideObject");
  const banks = rom.data.length / 0x4000;
  for (let i = 0; i < 0x80; i++) {
    const bank = rom.byte(t.bank, t.addr + i * 3);
    if (bank >= banks) break;
    const addr = rom.byte(t.bank, t.addr + i * 3 + 1) | (rom.byte(t.bank, t.addr + i * 3 + 2) << 8);
    if (bank === target.bank && addr === target.addr) return i;
  }
  throw new Error("HideObject is not in PredefPointers");
}

/** map header label (minus the `_h`) -> map id, longest first, so a scanned
 *  symbol matches the most specific map that prefixes it. */
function mapLabelPrefixes(rom: Rom, sym: SymbolTable): { label: string; id: number }[] {
  const ptrs = sym.sym("MapHeaderPointers");
  const banks = sym.sym("MapHeaderBanks");
  const count = (sym.nextAddr(ptrs.bank, ptrs.addr) - ptrs.addr) / 2;
  const out: { label: string; id: number }[] = [];
  for (let id = 0; id < count; id++) {
    const addr = rom.byte(ptrs.bank, ptrs.addr + id * 2)
      | (rom.byte(ptrs.bank, ptrs.addr + id * 2 + 1) << 8);
    const bank = rom.byte(banks.bank, banks.addr + id);
    const label = sym.labelsAt(bank, addr).find(n => n.endsWith("_h"));
    if (label) out.push({ label: label.slice(0, -2), id });
  }
  return out.sort((a, b) => b.label.length - a.label.length);
}

/** The sentence a blocked crossing gets: where the game clears the NPC holding
 *  the door. Prefers a PLACE the agent can be routed to; falls back to naming
 *  the routine when no map header owns it (Cerulean's own Rocket script is one),
 *  and says nothing at all when the ROM hides the object nowhere — an invented
 *  prerequisite would be the wq#1091 footgun again. */
export function clearedByLine(rom: Rom, sym: SymbolTable, gid: number,
                              mapName: (id: number) => string | null): string | null {
  const sites = hideSites(rom, sym, gid);
  if (!sites.length) return null;
  const places = [...new Set(sites.map(s => s.mapId !== null ? mapName(s.mapId) : null)
    .filter((n): n is string => !!n))];
  if (places.length)
    return `It is an EVENT object: the game clears it at ${places.join(" or ")}.`
      + ` Go there first — nothing in this town moves it.`;
  return `It is an EVENT object: nothing in this town moves it — the game clears it in`
    + ` ${[...new Set(sites.map(s => s.symbol))].join(", ")}.`;
}

/** Per-ROM, per-object memo: the scan is a full-image search and the answer for
 *  a given cartridge never changes. Keyed by the Rom instance so a probe that
 *  opens a second image cannot read the first one's answers. */
const cache = new WeakMap<Rom, Map<number, ClearSite[]>>();

/** Every site in the ROM that hides toggleable object `gid`. Empty when nothing
 *  does — which is itself an answer: no event in the game moves that NPC. */
export function hideSites(rom: Rom, sym: SymbolTable, gid: number): ClearSite[] {
  let memo = cache.get(rom);
  if (!memo) { memo = new Map<number, ClearSite[]>(); cache.set(rom, memo); }
  const hit = memo.get(gid);
  if (hit) return hit;
  const idx = sym.addr("wToggleableObjectIndex");
  const predef = sym.sym("Predef");
  const store = Buffer.from([0x3e, gid, 0xea, idx & 0xff, idx >> 8]);
  const call = Buffer.from([0x3e, hideObjectPredef(rom, sym), 0xcd, predef.addr & 0xff, predef.addr >> 8]);
  const prefixes = mapLabelPrefixes(rom, sym);
  const out: ClearSite[] = [];
  for (let i = rom.data.indexOf(store); i >= 0; i = rom.data.indexOf(store, i + 1)) {
    // The predef call follows the store; a couple of instructions may sit
    // between them, but not a whole routine.
    const j = rom.data.indexOf(call, i + store.length);
    if (j < 0 || j - (i + store.length) > 8) continue;
    const bank = Math.floor(i / 0x4000);
    const addr = bank === 0 ? i : 0x4000 + (i % 0x4000);
    const label = sym.labelBefore(bank, addr);
    if (!label) continue;
    const m = prefixes.find(p => label.name.startsWith(p.label));
    out.push({ bank, addr, symbol: label.name, mapId: m ? m.id : null });
  }
  memo.set(gid, out);
  return out;
}
