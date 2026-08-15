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

export class MapModel {
  width = 0; height = 0;          // in blocks
  gw = 0; gh = 0;                 // walk-unit grid dims (2x blocks)
  grid: boolean[][] = [];         // [y][x] true = walkable terrain
  tileIds: number[][] = [];       // [y][x] the collision tile id sampled per cell
  sprites: { y: number; x: number }[] = [];
  warps: Warp[] = [];
  tilesetId = 0;
  /** TilePairCollisionsLand entries that apply to the CURRENT tileset. */
  landPairs: TilePair[] = [];
  /** LedgeTiles entries — populated only on the overworld tileset (see build). */
  ledges: LedgeEntry[] = [];

  constructor(private emu: Emulator, private sym: SymbolTable, private rom: Rom) {}

  build() {
    const m = this.emu.mem();
    const s = this.sym;
    this.width = m[s.addr("wCurMapWidth")];
    this.height = m[s.addr("wCurMapHeight")];
    this.gw = this.width * 2; this.gh = this.height * 2;
    this.tilesetId = m[s.addr("wCurMapTileset")];

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
      if (sy >= 0 && sy < this.gh && sx >= 0 && sx < this.gw) this.sprites.push({ y: sy, x: sx });
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
        else if (this.sprites.some(sp => sp.x === x && sp.y === y)) out += "N";
        else out += this.grid[y][x] ? "." : "#";
      }
      out += "\n";
    }
    return out;
  }
}
