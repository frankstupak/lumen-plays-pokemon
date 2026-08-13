// LPP — species names read FROM THE ROM (2026-08-10).
//
// Closes an M4 open item: the duel brains were shown raw species NUMBERS, and
// at least one model reasoned about the wrong Pokemon from one. A number like
// 178 is meaningless to a model — and worse, it is meaningless in a way that
// looks like data, so the model confabulates rather than asking.
//
// Nothing is hardcoded. Gen1 stores its name table at MonsterNames ($07:421E,
// from roms/pokeblue.sym), 10 bytes per entry in INTERNAL index order starting
// at 1 — not Pokedex order. Verified against known internal indices:
//   $01 RHYDON   $15 MEW   $54 PIKACHU   $99 BULBASAUR
//   $B0 CHARMANDER   $B2 CHARMELEON
// RHYDON at index 1 is the classic tell that the table is internal-ordered; a
// Pokedex-ordered table would start at BULBASAUR.
//
// Reading the cart means the names always match the ROM actually running,
// including a Red/Blue swap, and there is no list to drift out of date.

import { readFileSync } from "fs";
import { romPath } from "../fixtures";

const MONSTER_NAMES_BANK = 0x07;
const MONSTER_NAMES_ADDR = 0x421e;
const NAME_BYTES = 10;
const MAX_INTERNAL_INDEX = 190;   // Gen1 uses 1..190, with gaps ("MissingNo.")

const bankOffset = (bank: number, addr: number) => bank * 0x4000 + (addr - 0x4000);

function decode(bytes: Buffer): string {
  let s = "";
  for (const c of bytes) {
    if (c === 0x50) break;
    if (c >= 0x80 && c <= 0x99) s += String.fromCharCode(65 + c - 0x80);
    else if (c >= 0xA0 && c <= 0xB9) s += String.fromCharCode(97 + c - 0xA0);
    else if (c === 0x7F) s += " ";
    else if (c === 0xE1) s += "PK";
    else if (c === 0xE2) s += "MN";
    else s += "";
  }
  return s.trim();
}

export class SpeciesNames {
  private names = new Map<number, string>();

  // wq#543: param renamed romPath -> romFile because the repo-root helper is
  // itself called romPath(). Positional, so no caller changes.
  constructor(romFile = romPath("pokeblue.gb")) {
    const rom = readFileSync(romFile);
    const base = bankOffset(MONSTER_NAMES_BANK, MONSTER_NAMES_ADDR);
    for (let idx = 1; idx <= MAX_INTERNAL_INDEX; idx++) {
      const start = base + NAME_BYTES * (idx - 1);
      const name = decode(rom.subarray(start, start + NAME_BYTES));
      if (name) this.names.set(idx, name);
    }
  }

  /** Name for an internal species index, or a labelled fallback. Never throws. */
  get(internalIndex: number): string {
    return this.names.get(internalIndex & 0xFF) ?? `SPECIES_${internalIndex}`;
  }

  /** "CHARMELEON (#178)" — for prompts, where the number is still worth keeping. */
  describe(internalIndex: number): string {
    return `${this.get(internalIndex)} (#${internalIndex})`;
  }

  get size(): number { return this.names.size; }
}

let shared: SpeciesNames | null = null;
/** Lazily built shared table; the ROM is read once per process. */
export function speciesNames(romPath?: string): SpeciesNames {
  if (!shared) shared = new SpeciesNames(romPath);
  return shared;
}
