// wq#907 acceptance: a brain call is bounded in wall-clock and ends on a rung
// that cannot dead-end.
//
// The bug this locks down: on 2026-08-23 LPP stood still for 12h at 0.0% CPU on
// an open socket to the gateway. Primary was qwen36-local, which the proxy gives
// `timeout: 600` and no fallback group, and `fetch` carried no deadline — so the
// harness had no bound of its own anywhere in the stack.
//
// Pure: no ROM, no emulator, no live gateway. A stub HTTP server on 127.0.0.1
// plays the proxy and is told per-model whether to answer, hang, or 500. "Hang"
// means accept the socket and never write — exactly the shape that hung LPP, and
// the shape a connect-refused test would NOT catch.
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { AddressInfo } from "net";

type Behaviour = "ok" | "hang" | "error";

const behaviour = new Map<string, Behaviour>();
const hits: string[] = [];
const held: ServerResponse[] = [];   // hung responses, released at teardown

function stubGateway(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const model = JSON.parse(Buffer.concat(chunks).toString()).model as string;
      hits.push(model);
      const b = behaviour.get(model) ?? "ok";
      if (b === "hang") { held.push(res); return; }        // never responds
      if (b === "error") { res.writeHead(500); res.end("stub: model down"); return; }
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

(async () => {
  const { server, port } = await stubGateway();

  // Env must be staged before config.js is first evaluated (ESM hoists static
  // imports above assignments), hence the dynamic imports below.
  process.env.LPP_GATEWAY = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.LPP_FALLBACK_LOG = `/tmp/lpp-probe-brain907-${process.pid}.jsonl`;
  process.env.LPP_BRAIN_PRIMARY = "stub-local";
  process.env.LPP_BRAIN_FALLBACK_MODELS = "stub-cloud-a,stub-cloud-b";
  process.env.LPP_BRAIN_TIMEOUT_MS = "1200";
  process.env.LPP_BRAIN_FALLBACK_TIMEOUT_MS = "800";
  process.env.LPP_BRAIN_TERMINAL_ATTEMPTS = "2";
  process.env.LPP_BRAIN_BREAKER_FAILS = "2";
  process.env.LPP_BRAIN_BREAKER_COOLDOWN_MS = "60000";

  const { CFG } = await import("./config.js");
  const { Brain } = await import("./brain.js");
  const { EventBus } = await import("./events.js");

  const newBrain = () => {
    hits.length = 0;
    return new Brain(new EventBus("/tmp", `probe-brain907-${process.pid}-${hits.length}`));
  };
  const MSG = [{ role: "user", content: "go" }];

  // --- 1. ladder shape -----------------------------------------------------
  {
    const rungs = newBrain().ladder(CFG.profiles.primary);
    chk("ladder is primary + both cloud rungs",
      rungs.map(r => r.model).join(",") === "stub-local,stub-cloud-a,stub-cloud-b",
      rungs.map(r => r.model).join(","));
    chk("primary rung gets the primary deadline", rungs[0].timeoutMs === 1200, String(rungs[0].timeoutMs));
    chk("fallback rungs get the SHORT deadline (a slow fallback is the same bug one rung down)",
      rungs[1].timeoutMs === 800 && rungs[2].timeoutMs === 800, `${rungs[1].timeoutMs},${rungs[2].timeoutMs}`);
    chk("last rung is terminal and is the only one that retries",
      rungs[2].terminal && rungs[2].attempts === 2 && rungs[0].attempts === 1 && !rungs[0].terminal);
    const dup = newBrain().ladder({ model: "stub-cloud-a", maxTokensOut: 10 });
    chk("a profile already pointed at a fallback is not tried twice",
      dup.map(r => r.model).join(",") === "stub-cloud-a,stub-cloud-b", dup.map(r => r.model).join(","));
  }

  // --- 2. a hung primary is bounded, and the turn still returns text --------
  {
    behaviour.set("stub-local", "hang");
    behaviour.set("stub-cloud-a", "ok");
    const b = newBrain();
    const t0 = Date.now();
    const { text, usage } = await b.complete(MSG);
    const ms = Date.now() - t0;
    chk("hung primary does not block the turn (THE 12h BUG)", ms < 4000, `${ms}ms`);
    chk("deadline is actually enforced, not merely survived", ms >= 1200, `${ms}ms`);
    chk("turn is rescued by the next rung", usage.model === "stub-cloud-a" && /stub-cloud-a/.test(text), usage.model);
    chk("token usage is attributed to the rung that answered", b.totalCompletion === 11, String(b.totalCompletion));
  }

  // --- 3. every rung hung: bounded FAILURE, which live_agent.ts survives ----
  {
    behaviour.set("stub-local", "hang");
    behaviour.set("stub-cloud-a", "hang");
    behaviour.set("stub-cloud-b", "hang");
    const b = newBrain();
    const t0 = Date.now();
    let err: any = null;
    try { await b.complete(MSG); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    // 1200 + 800 + 2x800 (terminal retries) + 1500 backoff = ~6.1s.
    chk("total-blackout ladder THROWS instead of hanging", err !== null, String(err?.message ?? err).slice(0, 60));
    chk("total-blackout ladder is bounded", ms < 12_000, `${ms}ms`);
    chk("the error names the deadline, not a generic fetch failure",
      /deadline \d+ms exceeded/.test(String(err?.message ?? "")), String(err?.message ?? "").slice(0, 60));
  }

  // --- 4. breaker: a saturated rung stops costing a deadline every turn -----
  {
    behaviour.set("stub-local", "hang");
    behaviour.set("stub-cloud-a", "ok");
    behaviour.set("stub-cloud-b", "ok");
    const b = newBrain();
    await b.complete(MSG);                       // primary fail 1
    await b.complete(MSG);                       // primary fail 2 -> breaker opens
    const before = hits.filter(m => m === "stub-local").length;
    const t0 = Date.now();
    const { usage } = await b.complete(MSG);
    const ms = Date.now() - t0;
    const after = hits.filter(m => m === "stub-local").length;
    chk("breaker opens after 2 consecutive failures", before === 2, String(before));
    chk("open breaker skips the saturated rung entirely (no request sent)", after === before, `${before}->${after}`);
    chk("degraded turn now costs milliseconds, not a deadline", ms < 500, `${ms}ms`);
    chk("degraded turn still plays", usage.model === "stub-cloud-a", usage.model);
  }

  // --- 5. the terminal rung is never skipped -------------------------------
  // Every rung's breaker open at once is the state that would let a turn make
  // no request at all — the same "nothing happens" failure in a new costume.
  {
    behaviour.set("stub-cloud-a", "error");
    behaviour.set("stub-cloud-b", "error");
    const b = newBrain();
    // Ladder for this profile is [cloud-b, cloud-a]; both fail, so both
    // breakers open. Note cloud-b is NOT terminal here, so it can be skipped.
    const startAtB = { model: "stub-cloud-b", maxTokensOut: 10 };
    for (let i = 0; i < 2; i++) { try { await b.complete(MSG, startAtB); } catch {} }
    // Ladder for this one is [cloud-a, cloud-b] — cloud-b IS terminal.
    const startAtA = { model: "stub-cloud-a", maxTokensOut: 10 };
    hits.length = 0;
    try { await b.complete(MSG, startAtA); } catch {}
    chk("open breaker skips the non-terminal rung", !hits.includes("stub-cloud-a"), hits.join(","));
    chk("terminal rung is attempted anyway (a turn always tries something)",
      hits.filter(m => m === "stub-cloud-b").length === 2, hits.join(","));
  }

  // --- 6. a healthy primary is still preferred (cheapest-first intact) ------
  {
    behaviour.set("stub-local", "ok");
    const b = newBrain();
    const { usage } = await b.complete(MSG);
    chk("healthy primary is used and no fallback is touched",
      usage.model === "stub-local" && hits.length === 1, hits.join(","));
  }

  for (const res of held) { try { res.destroy(); } catch {} }
  server.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
