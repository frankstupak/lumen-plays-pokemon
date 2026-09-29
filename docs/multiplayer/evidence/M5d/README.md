# M5d evidence pack (wq#484) — cross-node link over Tailscale

Regenerate everything in this directory with one command:

```
npx tsx src/link/probe_m5d.ts --sessions 3 --bind 100.117.66.102
```

## What is in here

| file | what it is |
| --- | --- |
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

## Result of the run in this directory

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

The cross-node half is **blocked on worker capability, not on this code** — see
"Cross-node (M5d, wq#484)" in `../../M5_REMOTE_LINK.md` and ISSUE-LOG row 1079.
No firewall or iptables rule was added or changed to produce anything here.
