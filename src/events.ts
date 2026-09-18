// JSONL event bus: every harness action is an event (drives kiosk + replay).
// S2 debt paid 2026-08-06: size-based rotation + boot-time retention so a
// multi-day run can never grow one unbounded log (87MB incident).
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";

export type EventKind = "state_read" | "think_chunk" | "tool_call" | "buttons"
  | "turn_summary" | "checkpoint" | "boot" | "verify" | "battle_softlock"
  | "regression"   // wq#477: whiteout/story-regression detected or cleared
  | "rule_violation"   // wq#488: brain tried to write borrowed content to notes
  | "oscillation"   // wq#517: warp-loop notice tripped (structured, so wq#515
                     // detectors and lpp-stats count trips without parsing prose)
  | "retention"    // wq#551: the one place log deletion is recorded. Retention
                   // used to run from the EventBus CONSTRUCTOR inside a bare
                   // `catch {}`, so files vanished with no record anywhere. Now
                   // deletion happens once, on request, and says so on the bus.
  | "progress"     // wq#1179: per-turn composite progress scalar P + tile
                   // novelty (novelty.ts). OBSERVE-ONLY: no gameplay path reads
                   // it. It exists so a stall can be seen in TURNS ("dP == 0
                   // over 40 turns") instead of only in wall hours, which is
                   // what every prior axis was limited to.
  | "winnability"  // wq#1181: per-battle-turn damage-calc verdict, plus the
                   // action it WITHHELD while advisory-only. The soak week's
                   // evidence for whether LPP_WINNABILITY_FORCE=1 is safe.
  | "fight_ledger" // wq#1181: fight outcome recorded, gate opened/fired/lifted.
  | "chat"         // wq#1176: a line Lumen spoke to the stream audience (one-way)
  | "persona"      // wq#1176: a self-fact became canonical, was reaffirmed, or was
                   // contradicted. Structured so a contradiction is countable rather
                   // than something a human has to notice in the chat panel.
  | "exploration_override" // wq#1731: the hard exploration rung fired or ended.
                   // Same records as runtime/stuck_escalation_overrides.jsonl.
  | "nav_trace";   // wq#542: per-step path intent vs actual displacement inside
                   // nav.goto. The turn-level log records position ONCE PER TURN,
                   // POST-ACTION, which makes every decision inside a journey
                   // invisible and has now defeated three separate attempts to
                   // measure why the agent does not cross Mt Moon B2F.

const ROTATE_BYTES = Number(process.env.LPP_EVENTS_ROTATE_BYTES ?? 25 * 1024 * 1024);
const KEEP_FILES = Number(process.env.LPP_EVENTS_KEEP_FILES ?? 30);

export class EventBus {
  private path: string;
  private bytes = 0;
  private part = 0;
  private listeners: ((e: object) => void)[] = [];
  // wq#551: CONSTRUCTING A BUS IS SIDE-EFFECT-FREE ON EXISTING FILES. This used
  // to call this.retain(), which unlinked every .jsonl past the newest
  // KEEP_FILES. Instantiating a class is the single most common thing a probe,
  // tool or one-off script does, so history was destroyed by ordinary
  // development activity — no run, no write, no flag, and silently, because
  // retain()'s whole body sat in a bare `catch {}`. 51 of 61 runs lost their
  // per-turn event logs that way. Retention is now retainEventLogs() below:
  // explicit, opt-in, called by exactly ONE owner (live_agent.ts at boot).
  constructor(private dir: string, private runId: string) {
    mkdirSync(dir, { recursive: true });
    this.path = `${dir}/${runId}.jsonl`;
  }
  emit(kind: EventKind, data: object) {
    // wq#522: the ENVELOPE WINS. This used to be `{ t, kind, ...data }`, so any
    // payload carrying its own `kind` silently rewrote the event kind. That is
    // not hypothetical: writeCheckpoint spreads a sidecar whose own `kind` is
    // "periodic" | "map" | "milestone", so EVERY checkpoint event in this
    // project's history was emitted as kind="periodic". metrics.ts switches on
    // "checkpoint", which therefore never matched, and maxEventCount read 0 in
    // every run summary ever written. Spreading data FIRST and pinning the
    // envelope last makes that class of collision impossible rather than
    // fixing one instance of it.
    // NOTE: pinning `kind` alone was not enough — my own probe caught that a
    // payload `t` could still rewrite the timestamp. No current emitter
    // sends one (verified: 0 of 443 on-disk events carry a bad `t`), but it is
    // the identical latent collision and costs one line to close. The `t: ""`
    // placeholder exists only to PIN KEY ORDER so log lines still lead with the
    // timestamp; its value is overwritten immediately below.
    const e: any = { t: "", ...data, kind };
    e.t = new Date().toISOString();
    const line = JSON.stringify(e) + "\n";
    if (this.bytes + line.length > ROTATE_BYTES) {
      this.part++;
      this.path = `${this.dir}/${this.runId}-p${this.part}.jsonl`;
      this.bytes = 0;
    }
    appendFileSync(this.path, line);
    this.bytes += line.length;
    for (const fn of this.listeners) fn(e);
  }
  on(fn: (e: object) => void) { this.listeners.push(fn); }
}

export interface RetentionResult {
  dir: string;
  keep: number;
  scanned: number;      // .jsonl files present before the sweep
  kept: number;
  deleted: string[];    // filenames actually unlinked
  failed: string[];     // "name: message" — an unlink that did NOT happen
}

/** THE ONLY CODE IN THIS REPO THAT DELETES AN EVENT LOG (wq#551).
 *
 *  Keeps the newest `keep` .jsonl files in `dir` by mtime and unlinks the rest.
 *
 *  It is a free function rather than a method BY DESIGN. A method is reachable
 *  from any instance, and this project has ~60 places that construct an
 *  EventBus; a free function has to be imported and called on purpose, so the
 *  destructive path cannot be reached by accident. Exactly one caller does:
 *  live_agent.ts at boot. Probes, tools and link drivers never call it, which
 *  is what makes them physically unable to delete history.
 *
 *  It is also LOUD. The old version wrapped everything in `catch {}`, which hid
 *  both errors and the deletions themselves. Every unlink is logged and
 *  returned; failures are collected and returned rather than swallowed, so a
 *  caller can emit a countable `retention` event (live_agent.ts does). */
// wq#861: TRIVIAL_BYTES threshold. A crash-loop boot writes ~1057 bytes
// (retention + supervisor_ban_loaded + corridor + boot + state_read). A real
// run with even ONE gameplay turn writes several KB of tool_call + think_chunk
// + turn_summary events. Logs below this threshold are "trivial" — crash-boot
// empties that must NEVER evict a real run log. The value is set at 2× the
// measured crash-loop size (1057 * 2 ≈ 2114, rounded to 2048) so it survives
// minor format changes without drifting into real-run territory.
const TRIVIAL_BYTES = 2048;
// Hard cap on trivial files kept, because a sustained crash loop at 8s/boot
// writes ~450 files/hour and the directory gets sluggish past a few thousand.
const TRIVIAL_CAP = 100;

export function retainEventLogs(dir: string, keep: number = KEEP_FILES): RetentionResult {
  const res: RetentionResult = { dir, keep, scanned: 0, kept: 0, deleted: [], failed: [] };
  let logs: { f: string; m: number; sz: number }[] = [];
  try {
    logs = readdirSync(dir).filter(f => f.endsWith(".jsonl"))
      .map(f => {
        let m = 0, sz = 0;
        try { const s = statSync(`${dir}/${f}`); m = s.mtimeMs; sz = s.size; } catch { /* raced away */ }
        return { f, m, sz };
      })
      .sort((a, b) => b.m - a.m);
  } catch (e: any) {
    res.failed.push(`readdir ${dir}: ${e?.message ?? e}`);
    console.error(`[retention] cannot read ${dir}: ${e?.message ?? e}`);
    return res;
  }
  res.scanned = logs.length;
  // wq#861: split into substantial (real runs) and trivial (crash-loop boots).
  // Substantial files compete for `keep` slots. Trivial files have their own
  // budget (TRIVIAL_CAP) and NEVER consume a slot that would evict a real run.
  // This is the fix for 712 crash-loop boots evicting hundreds of runs of
  // real gameplay history.
  const substantial: typeof logs = [];
  const trivial: typeof logs = [];
  for (const entry of logs) {
    if (entry.sz < TRIVIAL_BYTES) trivial.push(entry);
    else substantial.push(entry);
  }
  // Keep newest `keep` substantial files
  const doomedSubstantial = substantial.slice(keep);
  // Keep newest TRIVIAL_CAP trivial files
  const doomedTrivial = trivial.slice(TRIVIAL_CAP);
  const doomed = [...doomedSubstantial, ...doomedTrivial];
  res.kept = res.scanned - doomed.length;
  for (const { f } of doomed) {
    try {
      unlinkSync(`${dir}/${f}`);
      res.deleted.push(f);
      console.warn(`[retention] deleted ${f} (keep=${keep}, scanned=${res.scanned})`);
    } catch (e: any) {
      res.failed.push(`${f}: ${e?.message ?? e}`);
      console.error(`[retention] FAILED to delete ${f}: ${e?.message ?? e}`);
    }
  }
  if (doomed.length === 0) {
    console.log(`[retention] nothing to delete (${res.scanned} logs, substantial=${substantial.length}, trivial=${trivial.length}, keep=${keep})`);
  } else {
    console.log(`[retention] deleted ${doomed.length} (substantial: ${doomedSubstantial.length} of ${substantial.length}, trivial: ${doomedTrivial.length} of ${trivial.length})`);
  }
  return res;
}
