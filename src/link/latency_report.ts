// wq#484 — re-report a saved M5d latency dump without re-running a session.
//
// Usage:
//   npx tsx src/link/latency_report.ts docs/multiplayer/evidence/M5d/m5d-latency-s1-B.json
//   npx tsx src/link/latency_report.ts --split 415 <dump> [<dump> ...]
//
// WHY THIS EXISTS: the aggregate distribution over a whole session is a bimodal
// mess, and reading it as one number is misleading. The first M5d baseline
// measured p50=292us against p99=106ms / max=238ms — a 350x spread that looks
// like a catastrophically jittery link. It is not. Walking the samples shows the
// hundred-millisecond holds are all EARLY (handshake and room negotiation, where
// the ROM sits between bytes and our side legitimately holds the peer's transfer
// open), while the 415-byte block itself runs at a steady ~280us to the last
// sample.
//
// So this splits the series: the final `--split` samples are the payload, the
// rest is everything before it. Those are different populations and mixing them
// hides the only figure that predicts whether a block completes.
//
// The input is a committed evidence file, which is the point — this report is
// re-runnable from the repo at any later commit, with no emulator, no sockets,
// and no chance of measuring a different session than the one being cited.
import { readFileSync } from "fs";
import { stats, renderStats, histogram, renderHistogram, LatencyDump } from "./latency";

const argv = process.argv.slice(2);
let split = 415;                              // one Gen1 party block
const files: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--split") {
    const v = argv[++i];
    if (v === undefined || !/^\d+$/.test(v)) { console.error("--split needs a count"); process.exit(2); }
    split = Number(v);
  } else if (argv[i].startsWith("--")) {
    console.error(`unknown flag ${argv[i]}; known: --split <n>`);
    process.exit(2);
  } else files.push(argv[i]);
}
if (files.length === 0) {
  console.error("usage: latency_report.ts [--split <n>] <dump.json> [...]");
  process.exit(2);
}

for (const f of files) {
  const d: LatencyDump = JSON.parse(readFileSync(f, "utf8"));
  // A dump holds exactly one of the two series: only a master sends sync1, only
  // a slave answers one. Report whichever this side actually produced rather
  // than printing an empty block for the other.
  const series = d.rtt.length ? d.rtt.map(s => s.rttUs) : d.serve.map(s => s.serveUs);
  const kind = d.rtt.length ? "rtt (master round trips)" : "serve (slave holds)";
  const where = d.bind ? `listen ${d.bind}` : d.peerHost ? `dial ${d.peerHost}` : "unknown";
  console.log(`\n=== ${f}\n    tag=${d.tag} role=${d.role} ${where} — ${kind}`);
  if (series.length === 0) { console.log("    no samples"); continue; }

  console.log("    " + renderStats(stats(series), "all     "));
  if (series.length > split) {
    const payload = series.slice(-split);
    const before = series.slice(0, series.length - split);
    console.log("    " + renderStats(stats(before), `pre-${split} `));
    console.log("    " + renderStats(stats(payload), `last ${split}`));
    // The claim this report exists to make checkable, stated as a ratio rather
    // than prose: if the payload's tail is a small fraction of the whole
    // series' tail, the scary aggregate number is negotiation, not the link.
    const rAll = stats(series).p99Us, rPay = stats(payload).p99Us;
    console.log(`    p99 payload / p99 all = ${(rPay / rAll).toFixed(3)}`
      + `  (<<1 means the tail is NOT in the payload)`);
  }
  console.log(renderHistogram(histogram(series)));
}
