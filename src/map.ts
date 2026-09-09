// Build a walk-unit collision grid + warp list for the current map from WRAM + ROM
import { Emulator } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";

export interface Warp { y: number; x: number; destWarp: number; destMap: number }

/** A pair of tile ids the game refuses to let the player move BETWEEN, in
 *  either order, while a given tileset is loaded. */
export interface TilePair { a: number; b: number }

/** One LedgeTiles entry (pokered HandleLedges): standing on tile `standing`,
 *  pressing toward (dx,dy) with tile `ledge` in front, the game JUMPS the
 *  player two cells in that direction. Ledge tiles are NOT in the walkable
 *  set, so without these edges the model reads every ledge line as a solid
 *  wall — wq#601: Route 4 east's only route to Cerulean is behind a hop-down
 *  line at y=9, so eastbound A* died there and the run bounced off Mt Moon
 *  for 145h while the pack promised "hopping a ledge is progress". */
export interface LedgeEntry { standing: number; ledge: number; dx: number; dy: number }

/** wq#699: the ROM map header for a map id, as laid out by pokered's
 *  map_header macro: `db TILESET` then `db HEIGHT, WIDTH` (in blocks). The
 *  bank comes from MapHeaderBanks and the pointer from MapHeaderPointers, both
 *  indexed by map id. Standalone (no emulator) so callers that only have a ROM
 *  — checkpoint scoring, sidecar validation — can use it too. Returns null for
 *  an id past the end of the table: an unknown id must read as UNKNOWN and not
 *  as whatever bytes happen to follow the table. */
export function romMapHeader(sym: SymbolTable, rom: Rom, id: number):
    { tileset: number; height: number; width: number } | null {
  try {
    const p = sym.sym("MapHeaderPointers");
    const b = sym.sym("MapHeaderBanks");
    // Table length from the NEXT symbol, never a hardcoded map count: a ROM
    // whose layout moved returns null instead of reading past the end.
    const count = (sym.nextAddr(p.bank, p.addr) - p.addr) >> 1;
    if (id < 0 || id >= count) return null;
    const a = rom.byte(p.bank, p.addr + id * 2) | (rom.byte(p.bank, p.addr + id * 2 + 1) << 8);
    const e = rom.bytes(rom.byte(b.bank, b.addr + id), a, 3);
    return { tileset: e[0], height: e[1], width: e[2] };
  } catch { return null; }
}

/** wq#699: is (x,y) a coordinate the named map could physically hold? The
 *  torn-read signature is a position from the map being LEFT under the id of
 *  the map being ENTERED — map88 (Bill's house, 8x8 walk cells) reported at
 *  Route 25's (45,3). Unknown map ids answer true: this rejects impossibility,
 *  it does not assert correctness. */
export function coordsPlausible(sym: SymbolTable, rom: Rom, id: number, x: number, y: number): boolean {
  const h = romMapHeader(sym, rom, id);
  if (!h) return true;
  return x >= 0 && y >= 0 && x < h.width * 2 && y < h.height * 2;
}

export class MapModel {
  width = 0; height = 0;          // in blocks
  gw = 0; gh = 0;                 // walk-unit grid dims (2x blocks)
  grid: boolean[][] = [];         // [y][x] true = walkable terrain
  tileIds: number[][] = [];       // [y][x] the collision tile id sampled per cell
  /** wq#607: pic = wSpriteStateData1 picture id, so callers can give
   *  sprites IDENTITY (0x3D = ground item ball; see objects.ts). */
  sprites: { y: number; x: number; pic: number }[] = [];
  warps: Warp[] = [];
  tilesetId = 0;
  /** wq#1565: the tile id the ENGINE tests for a wild encounter, and the map's
   *  encounter rate. pokered LoadTilesetHeader copies the tileset header's
   *  grass byte into wGrassTile and the map header's rate into wGrassRate;
   *  TryDoWildEncounter rolls only when the tile underfoot equals wGrassTile
   *  (rate 0 = no wild pool at all, e.g. a town). Both come from RAM rather
   *  than a hardcoded 0x52 so every tileset answers for itself; verified equal
   *  to the ROM Tilesets entry's byte 10 on every checkpoint in the live
   *  corpus (probe_grass1565 G1). 0xff = this tileset has no grass tile. */
  grassTile = 0xff;
  grassRate = 0;
  /** TilePairCollisionsLand entries that apply to the CURRENT tileset. */
  landPairs: TilePair[] = [];
  /** LedgeTiles entries — populated only on the overworld tileset (see build). */
  ledges: LedgeEntry[] = [];
  /** wq#606: the map header's connection byte (pokered wCurMapConnections,
   *  d370 = wCurMapHeaderEnd - 1; the byte carries no label in pokeblue.sym).
   *  Bits per pokered map_data_constants: EAST=1, WEST=2, SOUTH=4, NORTH=8.
   *  0 means NO adjacent map exists to walk into — an interior, where the
   *  only exits are door warps. Bit layout verified empirically by
   *  probe_scope606 §E on maps 3 (0x0F), 15 (0x05), 67 (0x00). */
  connections = 0;

  constructor(private emu: Emulator, private sym: SymbolTable, private rom: Rom) {}

  build() {
    const m = this.emu.mem();
    const s = this.sym;
    this.width = m[s.addr("wCurMapWidth")];
    this.height = m[s.addr("wCurMapHeight")];
    this.gw = this.width * 2; this.gh = this.height * 2;
    this.tilesetId = m[s.addr("wCurMapTileset")];
    this.grassTile = m[s.addr("wGrassTile")];
    this.grassRate = m[s.addr("wGrassRate")];
    // wq#606: wCurMapConnections is the header's last byte and unlabeled in
    // the .sym — derive it from the labeled end marker rather than a magic
    // address, so a re-dumped symbol file cannot silently skew it.
    this.connections = m[s.addr("wCurMapHeaderEnd") - 1];

    const ts = s.sym("Tilesets");
    const e = this.rom.bytes(ts.bank, ts.addr + this.tilesetId * 12, 12);
    const tsBank = e[0];
    const blockPtr = e[1] | (e[2] << 8);
    const collPtr = e[5] | (e[6] << 8);
    const collBank = collPtr < 0x4000 ? 0 : tsBank;
    const walkable = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const t = this.rom.byte(collBank, collPtr + i);
      if (t === 0xff) break;
      walkable.add(t);
    }

    const stride = this.width + 6;
    const base = s.addr("wOverworldMap");
    this.grid = Array.from({ length: this.gh }, () => Array(this.gw).fill(false));
    this.tileIds = Array.from({ length: this.gh }, () => Array(this.gw).fill(-1));
    for (let y = 0; y < this.gh; y++) {
      for (let x = 0; x < this.gw; x++) {
        const block = m[base + ((y >> 1) + 3) * stride + ((x >> 1) + 3)];
        // bottom-left 8px tile of the 2x2 tile walk cell decides passability.
        // Confirmed against the running game by wq#552 probe_collision552: the
        // screen<->map origin matches 360/360 tiles with the player's cell
        // top-left at screen (8,8), so pokered's lda_coord 8,9 standing tile is
        // this cell's bottom-left; and wTileInFrontOfPlayer agrees on every
        // discriminating trial.
        const tile = this.rom.byte(tsBank, blockPtr + block * 16 + ((y & 1) * 2 + 1) * 4 + (x & 1) * 2);
        this.tileIds[y][x] = tile;
        this.grid[y][x] = walkable.has(tile);
      }
    }

    // TilePairCollisionsLand (pokered CheckForTilePairCollisions). Gen 1 refuses
    // movement between certain tile pairs EVEN WHEN BOTH TILES ARE PASSABLE, so
    // walkability is a property of the (standing, target) pair and not of the
    // target cell alone. Mt Moon's tileset pairs 0x20 with 0x05, which is the
    // whole of the wq#542 confinement: the strip floor is 0x20, the boundary
    // south of it is 0x05, and 0x05 is in the passable list.
    this.landPairs = [];
    const tp = s.sym("TilePairCollisionsLand");
    for (let i = 0; i < 64; i++) {
      const entryTileset = this.rom.byte(tp.bank, tp.addr + i * 3);
      if (entryTileset === 0xff) break;
      const a = this.rom.byte(tp.bank, tp.addr + i * 3 + 1);
      const b = this.rom.byte(tp.bank, tp.addr + i * 3 + 2);
      if (entryTileset === this.tilesetId) this.landPairs.push({ a, b });
    }

    // LedgeTiles (pokered HandleLedges). Unlike TilePairCollisionsLand the
    // table carries NO tileset column; the gate lives in code — HandleLedges
    // opens with `ld a, [wCurMapTileset] / and a / ret nz`, so ledges exist
    // ONLY on tileset 0 (overworld). That gate is load-bearing here: cave
    // tilesets reuse the same tile-id space, and ungated entries would mint
    // phantom hop edges through Mt Moon walls. Entry: facing, standing tile,
    // ledge tile, D-pad input; the input byte names the hop direction
    // (D_DOWN=0x80, D_UP=0x40, D_LEFT=0x20, D_RIGHT=0x10).
    this.ledges = [];
    if (this.tilesetId === 0) {
      const lt = s.sym("LedgeTiles");
      for (let i = 0; i < 32; i++) {
        const e2 = this.rom.bytes(lt.bank, lt.addr + i * 4, 4);
        if (e2[0] === 0xff) break;
        const input = e2[3];
        const dx = input === 0x20 ? -1 : input === 0x10 ? 1 : 0;
        const dy = input === 0x80 ? 1 : input === 0x40 ? -1 : 0;
        if (dx === 0 && dy === 0) continue;
        this.ledges.push({ standing: e2[1], ledge: e2[2], dx, dy });
      }
    }

    // NPC sprites 1..15 (0 = player); wSpriteStateData2[i*16+4/5] = mapY+4 / mapX+4
    this.sprites = [];
    const d1 = s.addr("wSpriteStateData1"), d2 = s.addr("wSpriteStateData2");
    for (let i = 1; i < 16; i++) {
      const pic = m[d1 + i * 16];
      if (pic === 0 || pic === 0xff) continue;
      const sy = m[d2 + i * 16 + 4] - 4, sx = m[d2 + i * 16 + 5] - 4;
      if (sy >= 0 && sy < this.gh && sx >= 0 && sx < this.gw) this.sprites.push({ y: sy, x: sx, pic });
    }

    const n = m[s.addr("wNumberOfWarps")];
    const we = s.addr("wWarpEntries");
    this.warps = [];
    for (let i = 0; i < n; i++)
      this.warps.push({ y: m[we + i * 4], x: m[we + i * 4 + 1], destWarp: m[we + i * 4 + 2], destMap: m[we + i * 4 + 3] });
  }

  passable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.gw || y >= this.gh) return false;
    if (!this.grid[y][x]) return false;
    return !this.sprites.some(sp => sp.x === x && sp.y === y);
  }

  /** Does the game refuse to move between these two adjacent cells because of a
   *  tile-pair collision? This is NOT a property of the destination: the same
   *  destination is enterable from one neighbour and refused from another. */
  pairBlocked(fromX: number, fromY: number, toX: number, toY: number): boolean {
    if (!this.landPairs.length) return false;
    if (fromX < 0 || fromY < 0 || fromX >= this.gw || fromY >= this.gh) return false;
    if (toX < 0 || toY < 0 || toX >= this.gw || toY >= this.gh) return false;
    const f = this.tileIds[fromY][fromX], t = this.tileIds[toY][toX];
    return this.landPairs.some(p => (p.a === f && p.b === t) || (p.b === f && p.a === t));
  }

  /** Can the player actually step from (fromX,fromY) to the adjacent
   *  (toX,toY)? Prefer this over passable() for movement decisions. */
  passableFrom(fromX: number, fromY: number, toX: number, toY: number): boolean {
    return this.passable(toX, toY) && !this.pairBlocked(fromX, fromY, toX, toY);
  }

  /** Ledge-hop landing cells from (x,y): for each LedgeTiles entry whose
   *  standing tile matches the cell underfoot and whose ledge tile is the
   *  next cell in the entry's direction, the game jumps the player TWO cells
   *  that way. Directed by construction — the reverse hop needs its own table
   *  entry and Gen 1 has none, which is exactly why Route 4 east is one-way.
   *  A sprite on the ledge cell or the landing blocks the jump in-engine, so
   *  it removes the edge here too (passable() already covers the landing). */
  hops(x: number, y: number): { x: number; y: number }[] {
    if (!this.ledges.length) return [];
    const standing = this.tileIds[y]?.[x];
    const out: { x: number; y: number }[] = [];
    for (const l of this.ledges) {
      if (l.standing !== standing) continue;
      const mx = x + l.dx, my = y + l.dy;          // ledge cell
      const lx = x + 2 * l.dx, ly = y + 2 * l.dy;  // landing cell
      if (this.tileIds[my]?.[mx] !== l.ledge) continue;
      if (!this.passable(lx, ly)) continue;
      if (this.sprites.some(sp => sp.x === mx && sp.y === my)) continue;
      if (!out.some(o => o.x === lx && o.y === ly)) out.push({ x: lx, y: ly });
    }
    return out;
  }

  /** Cached per-instance view of romMapHeader() (pure ROM data). */
  private hdrCache = new Map<number, { tileset: number; height: number; width: number } | null>();
  romHeader(id: number): { tileset: number; height: number; width: number } | null {
    if (this.hdrCache.has(id)) return this.hdrCache.get(id)!;
    const h = romMapHeader(this.sym, this.rom, id);
    this.hdrCache.set(id, h);
    return h;
  }

  /** wq#699/#700: TRUE while wCurMap names a map whose DATA IS NOT LOADED YET.
   *
   *  Gen 1 sets wCurMap to the destination early in the warp handler and only
   *  loads that map's header, blocks, warp table and player coordinates some
   *  frames later. In between, RAM describes two different maps at once and
   *  every (map,x,y) read is a lie — measured on this ROM (Route 25 -> Bill's
   *  house, checkpoint auto-mt2f0ie1-map88): wCurMap flips at frame 0, the
   *  header arrives at frame 15, the coordinates at frame 16, and for the
   *  first 12 of those frames wJoyIgnore/wStatusFlags5/wWalkCounter are ALL
   *  ZERO — so Sync.busy() reads "idle" and Sync.settle() returns inside the
   *  window. Quiet is not the same as finished; that is why this test is on
   *  the DATA and not on the flags or on a frame count.
   *
   *  The comparison is exact and ROM-derived: the loaded header must match the
   *  header the ROM defines for wCurMap. It cannot false-positive (a matching
   *  header is a loaded header) and it catches every transition between maps
   *  of differing size or tileset. Same-shape pairs are covered by the
   *  position-stability and bounds checks in Navigator.awaitMapSettled(). */
  loadPending(): boolean {
    const m = this.emu.mem(), s = this.sym;
    const h = this.romHeader(m[s.addr("wCurMap")]);
    if (!h) return false;                       // unknown id: nothing to assert
    return m[s.addr("wCurMapWidth")] !== h.width ||
           m[s.addr("wCurMapHeight")] !== h.height ||
           m[s.addr("wCurMapTileset")] !== h.tileset;
  }

  /** wq#1565: can a wild Pokemon appear on this cell? Wild encounters in Gen 1
   *  roll per STEP and ONLY on the tileset's grass tile, so every cell that is
   *  not one of these is dead ground for catching — the 582h Route 24 freeze
   *  was the brain walking such ground because the grid never named it. */
  isGrass(x: number, y: number): boolean {
    if (this.grassRate === 0 || this.grassTile === 0xff) return false;
    if (x < 0 || y < 0 || x >= this.gw || y >= this.gh) return false;
    return this.tileIds[y][x] === this.grassTile;
  }

  /** Every encounter tile on this map, nearest-first by Manhattan distance
   *  from (x,y). Manhattan is the ordering only — the caller prices the real
   *  walk with astar, which is what the brain is promised in steps. */
  grassCells(x: number, y: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let gy = 0; gy < this.gh; gy++)
      for (let gx = 0; gx < this.gw; gx++)
        if (this.isGrass(gx, gy)) out.push({ x: gx, y: gy });
    return out.sort((a, b) =>
      (Math.abs(a.x - x) + Math.abs(a.y - y)) - (Math.abs(b.x - x) + Math.abs(b.y - y)));
  }

  /** Is (x,y) a warp tile? Pathfinding must not cross these as shortcuts. */
  isWarp(x: number, y: number): boolean {
    return this.warps.some(w => w.x === x && w.y === y);
  }

  ascii(px: number, py: number): string {
    let out = "";
    for (let y = 0; y < this.gh; y++) {
      for (let x = 0; x < this.gw; x++) {
        if (x === px && y === py) out += "P";
        else if (this.warps.some(w => w.x === x && w.y === y)) out += "W";
        else if (this.sprites.some(sp => sp.x === x && sp.y === y && sp.pic === 0x3d)) out += "B";  // wq#607: item ball
        else if (this.sprites.some(sp => sp.x === x && sp.y === y)) out += "N";
        else if (this.isGrass(x, y)) out += "G";   // wq#1565: the only cells wilds spawn on
        else out += this.grid[y][x] ? "." : "#";
      }
      out += "\n";
    }
    return out;
  }
}

/** What the brain is told about encounter tiles on the current map. */
export interface GrassView {
  count: number;                            // encounter tiles on this map
  onGrass: boolean;                         // the player is standing on one
  nearest: { x: number; y: number } | null; // nearest reachable-looking cell
  steps: number | null;                     // astar cost to it, null = no path
}

/** wq#1565: the encounter-tile advisory. Renders ONLY on maps that HAVE grass
 *  (same wq#488 no-dead-prose rule as the item-ball and hidden-item lines), so
 *  towns, interiors and caves stay silent. It exists because the MAPGRID alone
 *  answers "where is grass" but not "wilds appear ONLY there, per step" — the
 *  brain spent 452 turns and 725 goto calls on Route 24 without one battle
 *  while believing grass simply was not shown. */
export function grassLine(v: GrassView): string | null {
  if (v.count === 0) return null;
  const where = `${v.count} tall-grass tile${v.count > 1 ? "s" : ""} on this map (G in MAPGRID)`;
  if (v.onGrass)
    return `! TALL GRASS: you are STANDING on grass — ${where}. Wild Pokemon roll PER STEP ` +
      `taken on a G tile and never anywhere else: keep goto()ing G tiles here until a battle ` +
      `starts, and do not walk off the grass to look for one.`;
  if (!v.nearest || v.steps === null)
    return `! TALL GRASS: ${where}, none reachable from here — wild Pokemon appear ONLY while ` +
      `stepping on G tiles, so a catch needs a route onto the grass first.`;
  return `! TALL GRASS at (${v.nearest.x},${v.nearest.y}), ${v.steps} steps — ${where}. Wild ` +
    `Pokemon appear ONLY while stepping on a G tile: goto(${v.nearest.x},${v.nearest.y}), then ` +
    `keep stepping between G tiles until one shows up.`;
}
