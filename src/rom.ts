// Direct ROM file reader with GB bank addressing
import { readFileSync } from "fs";

export class Rom {
  data: Buffer;
  constructor(path: string) { this.data = readFileSync(path); }
  offset(bank: number, addr: number): number {
    return addr < 0x4000 ? addr : bank * 0x4000 + (addr - 0x4000);
  }
  byte(bank: number, addr: number): number { return this.data[this.offset(bank, addr)]; }
  bytes(bank: number, addr: number, n: number): Buffer {
    const o = this.offset(bank, addr); return this.data.subarray(o, o + n);
  }
}
