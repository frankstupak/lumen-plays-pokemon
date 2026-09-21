// wq#1584 acceptance: the isis_alert for a failing primary brain can ACTUALLY
// FIRE. It never had: zero isis_alert rows across every events/*.jsonl on disk
// and one primary_fail_threshold row in the whole of fallback_stats.jsonl, over
// a history that includes wq#1578's 14h of 401s. Two reasons, both covered
// below. (1) The counter lived on the Brain instance and live_agent builds a
// new Brain every agent reboot cycle — one every ~57s during an outage — so it
// was wiped long before 3-in-10min. (2) Only a real request counted, but a rung
// that is dead (15min recheck) or breaker-open (10min cooldown) is SKIPPED, and
// both of those windows are >= the 10min alert window, so during exactly the
// outage worth paging for the counter could not reach 3 by arithmetic.
//
// Pure: no ROM, no emulator, no live gateway — the probe_brain1660 stub pattern.
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { AddressInfo } from "net";
import { readFileSync } from "fs";

type Behaviour = "ok" | number;   // number = answer that HTTP status

const behaviour = new Map<string, Behaviour>();
const hits: string[] = [];

function stubGateway(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const model = JSON.parse(Buffer.concat(chunks).toString()).model as string;
      hits.push(model);
      const b = behaviour.get(model) ?? "ok";
      if (b !== "ok") {
        res.writeHead(b);
        res.end(JSON.stringify({ error: { message: `stub: ${b} for ${model}` } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: `ACT: press(a) from ${model}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 11 },
      }));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () =>
    resolve({ server, port: (server.address() as AddressInfo).port })));
}

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const FALLBACK_LOG = `/tmp/lpp-probe-isis1584-${process.pid}.jsonl`;

(async () => {
  const { server, port } = await stubGateway();

  // Env must be staged before config.js is first evaluated (ESM hoists static
  // imports above assignments), hence the dynamic imports below.
  process.env.LPP_GATEWAY = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.LPP_FALLBACK_LOG = FALLBACK_LOG;
  process.env.LPP_BRAIN_PRIMARY = "stub-local";
  process.env.LPP_BRAIN_FALLBACK_MODELS = "stub-cloud-a,stub-cloud-b";
  process.env.LPP_BRAIN_TIMEOUT_MS = "1200";
  process.env.LPP_BRAIN_FALLBACK_TIMEOUT_MS = "800";
  process.env.LPP_BRAIN_TERMINAL_ATTEMPTS = "2";
  // Production values on purpose: the bug is that both of these skip windows
  // are longer than the alert window, so a request-only counter cannot trip.
  process.env.LPP_BRAIN_BREAKER_FAILS = "2";
  process.env.LPP_BRAIN_BREAKER_COOLDOWN_MS = "600000";
  process.env.LPP_BRAIN_DEAD_RUNG_RECHECK_MS = "900000";
  process.env.LPP_PRIMARY_FAIL_WINDOW_MS = "600000";
  process.env.LPP_PRIMARY_FAIL_THRESHOLD = "3";
  process.env.LITELLM_MASTER_KEY = "sk-stub";

  const { CFG } = await import("./config.js");
  const { Brain, BrainUnreachableError, resetPrimaryFailTracking } = await import("./brain.js");
  const { EventBus } = await import("./events.js");

  const MSG = [{ role: "user", content: "go" }];
  let alerts: string[] = [];
  let mk = 0;
  /** A Brain wired to a fresh bus, every alert it emits collected. Calling this
   *  per turn IS live_agent's reboot cycle (live_agent.ts:667). */
  const newBrain = () => {
    const bus = new EventBus("/tmp", `probe-isis1584-${process.pid}-${mk++}`);
    bus.on((e: any) => { if (e.tool === "isis_alert") alerts.push(String(e.msg)); });
    return new Brain(bus);
  };
  /** Each case starts from a clean slate: the history is process-wide now. */
  const reset = () => { resetPrimaryFailTracking(); alerts = []; hits.length = 0; };
  const turn = async (b: any) => { try { return await b.complete(MSG); } catch { return null; } };

  // --- 1. the ticket: history survives the reboot that rebuilds the Brain ---
  {
    reset();
    behaviour.set("stub-local", 500);      // primary down, clouds healthy
    behaviour.set("stub-cloud-a", "ok");
    behaviour.set("stub-cloud-b", "ok");
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) { await turn(newBrain()); seen.push(alerts.length); }
    chk("3 fails across 3 SEPARATE Brains page (per-instance state never could)",
      seen.join(",") === "0,0,1", seen.join(","));
    chk("the page names the model and the count", /stub-local/.test(alerts[0] ?? "") &&
      /3 turns/.test(alerts[0] ?? ""), alerts[0]);
    chk("a turn the fallback rescued still counts as a lost primary turn",
      /rescued by stub-cloud-a/.test(alerts[0] ?? ""), alerts[0]);
  }

  // --- 2. wq#1578's shape: every rung 401, a new Brain each cycle ----------
  {
    reset();
    behaviour.set("stub-local", 401);
    behaviour.set("stub-cloud-a", 401);
    behaviour.set("stub-cloud-b", 401);
    let unreachable = 0;
    for (let i = 0; i < 3; i++) {
      const b = newBrain();
      try { await b.complete(MSG); } catch (e) { if (e instanceof BrainUnreachableError) unreachable++; }
    }
    chk("14h-of-401s shape pages by the 3rd cycle instead of never",
      alerts.length === 1 && unreachable === 3, `${alerts.length} alerts, ${unreachable} unreachable`);
  }

  // --- 3. ...and the same outage on ONE Brain, where the turns cost zero
  //        requests because every rung is already dead (wq#1660 hold path) ---
  {
    reset();
    const b = newBrain();
    await turn(b);                                  // marks all three rungs dead
    const afterFirst = hits.length;
    await turn(b); await turn(b);                   // skipped outright: no HTTP at all
    chk("dead-rung SKIPS count too — 15min recheck > 10min window",
      alerts.length === 1 && hits.length === afterFirst,
      `${alerts.length} alerts, ${hits.length} requests (${afterFirst} on turn 1)`);
    chk("the page says WHY the primary is out, not 'no rung configured'",
      /rung dead: .*401/.test(alerts[0] ?? ""), alerts[0]);
  }

  // --- 4. breaker-held skips count on the same arithmetic ------------------
  {
    reset();
    behaviour.set("stub-local", 500);               // 5xx: breaker path, not dead
    behaviour.set("stub-cloud-a", "ok");
    behaviour.set("stub-cloud-b", "ok");
    const b = newBrain();
    await turn(b); await turn(b);                   // two fails -> breaker opens
    const asked = hits.filter(m => m === "stub-local").length;
    await turn(b);                                  // primary skipped, cloud serves
    chk("breaker-open SKIPS count — 10min cooldown >= 10min window",
      alerts.length === 1 && hits.filter(m => m === "stub-local").length === asked,
      `${alerts.length} alerts, primary asked ${asked}x`);
  }

  // --- 5. the latch: one page per outage, not one per turn -----------------
  {
    const before = alerts.length;
    const b = newBrain();
    await turn(b); await turn(b); await turn(b);
    chk("a still-down primary does not re-page every turn", alerts.length === before,
      `${alerts.length - before} extra`);
  }

  // --- 6. recovery clears the history AND re-arms the latch ----------------
  {
    reset();
    behaviour.set("stub-local", 500);
    const b1 = newBrain();
    await turn(b1); await turn(b1);                 // 2 fails, one short of a page
    behaviour.set("stub-local", "ok");
    const b2 = newBrain();                          // the reboot: instance state goes,
    const ok = await turn(b2);                      // the history does not — until this
    chk("a served turn clears the count", ok?.usage.model === "stub-local" && alerts.length === 0,
      `${ok?.usage.model}, ${alerts.length} alerts`);
    behaviour.set("stub-local", 500);
    await turn(b2); await turn(b2);
    chk("the two pre-recovery fails do not carry over (2+2 != page)", alerts.length === 0,
      String(alerts.length));
    await turn(b2);
    chk("a second outage in the same process pages again", alerts.length === 1,
      String(alerts.length));
  }

  // --- 7. history is keyed by MODEL, so a primary swap starts clean --------
  {
    reset();
    behaviour.set("stub-local", 500);
    behaviour.set("stub-local-v2", 500);
    const b = newBrain();
    await turn(b); await turn(b);                   // 2 fails on stub-local
    (CFG as any).profiles.primary.model = "stub-local-v2";
    await turn(b);
    chk("fails on the retired primary do not page for the new one", alerts.length === 0,
      alerts.join(" | "));
    await turn(b); await turn(b);
    chk("the new primary pages on its own 3", alerts.length === 1 &&
      /stub-local-v2/.test(alerts[0] ?? ""), alerts[0]);
    (CFG as any).profiles.primary.model = "stub-local";
  }

  // --- 8. the window still bounds the history ------------------------------
  {
    reset();
    (CFG as any).brain.primaryFailWindowMs = 300;
    const b = newBrain();
    await turn(b); await turn(b);
    await new Promise(r => setTimeout(r, 350));     // both fails age out
    await turn(b); await turn(b);
    chk("fails older than the window drop out (2+2 in 300ms windows != page)",
      alerts.length === 0, String(alerts.length));
    (CFG as any).brain.primaryFailWindowMs = 600_000;
  }

  // --- 9. incident review reads fallback_stats.jsonl, so write there too ---
  {
    const rows = readFileSync(FALLBACK_LOG, "utf8").trim().split("\n")
      .map(l => JSON.parse(l)).filter((r: any) => r.reason === "primary_fail_threshold");
    chk("every page also lands in fallback_stats as primary_fail_threshold",
      rows.length === 6 && rows.every((r: any) => r.profile === "isis_health" && r.model && r.error),
      `${rows.length} rows`);
  }

  server.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
