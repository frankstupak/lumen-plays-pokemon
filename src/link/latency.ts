// wq#484 (M5d) — turn a BgbLink's per-transfer wall-clock samples into a
// distribution. Pure functions over numbers: no sockets, no cores, so a probe
// can assert on them directly and an evidence pack can be regenerated from a
// saved sample file without re-running a session.
//
// Percentiles, not an average. A link's average round trip is the least
// interesting number it has: a Gen1 party block is ~415 sequential transfers,
// so the thing that decides whether a block completes is the TAIL — one 12s
// outlier trips the bridge's 15s settle budget and strands the peer, while the
// mean stays microseconds. p99 and max are the numbers M5d exists to report.
import type { LatencySample, ServeSample } from "./bgblink";

export interface LatencyStats {
  n: number;
  minUs: number; p50Us: number; p90Us: number; p99Us: number; maxUs: number;
  meanUs: number;
  /** total observed round-trip time — how much of a session was spent waiting. */
  sumUs: number;
}

/** Nearest-rank on a sorted copy (no interpolation): every reported percentile
 *  is an actual observed transfer, which is what makes it citable evidence. */
export function percentile(sortedUs: number[], q: number): number {
  if (sortedUs.length === 0) return NaN;
  const i = Math.min(sortedUs.length - 1, Math.max(0, Math.ceil(q * sortedUs.length) - 1));
  return sortedUs[i];
}

export function stats(us: number[]): LatencyStats {
  const s = [...us].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    minUs: s.length ? s[0] : NaN,
    p50Us: percentile(s, 0.5),
    p90Us: percentile(s, 0.9),
    p99Us: percentile(s, 0.99),
    maxUs: s.length ? s[s.length - 1] : NaN,
    meanUs: s.length ? sum / s.length : NaN,
    sumUs: sum,
  };
}

/**
 * Doubling bucket edges in microseconds, open-ended at the top. Fixed rather
 * than derived from the data so two runs are directly comparable bucket for
 * bucket — a histogram whose bins move with the sample is a picture, not a
 * measurement. The range deliberately spans loopback (tens of microseconds)
 * through a bad WAN hop (hundreds of milliseconds) in one scale.
 */
export const BUCKET_EDGES_US = [
  50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 102400, 204800,
];

export interface Histogram {
  /** counts.length === BUCKET_EDGES_US.length + 1; the last bin is the overflow. */
  edgesUs: number[];
  counts: number[];
}

export function histogram(us: number[], edgesUs = BUCKET_EDGES_US): Histogram {
  const counts = new Array(edgesUs.length + 1).fill(0);
  for (const v of us) {
    let b = edgesUs.findIndex(e => v < e);
    if (b < 0) b = edgesUs.length;                 // >= the top edge: overflow bin
    counts[b]++;
  }
  return { edgesUs, counts };
}

const label = (edges: number[], i: number): string =>
  i === 0 ? `      < ${edges[0]}us`
    : i === edges.length ? `>= ${edges[edges.length - 1]}us`
      : `${String(edges[i - 1]).padStart(6)}..${edges[i]}us`;

/** Fixed-width text bars — the evidence pack is read in a terminal and in a
 *  diff, so the histogram has to survive both. */
export function renderHistogram(h: Histogram, width = 48): string {
  const top = Math.max(1, ...h.counts);
  const total = h.counts.reduce((a, b) => a + b, 0) || 1;
  const rows = h.counts.map((c, i) => {
    const bar = "#".repeat(Math.round((c / top) * width));
    const pct = ((c / total) * 100).toFixed(1).padStart(5);
    return `${label(h.edgesUs, i).padEnd(20)} ${String(c).padStart(7)}  ${pct}%  ${bar}`;
  });
  return rows.join("\n");
}

export function renderStats(s: LatencyStats, title: string): string {
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "n/a");
  return `${title}: n=${s.n} min=${f(s.minUs)}us p50=${f(s.p50Us)}us `
    + `p90=${f(s.p90Us)}us p99=${f(s.p99Us)}us max=${f(s.maxUs)}us `
    + `mean=${f(s.meanUs)}us total=${(s.sumUs / 1000).toFixed(1)}ms`;
}

/** What a side dumps at exit and what a probe reads back in. */
export interface LatencyDump {
  tag: string;
  /** 2 = master in Gen1's own encoding (wLinkRole), matching rdv_side. */
  role?: number;
  bind?: string;
  peerHost?: string;
  rtt: LatencySample[];
  serve: ServeSample[];
}

export function summarise(d: LatencyDump): { rtt: LatencyStats; serve: LatencyStats; hist: Histogram } {
  const rttUs = d.rtt.map(s => s.rttUs);
  return {
    rtt: stats(rttUs),
    serve: stats(d.serve.map(s => s.serveUs)),
    hist: histogram(rttUs),
  };
}
