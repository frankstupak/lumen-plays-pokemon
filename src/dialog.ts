// Dialog driver: read text boxes, advance them, and stop at genuine choices.
//
// Contract: advance() never makes a decision. The moment a selection cursor
// appears it hands control back, because pressing A at a Yes/No prompt is a
// choice the agent must own, not something the transport layer guesses at.

import { Emulator, KEYS } from "./emulator";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { SymbolTable } from "./symbols";
import { EventBus } from "./events";

const BOX_TOP = 12;   // text box occupies the bottom six rows

export interface DialogResult {
  lines: string[];        // everything read across the whole exchange
  stoppedAt: "clear" | "choice" | "limit";
  presses: number;
}

export class Dialog {
  private aSf5: number;
  constructor(private emu: Emulator, private scr: Screen,
              private sync: Sync, private bus: EventBus, sym: SymbolTable) {
    this.aSf5 = sym.addr("wStatusFlags5");
  }

  /**
   * wStatusFlags5 bit 6 is the engine's own "printing text" flag. Verified set
   * for the full duration of both bottom text boxes and full-screen displays
   * like the Pokedex entry shown when taking a starter. This is authoritative
   * where scanning the tilemap is not: the dex screen paints in the UPPER rows,
   * so a bottom-rows-only scan reports "no dialog" while text is very much up.
   */
  printingText(): boolean { return (this.emu.mem()[this.aSf5] & 0x40) !== 0; }

  /** Readable text anywhere on screen, not just the bottom box */
  screenLines(): string[] {
    return this.scr.textGrid()
      .map(r => r.trim()).filter(r => (r.match(/[A-Za-z]/g) || []).length >= 2);
  }

  /** Decoded lines currently inside the text box region */
  boxLines(): string[] {
    return this.scr.textGrid().slice(BOX_TOP)
      .map(r => r.trim()).filter(r => (r.match(/[A-Za-z]/g) || []).length >= 2);
  }

  /** Text is on screen in any form */
  open(): boolean { return this.printingText() || this.boxLines().length > 0; }

  /** A selection cursor is sitting inside the text box = a real choice */
  choice(): boolean {
    // Any rendered selection cursor is a decision point. Scoping this to the
    // bottom box was wrong: the nickname yes/no prompt draws in the upper
    // rows, so a bottom-only check walked straight past it into the name
    // entry keyboard and mashed A.
    return this.scr.cursor() !== null;
  }

  /** A menu cursor anywhere (choices can render above the box too) */
  anyCursor(): boolean { return this.scr.cursor() !== null; }

  /**
   * Press A until the conversation clears or a choice appears.
   * Returns every distinct line observed, in order.
   */
  async advance(maxPresses = 60): Promise<DialogResult> {
    const seen: string[] = [];
    const record = () => {
      for (const l of this.screenLines()) if (!seen.includes(l)) seen.push(l);
    };

    await this.sync.settle();
    record();

    let presses = 0;
    let clearStreak = 0;

    while (presses < maxPresses) {
      if (this.choice()) {
        this.bus.emit("tool_call", { tool: "dialog", result: "choice", lines: seen.slice(-3) });
        return { lines: seen, stoppedAt: "choice", presses };
      }
      if (!this.open() && !this.scr.awaitingPrompt()) {
        if (++clearStreak >= 4) {
          if (seen.length)
            this.bus.emit("tool_call", { tool: "dialog", result: "clear", lines: seen });
          return { lines: seen, stoppedAt: "clear", presses };
        }
        await this.emu.framesAsync(30);
        record();
        continue;
      }
      clearStreak = 0;
      await this.emu.tapAsync(KEYS.A, 8, 24);
      presses++;
      await this.sync.settle(240);
      record();
    }

    this.bus.emit("tool_call", { tool: "dialog", result: "limit", lines: seen.slice(-3) });
    return { lines: seen, stoppedAt: "limit", presses };
  }

  /** Face a direction and interact; returns whatever dialog resulted. */
  async interact(dirKey: "UP" | "DOWN" | "LEFT" | "RIGHT" | null = null): Promise<DialogResult> {
    await this.sync.settle();
    if (dirKey) { await this.emu.tapAsync(KEYS[dirKey], 8, 6); await this.sync.settle(240); }
    await this.emu.tapAsync(KEYS.A, 8, 24);
    await this.sync.settle(240);
    return this.advance();
  }
}
