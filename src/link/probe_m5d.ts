// wq#484 probe — M5d: the M5c-3 two-process session run over a REAL network
// address, repeated, with the per-transfer latency distribution captured.
//
// Usage:
//   npx tsx src/link/probe_m5d.ts                        # 3 sessions, loopback baseline
//   npx tsx src/link/probe_m5d.ts --bind 100.117.66.102  # same host, real address
//   npx tsx src/link/probe_m5d.ts --peer remote --bind 100.117.66.102 \
//       --peer-node thor --local-role listen             # the real M5d shape
// Every flag also reads an M5D_* environment variable (see FLAGS below), which is
// how the remotely-launched peer side is configured.
//
// WHAT THIS PROBE IS FOR, AND WHAT IT CANNOT PROVE ON ITS OWN
// ----------------------------------------------------------
// M5c-3 proved a party block survives two independent processes on ONE machine
// over loopback. M5d's question is different and is not a code question: does it
// survive two machines' clocks and a real path's jitter. So this probe reports
// the transport it actually ran on, in every artifact it writes, and refuses to
// describe a same-host run as a cross-node one. `M5D_PEER=local` is a BASELINE:
// a real socket on a real address, one kernel, one clock. `M5D_PEER=remote` is
// the measurement: this side only, the peer launched on the other node, which is
// the configuration the M5d gate asks for.
//
// The gate, either way, is the same three claims per session:
//   1. both sides reached the room and exactly one was master,
//   2. the ROM finished the 415-byte exchange and M5b invariants pass on the
//      RECEIVED bytes,
//   3. ZERO DESYNC — the block that arrived equals the block our own party
//      serialises to, byte for byte. Both sides boot the same snapshot, so a
//      single lost or duplicated byte shifts the tail and fails this. It is the
//      only check that sees such a loss; structural validation passes it.
// Repeated over >=3 consecutive sessions, because a one-run green on a lossy
// path is a coin flip, not evidence.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { hostname } from "os";
import { spawnSide, Side, REPO_ROOT } from "./side_runner";
import { stats, histogram, renderHistogram, renderStats, LatencyDump } from "./latency";
import type { LatencySample } from "./bgblink";

/**
 * `--flag value` beats `M5D_FLAG`, which beats the default. Flags exist because
 * a `VAR=value cmd` prefix is not a shape every caller can use (a worker
 * harness allowlists whole commands, not environment prefixes), and a probe
 * only reachable through the environment is a probe that quietly stops being
 * run. Unknown flags are fatal: a typo'd `--sesions 5` that silently ran 3
 * would produce evidence labelled with the wrong sample count.
 */
const FLAGS = new Set(["sessions", "port", "bind", "host", "peer", "local-role",
  "timeout-ms", "evidence", "peer-node", "max-retries"]);
const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { console.error(`unexpected argument ${a!}`); process.exit(2); }
  const k = a.slice(2);
  if (!FLAGS.has(k)) {
    console.error(`unknown flag --${k}; known: ${[...FLAGS].map(f => "--" + f).join(" ")}`);
    process.exit(2);
  }
  const v = argv[++i];
  if (v === undefined) { console.error(`--${k} needs a value`); process.exit(2); }
  flags[k] = v;
}
const opt = (flag: string, envName: string, dflt: string): string =>
  flags[flag] ?? process.env[envName] ?? dflt;

const SESSIONS = Number(opt("sessions", "M5D_SESSIONS", "3"));
const PORT0 = Number(opt("port", "M5D_PORT", "9451"));
const BIND = opt("bind", "M5D_BIND", "127.0.0.1");
const HOST = opt("host", "M5D_HOST", BIND);
const PEER = opt("peer", "M5D_PEER", "local") as "local" | "remote";
const LOCAL_ROLE = opt("local-role", "M5D_LOCAL_ROLE", "listen") as "listen" | "connect";
const TIMEOUT_MS = Number(opt("timeout-ms", "M5D_TIMEOUT_MS", "600000"));
const EVIDENCE = opt("evidence", "M5D_EVIDENCE", join(REPO_ROOT, "docs/multiplayer/evidence/M5d"));
const PEER_NODE = opt("peer-node", "M5D_PEER_NODE", PEER === "local" ? hostname() : "unknown");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, note = "") => {
  c ? (pass++, console.log(`PASS ${n} :: ${note}`)) : (fail++, console.log(`FAIL ${n} :: ${note}`));
};

/** The exit code wq#510 defined as retryable: the master entered the room and
 *  stopped clocking, so nobody is left to reconnect to inside the process. */
const STRANDED = 4;
const MAX_RETRIES = Number(opt("max-retries", "M5D_MAX_RETRIES", "3"));

interface SessionOut { n: number; sides: Array<{ tag: string; side: Side; latFile: string }>; retries: number }

function sideEnv(tag: string, role: "listen" | "connect", port: number, latFile: string): Record<string, string> {
  return {
    RDV_CONTINUE: "block",
    RDV_PORT: String(port),
    RDV_LINGER_MS: "45000",
    RDV_TAG: tag,
    RDV_ROLE: role,
    RDV_BIND: BIND,
    RDV_HOST: HOST,
    RDV_LAT_OUT: latFile,
    // Only the dialling side is delayed, and only so the listener is bound
    // first. Both sides racing the socket is a flaky-test generator, not a
    // realistic scenario — a real pair is started by a human or a scheduler.
    ...(role === "connect" ? { RDV_DELAY_MS: "4000" } : {}),
  };
}

async function runSession(n: number): Promise<SessionOut> {
  let retries = 0;
  for (;;) {
    const port = PORT0 + n * 100 + retries * 10;
    const mk = (tag: string, role: "listen" | "connect") => ({
      tag, role, latFile: join(EVIDENCE, `m5d-latency-s${n}-${tag}.json`),
    });
    const want = PEER === "local"
      ? [mk("A", "listen"), mk("B", "connect")]
      : [mk(LOCAL_ROLE === "listen" ? "A" : "B", LOCAL_ROLE)];

    if (PEER === "remote") {
      const peerRole = LOCAL_ROLE === "listen" ? "connect" : "listen";
      console.log(`--- session ${n}: peer is REMOTE. Launch on ${PEER_NODE}, from a synced checkout:`);
      console.log(`    RDV_CONTINUE=block RDV_ROLE=${peerRole} RDV_TAG=${peerRole === "listen" ? "A" : "B"} `
        + `RDV_PORT=${port} RDV_BIND=${BIND} RDV_HOST=${HOST} `
        + `RDV_LAT_OUT=/tmp/m5d-latency-s${n}-peer.json npx tsx src/link/rdv_side.ts`);
    }

    const sides = await Promise.all(want.map(async w => ({
      tag: w.tag, latFile: w.latFile,
      side: await spawnSide(sideEnv(w.tag, w.role, port, w.latFile), TIMEOUT_MS),
    })));

    if (retries >= MAX_RETRIES || !sides.some(s => s.side.code === STRANDED)) {
      return { n, sides, retries };
    }
    retries++;
    console.log(`--- session ${n}: STRANDED (exits ${sides.map(s => s.side.code).join("/")}); `
      + `relaunching both sides on a fresh port, attempt ${retries + 1}`);
  }
}

function readDump(path: string): LatencyDump | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  console.log(`=== M5d: ${SESSIONS} consecutive two-process sessions ===`);
  console.log(`transport: peer=${PEER} bind=${BIND} host=${HOST} localNode=${hostname()} peerNode=${PEER_NODE}`);
  if (PEER === "local") {
    console.log("NOTE: peer=local — both sides on THIS host. Real sockets on a real");
    console.log("      address, but ONE kernel and ONE clock. This is the M5d baseline,");
    console.log("      not the cross-node measurement.");
  }

  const allRtt: LatencySample[] = [];
  const allServe: number[] = [];
  const perSession: any[] = [];

  for (let n = 1; n <= SESSIONS; n++) {
    const s = await runSession(n);
    if (s.retries) console.log(`--- session ${n} took ${s.retries} retr${s.retries === 1 ? "y" : "ies"}`);

    const sessionRtt: number[] = [];
    for (const { tag, side, latFile } of s.sides) {
      writeFileSync(join(EVIDENCE, `m5d-session${n}-${tag}.log`), side.out);
      const bl = side.block;
      console.log(`--- session ${n} side ${tag} exit=${side.code}`);

      ok(`s${n}/${tag}: rendezvoused`, !!side.res?.ok, `${side.res?.phase ?? "no RESULT"}`);
      ok(`s${n}/${tag}: seated at its own chair`, !!bl?.seat?.ok, JSON.stringify(bl?.seat?.at ?? null));
      ok(`s${n}/${tag}: ROM finished the 415-byte exchange`, !!bl?.exchangeDone, `linkState=${bl?.linkState}`);
      ok(`s${n}/${tag}: M5b invariants PASS on the received block`, !!bl?.ok,
         bl ? `${bl.checks} checks ${JSON.stringify(bl.failures).slice(0, 140)}` : "no BLOCKCHECK");
      // THE desync gate.
      ok(`s${n}/${tag}: ZERO DESYNC — received block mirrors our party byte-for-byte`, !!bl?.mirror?.ok,
         bl?.mirror ? `diffs=${bl.mirror.diffs} where=${JSON.stringify(bl.mirror.where ?? null)}` : "no mirror");
      ok(`s${n}/${tag}: the block really crossed the wire`, (bl?.exchanges ?? 0) > 415, `exchanges=${bl?.exchanges}`);

      const dump = readDump(latFile);
      // Only the MASTER sends sync1, so only the master has round trips; the
      // slave's series is `serve`. Requiring rtt from both would fail the slave
      // on every healthy run — and requiring neither would let a silently
      // uninstrumented side pass, which is how the first M5d run shipped an
      // empty slave pack. So: each side must have captured ITS own series.
      const master = side.res?.role === 2;
      const nRtt = dump?.rtt?.length ?? 0, nServe = dump?.serve?.length ?? 0;
      ok(`s${n}/${tag}: captured its own latency series (${master ? "master/rtt" : "slave/serve"})`,
         master ? nRtt > 0 : nServe > 0, `role=${side.res?.role} rtt=${nRtt} serve=${nServe}`);
      if (dump) {
        allRtt.push(...dump.rtt);
        sessionRtt.push(...dump.rtt.map(r => r.rttUs));
        allServe.push(...dump.serve.map(r => r.serveUs));
        console.log(`    ${renderStats(stats(dump.rtt.map(r => r.rttUs)), `rtt s${n}/${tag}`)}`);
      }
      console.log(`    pacing ${tag}: ${JSON.stringify(bl?.pacing ?? null)}`);
    }
    if (PEER === "local") {
      const roles = s.sides.map(x => x.side.res?.role);
      ok(`s${n}: exactly one side was master`, roles.filter(r => r === 2).length === 1, `roles=${roles.join("/")}`);
    }
    perSession.push({
      session: n, retries: s.retries,
      sides: s.sides.map(x => ({
        tag: x.tag, exit: x.side.code, invariants: !!x.side.block?.ok,
        mirror: !!x.side.block?.mirror?.ok, exchanges: x.side.block?.exchanges,
        exchangeDone: !!x.side.block?.exchangeDone,
      })),
      rtt: stats(sessionRtt),
    });
  }

  // ------------------------------------------------------ the evidence pack
  const rttUs = allRtt.map(r => r.rttUs);
  const hist = histogram(rttUs);
  const header = [
    `M5d per-transfer latency — ${SESSIONS} sessions, ${rttUs.length} master round trips`,
    `transport: peer=${PEER} bind=${BIND} host=${HOST} localNode=${hostname()} peerNode=${PEER_NODE}`,
    PEER === "local"
      ? "BASELINE: both sides on this host — one kernel, one clock. NOT a cross-node measurement."
      : "CROSS-NODE: the peer ran on another machine with its own clock.",
    "",
    renderStats(stats(rttUs), "rtt  (sync1 written -> peer answer parsed, wall clock)"),
    renderStats(stats(allServe), "serve (peer sync1 -> our answer written, OUR cost)"),
    "",
  ].join("\n");
  const histText = `${header}${renderHistogram(hist)}\n`;
  writeFileSync(join(EVIDENCE, "m5d-latency-histogram.txt"), histText);
  console.log(`\n${histText}`);

  const desyncs = perSession.reduce((a, s) => a + s.sides.filter((x: any) => !x.mirror).length, 0);
  ok(`zero desyncs across all ${SESSIONS} sessions`, desyncs === 0, `desyncs=${desyncs}`);
  ok(`at least 3 consecutive sessions were run`, SESSIONS >= 3, `sessions=${SESSIONS}`);
  ok(`cross-node: the peer ran on another machine`, PEER === "remote",
     PEER === "remote" ? `peerNode=${PEER_NODE}` : "peer=local — baseline only, the M5d gate is NOT met");

  writeFileSync(join(EVIDENCE, "m5d-summary.json"), JSON.stringify({
    ticket: "wq#484", generated: new Date().toISOString(),
    transport: { peer: PEER, bind: BIND, host: HOST, localNode: hostname(), peerNode: PEER_NODE },
    crossNode: PEER === "remote",
    sessions: perSession, desyncs,
    rtt: stats(rttUs), serve: stats(allServe),
    histogram: { edgesUs: hist.edgesUs, counts: hist.counts },
    pass, fail,
  }, null, 2) + "\n");

  console.log(`\n${pass} PASS / ${fail} FAIL   (evidence: ${EVIDENCE})`);
  process.exit(fail ? 1 : 0);
})();
