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
//   whiteouts         = in-game blackouts, detected by their DURABLE
//                       CONSEQUENCES (see blackout.ts). wq#547 replaced the old
//                       all-fainted edge, which was UNOBSERVABLE at one poll per
//                       turn: 1285 state_reads on disk carry party data and not
//                       one of them caught an all-fainted party.
//                       Split in two so a measured number is never mixed with a
//                       remembered one:
//                         whiteoutsObservedBase/currentWhiteouts = MACHINE-COUNTED
//                         whiteoutsEstimatePre = the 7 typed in by hand on
//                           2026-08-08 ("6 documented pre-metrics blackouts + 1
//                           from run-summaries"). FROZEN. Never added to, never
//                           summed into the live figure, displayed separately as
//                           an estimate. A number the operator cannot trust is
//                           worse than no number.
// History note: "boots" was displayed as CONTINUES until 2026-08-12; the
// 08-11/12 brain outage crash-looped the service and inflated it with pure
// infra restarts, so gameplayContinues counts forward from 0 (see ledger note).
// Ledger writes are atomic-rename (same pattern as power_ledger.json).
import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { BlackoutDetector } from "./blackout";

interface Ledger {
  boots: number;              // legacy name; semantically serviceBoots
  gameplayContinues?: number; // absent in pre-wq#470 ledgers -> 0
  pendingContinue?: boolean;  // set before a designed exit(3); consumed on next boot
  whiteoutsBase: number;      // LEGACY (pre-wq#547): hand-typed 7 mixed with observation
  whiteoutsEstimatePre?: number;   // wq#547: frozen pre-instrumentation estimate
  whiteoutsObservedBase?: number;  // wq#547: MACHINE-COUNTED, from all PRIOR runs
  currentRun: string;
  currentWhiteouts: number;   // observed in the current run (folded into observed base on next boot)
  note?: string;
}

export interface RetryStats {
  continues: number;          // legacy alias = gameplayContinues (kiosk-facing number)
  gameplayContinues: number;
  serviceBoots: number;
  whiteouts: number;              // wq#547: OBSERVED ONLY. No estimate folded in.
  whiteoutsEstimatePre: number;   // wq#547: shown separately, never added to the above
}

export class RetryCounter {
  private path: string;
  private l: Ledger;
  private blackout = new BlackoutDetector();

  constructor(runTag: string, eventsDir: string) {
    this.path = eventsDir + "/retry_ledger.json";
    this.l = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : { boots: 0, gameplayContinues: 0, whiteoutsBase: 0, currentRun: "", currentWhiteouts: 0 };
    if (this.l.gameplayContinues === undefined) this.l.gameplayContinues = 0;
    // wq#547 MIGRATION, run once on a pre-wq#547 ledger. The old whiteoutsBase
    // was a single hand-entered 7 covering "6 documented pre-metrics blackouts
    // + 1 from run-summaries". It is FROZEN WHOLE as the pre-instrumentation
    // estimate and observation restarts at 0 under the new detector.
    // I am deliberately NOT splitting that 7 into 6-estimated + 1-observed:
    // the note is prose, the 1 was produced by the detector wq#547 just
    // established could not work, and inventing precision here is the same sin
    // as the original hand entry. See the board note of 2026-08-13T16:52Z.
    if (this.l.whiteoutsEstimatePre === undefined) {
      this.l.whiteoutsEstimatePre = this.l.whiteoutsBase ?? 0;
      this.l.whiteoutsObservedBase = 0;
    }
    if (this.l.whiteoutsObservedBase === undefined) this.l.whiteoutsObservedBase = 0;
    if (this.l.currentRun !== runTag) {
      // new run: fold last run's OBSERVED whiteouts into the observed base
      // (never into the estimate), and count this boot
      this.l.whiteoutsObservedBase += this.l.currentWhiteouts;
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

  // wq#547: same detector as metrics.ts, and it is now a CONSEQUENCE test
  // (purse halved + Center or full-heal) rather than the all-fainted edge,
  // which no state_read on disk has ever caught.
  observe(e: any): void {
    if (e.kind !== "state_read") return;
    if (this.blackout.observe(e)) { this.l.currentWhiteouts++; this.save(); }
  }

  stats(): RetryStats {
    const g = this.l.gameplayContinues ?? 0;
    return {
      continues: g,
      gameplayContinues: g,
      serviceBoots: this.l.boots,
      // wq#547: OBSERVED only. The hand-typed estimate is reported alongside,
      // never inside, so the live figure can only move by measurement.
      whiteouts: (this.l.whiteoutsObservedBase ?? 0) + this.l.currentWhiteouts,
      whiteoutsEstimatePre: this.l.whiteoutsEstimatePre ?? 0,
    };
  }

  private save(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.l, null, 1));
    renameSync(tmp, this.path);
  }
}
