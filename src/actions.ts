// High-level game actions built on nav + dialog.
//
// Facing note: a directional press walks the player when the target tile is
// open, so "turn to face X" is not a primitive. The reliable technique is to
// stand adjacent and step *into* the target: NPCs and objects block the step,
// and a blocked step leaves the player facing what blocked it.

import { Emulator, KEYS } from "./emulator";
import { Navigator } from "./nav";
import { Dialog, DialogResult } from "./dialog";
import { Sync } from "./sync";
import { Screen } from "./screen";
import { EventBus } from "./events";
import { SymbolTable } from "./symbols";

export class Actions {
  private aCurItem: number;
  private aMaxItem: number;
  constructor(private emu: Emulator, private nav: Navigator, private dlg: Dialog,
              private sync: Sync, private scr: Screen, private bus: EventBus,
              sym: SymbolTable) {
    this.aCurItem = sym.addr("wCurrentMenuItem");
    this.aMaxItem = sym.addr("wMaxMenuItem");
  }

  /**
   * Face and interact with whatever occupies (tx,ty).
   *
   * Approach side matters: table-top objects and counter NPCs only respond
   * from their front, so a side approach silently produces nothing. We try
   * each adjacent tile, south first (the common case), and accept the first
   * approach that actually yields dialog.
   */
  async interactAt(tx: number, ty: number): Promise<DialogResult | null> {
    this.bus.emit("tool_call", { tool: "interactAt", args: { tx, ty } });
    const sides = [
      { x: tx, y: ty + 1 }, { x: tx - 1, y: ty },
      { x: tx + 1, y: ty }, { x: tx, y: ty - 1 },
    ];

    for (const c of sides) {
      const p0 = this.nav.pos();
      if (c.x !== p0.x || c.y !== p0.y) {
        const r = await this.nav.goto(c.x, c.y);
        if (r === "warped") return null;
        if (r !== "arrived") continue;
      }
      const p = this.nav.pos();
      const dx = Math.sign(tx - p.x), dy = Math.sign(ty - p.y);
      if (Math.abs(tx - p.x) + Math.abs(ty - p.y) !== 1) continue;

      // Blocked step == now facing the target.
      await this.nav.step(dx, dy);
      await this.sync.settle();
      await this.emu.tapAsync(KEYS.A, 8, 24);
      await this.sync.settle(300);

      const d = await this.dlg.advance();
      if (d.lines.length || d.stoppedAt === "choice") {
        this.bus.emit("tool_call", { tool: "interactAt", from: c, result: d.stoppedAt });
        return d;
      }
    }
    this.bus.emit("tool_call", { tool: "interactAt", args: { tx, ty }, result: "no_response" });
    return null;
  }

  /**
   * Answer an open menu/choice by driving the cursor to `index` and confirming.
   * wCurrentMenuItem is the engine's own selection index and was verified to
   * track the rendered cursor exactly, so we steer on it rather than on pixels.
   */
  async choose(index: number, max = 12): Promise<boolean> {
    await this.sync.settle();
    if (!this.scr.cursor()) return false;
    for (let i = 0; i < max; i++) {
      const cur = this.menuIndex();
      if (cur === index) break;
      await this.emu.tapAsync(cur < index ? KEYS.DOWN : KEYS.UP, 8, 10);
      await this.sync.settle(180);
      if (this.menuIndex() === cur) break;   // cursor refused to move
    }
    this.bus.emit("tool_call", { tool: "choose", args: { index }, landed: this.menuIndex() });
    await this.emu.tapAsync(KEYS.A, 8, 24);
    await this.sync.settle(300);
    return true;
  }

  menuIndex(): number { return this.emu.mem()[this.aCurItem]; }
  menuMax(): number { return this.emu.mem()[this.aMaxItem]; }

  /**
   * Answer a yes/no prompt. Gen 1 renders YES at index 0 and NO at index 1;
   * B also cancels, but explicit selection is unambiguous and logs cleanly.
   */
  async answerYesNo(yes: boolean): Promise<boolean> {
    if (!this.scr.cursor()) return false;
    this.bus.emit("tool_call", { tool: "answerYesNo", args: { yes } });
    return this.choose(yes ? 0 : 1);
  }

  /** Press B until no menu or text remains (safe abort). */
  async backOut(max = 8): Promise<void> {
    for (let i = 0; i < max; i++) {
      if (!this.dlg.open() && !this.scr.cursor()) return;
      await this.emu.tapAsync(KEYS.B, 8, 20);
      await this.sync.settle(240);
    }
  }
}
