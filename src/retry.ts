// Lifetime "CONTINUES" counter: how many resets it takes to train Lumen to
// beat the game. Two numbers, both persisted across runs in a ledger:
//   continues  = boots (every harness (re)start = one reset of the session)
//   whiteouts  = in-game all-fainted resets (mirrors metrics.ts edge logic)
// Ledger writes are atomic-rename (same pattern as power_ledger.json).
// Backfill note: seeded 2026-08-08 with boots=36 (boot events across ALL
// surviving event logs, complete since project start 2026-08-02) and
// whiteoutsBase=7 (6 documented pre-metrics blackouts + 1 from run-summaries).
import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";

interface Ledger {
  boots: number;
  whiteoutsBase: number;      // whiteouts from all PRIOR runs
  currentRun: string;
  currentWhiteouts: number;   // whiteouts in the current run (folded into base on next boot)
  note?: string;
}

export class RetryCounter {
  private path: string;
  private l: Ledger;
  private wasAllFainted = false;

  constructor(runTag: string, eventsDir: string) {
    this.path = eventsDir + "/retry_ledger.json";
    this.l = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : { boots: 0, whiteoutsBase: 0, currentRun: "", currentWhiteouts: 0 };
    if (this.l.currentRun !== runTag) {
      // new run: fold last run's whiteouts into base, count this boot
      this.l.whiteoutsBase += this.l.currentWhiteouts;
      this.l.currentRun = runTag;
      this.l.currentWhiteouts = 0;
      this.l.boots += 1;
      this.save();
    }
  }

  // Same edge detection as metrics.ts: transition INTO all-fainted, not level.
  observe(e: any): void {
    if (e.kind !== "state_read") return;
    if (!Array.isArray(e.party) || e.party.length === 0) return;
    const allFainted = e.party.every((p: any) => p.hp === 0);
    if (allFainted && !this.wasAllFainted) { this.l.currentWhiteouts++; this.save(); }
    this.wasAllFainted = allFainted;
  }

  stats(): { continues: number; whiteouts: number } {
    return { continues: this.l.boots, whiteouts: this.l.whiteoutsBase + this.l.currentWhiteouts };
  }

  private save(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.l, null, 1));
    renameSync(tmp, this.path);
  }
}
