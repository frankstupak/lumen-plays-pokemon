// wq#1660 acceptance: a deterministic gateway 4xx kills the rung instead of
// feeding the breaker -> next rung -> failStreak reboot loop, and a run whose
// EVERY rung is dead says so by name (BrainUnreachableError) so live_agent can
// hold instead of rebooting every ~57s (M2/E6: six brain-dead days, 45,965
// budget errors, 9,200 stale FIGHT_LOSS_LOOP directives).
//
// Pure: no ROM, no emulator, no live gateway — the probe_brain907 stub pattern,
// extended with per-model HTTP statuses and /v1/models + /key/info endpoints
// for the boot pre-flight.
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { AddressInfo } from "net";

type Behaviour = "ok" | number;   // number = answer that HTTP status

const behaviour = new Map<string, Behaviour>();
const hits: string[] = [];
let servedModels: string[] = [];
let modelsStatus = 200;

function stubGateway(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url?.endsWith("/v1/models")) {
      res.writeHead(modelsStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: servedModels.map(id => ({ id })) }));
      return;
    }
    if (req.method === "GET" && req.url?.endsWith("/key/info")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ info: { spend: 12.5, max_budget: 40 } }));
      return;
    }
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

(async () => {
  const { server, port } = await stubGateway();

  // Env must be staged before config.js is first evaluated (ESM hoists static
  // imports above assignments), hence the dynamic imports below.
  process.env.LPP_GATEWAY = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.LPP_FALLBACK_LOG = `/tmp/lpp-probe-brain1660-${process.pid}.jsonl`;
  process.env.LPP_BRAIN_PRIMARY = "stub-local";
  process.env.LPP_BRAIN_FALLBACK_MODELS = "stub-cloud-a,stub-cloud-b";
  process.env.LPP_BRAIN_TIMEOUT_MS = "1200";
  process.env.LPP_BRAIN_FALLBACK_TIMEOUT_MS = "800";
  process.env.LPP_BRAIN_TERMINAL_ATTEMPTS = "2";
  process.env.LPP_BRAIN_BREAKER_FAILS = "2";
  process.env.LPP_BRAIN_BREAKER_COOLDOWN_MS = "60000";
  process.env.LPP_BRAIN_DEAD_RUNG_RECHECK_MS = "1000";
  process.env.LITELLM_MASTER_KEY = "sk-stub";

  const { CFG } = await import("./config.js");
  const { Brain, BrainUnreachableError, isTerminal4xx, preflightGateway } = await import("./brain.js");
  const { EventBus } = await import("./events.js");

  let mk = 0;
  const newBrain = () => {
    hits.length = 0;
    return new Brain(new EventBus("/tmp", `probe-brain1660-${process.pid}-${mk++}`));
  };
  const MSG = [{ role: "user", content: "go" }];

  // --- 1. the terminal-4xx family ------------------------------------------
  {
    chk("400/401/403/404 are terminal", [400, 401, 403, 404].every(isTerminal4xx));
    chk("429 (rate limit) and 408 (gateway timeout) are NOT",
      !isTerminal4xx(429) && !isTerminal4xx(408));
    chk("5xx and 2xx are not terminal-4xx", !isTerminal4xx(500) && !isTerminal4xx(200));
  }

  // --- 2. a 401 kills the rung after ONE request ---------------------------
  {
    behaviour.set("stub-local", 401);
    behaviour.set("stub-cloud-a", "ok");
    behaviour.set("stub-cloud-b", "ok");
    const b = newBrain();
    const r1 = await b.complete(MSG);
    chk("turn is rescued by the next rung", r1.usage.model === "stub-cloud-a", r1.usage.model);
    const before = hits.filter(m => m === "stub-local").length;
    await b.complete(MSG);
    const after = hits.filter(m => m === "stub-local").length;
    chk("dead rung got exactly ONE request, ever (the E6 loop asked 45,965x)",
      before === 1 && after === 1, `${before}->${after}`);
  }

  // --- 3. a 429 is NOT a dead rung (ordinary breaker path) -----------------
  {
    behaviour.set("stub-local", 429);
    const b = newBrain();
    await b.complete(MSG);                        // 429 -> rung fail 1
    const n1 = hits.filter(m => m === "stub-local").length;
    await b.complete(MSG);                        // 429 -> rung fail 2 (breaker opens)
    const n2 = hits.filter(m => m === "stub-local").length;
    chk("429 keeps being retried until the breaker opens (2 fails), not dead at 1",
      n1 === 1 && n2 === 2, `${n1},${n2}`);
  }

  // --- 4. every rung 4xx: BrainUnreachableError, by name -------------------
  {
    behaviour.set("stub-local", 400);
    behaviour.set("stub-cloud-a", 401);
    behaviour.set("stub-cloud-b", 400);
    const b = newBrain();
    let err: any = null;
    try { await b.complete(MSG); } catch (e) { err = e; }
    chk("all-rungs-terminal throws BrainUnreachableError",
      err instanceof BrainUnreachableError && err.name === "BrainUnreachableError",
      String(err?.name));
    chk("the error names every dead rung and its 4xx",
      err?.rungs?.length === 3 && /gateway 40[01]/.test(err.rungs[0].error),
      JSON.stringify(err?.rungs)?.slice(0, 80));
    chk("terminal rung was NOT retried (a 4xx retry gets the same 4xx)",
      hits.filter(m => m === "stub-cloud-b").length === 1,
      hits.join(","));
    // While everything is dead, a turn costs ZERO requests but still fails loudly.
    hits.length = 0;
    let err2: any = null;
    try { await b.complete(MSG); } catch (e) { err2 = e; }
    chk("while dead: no request at all, same named error",
      hits.length === 0 && err2 instanceof BrainUnreachableError, `${hits.length} hits`);
  }

  // --- 5. the recheck window re-probes (a budget reset is noticed) ---------
  {
    behaviour.set("stub-local", 400);
    behaviour.set("stub-cloud-a", 400);
    behaviour.set("stub-cloud-b", 400);
    const b = newBrain();
    try { await b.complete(MSG); } catch {}
    behaviour.set("stub-local", "ok");            // the gateway is fixed...
    await new Promise(r => setTimeout(r, 1100));  // ...and the 1s recheck expires
    const { usage } = await b.complete(MSG);
    chk("after deadRungRecheckMs the rung is re-probed and recovers",
      usage.model === "stub-local", usage.model);
  }

  // --- 6. boot pre-flight --------------------------------------------------
  {
    servedModels = ["stub-local", "stub-cloud-a", "stub-cloud-b", "lumen-vision", "deepseek-v4-flash", "cerebras-oss-120b"];
    const ok = await preflightGateway();
    chk("full ladder present: no fatal", ok.fatal.length === 0, ok.fatal.join(" | ").slice(0, 120));
    chk("key budget read from /key/info", ok.budget?.spend === 12.5 && ok.budget?.maxBudget === 40,
      JSON.stringify(ok.budget));

    servedModels = ["stub-cloud-a", "stub-cloud-b", "cerebras-oss-120b"];   // primary vanished
    const missing = await preflightGateway();
    chk("missing primary model is FATAL and names the model",
      missing.fatal.length >= 1 && missing.fatal[0].includes("stub-local"),
      missing.fatal.join(" | ").slice(0, 120));

    modelsStatus = 401;
    const badKey = await preflightGateway();
    chk("401 on /v1/models (key refused) is FATAL", badKey.fatal.length === 1,
      badKey.fatal.join(" | ").slice(0, 120));
    modelsStatus = 200;

    const savedGw = CFG.gateway;
    (CFG as any).gateway = "http://127.0.0.1:1/v1/chat/completions";   // nothing listens
    const down = await preflightGateway();
    chk("gateway DOWN is a warning, never fatal (an outage must not crash-loop the boot)",
      down.fatal.length === 0 && down.warn.length >= 1, down.warn.join(" | ").slice(0, 120));
    (CFG as any).gateway = savedGw;
  }

  server.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
