# wq#1066 — LPP frontier stall: root cause + fixes

Session: claude-web-lpp1066  •  2026-08-28

## TL;DR
The frozen frontier has TWO stacked causes. The resume oscillation (the ticket's
framing) is real and is now fixed. But the BINDING constraint is that the LPP
LiteLLM brain key hit its budget cap, so every brain call returns 400 and the
agent cannot think. Frontier will not advance until that budget is addressed
(Frank cost decision).

## Root cause 1 (binding): brain budget exhausted
- Brain routes through LiteLLM (localhost:4000) on the scoped key
  `/home/lumen/.secrets/litellm-service-keys/lpp.key` (alias `lpp-2`).
- `/key/info`: `spend=5.078`, `max_budget=5.0`, `budget_duration=30d`,
  `budget_reset_at=2026-09-01T00:00:00Z`.
- Every call: `400 {"type":"budget_exceeded","message":"... Current cost:
  5.078..., Max budget: 5.0"}`. Present in the previous PID's event log too
  (back to the 2026-08-27 wq#1021 rehome), so the brain has been dead the whole
  post-crash window.
- WHY a free-model key accrued $5: LiteLLM charges notional per-token cost on
  qwen36-local / cerebras-oss-120b; ~29M campaign tokens -> ~$5.08 -> hit the cap.
- Effect: brain 400 -> `brain_breaker` -> inner loop bails ~every 57s ->
  re-resume. That 57s reset is what surfaced as the "oscillation".

DECISION FOR FRANK (cost policy, not changed by this session):
  a) reset spend now (unblocks immediately; 30d guard still resets 09-01):
     curl -s -X POST -H "Authorization: Bearer $(cat /home/lumen/.secrets/litellm-service-keys/admin.key 2>/dev/null || echo MASTER)" \
       -H "Content-Type: application/json" http://localhost:4000/key/update \
       -d '{"key":"<lpp-2 key>","spend":0}'
  b) raise/remove the cap (durable, overrides the guard):
     ... /key/update -d '{"key":"<lpp-2 key>","max_budget":50}'
  c) fix root: price qwen36-local + cerebras-oss-120b at $0 in the gateway
     model_cost so free rungs never accrue (broadest blast — affects all keys
     using those models).
  d) do nothing: auto-resets 2026-09-01 (~4 days).
Recommendation: (c) is the correct root fix (they ARE free); (a) as the
immediate unblock. Left for Frank — cost guard on shared infra.

## Root cause 2 (fixed this session): resume picker preferred warp-tile saves
`src/resume.ts pickResume()` sorted: critical -> badges -> story -> RANK -> fine
-> events -> onWarp -> mtime. `onWarp` was the LAST tiebreak. A checkpoint saved
standing ON a warp tile does not hold the map-rank it appears to (the next step
re-fires the warp), but it still won on rank:
- `auto-*-t10` = map88 Bill's-warp @(2,7), onWarp=true, rank 25 -> always #1.
- REPEAT_LIMIT=2 demoted it every 2nd pick to `auto-*-map36` (Route 25, rank 24),
  also in the trap -> the exact t10/t10/map36 A/B alternation, 180h frozen.
- resume.ts never reads supervisor_directive.json, so the WARP_OSC ban never
  reached the picker.

FIX: move `onWarp` directly under badges/story and ABOVE rank, so a warp-tile
save can never claim positional rank it cannot keep (still never outvotes real
permanent progress). Also: the REPEAT-GUARD escape now prefers a NEWER NON-WARP
alternate (falling back to the old "any newer viable" pick), so the escape hatch
can't step back onto a warp tile. Verified over the live 93-candidate corpus:
winner is now Route 25 map36 @(0,4) onWarp=false; t10/map88 never selected across
12 picks. probe_resume518 39/39, probe_pocket534 13/0/2 green. Deployed via one
clean restart (NRestarts=0, healthy).

## Fixes for the ticket's 3 asks
1. Oscillation — FIXED in src/resume.ts (above). Deployed.
2. frontier.json emission — RESTORED. It only persists from lpp_frontier.py's
   main(); compute() (what lpp_stuck_mode imports) never writes it, and nothing
   on the agent path runs the script — so emission was never reliably wired, it
   rode now-disabled monitors. Added a dedicated timer
   `lumen-lpp-frontier.timer` (15 min, deploy/lumen-lpp-frontier.{service,timer}).
   frontier.json now regenerates (was frozen at 2026-08-23).
3. Stuck escalation — RESTORED. `lumen-lpp-stuck-supervisor.timer` had been
   `systemctl disable`d during the crash-window firefight (not for cause; the
   supervisor is read-only-plus-directive per its anti-footgun spec — never
   touches the service). Re-enabled; it now emits stuck_mode.json +
   supervisor_directive.json (fresh WARP_OSC@64, gotoBan [3,36,64]) +
   stuck_escalation.json. Also re-enabled lumen-lpp-sentinel.timer was left as-is
   (out of scope) — see follow-ups.

## Residual / follow-ups
- Frontier advance is Frank-gated on the budget decision above.
- lpp-sentinel / lpp-snapshot / lpp-watchdog timers are also still disabled from
  the same firefight; re-enable if the monitoring is wanted (not done here —
  scoped to the ticket).
