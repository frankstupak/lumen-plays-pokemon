# Brain-unreachable is its own stuck mode (wq#1660)

## The incident this exists for

M2 in `foreman/research/LPP_BEHAVIORAL_ANALYSIS.md`: ~200h of a 336h window had
no reachable brain at all — "Budget has been exceeded" 45,965x (Sep 3-9),
"Invalid model" 1,837x (Aug 30 - Sep 1), "key not allowed" 4,619x (Sep 9). All
three arrive as gateway **4xx** responses, and `Brain.complete()` treated them
exactly like a timeout: rung fails → breaker cools it 10 min → next rung →
same 4xx → `failStreak >= 5` → live_agent tears the agent down and resumes a
checkpoint, every ~57 s, for six days. Meanwhile the stuck supervisor kept
reading the (frozen, stale) `warp_history.json` and prescribed
FIGHT_LOSS_LOOP grind pins 9,200 times to a brain that could not read them.

A deterministic 4xx is not a saturated rung. Retrying it is free-looking and
worthless, and *rebooting* on it is worse: a reboot exists to roll the game
back to a better checkpoint, and a dead brain writes no new checkpoints.

## The four changes

1. **Terminal 4xx classification** (`src/brain.ts`). `callRung` throws
   `GatewayError` carrying the HTTP status. In the ladder walk, a 4xx that is
   not 429 (rate limit — transient) and not 408 (gateway-side timeout —
   transient) marks the rung **dead** for `CFG.brain.deadRungRecheckMs`
   (default 15 min, `LPP_BRAIN_DEAD_RUNG_RECHECK_MS`): no further requests to
   it, not even on the terminal rung — unlike the wq#907 breaker, which the
   terminal rung deliberately ignores. Dead is different from saturated: the
   breaker guards a busy decode slot that frees itself; dead is "this request
   can never succeed as configured". The recheck window is what lets a budget
   reset or a gateway fix be noticed without a restart.

2. **`BrainUnreachableError` instead of a reboot loop** (`src/brain.ts`,
   `src/live_agent.ts`). When every rung in the ladder is dead,
   `complete()` throws `BrainUnreachableError` (naming each rung's last
   error) instead of a generic failure. live_agent's turn loop catches it
   specifically: emits a `brain_unreachable` event, writes/refreshes
   `runtime/brain_unreachable.json` (`{since, updatedAt, lastError, rungs}`),
   and **holds in place** — sleeps and retries in-process, never counting
   toward the `failStreak >= 5` teardown. No reboot happens while the brain
   is unreachable, which trivially satisfies "no reboot without a new
   checkpoint since the last one": an unreachable brain produces no new
   checkpoints, so there is nothing a resume could improve. The first
   successful turn afterwards deletes the signal file.

3. **`BRAIN_UNREACHABLE` stuck mode + aq page** (`tools/lpp_stuck_mode.py`,
   `tools/lpp-stuck-supervisor`). `compute()` reads the signal file first; if
   its heartbeat is fresh (updated within 10 min) the state is
   `stalled=True, stallAxis="brain", mode=BRAIN_UNREACHABLE` — ahead of
   FIGHT_LOSS_LOOP and every other classifier, all of which read history a
   dead brain cannot be writing. The intervention layer has no prescription
   for it on purpose (`decide()` returns its existing "no prescription"
   no-op): a notepad pin cannot reach a dead brain. Instead the supervisor
   upserts an aq row — `source='probe'`, `priority='high'`,
   `key='lpp-brain-unreachable'` — the exact predicate the wq#965 responder
   escalates: at count>=3 (three supervisor ticks unrecovered) it files one
   P0 ticket and pages Frank once. Recovery edge-clears: when the signal file
   goes away the supervisor resolves the open row.

4. **Boot pre-flight** (`src/brain.ts` `preflightGateway()`, called at the top
   of live_agent's async main). GET `/v1/models` with the service key; every
   model on the turn path (primary, escalate, actRetry, summarize, and each
   fallback rung) must be present or the process refuses to start (exit 2,
   same contract as the wq#1664 config guard: a restart cannot fix it).
   Off-turn-path models (vision, persona) only warn. GET `/key/info` and log
   the key's spend / max_budget so a nearly-spent key is visible in the boot
   log. A *network* failure or 5xx from the gateway is a warning, not a
   refusal — refusing to boot on a transient outage would turn it into a
   crash loop; the rung ladder already survives a down gateway.
   `LPP_BRAIN_PREFLIGHT=0` skips it (probes, stub gateways).

The other page for the same outage — `brain.ts`'s own `isis_alert` when the
primary stops serving turns — reaches Frank by a different route, and only since
wq#2389 reached him at all: see `docs/ISIS_ALERT.md`.

## Probes

- `src/probe_brain1660.ts` (pure, stub gateway; in `scripts/probes-pure.sh`):
  401 dead-marks a rung after ONE request; 429 does not; all-rungs-4xx throws
  `BrainUnreachableError`; the recheck window re-probes; preflight refuses on
  a missing ladder model and tolerates a dead gateway.
- `tools/test_stuck1660.py` (in `scripts/probes-stuck.sh`): fresh signal file
  preempts a FIGHT_LOSS_LOOP-shaped warp history; stale signal does not; aq
  upsert bumps count on repeat and targets a scratch `AQ_DB`.
