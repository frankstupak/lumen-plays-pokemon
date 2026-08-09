// Input-safety gate.
// The engine drops joypad input whenever a script owns the player (map-entry
// auto-walk, cutscenes, forced movement). Pressing buttons in that window is a
// no-op that silently desyncs the agent from the game. Nothing may press a
// button until settle() says the engine is listening.

import { Emulator } from "./emulator";
import { SymbolTable } from "./symbols";

export const SF5_SCRIPT_CONTROL = 0x80;  // wStatusFlags5 bit 7: script owns the player

export class Sync {
  private aJoyIgnore: number;
  private aSf5: number;
  private aWalk: number;
  private aCurMap: number;

  constructor(private emu: Emulator, sym: SymbolTable) {
    this.aJoyIgnore = sym.addr("wJoyIgnore");
    this.aSf5 = sym.addr("wStatusFlags5");
    this.aWalk = sym.addr("wWalkCounter");
    this.aCurMap = sym.addr("wCurMap");
  }

  joyIgnore(): number { return this.emu.mem()[this.aJoyIgnore]; }
  statusFlags5(): number { return this.emu.mem()[this.aSf5]; }
  walkCounter(): number { return this.emu.mem()[this.aWalk]; }
  curMap(): number { return this.emu.mem()[this.aCurMap]; }

  /** Text box or full-screen text is being displayed (wStatusFlags5 bit 6).
   *  NOT part of busy(): dialog handling must run while text is up. Movement
   *  must NOT: a wedged sign dialog silently ate 4 minutes of nav input. */
  textUp(): boolean { return (this.statusFlags5() & 0x40) !== 0; }

  /** True while the engine is ignoring us or mid-step */
  busy(): boolean {
    return this.joyIgnore() !== 0
      || (this.statusFlags5() & SF5_SCRIPT_CONTROL) !== 0
      || this.walkCounter() !== 0;
  }

  /**
   * Advance frames until the engine accepts input and has been quiet for
   * `quietFrames`. Returns true if it settled, false on timeout.
   */
  async settle(maxFrames = 900, quietFrames = 8): Promise<boolean> {
    let quiet = 0;
    for (let i = 0; i < maxFrames; i++) {
      await this.emu.framesAsync(1);
      if (this.busy()) { quiet = 0; continue; }
      if (++quiet >= quietFrames) return true;
    }
    return false;
  }

  /** Snapshot of the gate for logging */
  debug(): object {
    return {
      joyIgnore: this.joyIgnore(),
      sf5: this.statusFlags5(),
      walk: this.walkCounter(),
      busy: this.busy(),
    };
  }
}
