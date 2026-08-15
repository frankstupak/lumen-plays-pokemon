// S4 Pokecenter heal macro. Research-probe-verified (probe_s4_research, map 41):
//   - nurse is the topmost sprite, static behind the counter; approach (nx, ny+2), face UP
//   - dialog: Welcome -> heal pitch -> "Shall we heal your POKeMON?" YES/NO cursor
//     (first A at the choice gets EATEN - verified-press retry required)
//   - HP+PP restore EARLY (before the dialog finishes) -> completion = full party
//     AND provably back on the overworld (!dlg && !textUp && no cursor)
//   - center restores HP, PP, and status (Gen1 canon; HP/PP probe-verified)
import { Emulator, KEYS } from "./emulator";
import { SymbolTable } from "./symbols";
import { Screen } from "./screen";
import { Sync } from "./sync";
import { Dialog } from "./dialog";
import { EventBus } from "./events";
import { readMenu } from "./menu";  // wq#620

// Pokemon Centers are detected by TILESET, not map id: every Gen1 center uses
// TILESET_POKECENTER (=6 in this build, verified vs Viridian map41) and shares
// the identical interior - nurse behind the top counter at ~(3,1). This works
// for ALL centers (Viridian, Pewter, Cerulean, ...) with zero per-map config.
const POKECENTER_TILESET = 6;
const NURSE = { x: 3, y: 1 };   // universal Gen1 center nurse position

// kept for callers/tests that ask by map id, now tileset-agnostic (unused path)
const CENTER_NURSE: Record<number, { x: number; y: number }> = { 41: NURSE };
export function knownCenter(map: number): boolean { return CENTER_NURSE[map] !== undefined; }

export class Heal {
  constructor(private emu: Emulator, private sym: SymbolTable, private scr: Screen,
              private sync: Sync, private dlg: Dialog, private nav: any,
              private reader: any, private bat: any, private bus?: EventBus) {}

  private r(name: string) { return this.emu.mem()[this.sym.addr(name)]; }
  private async tap(k: number, settle = 250) { await this.emu.tapAsync(k, 8, 16); await this.sync.settle(settle); }
  private full(): boolean {
    const party = this.reader.read().party;
    return party.length > 0 && party.every((p: any) => p.hp === p.maxHp && p.status === 0);
  }
  private overworld(): boolean { return !this.dlg.open() && !this.sync.textUp() && this.scr.cursor() === null; }

  async atCenter(): Promise<string> {
    if (this.bat.active?.()) return "heal_at_center: not during a battle";
    const map = this.r("wCurMap");
    if (this.r("wCurMapTileset") !== POKECENTER_TILESET)
      return `heal_at_center: not inside a Pokemon Center (map ${map}) - walk into a Center first`;
    const nurse = NURSE;
    if (this.full()) return "heal_at_center: party already at full health";
    // approach the counter (nurse is static; retry once for wandering-NPC drift)
    let g = await this.nav.goto(nurse.x, nurse.y + 2).catch(() => "stuck");
    if (g === "stuck" || g === "adjacent_npc") { await this.emu.framesAsync(90); g = await this.nav.goto(nurse.x, nurse.y + 2).catch(() => "stuck"); }
    if (g === "stuck" || g === "adjacent_npc") return "heal_at_center: could not reach the counter (blocked)";
    await this.tap(KEYS.UP, 200);
    await this.tap(KEYS.A, 300);
    // drive the dialog; at the YES/NO use a verified press (first A gets eaten).
    // wq#620: the press at a cursor is now READ-GATED — A answers YES only when
    // the decoded dialog actually asks about healing; any OTHER window that
    // appears here (mis-aimed interact, PC menu) gets a B instead of a blind
    // confirm. Ground-truth exits (full party + provably overworld) unchanged.
    let engaged = false;
    for (let i = 0; i < 60 && !(this.full() && this.overworld()); i++) {
      if (this.dlg.open() || this.sync.textUp() || this.scr.cursor() !== null) engaged = true;
      if (this.scr.cursor() !== null) {
        const v = readMenu(this.scr.textGrid(), this.scr.cursor(), this.scr.awaitingPrompt(),
                           this.r("wTwoOptionMenuID") !== 0);
        if (v.yesNo && !/heal/i.test(v.dialog)) { await this.tap(KEYS.B, 300); continue; }
        const before = JSON.stringify(this.scr.cursor());
        await this.tap(KEYS.A, 300);   // YES is the default row
        if (JSON.stringify(this.scr.cursor()) === before) await this.tap(KEYS.A, 300);
      } else {
        await this.tap(KEYS.A, 300);
      }
      if (!engaged && i >= 4) { await this.tap(KEYS.A, 300); }   // nurse slow to respond
      if (i === 12 && !engaged) return "heal_at_center: nurse did not respond";
    }
    if (!(this.full() && this.overworld())) {
      // settle any trailing farewell, then re-check
      for (let i = 0; i < 8 && !this.overworld(); i++) await this.tap(KEYS.A, 250);
    }
    // The nurse's closing line leaves a textbox that dlg/textUp can miss while
    // still freezing movement (probe-proven: goto returns stuck at the counter).
    // Confirm the player can actually WALK before returning; clear with B until so.
    await this.clearUntilMovable();
    const ok = this.full() && this.overworld();
    this.bus?.emit("tool_call", { tool: "heal_at_center", args: { map, ok } });
    return ok ? "healed: party at full HP/PP, status cleared" : "heal_at_center: heal did not complete (check party state)";
  }

  // Press B/A until the player can actually move. Movement freeze after the
  // nurse dialog is invisible to dlg.open()/textUp; the only reliable probe is
  // to attempt a real step and see if position changes, then step back.
  private async clearUntilMovable(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const p0 = { x: this.r("wXCoord"), y: this.r("wYCoord") };
      // try to nudge up then down (counter is above, so up is blocked -> use down/left)
      await this.emu.tapAsync(KEYS.DOWN, 8, 16); await this.sync.settle(200);
      const moved = this.r("wXCoord") !== p0.x || this.r("wYCoord") !== p0.y;
      if (moved) { await this.emu.tapAsync(KEYS.UP, 8, 16); await this.sync.settle(200); return; }  // movable; undo
      // not movable yet -> a box is up; clear it
      await this.tap(this.sync.textUp() ? KEYS.A : KEYS.B, 250);
    }
  }
}
