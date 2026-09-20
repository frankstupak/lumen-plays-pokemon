# The live LPP service is decommissioned

This is an operations tombstone for the hosted stream, not an archive notice for
the project. The repo still builds and runs: `npm run verify`, `npm run p1` and
`npx tsx src/stream.ts` are unaffected. What is switched off is the unattended
live agent that played on Lumen around the clock.

**While this file exists, `src/live_agent.ts` refuses to boot (exit 4) and
`deploy/lumen-pokemon-live.service` refuses to start (failed assertion).**

- Decommissioned: 2026-09-13
- Ticket: wq#2073
- Re-approval condition: **a free local brain AND Frank's explicit go-ahead.**
  Neither is satisfied today.

## Why the unit being masked was not enough

The 2026-09-13 decommission was applied as a bare `systemctl mask` and recorded
nowhere a sibling agent could read. On 2026-09-18 wq#1990 — an unrelated ops
ticket installing wq#1661's :8871 unit files — found `LoadState=masked` with no
attached reason, judged it an undocumented leftover blocking an open fire
(wq#1821), ran `systemctl unmask`, and restarted the service. It ran 19h and
made ~8.5k brain calls, saturating the local qwen36 decode slot on isis, which
starved supergateway and dropped Frank's Claude MCP sessions. Full evidence:
`reports/2073_lpp_resurrection_rca.md`.

Nothing malfunctioned. A mask carries no reason, so the next person to read it
supplies their own. This file is the reason, and it lives in the tree the
service runs out of, so it cannot be lost to a `systemctl` verb or replaced by
a deploy that copies unit files into `/etc`.

## To revive

1. Get Frank's re-approval and point the brain at a free local model.
2. Delete this file **in a pull request** — one reviewable commit that names the
   approval. Do not delete it on the host.
3. `sudo systemctl unmask lumen-pokemon-live.service`, then install and restart
   per `docs/PORT-8871.md`.

Step 2 before step 3, always: the boot gate is what makes a stray `systemctl
start` — by a watchdog, a deploy hook, or a well-meaning ops ticket — a logged
refusal instead of another 19h run.
