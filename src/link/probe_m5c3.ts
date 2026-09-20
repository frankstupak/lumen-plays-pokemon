// wq#511 probe — M5c-3: the 415-byte party exchange, driven over the M5a bridge
// by two INDEPENDENT PROCESSES. wq#483 got both sides into the Trade Center and
// stopped there (exchanges=30 = the handshake only); this probe is the gate for
// the continuation that actually runs the block.
//
// Usage: npx tsx src/link/probe_m5c3.ts
//
// WHAT MAKES THIS A REAL CHECK, NOT A GREEN LIGHT
// -----------------------------------------------
// Both sides boot the SAME snapshot, so the peer's party is byte-identical to
// ours. That makes trade.ts's clone warning irrelevant here (we are not proving
// a swap) and buys the strongest one-sided evidence available: the 415 bytes we
// RECEIVED must equal the 415 bytes our own party serialises to. A dropped or
// duplicated byte anywhere in the block shifts the tail and fails `mirror` —
// which is exactly how the wq#511 one-byte loss was caught, invisible as it was
// in the wire tape. Structural M5b validation alone would have passed it.
import { spawn } from "child_process";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..", "..");   // spawn the sides from THIS tree
const PORT = process.env.M5C3_PORT ?? "9391";
const TIMEOUT_MS = Number(process.env.M5C3_TIMEOUT_MS ?? 600000);

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, note = "") => {
  c ? (pass++, console.log(`PASS ${n} :: ${note}`)) : (fail++, console.log(`FAIL ${n} :: ${note}`));
};

interface Side { code: number | null; out: string; res?: any; block?: any }

function line(out: string, tag: string): any {
  const m = out.match(new RegExp(`${tag} (\\{.*\\})`));
  try { return m ? JSON.parse(m[1]) : undefined; } catch { return undefined; }
}

function side(env: Record<string, string>): Promise<Side> {
  return new Promise(res => {
    const p = spawn("npx", ["tsx", "src/link/rdv_side.ts"], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", d => { out += d.toString(); });
    p.stderr.on("data", d => { out += d.toString(); });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, TIMEOUT_MS);
    p.on("close", code => {
      clearTimeout(t);
      res({ code, out, res: line(out, "RESULT"), block: line(out, "BLOCKCHECK") });
    });
  });
}

const MAX_RETRIES = Number(process.env.M5C3_MAX_RETRIES ?? 3);

/** One pair, from launch to both exits. */
async function pair(port: number): Promise<[Side, Side]> {
  const common = { RDV_CONTINUE: "block", RDV_PORT: String(port), RDV_LINGER_MS: "45000" };
  return Promise.all([
    side({ ...common, RDV_ROLE: "listen", RDV_TAG: "A" }),
    side({ ...common, RDV_ROLE: "connect", RDV_TAG: "B", RDV_DELAY_MS: "4000" }),
  ]);
}

(async () => {
  console.log("=== M5c-3: rendezvous -> 415-byte party block -> M5b invariants ===");
  // Exit 4 is STRANDED: the documented retryable rendezvous failure (wq#510),
  // whose remedy is an orchestrator relaunch of BOTH sides — the same policy
  // tools/rdv-soak applies, port bumped so the old socket's TIME_WAIT cannot
  // bite. Retries are reported, never hidden: a pair that needed three of them
  // is a different result from one that worked first time.
  let a: Side, b: Side, attempt = 0;
  for (;;) {
    [a, b] = await pair(Number(PORT) + attempt * 100);
    if (attempt >= MAX_RETRIES || (a.code !== 4 && b.code !== 4)) break;
    attempt++;
    console.log(`--- STRANDED (exits ${a.code}/${b.code}); relaunching both sides, attempt ${attempt + 1}`);
  }
  if (attempt) console.log(`--- rendezvous took ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
  for (const [tag, s] of [["A", a], ["B", b]] as const) {
    // Full JSON, untruncated: when this fails, the telemetry IS the diagnosis.
    console.log(`--- side ${tag} exit=${s.code}`);
    for (const l of s.out.split("\n")) if (/^(RESULT|BLOCKCHECK|\[)/.test(l)) console.log(`    ${l}`);
  }

  ok("both sides rendezvoused", !!a.res?.ok && !!b.res?.ok, `${a.res?.phase}/${b.res?.phase}`);
  ok("exactly one side was master", [a.res?.role, b.res?.role].filter(r => r === 2).length === 1, `roles=${a.res?.role}/${b.res?.role}`);

  for (const [tag, s] of [["A", a], ["B", b]] as const) {
    const bl = s.block;
    ok(`side ${tag} reported a block check`, !!bl, bl ? `count=${bl.peerCount}` : "no BLOCKCHECK line");
    // Seat nav inside $EF, checked directly. The exchange completing implies we
    // sat down, but only as a corollary — if the walk ever lands on the wrong
    // tile this says so, instead of leaving a dead handshake to explain.
    ok(`side ${tag}: seated at its own chair inside the room`, !!bl?.seat?.ok,
       `want=${JSON.stringify(bl?.seat?.want ?? null)} at=${JSON.stringify(bl?.seat?.at ?? null)}`);
    ok(`side ${tag}: the ROM finished the exchange`, !!bl?.exchangeDone, `linkState=${bl?.linkState}`);
    ok(`side ${tag}: M5b invariants PASS on the received block`, !!bl?.ok, bl ? JSON.stringify(bl.failures).slice(0, 200) : "no check");
    ok(`side ${tag}: received block mirrors our own party byte-for-byte`, !!bl?.mirror?.ok,
       bl?.mirror ? `diffs=${bl.mirror.diffs} where=${JSON.stringify(bl.mirror.where ?? null)}` : "no mirror");
    // Forced hand-overs are the mechanism by which a byte gets lost, so they are
    // worth watching — but they are not the thing itself: a force while the ROM
    // is between transfers costs nothing, and three of them have been measured
    // alongside a byte-perfect block. The mirror above measures the loss
    // DIRECTLY, so it is the gate and this is the leading indicator.
    console.log(`    pacing ${tag}: ${JSON.stringify(bl?.pacing ?? null)}`);
    ok(`side ${tag}: peer party is 1..6 mons`, (bl?.peerCount ?? 0) >= 1 && (bl?.peerCount ?? 0) <= 6, `count=${bl?.peerCount}`);
    // 415 bytes each way, so the wire must carry far more than the ~30-transfer
    // handshake wq#483 stopped at. Fail-closed on the exact symptom that ticket
    // recorded rather than on a vague "some traffic happened".
    ok(`side ${tag}: the block really crossed the wire`, (bl?.exchanges ?? 0) > 415, `exchanges=${bl?.exchanges}`);
  }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
