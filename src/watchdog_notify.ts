// wq#1053: a progress-tied systemd watchdog beat for the LPP live loop.
//
// Port of agent/lumen_watchdog_notify.py (wq#392/#1043) to Node. Node's stdlib has no unix
// datagram socket, so the notify goes out through `systemd-notify`, which needs
// NotifyAccess=all on the unit. Nothing here is wired into live_agent.ts: the unit is
// masked (LPP is decommissioned, wq#2073), and Type=notify/WatchdogSec must not precede a
// revive decision.
//
// FAIL-OPEN like the Python one: no NOTIFY_SOCKET means every call is a no-op, and a
// broken policy beats instead of starving the watchdog.
import { execFile, spawnSync as realSpawnSync } from "child_process";

export type Runner = (file: string, args: string[]) => void;

const defaultRunner: Runner = (file, args) => {
  execFile(file, args, { timeout: 5_000 }, () => { /* a notify failure must never disturb the loop */ });
};

export class Watchdog {
  readonly enabled: boolean;
  /** Beat at half the configured WatchdogSec, the cadence systemd recommends. */
  readonly intervalMs: number | null;
  private last = 0;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly run: Runner = defaultRunner,
    private readonly now: () => number = Date.now,
  ) {
    this.enabled = !!env.NOTIFY_SOCKET;
    const usec = Number(env.WATCHDOG_USEC);
    this.intervalMs = Number.isFinite(usec) && usec > 0 ? usec / 1000 / 2 : null;
  }

  private send(msg: string): void {
    if (!this.enabled) return;
    try { this.run("systemd-notify", [msg]); } catch { /* fail-open */ }
  }

  ready(): void { this.send("READY=1"); }
  status(text: string): void { this.send(`STATUS=${text.slice(0, 200)}`); }

  beat(force = false): void {
    if (!this.enabled || this.intervalMs === null) return;
    const t = this.now();
    if (force || t - this.last >= this.intervalMs) {
      this.send("WATCHDOG=1");
      this.last = t;
    }
  }
}

/** "Work happened" marker: call mark() once per frame. */
export class ProgressTracker {
  private last: number;
  constructor(private readonly now: () => number = Date.now) { this.last = now(); }
  mark(): void { this.last = this.now(); }
  progressedWithin(ms: number): boolean { return this.now() - this.last < ms; }
}

/** Healthy if work progressed within stallAfterMs OR a hold-down/freeze is active
 *  (wq#967 RESTART_FREEZE), so a frozen-but-healthy LPP is not SIGABRTed. */
export function progressOrHolddown(
  tracker: ProgressTracker, stallAfterMs: number, holddown?: () => boolean,
): () => boolean {
  return () => {
    if (holddown) {
      try { if (holddown()) return true; } catch { return true; }
    }
    return tracker.progressedWithin(stallAfterMs);
  };
}

/** True when `holddown check <unit>` exits 0 (a flag is set). Exit 1 is "no flag". */
export function holddownActive(unit: string, bin = process.env.LPP_HOLDDOWN_BIN ?? "/home/lumen/bin/holddown",
  spawnSync: typeof realSpawnSync = realSpawnSync): boolean {
  try { return spawnSync(bin, ["check", unit], { timeout: 3_000 }).status === 0; } catch { return true; }
}

/** Beat on a timer; skip the beat only when the policy says the loop is wedged.
 *  A throwing policy beats (fail-open). The timer is unref'd so it never keeps the process up. */
export function beatForever(wd: Watchdog, intervalMs = 10_000, shouldBeat?: () => boolean): NodeJS.Timeout {
  wd.ready();
  const t = setInterval(() => {
    let ok = true;
    try { ok = shouldBeat ? !!shouldBeat() : true; } catch { ok = true; }
    if (ok) wd.beat(true);
  }, intervalMs);
  t.unref();
  return t;
}
