// wq#484 probe — M5d: the M5c-3 two-process session run over a REAL network
// address, repeated, with the per-transfer latency distribution captured.
//
// Usage:
//   npx tsx src/link/probe_m5d.ts                        # 3 sessions, loopback baseline
//   npx tsx src/link/probe_m5d.ts --bind 100.117.66.102  # same host, real address
//   npx tsx src/link/probe_m5d.ts --mode trade           # + selection/confirm/swap
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
  "timeout-ms", "evidence", "peer-node", "max-retries", "mode", "offer", "want",
  "patched-tag"]);
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
// `block` stops where M5c-3 stopped: the parties have been shown to each other.
// `trade` carries on through selection -> confirm -> the swap, which is the half
// of M5d's "full trade" that no distance can supply on its own.
const MODE = opt("mode", "M5D_MODE", "block") as "block" | "trade";
if (MODE !== "block" && MODE !== "trade") { console.error(`--mode must be block|trade, got ${MODE}`); process.exit(2); }
const OFFER = Number(opt("offer", "M5D_OFFER", "0"));
const WANT = Number(opt("want", "M5D_WANT", "0"));
/**
 * The asymmetry, and why a trade session needs one.
 *
 * Both sides boot one snapshot, so their parties are byte-identical and a
 * completed swap would leave RAM unchanged — indistinguishable from a swap that
 * never happened (M3's blind-run rule, trade.ts). Exactly ONE side is therefore
 * patched into a different trainer before any link traffic. Which side is fixed
 * by TAG, not by the negotiated master/slave role: the roles swap between
 * sessions, and a patch that followed them would change what each side is proving
 * from run to run.
 */
const ASYM = "bob";
/**
 * `--patched-tag none` is the LIVE NEGATIVE CONTROL, and the reason the flag
 * exists at all: it runs the trade mode with no side patched, which is a clone
 * pair. A clone pair's swap is invisible in RAM, and the patch it claims to carry
 * never crosses, so the desync gate and the swap gate must BOTH fail. A pack that
 * only ever shows green cannot distinguish a working gate from a gate wired to
 * `true` (wq#2630), and this is the cheapest input drawn from outside the
 * population the gates were written for.
 */
const PATCHED_TAG = opt("patched-tag", "M5D_PATCHED_TAG", "B");
if (!["A", "B", "none"].includes(PATCHED_TAG)) {
  console.error(`--patched-tag must be A|B|none, got ${PATCHED_TAG}`); process.exit(2);
}
/** Gen1 exchanges ONE agreed pair, so offer(A) must equal want(B) and vice
 *  versa. With a single slot on both sides that holds trivially; a split pair
 *  would make the nybble sync never converge, which looks exactly like a link
 *  fault and is not one. */
if (MODE === "trade" && OFFER !== WANT) {
  console.error(`--offer ${OFFER} / --want ${WANT}: both sides run the same driver, so the pair is only `
    + `consistent when they match. Asymmetric slots need per-side env, not this probe.`);
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, note = "") => {
  c ? (pass++, console.log(`PASS ${n} :: ${note}`)) : (fail++, console.log(`FAIL ${n} :: ${note}`));
};

/** The exit code wq#510 defined as retryable: the master entered the room and
 *  stopped clocking, so nobody is left to reconnect to inside the process. */
const STRANDED = 4;
const MAX_RETRIES = Number(opt("max-retries", "M5D_MAX_RETRIES", "3"));

interface SessionOut { n: number; sides: Array<{ tag: string; side: Side; latFile: string }>; retries: number }

/** Is this the clone-pair control rather than a real asymmetric trade? */
const CONTROL = MODE === "trade" && PATCHED_TAG === "none";

/** Artifact prefix. The modes answer different questions and their packs are read
 *  side by side, so no run may overwrite another's — least of all the control,
 *  whose whole content is failures. */
const ART = CONTROL ? "m5d-trade-control" : MODE === "trade" ? "m5d-trade" : "m5d";

function sideEnv(tag: string, role: "listen" | "connect", port: number, latFile: string): Record<string, string> {
  return {
    RDV_CONTINUE: MODE,
    ...(MODE === "trade" ? {
      RDV_ASYM: ASYM,                                     // both sides: what may differ
      ...(tag === PATCHED_TAG ? { RDV_IDENT: ASYM } : {}), // one side: be that trainer
      RDV_OFFER: String(OFFER), RDV_WANT: String(WANT),
    } : {}),
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
      tag, role, latFile: join(EVIDENCE, `${ART}-latency-s${n}-${tag}.json`),
    });
    const want = PEER === "local"
      ? [mk("A", "listen"), mk("B", "connect")]
      : [mk(LOCAL_ROLE === "listen" ? "A" : "B", LOCAL_ROLE)];

    if (PEER === "remote") {
      const peerRole = LOCAL_ROLE === "listen" ? "connect" : "listen";
      const peerTag = peerRole === "listen" ? "A" : "B";
      // Printed with every variable filled in, including the asymmetry: a peer
      // launched without RDV_IDENT/RDV_ASYM produces a clone pair whose swap is
      // invisible, and the run would look green while proving nothing.
      const peerTrade = MODE === "trade"
        ? `RDV_ASYM=${ASYM} ${peerTag === PATCHED_TAG ? `RDV_IDENT=${ASYM} ` : ""}RDV_OFFER=${OFFER} RDV_WANT=${WANT} `
        : "";
      console.log(`--- session ${n}: peer is REMOTE. Launch on ${PEER_NODE}, from a synced checkout:`);
      console.log(`    RDV_CONTINUE=${MODE} RDV_ROLE=${peerRole} RDV_TAG=${peerTag} ${peerTrade}`
        + `RDV_PORT=${port} RDV_BIND=${BIND} RDV_HOST=${HOST} `
        + `RDV_LAT_OUT=/tmp/${ART}-latency-s${n}-peer.json npx tsx src/link/rdv_side.ts`);
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
      writeFileSync(join(EVIDENCE, `${ART}-session${n}-${tag}.log`), side.out);
      const bl = side.block;
      console.log(`--- session ${n} side ${tag} exit=${side.code}`);

      ok(`s${n}/${tag}: rendezvoused`, !!side.res?.ok, `${side.res?.phase ?? "no RESULT"}`);
      ok(`s${n}/${tag}: seated at its own chair`, !!bl?.seat?.ok, JSON.stringify(bl?.seat?.at ?? null));
      ok(`s${n}/${tag}: ROM finished the 415-byte exchange`, !!bl?.exchangeDone, `linkState=${bl?.linkState}`);
      ok(`s${n}/${tag}: M5b invariants PASS on the received block`, !!bl?.ok,
         bl ? `${bl.checks} checks ${JSON.stringify(bl.failures).slice(0, 140)}` : "no BLOCKCHECK");
      // THE desync gate, and it is mode-specific because the two modes have
      // different ground truth. A clone pair must match byte for byte. An
      // asymmetric pair MUST differ — so there the gate is that the difference is
      // confined to the sections the peer's known patch can reach, and non-empty.
      // Using the clone gate on an asymmetric run would fail every healthy
      // session; using the confined gate on a clone run would pass anything.
      if (CONTROL) {
        // Inverted on purpose: with nobody patched the blocks are identical, so
        // "nothing differs" must read as "this pair proves nothing", not as a
        // clean run. A green here would mean the gate is decorative.
        const c = bl?.confined;
        ok(`s${n}/${tag}: NEGATIVE CONTROL — the desync gate REFUSES a clone pair`, c?.ok === false,
           c ? `ok=${c.ok} crossed=${c.crossed} moved=${JSON.stringify(c.moved)}` : "no confined verdict");
      } else if (MODE === "trade") {
        const c = bl?.confined;
        ok(`s${n}/${tag}: ZERO DESYNC — block differs ONLY where the peer's patch reaches`, !!c?.ok,
           c ? `moved=${JSON.stringify(c.moved)} unexpected=${JSON.stringify(c.unexpected)}` : "no confined verdict");
        ok(`s${n}/${tag}: the peer's patched identity actually crossed the wire`, !!c?.crossed,
           c ? `movedSections=${c.moved?.length}` : "no confined verdict");
      } else {
        ok(`s${n}/${tag}: ZERO DESYNC — received block mirrors our party byte-for-byte`, !!bl?.mirror?.ok,
           bl?.mirror ? `diffs=${bl.mirror.diffs} where=${JSON.stringify(bl.mirror.where ?? null)}` : "no mirror");
      }
      ok(`s${n}/${tag}: the block really crossed the wire`, (bl?.exchanges ?? 0) > 415, `exchanges=${bl?.exchanges}`);

      if (CONTROL) {
        const tr = side.trade;
        // The ROM completes this trade too — it just cannot be SEEN, because both
        // mons are the same bytes. That is precisely M3's blind-run rule, and a
        // driver reporting `swapped` here would be reporting its own wishes.
        ok(`s${n}/${tag}: NEGATIVE CONTROL — a clone swap is correctly INVISIBLE`, tr?.swapped === false,
           tr ? `swapped=${tr.swapped} note=${tr.note}` : "no TRADECHECK");
      } else if (MODE === "trade") {
        const tr = side.trade;
        ok(`s${n}/${tag}: THE SWAP LANDED — our offered slot now holds another mon`, !!tr?.swapped,
           tr ? `${tr.note} (confirms=${tr.confirms} iters=${tr.iterations} phases=${JSON.stringify(tr.phases)})`
              : "no TRADECHECK");
        ok(`s${n}/${tag}: M5b post-trade invariants PASS (count stable, other slots untouched)`, !!tr?.post?.ok,
           tr?.post ? `${tr.post.checks?.length ?? 0} checks ${JSON.stringify(tr.post.failures).slice(0, 160)}` : "no post verdict");
        // The received block is the peer's only statement about what we should
        // end up holding. Checking our party against THAT, OT and nickname
        // included, is the one-sided form of "A ends holding B's exact mon".
        ok(`s${n}/${tag}: we hold exactly the identity the peer advertised`, tr?.identity?.ok === true,
           tr?.identity ? `got=${tr.identity.got} advertised=${tr.identity.advertised}` : "no identity verdict");
      }

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
        // `desync` is the mode's own gate, so the summary means the same thing in
        // both packs: "no byte was lost or shifted on this side".
        desync: MODE === "trade" ? !x.side.block?.confined?.ok : !x.side.block?.mirror?.ok,
        mirror: !!x.side.block?.mirror?.ok, confined: x.side.block?.confined,
        exchanges: x.side.block?.exchanges,
        exchangeDone: !!x.side.block?.exchangeDone,
        ...(MODE === "trade" ? {
          swapped: !!x.side.trade?.swapped, postTrade: !!x.side.trade?.post?.ok,
          identity: x.side.trade?.identity, gave: x.side.trade?.gave,
          confirms: x.side.trade?.confirms,
        } : {}),
      })),
      rtt: stats(sessionRtt),
    });
  }

  // ------------------------------------------------------ the evidence pack
  const rttUs = allRtt.map(r => r.rttUs);
  const hist = histogram(rttUs);
  const header = [
    `M5d per-transfer latency — mode=${MODE}, ${SESSIONS} sessions, ${rttUs.length} master round trips`,
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
  writeFileSync(join(EVIDENCE, `${ART}-latency-histogram.txt`), histText);
  console.log(`\n${histText}`);

  const desyncs = perSession.reduce((a, s) => a + s.sides.filter((x: any) => x.desync).length, 0);
  if (CONTROL) {
    // The control's aggregate is the mirror image: every side must have been
    // refused. `desyncs === 0` here would mean the gate passed a clone pair.
    const sides = perSession.reduce((a, s) => a + s.sides.length, 0);
    ok(`NEGATIVE CONTROL — every side of every session was refused`, desyncs === sides, `${desyncs}/${sides}`);
    console.log("NOTE: this pack is the control. Its content is failures BY DESIGN;");
    console.log("      cite m5d-trade-summary.json for the measurement.");
  } else {
  ok(`zero desyncs across all ${SESSIONS} sessions`, desyncs === 0, `desyncs=${desyncs}`);
  ok(`at least 3 consecutive sessions were run`, SESSIONS >= 3, `sessions=${SESSIONS}`);
  if (MODE === "trade") {
    const swaps = perSession.reduce((a, s) => a + s.sides.filter((x: any) => x.swapped).length, 0);
    const wanted = perSession.reduce((a, s) => a + s.sides.length, 0);
    ok(`every side of every session completed its swap`, swaps === wanted, `${swaps}/${wanted}`);
  }
  ok(`cross-node: the peer ran on another machine`, PEER === "remote",
     PEER === "remote" ? `peerNode=${PEER_NODE}` : "peer=local — baseline only, the M5d gate is NOT met");
  }

  writeFileSync(join(EVIDENCE, `${ART}-summary.json`), JSON.stringify({
    ticket: "wq#484", generated: new Date().toISOString(),
    mode: MODE, control: CONTROL,
    ...(MODE === "trade" ? { asymmetry: { patch: CONTROL ? null : ASYM, patchedTag: PATCHED_TAG, offer: OFFER, want: WANT } } : {}),
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
