// wq#2389 acceptance: a critical isis_alert REACHES THE PAGE PATH.
//
// wq#1584's probe proves the alert can fire; this one proves something reads
// it. Before this ticket the only consumers of tool=isis_alert were the event
// log (no watcher) and stderr (no alerting tail), so every assertion below was
// vacuously false: nothing invoked ntfy-send at all.
//
// Pure: no ROM, no emulator, no gateway, no real ntfy. LPP_NTFY_BIN points at a
// throwaway shell recorder, so what is asserted is the ARGV the pager would
// hand /home/lumen/bin/ntfy-send, not a mock of it.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const DIR = mkdtempSync(join(tmpdir(), "lpp-isis2389-"));
const RECORD = join(DIR, "sent.log");
const FAKE_NTFY = join(DIR, "ntfy-send");

/** A recorder standing in for ntfy-send: one line per publish, exit code taken
 *  from a file so a leg of the test can make delivery fail. */
function writeFakeNtfy() {
  writeFileSync(FAKE_NTFY,
    `#!/usr/bin/env bash\n` +
    `printf '%s\\n' "$*" >> ${RECORD}\n` +
    `rc=$(cat ${join(DIR, "rc")} 2>/dev/null || echo 0)\n` +
    `[ "$rc" = "0" ] || echo "ntfy-send: DELIVERY FAILED [primary=000(FAIL)]" >&2\n` +
    `exit "$rc"\n`);
  chmodSync(FAKE_NTFY, 0o755);
}
const setRc = (rc: number) => writeFileSync(join(DIR, "rc"), String(rc));

// The loud-on-stderr half of the contract is asserted, not assumed.
const stderr: string[] = [];
const realError = console.error.bind(console);
console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); realError(...args); };
const sent = () => (existsSync(RECORD) ? readFileSync(RECORD, "utf8").trim().split("\n").filter(Boolean) : []);

(async () => {
  writeFakeNtfy();
  setRc(0);
  process.env.LPP_NTFY_BIN = FAKE_NTFY;
  process.env.LPP_NTFY_TOPIC = "lumen-probe-2389";
  // Env must be staged before the module is first evaluated (its config is
  // read at module scope), hence the dynamic imports.
  const { EventBus } = await import("./events.js");
  const { attachIsisPager, pageKey } = await import("./isis_page.js");

  const bus = new EventBus(DIR, "probe-isis2389");
  const pager = attachIsisPager(bus);
  const alerts: object[] = [];
  bus.on((e: any) => { if (e.tool === "isis_page") alerts.push(e); });

  // --- 1. the ticket: a critical alert leaves the box ----------------------
  {
    bus.emit("tool_call", {
      tool: "isis_alert", level: "critical", source: "brain",
      msg: "LPP primary brain (isis-local) failed 3 turns in 10min — last: rung dead: 401",
    });
    await pager.drain();
    const lines = sent();
    chk("a critical isis_alert invokes the page path at all", lines.length === 1, String(lines.length));
    chk("published high-priority to the fleet topic with a titled body",
      /-p high/.test(lines[0] ?? "") && /-t lumen-probe-2389/.test(lines[0] ?? "") &&
      /-T LPP CRITICAL/.test(lines[0] ?? ""), lines[0]);
    chk("the page carries the producer and the alert text",
      /\[brain\]/.test(lines[0] ?? "") && /isis-local/.test(lines[0] ?? ""), lines[0]);
    chk("delivery is recorded ON THE BUS, so events/*.jsonl shows it went out",
      alerts.length === 1 && (alerts[0] as any).ok === true, JSON.stringify(alerts[0] ?? {}));
  }

  // --- 2. dedup: the same outage does not page twice -----------------------
  {
    bus.emit("tool_call", {
      tool: "isis_alert", level: "critical", source: "brain",
      msg: "LPP primary brain (isis-local) failed 3 turns in 10min — last: rung dead: 401",
    });
    await pager.drain();
    chk("a repeat of the same alert is not a second page", sent().length === 1, String(sent().length));
  }

  // --- 3. ...including live_agent's dead-cycle text, which CHANGES every
  //        reboot because it carries the cycle count (live_agent.ts:792) ----
  {
    for (let n = 3; n <= 6; n++) {
      bus.emit("tool_call", {
        tool: "isis_alert", level: "critical", source: "live_agent",
        msg: `LPP has taken 0 turns across ${n} consecutive agent reboots (last error: 401); ` +
             `backing off ${5 * n}s before the next attempt.`,
      });
      await pager.drain();
    }
    chk("a dead loop pages ONCE, not once per reboot", sent().length === 2, String(sent().length));
    chk("the key collapses the counts that make the text differ",
      pageKey("live_agent", "0 turns across 4 reboots") === pageKey("live_agent", "0 turns across 91 reboots"));
  }

  // --- 4. everything that is not a critical isis_alert stays off the pager --
  {
    bus.emit("tool_call", { tool: "isis_alert", level: "warn", source: "brain", msg: "not critical" });
    bus.emit("tool_call", { tool: "goto", level: "critical", source: "brain", msg: "not an alert" });
    bus.emit("turn_summary", { line: "DEAD LOOP: 0 turns in 9 reboots" });
    await pager.drain();
    chk("non-critical levels, other tools and prose lines do not page", sent().length === 2, String(sent().length));
  }

  // --- 5. a page that did NOT leave the box must not latch ------------------
  {
    setRc(1);
    bus.emit("tool_call", {
      tool: "isis_alert", level: "critical", source: "brain",
      msg: "LPP primary brain (isis-cloud) failed 3 turns in 10min — last: timeout",
    });
    await pager.drain();
    const failEv = alerts.find((a: any) => a.ok === false) as any;
    chk("a failed publish is reported as failed on the bus, not swallowed",
      !!failEv && failEv.rc === 1, JSON.stringify(failEv ?? {}));
    // stream.ts renders every event's JSON into the public kiosk feed, and
    // ntfy-send's failure text quotes the command line (fleet topic included).
    chk("the publisher's own output stays OFF the bus and lands on stderr",
      !JSON.stringify(failEv ?? {}).includes("lumen-probe-2389") &&
      stderr.some(l => /PAGE DELIVERY FAILED/.test(l) && /DELIVERY FAILED \[primary/.test(l)),
      stderr.join(" | ").slice(0, 160));
    chk("a failed page is not counted as delivered",
      !pager.delivered.has(pageKey("brain", "LPP primary brain (isis-cloud) failed 3 turns in 10min — last: timeout")));
    setRc(0);
    bus.emit("tool_call", {
      tool: "isis_alert", level: "critical", source: "brain",
      msg: "LPP primary brain (isis-cloud) failed 3 turns in 10min — last: timeout",
    });
    await pager.drain();
    chk("...so the next identical alert RETRIES instead of going quiet",
      sent().length === 4, String(sent().length));
  }

  // --- 6. a missing ntfy binary cannot take the turn loop down -------------
  {
    process.env.LPP_NTFY_BIN = join(DIR, "does-not-exist");
    const { attachIsisPager: attachFresh } = await import(`./isis_page.js?nobin=${Date.now()}`);
    const bus2 = new EventBus(DIR, "probe-isis2389-nobin");
    const pager2 = attachFresh(bus2);
    const seen: any[] = [];
    bus2.on((e: any) => { if (e.tool === "isis_page") seen.push(e); });
    bus2.emit("tool_call", { tool: "isis_alert", level: "critical", source: "brain", msg: "gateway down" });
    await pager2.drain();
    chk("an unpublishable page fails loudly and locally, never throws",
      seen.length === 1 && seen[0].ok === false, JSON.stringify(seen[0] ?? {}));
  }

  // --- 7. the sweep: the retry brain.ts's latch cannot perform itself ------
  {
    const SWEEP_LOG = join(DIR, "swept.log");
    const fakeAudit = join(DIR, "audit");
    writeFileSync(fakeAudit, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${SWEEP_LOG}\nexit 1\n`);
    chmodSync(fakeAudit, 0o755);
    process.env.LPP_ISIS_AUDIT_BIN = fakeAudit;
    process.env.LPP_ISIS_SWEEP_MS = "60";
    const { startUnpagedSweep } = await import(`./isis_page.js?sweep=${Date.now()}`);
    const timer = startUnpagedSweep();
    await new Promise(r => setTimeout(r, 400));
    clearInterval(timer);
    const swept = existsSync(SWEEP_LOG) ? readFileSync(SWEEP_LOG, "utf8").trim().split("\n") : [];
    chk("the sweep hands events/*.jsonl to the audit with --send", swept.length >= 1 &&
      /--send/.test(swept[0] ?? "") && /--max-send 1/.test(swept[0] ?? ""), swept[0]);
    chk("exit 1 (still unpaged) is the next sweep's job, not a noisy failure",
      !stderr.some(l => /unpaged sweep failed/.test(l)), stderr.slice(-1).join(""));

    process.env.LPP_ISIS_SWEEP_MS = "0";
    const { startUnpagedSweep: offSweep } = await import(`./isis_page.js?off=${Date.now()}`);
    chk("LPP_ISIS_SWEEP_MS=0 turns it off", offSweep() === null);
  }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
