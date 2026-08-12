// Lifetime retry ledger, split three ways (wq#470):
//   serviceBoots      = every harness (re)start (infra: deploys, crashes,
//                       crash-loops). Stored as legacy field "boots" so old
//                       ledgers stay readable. NOT a gameplay stat.
//   gameplayContinues = deliberate resume-from-checkpoint after a brain
//                       failure streak or terminal battle softlock — the
//                       "how many continues did Lumen burn" number. Counted
//                       two ways: in-process agent reboots (noteGameplayContinue)
//                       and designed exit(3) restarts (markPendingContinue set
//                       before exit, folded in on next construction).
//   whiteouts         = in-game all-fainted resets (edge logic mirrors metrics.ts).
// History note: "boots" was displayed as CONTINUES until 2026-08-12; the
// 08-11/12 brain outage crash-looped the service and inflated it with pure
// infra restarts, so gameplayContinues counts forward from 0 (see ledger note).
// Ledger writes are atomic-rename (same pattern as power_ledger.json).
import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";

interface Ledger {
  boots: number;              // legacy name; semantically serviceBoots
  gameplayContinues?: number; // absent in pre-wq#470 ledgers -> 0
  pendingContinue?: boolean;  // set before a designed exit(3); consumed on next boot
  whiteoutsBase: number;      // whiteouts from all PRIOR runs
  currentRun: string;
  currentWhiteouts: number;   // whiteouts in the current run (folded into base on next boot)
  note?: string;
}

export interface RetryStats {
  continues: number;          // legacy alias = gameplayContinues (kiosk-facing number)
  gameplayContinues: number;
  serviceBoots: number;
  whiteouts: number;
}

export class RetryCounter {
  private path: string;
  private l: Ledger;
  private wasAllFainted = false;

  constructor(runTag: string, eventsDir: string) {
    this.path = eventsDir + "/retry_ledger.json";
    this.l = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : { boots: 0, gameplayContinues: 0, whiteoutsBase: 0, currentRun: "", currentWhiteouts: 0 };
    if (this.l.gameplayContinues === undefined) this.l.gameplayContinues = 0;
    if (this.l.currentRun !== runTag) {
      // new run: fold last run's whiteouts into base, count this boot
      this.l.whiteoutsBase += this.l.currentWhiteouts;
      this.l.currentRun = runTag;
      this.l.currentWhiteouts = 0;
      this.l.boots += 1;
      if (this.l.pendingContinue) {
        // previous process exited via the designed continue path (softlock
        // exit(3) -> systemd relaunch): that restart IS a gameplay continue.
        this.l.gameplayContinues += 1;
        this.l.pendingContinue = false;
      }
      this.save();
    }
  }

  // In-process agent reboot from checkpoint (brain fail-streak / budget path).
  noteGameplayContinue(): void {
    this.l.gameplayContinues = (this.l.gameplayContinues ?? 0) + 1;
    this.save();
  }

  // Call immediately before a designed process.exit that systemd will restart
  // (terminal softlock). The next construction converts it into a continue.
  markPendingContinue(): void {
    this.l.pendingContinue = true;
    this.save();
  }

  // Same edge detection as metrics.ts: transition INTO all-fainted, not level.
  observe(e: any): void {
    if (e.kind !== "state_read") return;
    if (!Array.isArray(e.party) || e.party.length === 0) return;
    const allFainted = e.party.every((p: any) => p.hp === 0);
    if (allFainted && !this.wasAllFainted) { this.l.currentWhiteouts++; this.save(); }
    this.wasAllFainted = allFainted;
  }

  stats(): RetryStats {
    const g = this.l.gameplayContinues ?? 0;
    return {
      continues: g,
      gameplayContinues: g,
      serviceBoots: this.l.boots,
      whiteouts: this.l.whiteoutsBase + this.l.currentWhiteouts,
    };
  }

  private save(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.l, null, 1));
    renameSync(tmp, this.path);
  }
}
