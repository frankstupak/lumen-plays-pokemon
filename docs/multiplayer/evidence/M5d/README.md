# M5d evidence pack (wq#484) — cross-node link over Tailscale

Three runs produce this directory, and they answer different questions. Run them
in this order:

```
npx tsx src/link/probe_m5d.ts --sessions 3 --bind 100.117.66.102
npx tsx src/link/probe_m5d.ts --mode trade --sessions 3 --bind 100.117.66.102
npx tsx src/link/probe_m5d.ts --mode trade --patched-tag none --sessions 1 --bind 100.117.66.102
```

`m5d-*` is the party-block baseline (clone pair, byte-for-byte mirror gate).
`m5d-trade-*` adds selection -> confirm -> the swap itself, which needs an
ASYMMETRIC pair and therefore a different desync gate. `m5d-trade-control-*` is
the negative control: the same trade mode with nobody patched, where every gate
must REFUSE. Its content is failures by design — never cite it as a result.

## What is in here

| file | what it is |
| --- | --- |
| `m5d-trade-summary.json` | the swap verdict per session and side: `swapped`, `postTrade`, the `identity` comparison against what the peer advertised, and the `confined` desync verdict with every moved block section |
| `m5d-trade-session<N>-<A\|B>.log` | that side's stdout including `TRADECHECK` — which menu phases it passed through, how many confirm attempts it took, and what it gave away |
| `m5d-trade-latency-s3-<A\|B>.json` | per-transfer samples for one trade session: ~12.6k transfers, against ~700 for a block-only session. **Session 3 only, deliberately** — six full trade dumps are 4.5MB against this whole directory's 104KB before them, and the per-session percentiles are in the summary either way. Re-running the pack writes all six locally |
| `m5d-trade-latency-histogram.txt` | the trade-mode distribution, header-labelled `mode=trade` |
| `m5d-trade-latency-split-s3-B.txt` | `latency_report.ts` on one trade side. **Read the caption:** its `last 415` bucket is the last 415 transfers of a ~14k-transfer session, NOT the party block (which ended thousands of transfers earlier), so the payload/all ratio does not mean here what it means in the block pack. Cite the `all` line: p50 1.93ms sustained |
| `m5d-trade-probe-run.log` | the orchestrator's output for the trade pack, assertions in order, including session 2's STRANDED relaunch |
| `m5d-trade-control-probe-run.log` | the negative control: 18 assertions, all of them inverted (`the desync gate REFUSES a clone pair`, `a clone swap is correctly INVISIBLE`). Its own sample dumps are not committed for the same size reason |
| `m5d-summary.json` | machine-readable verdict: transport, per-session invariant/mirror results, aggregate rtt stats, histogram counts, PASS/FAIL tally |
| `m5d-latency-histogram.txt` | the per-transfer latency distribution, fixed doubling buckets, with the transport it was measured on in the header |
| `m5d-latency-s<N>-<A\|B>.json` | every individual sample for session N, side A/B — `rttUs` per master transfer plus the separate slave-side serve series |
| `m5d-session<N>-<A\|B>.log` | that side's full stdout: rendezvous phases, `BLOCKCHECK` (M5b invariants + byte-for-byte mirror), `LATENCY` summary, pacing telemetry |
| `m5d-probe-run.log` | the orchestrator's own output for this pack — every assertion, in order, with the session boundaries and retries |
| `m5d-latency-split-s3-B.txt` | the handshake-vs-payload split for one master side, as produced by `latency_report.ts` |

Re-report any saved dump without re-running a session — this is how the
handshake-vs-payload split in `../../M5_REMOTE_LINK.md` is reproduced:

```
npx tsx src/link/latency_report.ts docs/multiplayer/evidence/M5d/m5d-latency-s3-B.json
```

## Result of the trade pack (`m5d-trade-*`)

3 consecutive sessions, **72 PASS / 1 FAIL** — the FAIL is the same one as below:
the probe declining to call a same-host run cross-node. Every session, both
sides: a full two-way swap, the mon held afterwards matching the identity the
peer's block advertised down to OT and nickname, `verifyPostTrade` green, and
**zero desyncs — 30 moved block sections, 0 outside the set the peer's patch can
reach, on all six side-runs**. One confirm attempt per side; session 2 needed one
wq#510 STRANDED relaunch. ~12.6k transfers per session (a block-only session is
~700). Aggregate over 37878 master round trips: p50 912us, p90 1.42ms,
p99 3.03ms, max 234ms.

The control (`m5d-trade-control-*`, 1 session, nobody patched) is **18 PASS / 0
FAIL with every assertion inverted**: `ok=false crossed=false moved=[]` on both
sides, and `swapped=false` from both drivers. That is what makes the 72 above a
measurement rather than a tautology.

## Result of the block baseline (`m5d-*`)

3 consecutive sessions, 47 PASS / 1 FAIL — the FAIL is the probe declining to
call a same-host run cross-node. Zero desyncs (0 differing bytes) on both sides
of all 3 sessions; ~702 exchanges per side per session. Aggregate rtt over 2108
master round trips: p50 293us, p90 778us, p99 105ms, max 238ms. Read the split
before drawing a conclusion from that p99: the 415-byte payload's own worst
transfer is **1.2ms** (p99 859us), and every hundred-millisecond hold belongs to
the handshake before it.

## Reading the latency numbers

`rttUs` is **wall clock**: sync1 written to the socket, the peer's answer parsed
back out of it. It has to be wall clock, because the protocol's own `i1`
timestamps count *emulated* cycles and deliberately freeze while a byte is
pending (spec rule 5 — that freeze is what lets a remote peer wait for us
correctly). A link across a continent and a link on loopback therefore produce
identical `i1` deltas. Only `rttUs` sees the network.

The `serve` series is separate on purpose: it is our own core's turnaround on a
transfer the *peer* mastered. Folding it into `rttUs` would let a slow core read
as a slow link.

Percentiles, not the mean. A party block is ~415 sequential transfers, so what
decides whether one completes is the tail: a single 15s outlier trips the
bridge's settle budget and strands the peer while the mean stays in
microseconds. `p99` and `max` are the numbers to read.

## The honest limit on this pack — READ THIS BEFORE CITING IT

`m5d-summary.json` carries a `crossNode` boolean and every artifact repeats the
transport in its header. **A `peer=local` run is a baseline, not the M5d
measurement.** It uses real sockets on a real non-loopback address and two
genuinely independent processes, but one kernel and one clock, so it cannot
exhibit the two things M5d exists to test: clock skew between machines and a
real path's jitter. The probe fails its own `cross-node` assertion in that
configuration rather than reporting green.

The cross-node half is **blocked on worker capability, not on this code** — no
fleet-exec verb can start a process on a second node, which is wq#3200. See
"Cross-node (M5d, wq#484)" in `../../M5_REMOTE_LINK.md` and ISSUE-LOG row 1079.
No firewall or iptables rule was added or changed to produce anything here, and
no process was ever started on Thor.
