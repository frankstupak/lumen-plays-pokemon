// wq#1053: systemd watchdog beat for the LPP RESEARCH pipeline (link drivers, accept runs),
// not the game. Nothing here starts on its own: the beat only runs inside research_run.ts.
//
// Every frame the emulator advances calls markResearchProgress(). That is one counter bump,
// and it only reads the clock every 30th frame, so it is free on the game path and inert
// there (no beat loop is ever started by live_agent.ts).
//
// Policy (watchdog_notify.progressOrHolddown): keep beating while frames progressed within
// stallAfterMs, or while a holddown/freeze flag for the research unit is set. A wedged
// emulator stops advancing frames, the beats stop, and systemd's WatchdogSec kills the run.
//
// The holddown unit is the research unit, deliberately NOT lumen-pokemon-live: the live
// service is decommissioned (wq#2073) and a freeze flag on it must never keep a stalled
// research run alive.
import { ProgressTracker, Watchdog, beatForever, holddownActive, progressOrHolddown } from "./watchdog_notify.js";

export const RESEARCH_UNIT = "lumen-lpp-research";
const MARK_EVERY_FRAMES = 30;

const tracker = new ProgressTracker();
let frames = 0;

/** Called by Emulator on every frame advance. Cheap by design. */
export function markResearchProgress(): void {
  if (++frames % MARK_EVERY_FRAMES === 0) tracker.mark();
}

/** Test seam: make the singleton tracker's view of time explicit. */
export function researchProgressTracker(): ProgressTracker { return tracker; }

export interface ResearchBeat { timer: NodeJS.Timeout | null; enabled: boolean; stallAfterMs: number; unit: string }

/**
 * Start the beat if systemd gave us a watchdog (NOTIFY_SOCKET + WATCHDOG_USEC). Without one
 * this is a no-op, so running a driver by hand behaves exactly as before.
 */
export function startResearchBeat(
  env: NodeJS.ProcessEnv = process.env,
  wd: Watchdog = new Watchdog(env),
  holddown: (unit: string) => boolean = (u) => holddownActive(u),
): ResearchBeat {
  const unit = env.LPP_RESEARCH_UNIT || RESEARCH_UNIT;
  const stall = Number(env.LPP_RESEARCH_STALL_MS);
  const stallAfterMs = Number.isFinite(stall) && stall > 0 ? stall : 120_000;
  if (!wd.enabled || wd.intervalMs === null) return { timer: null, enabled: false, stallAfterMs, unit };
  tracker.mark(); // startup counts as progress; the first beat must not race the first frame
  const policy = progressOrHolddown(tracker, stallAfterMs, () => holddown(unit));
  const timer = beatForever(wd, wd.intervalMs, policy);
  wd.status(`research beat on, stall_after=${stallAfterMs}ms unit=${unit}`);
  return { timer, enabled: true, stallAfterMs, unit };
}
