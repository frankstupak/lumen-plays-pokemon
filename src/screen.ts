// Screen text layer: decode the live BG tilemap (wTileMap, 20x18) into text.
// Gen 1 loads the font so that, for text tiles, tile ID == character code.
// This gives us dialog/menu text as ground truth with zero OCR.

import { Emulator } from "./emulator";
import { SymbolTable } from "./symbols";

export const W = 20, H = 18;

// Special tiles that carry meaning rather than letters
export const TILE = {
  SPACE: 0x7f,
  CURSOR: 0xed,   // right-pointing menu selection arrow
  PROMPT: 0xee,   // down arrow: text is paused, waiting for A
  BOX_TL: 0x79, BOX_H: 0x7a, BOX_TR: 0x7b,
  BOX_V: 0x7c, BOX_BL: 0x7d, BOX_BR: 0x7f,
};

function ch(t: number): string {
  if (t === TILE.SPACE) return " ";
  if (t >= 0x80 && t <= 0x99) return String.fromCharCode(65 + (t - 0x80));   // A-Z
  if (t >= 0xa0 && t <= 0xb9) return String.fromCharCode(97 + (t - 0xa0));   // a-z
  if (t >= 0xf6 && t <= 0xff) return String.fromCharCode(48 + (t - 0xf6));   // 0-9
  switch (t) {
    case 0xba: return "e";
    case 0x9a: return "("; case 0x9b: return ")"; case 0x9c: return ":";
    case 0x9d: return ";"; case 0x9e: return "["; case 0x9f: return "]";
    case 0xe0: return "'"; case 0xe1: return "P"; case 0xe2: return "M";
    case 0xe3: return "-"; case 0xe6: return "?"; case 0xe7: return "!";
    case 0xe8: return "."; case 0xef: return "M"; case 0xf5: return "F";
    case 0xf1: return "x"; case 0xf2: return "."; case 0xf3: return "/";
    case 0xf4: return ","; case 0xe4: return "'"; case 0xe5: return "'";
    case 0xed: case 0xee: return "\u0000";  // cursor/prompt: control, not text
    default: return "\u0000";  // not a text tile
  }
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
