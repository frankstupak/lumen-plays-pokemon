// wq#607: ITEM-BALL PERCEPTION — give sprites identity, so the brain can see
// the free items it has been walking past (124h of Mt Moon, multiple balls).
//
// EMPIRICAL BASIS (recon607, live fixtures, 2026-08-15 — measured, not
// recalled): ground item balls are the sprites whose picture id is 0x3D with
// wMapSpriteExtraData = [itemId, 0]; observed on map59 (potion/moon_stone/
// rare_candy/escape_rope/potion at exact coordinates) and map61 (hp_up).
// Trainers carry [class>=201, roster>0] in the same table (trainers.ts), and
// plain NPCs carry [0,0] — extra[1]==0 with extra[0]>0 plus pic 0x3D is the
// discriminating predicate. TM balls carry ids >200 in extra[0] (observed 201
// and 212), which is exactly the trainer-class value range: the pic check is
// what keeps a TM ball from reading as a trainer and vice versa.
//
// PERCEPTION IS PURE WRAM, WITH THE FLAG CHECK THE ENGINE ITSELF USES: a
// same-session pickup does NOT clear the sprite from wSpriteStateData (t607c
// measured it byte-for-byte: the record persists; the DRAW is suppressed by a
// per-frame flag check). The truth lives in wToggleableObjectList (d5ce),
// loaded per map by MarkTownVisitedAndLoadToggleableObjects: 2-byte entries
// (objectIndex -> global flag id), 0xFF-terminated. An object whose flag bit
// is set in wToggleableObjectFlags is hidden — verified on live fixtures:
// map61's two taken Dome-Fossil sprites carry flagBit=1, and the map59 potion
// pickup flipped exactly global id 107, the id its own list entry names.
// (The ticket asked for ROM-table sourcing; the WRAM list IS that table as
// loaded, nothing hand-entered. Deviation noted in the report.)
//
// CONFIRMATION channel for pickups: wToggleableObjectFlags (d5a6-d5c5 in this
// build's sym — pokered calls the same region wMissableObjectFlags): picking
// an item up flips exactly one bit there, the sprite despawns, and the bag
// grows. diffFlags() exposes the flip; the probe asserts all three.
import { SymbolTable } from "./symbols";
import { itemLabel } from "./items";

/** Picture id of the ground item-ball sprite (recon607: universal across
 *  observed maps; nothing else uses it). */
export const BALL_PIC = 0x3d;

export interface ItemObj {
  sprite: number;        // wSpriteStateData slot (1-based)
  x: number; y: number;
  itemId: number;        // extra[0]; >200 = a TM ball, id = 200 + TM number
  name: string;
  /** Global toggleable-object flag id from wToggleableObjectList, when the
   *  list names this object. This is the bit a pickup must flip. */
  globalId: number | null;
}

/** Every visible ground item ball on the CURRENT map, from the live sprite
 *  state. Self-filtering: despawned (picked-up) missables never appear. */
export function decodeItemObjects(mem: ArrayLike<number>, sym: SymbolTable): ItemObj[] {
  const n = mem[sym.addr("wNumSprites")];
  const extra = sym.addr("wMapSpriteExtraData");
  const d1 = sym.addr("wSpriteStateData1"), d2 = sym.addr("wSpriteStateData2");
  // objectIndex -> global flag id for THIS map (see module header)
  const listA = sym.addr("wToggleableObjectList");
  const flagsA = sym.addr("wToggleableObjectFlags");
  const gids = new Map<number, number>();
  for (let k = 0; k < 16; k++) {
    const obj = mem[listA + k * 2];
    if (obj === 0xff) break;
    gids.set(obj, mem[listA + k * 2 + 1]);
  }
  const hidden = (i: number): boolean => {
    const gid = gids.get(i);
    if (gid === undefined) return false;
    return ((mem[flagsA + (gid >> 3)] >> (gid & 7)) & 1) === 1;
  };
  const out: ItemObj[] = [];
  for (let i = 1; i <= n && i <= 15; i++) {
    const pic = mem[d1 + i * 16];
    if (pic !== BALL_PIC) continue;
    const e0 = mem[extra + (i - 1) * 2], e1 = mem[extra + (i - 1) * 2 + 1];
    if (e0 === 0 || e1 !== 0) continue;
    if (hidden(i)) continue;   // picked up: flag set, draw suppressed
    out.push({
      sprite: i,
      y: mem[d2 + i * 16 + 4] - 4,
      x: mem[d2 + i * 16 + 5] - 4,
      itemId: e0,
      // ids >200 are TM balls with id = 200 + TM number. NOT recalled: the two
      // TM balls in the live corpus decode to id 201 on map61 (Mt Moon B2F,
      // which Bulbapedia places TM01 on) and id 212 on map59 (Mt Moon 1F,
      // TM12) — two independent map/item cross-checks. probe_items607 asserts
      // both. Plain items go through itemLabel (ItemNames-backed, wq#519).
      name: e0 > 200 ? `tm${String(e0 - 200).padStart(2, "0")}` : itemLabel(e0),
      globalId: gids.get(i) ?? null,
    });
  }
  return out;
}

/** Snapshot of the toggleable/missable object flag region (32 bytes). */
export function toggleableFlags(mem: ArrayLike<number>, sym: SymbolTable): number[] {
  const a = sym.addr("wToggleableObjectFlags");
  const end = sym.addr("wToggleableObjectFlagsEnd");
  const out: number[] = [];
  for (let i = a; i < end; i++) out.push(mem[i]);
  return out;
}

/** Global bit indices that flipped 0->1 between two snapshots. A confirmed
 *  single pickup flips exactly one. */
export function flippedBits(before: number[], after: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const gained = after[i] & ~before[i];
    for (let b = 0; b < 8; b++) if ((gained >> b) & 1) out.push(i * 8 + b);
  }
  return out;
}

/** The state-block line: present ONLY when a ball is on-map (wq#488 no dead
 *  prose). steps: astar distances keyed by sprite slot; null = unreachable
 *  from here, which is stated rather than hidden — a ball across a ledge is
 *  real information. */
export function itemBallLine(objs: ItemObj[], steps: Map<number, number | null>): string | null {
  if (!objs.length) return null;
  const parts = objs.map(o => {
    const s = steps.get(o.sprite);
    const dist = s === null || s === undefined ? "unreachable from here" : `${s} steps`;
    return `${o.name} at (${o.x},${o.y}), ${dist}`;
  });
  return `! ITEM BALL${objs.length > 1 ? "S" : ""} on this map: ${parts.join("; ")} — ` +
    `free items: walk adjacent and interact(x,y) to pick up (grab when close, don't cross the map for one).`;
}
