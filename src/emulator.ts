// serverboy wrapper: exposes internal save states + convenience I/O
import { readFileSync, writeFileSync } from "fs";
import { PNG } from "pngjs";
const Gameboy = require("serverboy");

export const KEYS = Gameboy.KEYMAP as Record<string, number>;

export class Emulator {
  private gb: any;
  private inner: any;

  constructor(romPath: string, saveData?: number[]) {
    this.gb = new Gameboy();
    const rom = readFileSync(romPath);
    saveData ? this.gb.loadRom(rom, saveData) : this.gb.loadRom(rom);
    const priv = Object.keys(this.gb)[0];
    this.inner = (this.gb as any)[priv].gameboy; // internal GameBoyCore
    if (typeof this.inner.saveState !== "function" || typeof this.inner.saving !== "function")
      throw new Error("serverboy internals changed: saveState/returnFromState unavailable");
  }

  frames(n: number) { for (let i = 0; i < n; i++) this.gb.doFrame(); }
  /** paced/streamed frame advance: onFrame every 6th frame, optional realtime pacing */
  onFrame: ((png: Buffer) => void) | null = null;
  paceMs = 0;                  // ms per 6 frames; 100 = realtime, 50 = 2x, 0 = unpaced
  private frameCount = 0;
  async framesAsync(n: number) {
    for (let i = 0; i < n; i++) {
      this.gb.doFrame(); this.frameCount++;
      if (this.frameCount % 6 === 0) {
        if (this.onFrame) this.onFrame(this.screenPngBuffer());
        if (this.paceMs) await new Promise(r => setTimeout(r, this.paceMs));
      }
    }
  }
  async tapAsync(key: number, hold = 8, release = 20) {
    for (let i = 0; i < hold; i++) { this.gb.pressKey(key); await this.framesAsync(1); }
    await this.framesAsync(release);
  }
  screenPngBuffer(): Buffer {
    const px = this.gb.getScreen();
    const png = new PNG({ width: 160, height: 144 });
    for (let i = 0; i < px.length; i++) png.data[i] = px[i];
    return PNG.sync.write(png);
  }
  tap(key: number, hold = 8, release = 20) {
    for (let i = 0; i < hold; i++) { this.gb.pressKey(key); this.gb.doFrame(); }
    this.frames(release);
  }
  hold(keys: number[], n: number) {
    for (let i = 0; i < n; i++) { this.gb.pressKeys(keys); this.gb.doFrame(); }
  }

  private liveMem: number[] | null = null;
  /** Live reference into emulator memory — zero-copy, stays valid across frames */
  mem(): number[] {
    if (!this.liveMem) this.liveMem = this.gb.getMemory() as number[];
    return this.liveMem!;
  }
  read(addr: number): number { return this.gb.getMemory()[addr]; }
  read16BE(addr: number): number { const m = this.gb.getMemory(); return (m[addr] << 8) | m[addr + 1]; }

  saveState(): any { return this.inner.saveState(); }
  loadState(snap: any) { this.inner.saving(snap); this.liveMem = null; this.gb.doFrame(); }
  batterySave(): number[] { return this.gb.getSaveData(); }

  screenPng(path: string) {
    const px = this.gb.getScreen(); // 160x144 RGBA
    const png = new PNG({ width: 160, height: 144 });
    for (let i = 0; i < px.length; i++) png.data[i] = px[i];
    writeFileSync(path, PNG.sync.write(png));
  }
}

// --- snapshot persistence ---
import { gzipSync, gunzipSync } from "zlib";
export function saveSnapshotFile(emu: Emulator, path: string) {
  writeFileSync(path, gzipSync(JSON.stringify(emu.saveState())));
}
export function loadSnapshotFile(emu: Emulator, path: string) {
  emu.loadState(JSON.parse(gunzipSync(readFileSync(path)).toString()));
}
