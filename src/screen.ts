// Screen text layer: decode the live BG tilemap (wTileMap, 20x18) into text.
// Gen 1 loads the font so that, for text tiles, tile ID == character code.
// This gives us dialog/menu text as ground truth with zero OCR.

import { Emulator } from "./emulator";
import { SymbolTable } from "./symbols";
import { GEN1_CHAR } from "./names";

export const W = 20, H = 18;

// Special tiles that carry meaning rather than letters
export const TILE = {
  SPACE: 0x7f,
  CURSOR: 0xed,   // right-pointing menu selection arrow
  PROMPT: 0xee,   // down arrow: text is paused, waiting for A
  BOX_TL: 0x79, BOX_H: 0x7a, BOX_TR: 0x7b,
  BOX_V: 0x7c, BOX_BL: 0x7d, BOX_BR: 0x7f,
};

/** wq#620: one character map, one home — the ROM-verified GEN1_CHAR in
 *  names.ts (font tile ID == character code, so tilemap and ROM strings share
 *  the encoding). This function previously carried its own hand-typed copy,
 *  and the copies had drifted (0xE1/0xE2 as "P"/"M", 0xBA as bare "e", no
 *  0xBD): the mart list rendered "POKe BALL" from one table while ItemNames
 *  decoded "POKé BALL" from the other. Cursor/prompt stay control tiles. */
function ch(t: number): string {
  if (t === TILE.CURSOR || t === TILE.PROMPT) return "\u0000";  // control, not text
  return GEN1_CHAR[t] ?? "\u0000";  // not a text tile
}

export class Screen {
  private base: number;
  constructor(private emu: Emulator, sym: SymbolTable) {
    this.base = sym.addr("wTileMap");
  }

  /** Raw 20x18 tile IDs */
  tiles(): number[][] {
    const m = this.emu.mem();
    const out: number[][] = [];
    for (let y = 0; y < H; y++) {
      const row: number[] = [];
      for (let x = 0; x < W; x++) row.push(m[this.base + y * W + x]);
      out.push(row);
    }
    return out;
  }

  /** Rendered text grid; non-text tiles become spaces */
  textGrid(): string[] {
    return this.tiles().map(row =>
      row.map(t => { const c = ch(t); return c === "\u0000" ? " " : c; }).join(""));
  }

  /** All readable text, blank rows dropped */
  text(): string {
    return this.textGrid().map(r => r.replace(/\s+$/, ""))
      .filter(r => r.trim().length > 1).join("\n");
  }

  /** Coordinates of every occurrence of a tile ID */
  find(tile: number): { x: number; y: number }[] {
    const hits: { x: number; y: number }[] = [];
    const t = this.tiles();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      if (t[y][x] === tile) hits.push({ x, y });
    return hits;
  }

  /** Text is paused mid-dialog waiting for A (the blinking down-arrow) */
  awaitingPrompt(): boolean { return this.find(TILE.PROMPT).length > 0; }

  /** Menu selection arrow position, or null when no menu cursor is drawn */
  cursor(): { x: number; y: number } | null {
    const c = this.find(TILE.CURSOR);
    return c.length ? c[0] : null;
  }

  /** Debug: hex dump of the tilemap */
  hex(): string {
    return this.tiles().map(r => r.map(t => t.toString(16).padStart(2, "0")).join(" ")).join("\n");
  }
}
