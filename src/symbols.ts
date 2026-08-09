// Parse a pret .sym file -> name -> {bank, addr}
import { readFileSync } from "fs";

export interface Sym { bank: number; addr: number }

export class SymbolTable {
  private map = new Map<string, Sym>();
  constructor(symPath: string) {
    for (const line of readFileSync(symPath, "utf8").split("\n")) {
      const m = line.match(/^([0-9a-f]{2}):([0-9a-f]{4})\s+(\S+)/i);
      if (m && !this.map.has(m[3]))
        this.map.set(m[3], { bank: parseInt(m[1], 16), addr: parseInt(m[2], 16) });
    }
  }
  sym(name: string): Sym {
    const s = this.map.get(name);
    if (!s) throw new Error(`symbol not found: ${name}`);
    return s;
  }
  /** WRAM/HRAM convenience: returns flat address, asserts bank 0 */
  addr(name: string): number {
    const s = this.sym(name);
    if (s.bank !== 0) throw new Error(`symbol ${name} is banked (${s.bank}), use sym()`);
    return s.addr;
  }
  has(name: string): boolean { return this.map.has(name); }
  get size(): number { return this.map.size; }
}
