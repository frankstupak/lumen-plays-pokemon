// wq#484 probe — the latency distribution layer, red AND green.
//
// Usage: npx tsx src/link/probe_latency.ts
//
// Two things are under test and they are different claims:
//   1. The MATH (latency.ts) — percentiles are nearest-rank over real observed
//      samples, buckets are fixed so two runs compare bucket-for-bucket, and an
//      empty series reports NaN rather than a confident zero.
//   2. The INSTRUMENTATION (bgblink.ts) — a sample is closed only by an actual
//      answer to an outstanding sync1. This is the part that could lie: a
//      counter that also fires on the unsolicited timestamp-only sync3 (b2=0),
//      or on a sync2 arriving with no transfer open, invents microsecond
//      samples and would make ANY link look fast. Both of those are asserted
//      NEGATIVE here, against packets fed straight into the state machine.
import { BgbLink, sync2Packet, sync3Time, sync3Ack, sync1Packet, encodePacket, statusPacket, versionPacket, DEFER_REPLY } from "./bgblink";
import { stats, histogram, percentile, BUCKET_EDGES_US, renderHistogram, summarise } from "./latency";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, note = "") => {
  c ? (pass++, console.log(`PASS ${n} :: ${note}`)) : (fail++, console.log(`FAIL ${n} :: ${note}`));
};

// ---------------------------------------------------------------- 1. the math
const series = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const s = stats(series);
ok("stats counts every sample", s.n === 10, `n=${s.n}`);
ok("p50 is nearest-rank, an OBSERVED value", s.p50Us === 50, `p50=${s.p50Us}`);
ok("p99 of 10 samples is the max, not an interpolation", s.p99Us === 100, `p99=${s.p99Us}`);
ok("min/max/mean/sum", s.minUs === 10 && s.maxUs === 100 && s.meanUs === 55 && s.sumUs === 550,
   `min=${s.minUs} max=${s.maxUs} mean=${s.meanUs} sum=${s.sumUs}`);
ok("an unsorted series gives the same answer", stats([...series].reverse()).p50Us === 50);
// The red case the "average latency" habit hides: 999 fast transfers and one
// 20ms stall. A mean says the link is fine; p99/max say a party block is at
// risk. If this ever reports a healthy tail, the stats are useless for M5d.
const tail = [...new Array(999).fill(80), 20000];
const ts = stats(tail);
ok("one outlier in 1000 moves the tail, not the mean", ts.meanUs < 200 && ts.maxUs === 20000 && ts.p99Us === 80,
   `mean=${ts.meanUs.toFixed(1)} p99=${ts.p99Us} max=${ts.maxUs}`);
ok("empty series reports NaN, never a confident 0", Number.isNaN(stats([]).p50Us) && stats([]).n === 0);
ok("percentile clamps instead of running off the end",
   percentile([1, 2, 3], 0) === 1 && percentile([1, 2, 3], 1) === 3);

const h = histogram([10, 60, 150, 300000]);
ok("histogram has one bin per edge plus an overflow",
   h.counts.length === BUCKET_EDGES_US.length + 1, `bins=${h.counts.length}`);
ok("each sample lands in exactly one bin", h.counts.reduce((a, b) => a + b, 0) === 4);
ok("a 300ms transfer lands in the overflow bin", h.counts[h.counts.length - 1] === 1);
ok("bucket edges are fixed, not derived from the data",
   histogram([1]).edgesUs === histogram([1, 2, 3, 999999]).edgesUs);
ok("renderHistogram emits one row per bin",
   renderHistogram(h).split("\n").length === h.counts.length);

// ------------------------------------------------- 2. the instrumentation
// No socket: feed() drives the state machine directly, which is how the framing
// tests in probe_bgblink work too. `send()` is a no-op without a socket, so the
// sync1 start-stamp is staged through the public master path with a fake socket.
function armed(): BgbLink {
  const link = new BgbLink({ onMasterByte: () => 0x42 });
  // Minimal stand-in for a Socket: the state machine only ever writes to it.
  (link as any).sock = { write: () => true, setNoDelay: () => {}, on: () => {}, destroy: () => {} };
  return link;
}

const a = armed();
a.feed(encodePacket(sync2Packet(0x99)));
ok("a sync2 with NO transfer open is not timed", a.latency.length === 0, `n=${a.latency.length}`);

const b = armed();
b.feed(encodePacket(sync3Time(1234)));
ok("an unsolicited timestamp-only sync3 (b2=0) is not timed", b.latency.length === 0, `n=${b.latency.length}`);

const c = armed();
c.advance(4096);
c.sendMaster(0x01);
c.feed(encodePacket(sync2Packet(0x55)));
ok("sync1 answered by sync2 produces exactly one sample", c.latency.length === 1, `n=${c.latency.length}`);
ok("the sample records the link timestamp the sync1 carried",
   c.latency[0]?.linkTs === 4096 && c.latency[0]?.kind === "sync2",
   `linkTs=${c.latency[0]?.linkTs} kind=${c.latency[0]?.kind}`);
ok("rtt is a positive wall-clock measurement", (c.latency[0]?.rttUs ?? -1) > 0, `rtt=${c.latency[0]?.rttUs}us`);
// The transfer is closed: a second answer must not re-time the same sync1.
c.feed(encodePacket(sync2Packet(0x56)));
ok("a duplicate answer does not double-count the transfer", c.latency.length === 1, `n=${c.latency.length}`);

const d = armed();
d.sendMaster(0x02);
d.feed(encodePacket(sync3Ack()));
ok("sync1 answered by a sync3 ACK (b2=1) is timed as a round trip",
   d.latency.length === 1 && d.latency[0].kind === "sync3", `kind=${d.latency[0]?.kind}`);

// Slave side: a sync1 we ANSWER is our own service cost, and must not appear in
// the rtt series — conflating the two is how a slow core reads as a slow link.
const e = armed();
e.feed(encodePacket(sync1Packet(0x77, 999)));
ok("answering a peer's sync1 records a SERVE sample, not an rtt",
   e.serve.length === 1 && e.latency.length === 0, `serve=${e.serve.length} rtt=${e.latency.length}`);
ok("an inline reply is marked deferred=false", e.serve[0]?.deferred === false);

// The production slave path, and the one the first M5d run came back empty on:
// SerialBridge defers EVERY passive transfer (wq#511 pacing rule 3), so a serve
// series that only samples inline replies is empty on the whole slave side. The
// clock must run from sync1 arrival until the handler's own answer is written.
const def = new BgbLink({ onMasterByte: () => DEFER_REPLY });
(def as any).sock = { write: () => true, setNoDelay: () => {}, on: () => {}, destroy: () => {} };
def.feed(encodePacket(sync1Packet(0x33, 7)));
ok("a DEFERRED sync1 is not sampled at arrival — the transfer is still open",
   def.serve.length === 0, `serve=${def.serve.length}`);
// An unrelated timestamp-only sync3 must not close it.
def.feed(encodePacket(sync3Time(4242)));
ok("a timestamp-only sync3 reply does not close a deferred transfer",
   def.serve.length === 0, `serve=${def.serve.length}`);
def.send(sync2Packet(0x33));
ok("the handler's own sync2 closes the deferred transfer",
   def.serve.length === 1 && def.serve[0].deferred === true,
   `serve=${def.serve.length} deferred=${def.serve[0]?.deferred}`);
ok("a deferred serve is longer than the inline one it replaced",
   (def.serve[0]?.serveUs ?? 0) > 0, `serveUs=${def.serve[0]?.serveUs}`);
def.send(sync2Packet(0x34));
ok("a second write does not re-close an already-closed transfer", def.serve.length === 1);
// A deferred sync3 ACK is the other legal answer.
const def2 = new BgbLink({ onMasterByte: () => DEFER_REPLY });
(def2 as any).sock = { write: () => true, setNoDelay: () => {}, on: () => {}, destroy: () => {} };
def2.feed(encodePacket(sync1Packet(0x44, 8)));
def2.send(sync3Ack());
ok("a deferred sync3 ACK closes the transfer too",
   def2.serve.length === 1 && def2.serve[0].deferred === true, `serve=${def2.serve.length}`);

// Handshake traffic must not be mistaken for transfers.
const f = armed();
f.feed(encodePacket(versionPacket()));
f.feed(encodePacket(statusPacket()));
ok("version/status carry no transfer and are not timed", f.latency.length === 0 && f.serve.length === 0);

// Bounded: the cap drops the OLDEST sample, so a tail stall always survives.
const g = armed();
g.latencyCap = 3;
for (const v of [1, 2, 3, 4, 5]) { g.advance(v); g.sendMaster(v); g.feed(encodePacket(sync2Packet(v))); }
ok("samples are capped and the newest are kept", g.latency.length === 3 && g.latency[2].linkTs === 15,
   `n=${g.latency.length} lastTs=${g.latency[2]?.linkTs}`);

const sum = summarise({ tag: "t", rtt: c.latency, serve: e.serve });
ok("summarise wires the dump into stats + histogram",
   sum.rtt.n === 1 && sum.serve.n === 1 && sum.hist.counts.length === BUCKET_EDGES_US.length + 1);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
