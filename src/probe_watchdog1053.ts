// wq#1053: Node port of the progress+holddown watchdog beat. Pure: a recording runner stands
// in for systemd-notify, and the clock is injected.
import { Watchdog, ProgressTracker, progressOrHolddown, holddownActive, beatForever } from "./watchdog_notify.js";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

(async () => {
  const sent: string[] = [];
  const rec = (_f: string, a: string[]) => { sent.push(a.join(" ")); };
  let t = 0;
  const now = () => t;

  // fail-open: no NOTIFY_SOCKET
  const off = new Watchdog({}, rec, now); off.ready(); off.beat(true); off.status("x");
  chk("no NOTIFY_SOCKET: every call is a silent no-op", sent.length === 0 && !off.enabled, String(sent.length));

  const wd = new Watchdog({ NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "60000000" }, rec, now);
  chk("interval is half of WatchdogSec", wd.intervalMs === 30_000, String(wd.intervalMs));
  wd.ready();
  chk("READY=1 goes out", sent.at(-1) === "READY=1");
  t = 100_000; wd.beat();
  chk("first beat is sent", sent.at(-1) === "WATCHDOG=1" && sent.length === 2);
  t += 10_000; wd.beat();
  chk("a beat inside the interval self-throttles", sent.length === 2, String(sent.length));
  t += 25_000; wd.beat();
  chk("a beat after the interval goes out", sent.length === 3, String(sent.length));
  wd.status("a".repeat(500));
  chk("STATUS is capped at 200 chars", sent.at(-1)!.length === "STATUS=".length + 200);
  const noUsec = new Watchdog({ NOTIFY_SOCKET: "x" }, rec, now); const n0 = sent.length; noUsec.beat(true);
  chk("no WATCHDOG_USEC: beat is a no-op (unit has no WatchdogSec)", sent.length === n0);

  // policy
  const tr = new ProgressTracker(now);
  let frozen = false;
  const pol = progressOrHolddown(tr, 120_000, () => frozen);
  chk("fresh progress: beat", pol() === true);
  t += 121_000;
  chk("no progress past stall_after: no beat (a wedged loop gets killed)", pol() === false);
  frozen = true;
  chk("hold-down/freeze active: keeps beating despite no progress", pol() === true);
  frozen = false; tr.mark();
  chk("mark() restores the beat", pol() === true);
  const boom = progressOrHolddown(tr, 1, () => { throw new Error("x"); });
  chk("a throwing holddown fails open", boom() === true);

  // holddownActive against fake binaries
  const fake = (status: number | null) => ((..._a: unknown[]) => ({ status })) as any;
  chk("holddown exit 0 = flag set", holddownActive("u", "h", fake(0)) === true);
  chk("holddown exit 1 = no flag", holddownActive("u", "h", fake(1)) === false);
  chk("holddown binary missing/throwing fails open", holddownActive("u", "h", (() => { throw new Error("ENOENT"); }) as any) === true);

  // the real binary, default spawn: unit with no flag set must read false (exit 1), not throw
  chk("holddownActive with the real spawn on an unflagged unit is false",
    holddownActive("wq1053-probe-no-such-unit-" + process.pid) === false);

  // beatForever wiring, real timers
  const sent2: string[] = [];
  const wd2 = new Watchdog({ NOTIFY_SOCKET: "x", WATCHDOG_USEC: "1000000" }, (_f, a) => { sent2.push(a.join(" ")); });
  let ok = true;
  const timer = beatForever(wd2, 20, () => ok);
  await new Promise(r => setTimeout(r, 130));
  const whileOk = sent2.filter(s => s === "WATCHDOG=1").length;
  ok = false; const mark = sent2.length;
  await new Promise(r => setTimeout(r, 100));
  clearInterval(timer);
  chk("beatForever announces READY then beats while the policy is true", sent2[0] === "READY=1" && whileOk >= 3, `beats=${whileOk}`);
  chk("beatForever stops beating when the policy goes false", sent2.length === mark, `${sent2.length - mark} extra`);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
