// wq#622: HIDDEN ITEMS — pure ROM table decode. This is the one perception
// class research/vision_research_brief.md calls out as un-seeable by ANY
// pixel pipeline: a hidden item has no sprite, no OAM entry, nothing to
// render — the ONLY channel that can ever perceive it is this (map,y,x)
// database the engine itself checks.
//
// EMPIRICAL BASIS (this session, live-verified, not guessed):
//  * HiddenItemCoords (ROM bank 0x1d, resolved via roms/pokeblue.sym) is a
//    flat 3-byte-per-entry (map, y, x) list, 0xFF-terminated: 54 entries,
//    163 bytes total (54*3 + 1 terminator — exact, sym.nextAddr() lands
//    precisely on the next real label, FoundHiddenItemText).
//  * Decoded entries match real Gen1 hidden-item locations by map name
//    (Viridian Forest, Mt Moon B2F, SS Anne Kitchen, Silph Co, Cerulean
//    Cave, Rocket Hideout, Safari Zone, ...) and entry #53 is map=15
//    (Route 4) y=3 x=40 — the exact map the ticket names as its own example.
//  * Coordinate space verified against a LIVE checkpoint
//    (checkpoints/auto-mstz9zfg-map15.state.gz): the player's own
//    StateReader (x,y) rendered at the correct spot in MapModel.ascii(x,y)
//    with zero transform, so the table's (x,y) columns are the SAME space
//    the rest of the harness already reads and renders — no scaling/offset
//    to get wrong.
//  * Obtained-status: wObtainedHiddenItemsFlags ($D6F0, 14 bytes = 112 bits)
//    is bit-indexed by table position (bit `idx` == entry `idx`), same
//    bit-ordering convention as objects.ts's toggleableFlags/flippedBits
//    (byte-major, LSB first). The SAME live checkpoint read all-zero across
//    all 14 item-flag bytes (consistent with none of these 54 taken yet in
//    that run) while wObtainedHiddenCoinsFlags (the very next field, $D6FE)
//    had bits 104-107 set — indices that don't exist in a 54-entry table at
//    all, proving hidden COINS use a SEPARATE counting scheme from hidden
//    ITEMS rather than sharing this table's index space. Hidden coins are
//    therefore explicitly OUT OF SCOPE here, not silently mis-decoded.
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";

export interface HiddenItem { idx: number; map: number; x: number; y: number }

let TABLE: HiddenItem[] | null = null;

/** The full ROM table, parsed once and cached (it's a ROM constant — never
 *  changes within a process). */
export function hiddenItemTable(rom: Rom, sym: SymbolTable): HiddenItem[] {
  if (TABLE) return TABLE;
  const hc = sym.sym("HiddenItemCoords");
  const end = sym.nextAddr(hc.bank, hc.addr);
  const bytes = rom.bytes(hc.bank, hc.addr, end - hc.addr);
  const out: HiddenItem[] = [];
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    if (bytes[i] === 0xff) break;   // table terminator
    out.push({ idx: i / 3, map: bytes[i], y: bytes[i + 1], x: bytes[i + 2] });
  }
  TABLE = out;
  return out;
}

/** true if hidden item `idx` has already been picked up this save. */
export function hiddenItemObtained(mem: ArrayLike<number>, sym: SymbolTable, idx: number): boolean {
  const a = sym.addr("wObtainedHiddenItemsFlags");
  return ((mem[a + (idx >> 3)] >> (idx & 7)) & 1) === 1;
}

/** Snapshot of the obtained-flags region, for pickup confirmation (mirrors
 *  objects.ts's toggleableFlags — same shape, same diffing via flippedBits). */
export function hiddenItemFlags(mem: ArrayLike<number>, sym: SymbolTable): number[] {
  const a = sym.addr("wObtainedHiddenItemsFlags");
  const out: number[] = [];
  for (let i = 0; i < 14; i++) out.push(mem[a + i]);
  return out;
}

// itemfinder-style: "on or adjacent" per the ticket, not full-map ranging —
// a Chebyshev distance of 1 covers the tile itself and all 8 neighbors.
const ADJ = 1;

/** Undiscovered hidden items on `map` within ADJ tiles of (px,py). Perception
 *  only — the ticket is explicit that this must NOT auto-detour navigation,
 *  so this function is never called from anything that plans a goal, only
 *  from the observe() state block (a nudge, not a target). */
export function nearbyHiddenItems(rom: Rom, sym: SymbolTable, mem: ArrayLike<number>,
                                   map: number, px: number, py: number): HiddenItem[] {
  return hiddenItemTable(rom, sym)
    .filter(h => h.map === map && !hiddenItemObtained(mem, sym, h.idx))
    .filter(h => Math.max(Math.abs(h.x - px), Math.abs(h.y - py)) <= ADJ);
}

/** The state-block line — present ONLY when something undiscovered is
 *  nearby (wq#488: no dead prose on clean maps). Deliberately does not name
 *  the item: the real itemfinder doesn't either, and this build has no
 *  verified per-location item-identity decode (that's a separate, much
 *  larger per-map script disassembly — out of scope here, noted in the
 *  report rather than guessed).
 *
 *  Deliberately does NOT prescribe a specific button/position recipe: this
 *  session tried direct A-on-tile, stepping onto the tile from all 4
 *  cardinal directions, and the existing interact() tool against the exact
 *  verified Route 4 entry — none flipped the obtained flag in a synthetic
 *  position-injection test (report 622_hidden_items.md). Rather than assert
 *  an unverified mechanism as fact, the line tells the brain to try and lets
 *  the harness's own ground-truth confirmation (agent.ts's press() hook,
 *  hiddenItemObtained) report success or silence honestly either way. */
export function hiddenItemLine(items: HiddenItem[]): string | null {
  if (!items.length) return null;
  const parts = items.map(h => `(${h.x},${h.y})`);
  return `! HIDDEN ITEM HERE: something is buried at ${parts.join(", ")} on this map, invisible ` +
    `on any screen — get close and try press(a) or interact(x,y); a real pickup is confirmed ` +
    `automatically (free economy, itemfinder-style).`;
}
