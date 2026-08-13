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

  // wq#503: reverse + ordered views over the same symbols. Built lazily on
  // first use so existing callers (probes, the live agent's hot path) pay
  // nothing. Needed to name map headers from MapHeaderPointers and to derive
  // ROM table LENGTHS from the next symbol, instead of hardcoding counts.
  private rev: Map<number, string[]> | null = null;
  private ordered: Map<number, number[]> | null = null;

  private index(): void {
    if (this.rev) return;
    const rev = new Map<number, string[]>();
    const banks = new Map<number, Set<number>>();
    for (const [name, s] of this.map) {
      const k = (s.bank << 16) | s.addr;
      const at = rev.get(k);
      if (at) at.push(name); else rev.set(k, [name]);
      let set = banks.get(s.bank);
      if (!set) { set = new Set<number>(); banks.set(s.bank, set); }
      set.add(s.addr);
    }
    this.ordered = new Map([...banks].map(([b, s]) => [b, [...s].sort((x, y) => x - y)]));
    this.rev = rev;
  }

  /** Every label defined at this exact bank:addr (pokered stacks several). */
  labelsAt(bank: number, addr: number): string[] {
    this.index();
    return this.rev!.get((bank << 16) | addr) ?? [];
  }

  /** Address of the next symbol after `addr` in `bank`. Table lengths are
   *  derived from this, so a ROM whose layout moved throws instead of
   *  silently reading past the end of a table. */
  nextAddr(bank: number, addr: number): number {
    this.index();
    const list = this.ordered!.get(bank);
    const next = list?.find(a => a > addr);
    if (next === undefined) throw new Error(`no symbol after ${bank.toString(16)}:${addr.toString(16)}`);
    return next;
  }
}
