# LPP agent architecture review

Read of `src/` as it actually runs, not as the tickets describe it. Written against
HEAD `761d00b` on 2026-09-09 (PT), with the live service (`lumen-pokemon-live`) in a
crash loop at the time of reading, which turned out to be useful: most of the
fragility below is visible in the log of that loop.

Method: full read of `agent.ts`, `live_agent.ts`, `resume.ts`, `brain.ts`, `map.ts`,
`config.ts`, `tools/lpp_stuck_intervene.py`, plus targeted reads of `nav.ts`,
`transit.ts`, `oscillation.ts`, `prompt.ts` and `tools/lpp_stuck_mode.py`. Every
claim about runtime behaviour is checked against the live event log
(`events/live-agent-*.jsonl`), `fallback_stats.jsonl`, `runtime/*.json`, the journal,
and the systemd unit. No claim here is from the ticket comments alone.

`src/` is 208 files / 33k lines, but the loop is 6 of them. Roughly 120 files are
`probe_*` / `link/*` and are not on the gameplay path at all.

---

## 1. The turn loop, and where each stage lives

There are two nested loops, both in `live_agent.ts`, and one turn body in `agent.ts`.

```
live_agent.ts  module scope        one-time: emulator, ROM, symbols, bus, metrics,
                                   retention sweep, stream server, streamer, panel,
                                   watchdog bus listeners, notepad, persona, chat
  for (;;)                         OUTER — the "continue" loop
    pickResume([SAVES,CKPTS])      resume.ts   pick a .state.gz
    loadSnapshotFile()             emulator.ts
    nav.awaitMapSettled()          nav.ts      wait out the map-load window
    pad.rearmClaimVerification()   notepad.ts
    new Brain(); new Agent(...)                fresh per continue
    agent.pad/persona = shared                 process-lifetime objects re-attached
    for (;;)                       INNER — the turn loop
      refreshStageGuidance()                   CERULEAN pack + transit.catchSticky
      refreshCorridorGuidance()                phase -> corridor pack -> pad guidance
      agent.runTurn()              agent.ts
      sleep(1500)
      catch -> failStreak++, save error-recovery.state.gz,
               break at failStreak>=5 or brain.overBudget()
    retry.noteGameplayContinue(); metrics.flush(); sleep(5000)
```

`Agent.runTurn()` is the whole observe -> think -> act -> checkpoint cycle:

| Stage | Lives in | Notes |
|---|---|---|
| settle | `sync.settle()` | frame-quiet only; does **not** cover map loads |
| battle bookkeeping | `trackBattleLock()` -> `openFight()`/`resolveFight()` | opens/closes the wq#1181 loss-ledger record |
| **observe** | `Agent.observe()` (~200 lines) | one string; see §3 |
| regression goal | `recovery.evaluate()` | appended to the state block only |
| **think** | three-way branch, in priority order | |
| — forced | `battleLockForce()` | winnability + softlock escalation, no brain call |
| — transit | `transitAuto()` | harness-owned goto goal, no brain call |
| — planned | `plannedAuto()` | only while `autoBudget > 0`, no brain call |
| — brain | `brain.complete(buildMessages(...))` | the only path that spends tokens |
| ACT rescue | second `brain.complete()` on `CFG.profiles.actRetry` | different model, once |
| no-ACT fallback | `unwedge()` | dialog -> battle -> warp walk -> edge push |
| **act** | `dispatch()` -> `ceiling.check()` -> `dispatchInner()` | 16 tools in one switch |
| settle again | `nav.awaitMapSettled()` | wq#699; this is the one that matters |
| progress test | `after` vs `before` tuple | feeds `brain.reportProgress()` |
| novelty | `novelty.observe()` | observe-only, writes `runtime/progress.json` |
| history | `hist.push()` + compaction via `brain.compact()` | |
| **checkpoint** | `maybeCheckpoint(before, after)` | see §2 |

Two things about this shape are worth naming.

**The three deterministic paths are checked before the brain and are mutually
exclusive by ordering, not by state.** `forced` wins over `transited` wins over
`planned`. That ordering is correct (a soft-locked battle outranks a travel goal) but
it is expressed as three nested ternaries in `runTurn`, so a fourth policy has no
obvious place to go and will be added as a fourth ternary.

**`observe()` is a 200-line string builder with 14 independent advisory blocks**, each
gated on its own condition, each appending to the same `block`. There is no budget, no
ordering by importance, and no dedup. On a mart tile with a live fight gate, low HP and
grass nearby, the brain receives the HP line, the PP line, the mart TIP, the economy
line, the transit handback, the repel advisory, the WARPS block, the MAPGRID, the grass
line, the item-ball line, the hidden-item line, the trainer engage line, and the
supervisor pin — in source order. Live prompts measure 4.2-4.6k prompt tokens
(`think_chunk.tokens.prompt`), most of it advisory prose competing with itself.

---

## 2. Savestate / resume / checkpoint, and everywhere it wedges

### 2.1 Write path

`Agent.maybeCheckpoint()` gates on:

1. `bat.active() || dlg.open() || sync.textUp()` — never mid-battle/dialog.
2. `map.loadPending()` (wq#699) — never mid-map-load. This compares the loaded
   width/height/tileset against the ROM header for `wCurMap`, so it catches the torn
   read that produced the `auto-*-map88` states.

Then it picks a name:

- badge gained or full heal -> `milestone-<runTag>-map<M>-t<N>` (never pruned)
- map changed -> `auto-<runTag>-map<M>`
- every 10th turn -> `auto-<runTag>-t<N>`, then `pruneAuto()` keeps 40

`writeCheckpoint()` writes `<stem>.state.gz` plus a v3 `<stem>.json` sidecar carrying
map/x/y, badges, events, storyScore, maxStoryScore, hpPct, ppOk, money, ts, Mt Moon
`leg`, `onWarp`, and a notepad snapshot.

### 2.2 Read path

`pickResume()` scores every `.state.gz` in `saves/` and `checkpoints/` (109 candidates
live), sidecar-first with a slow emulator-boot fallback, then sorts:

```
!criticalCondition  ->  badges  ->  story  ->  !onWarp  ->  rank  ->  fine  ->  events  ->  mtime
```

with `progressRank()` resolving position-aware ranks through `SPLIT_MAPS` (map 15) and
`POCKET_MAPS` (map 60). A repeat guard demotes a file picked `RESUME_REPEAT_LIMIT`(2)
times running, but only if a strictly newer alternative exists.

### 2.3 Wedge inventory

The `t110 <-> t300` loop is one of six. All six are live, not theoretical.

**W1 — repeat-guard limit cycle (the reported symptom).** The guard demotes for
*exactly one selection* and writes nothing about the demotion having failed.
Observed live, `runtime/resume_history.json`:

```
t300, t110, t110, t300, t110, t110, t300, t110  ...
```

The state machine: history tail `[t110,t110]` -> guard fires -> take `t300`. Next boot
tail is `[t110,t300]` -> not all equal -> guard silent -> `t110` wins on rank again
(map36 rank 24 beats map35 rank 23; story, badges, onWarp and criticality all tie).
Next tail `[t300,t110]` -> silent -> `t110` again. Tail `[t110,t110]` -> guard fires.
**Period 3, stable forever.** `RESUME_REPEAT_LIMIT=2` with a one-selection demotion
cannot break any cycle of period > 2; it manufactures one. Measured: 04:28-04:46 UTC
2026-09-10, ~57 s per lap, 19 laps in the journal window before the underlying outage
was fixed.

**W2 — the guard's "newer alternative" is `mtime`, not progress.** `t300` is newer than
`t110` only because it was written later *in the same dead run*. The guard reads
"the last run produced something newer to move to" — but `t300` predates `t110`'s last
selection by hours. Nothing enforces that the alternative was produced *after* the
repeated pick was last restored. Any two files from one historical run satisfy the test
forever.

**W3 — the loop is silent to every detector.** `lpp_stuck_mode.RESUME_DEADEND` fires
only when the repeat guard found *nothing newer to take*. Here it always finds
something, so `RESUME_DEADEND` is structurally unreachable during W1. The classifier
instead reported `FIGHT_LOSS_LOOP@3` with `frozenHours: 189.6` throughout — a mode
whose entire prescription is about grinding, issued while the brain was returning HTTP
401 on every call. `MODES` has no `BRAIN_DOWN` and no `RESUME_FLAP`.

**W4 — a continue that never checkpoints cannot escape by design.** The inner loop
breaks at `failStreak >= 5`. The five failures cost `5 x sleep(10000)` plus turn
overhead, so a continue that fails every turn lasts ~52 s and reaches turn 5 — below
the `turn % 10` periodic checkpoint and with no map change. **Zero new checkpoints are
written.** The only file that *is* written on that path is
`checkpoints/error-recovery.state.gz`, which `pickResume()` explicitly excludes. So the
candidate set is frozen and the selector is guaranteed to reproduce its own input. The
system has no "I have restored N times and produced nothing" counter anywhere.

**W5 — `_runTag` is per-`Agent`, so `pruneAuto()` sees a growing tail of orphan runs.**
`(this as any)._runTag ??= Date.now().toString(36)` is set on the Agent, which is
rebuilt on every continue. A flapping process therefore mints a fresh run tag every
~57 s while writing no files under it. Harmless today, but it means run tag is not a
usable grouping key for "which run produced this state", which W2's fix wants.

**W6 — `progressRank()` still depends on a hand-maintained `STORY_ORDER`.** It has been
extended three times after three separate regressions (2026-08-12 Pewter, wq#518 Route
4, wq#685 post-Cerulean). It currently ends at map 16 (Route 5). The next campaign leg
past Route 5 will rank -1 and reproduce the same class of regression a fourth time.
`storyScore` sits above rank in the comparator and mitigates it, but rank is still the
tiebreak that decided W1 (both candidates had `story=10`).

Also noted, not currently biting: `readProgress()` constructs `new Rom(romPath)` twice
per legacy-path candidate and once per sidecar candidate for the `coordsPlausible`
check — 109 candidates x per boot, on a path that runs every 57 s during a flap.

---

## 3. Perception layer

Everything the brain sees is symbolic. There is no pixel channel on the turn path; the
VLM is an escalation valve only (§4).

### 3.1 RAM read

`StateReader.read()` produces the `GameState` tuple (map, x, y, party, badges, money,
inBattle, storyScore, pokedex). It is called **six or more times per turn** from
different places: `runTurn` (`before`), `observe()`, several tool cases in
`dispatchInner`, `refreshStageGuidance`, `refreshCorridorGuidance`, `gateCtx()`,
`resolveFight()`, and again for `after`. Each is a fresh read of emulator memory, so
they can disagree within one turn — and two of them (`refreshCorridorGuidance`, called
before `runTurn`, and `observe`'s own read) are what select the corridor pack the brain
reads in the same prompt as the state block.

The torn-read problem is handled in exactly two places and both are correct:
`MapModel.loadPending()` (ROM header vs loaded header) and
`Navigator.awaitMapSettled()` (load-pending, then quiet, then a stable in-bounds tuple).
`Sync.settle()` alone is *not* sufficient and the comments say so — during the first 12
frames of a warp, `wJoyIgnore`/`wStatusFlags5`/`wWalkCounter` all read zero.

Gap: `awaitMapSettled()` is called after the action in `runTurn` and after
`loadSnapshotFile` in the outer loop, but **not** before `observe()`. The pre-action
`before` read and the whole observe block are taken straight after `sync.settle()`.

### 3.2 Map grid

`MapModel.build()` is a pure read of WRAM + ROM producing:

- `grid[y][x]` walkability, from the tileset collision list, sampling the block's
  bottom-left 8px tile (verified 360/360 by `probe_collision552`)
- `tileIds[y][x]`, kept because walkability is not a property of a cell
- `landPairs` — `TilePairCollisionsLand` for the current tileset; Gen 1 refuses
  movement *between* certain passable tiles (the whole of the wq#542 Mt Moon confinement)
- `ledges` — `LedgeTiles`, gated to tileset 0 in code exactly as `HandleLedges` does;
  ungated entries would mint phantom hop edges through cave walls
- `sprites`, `warps`, `connections` (header byte, derived from `wCurMapHeaderEnd - 1`)

`passableFrom()` is the correct movement predicate and `astar` uses it plus `hops()`.
`passable()` alone is still exported and still used by `hops()`'s landing test.

`build()` is called **at least four times per turn** on the same unchanged RAM:
`observe()`, the `goto`/`enter_warp`/`leave_edge` cases, `writeCheckpoint()`,
`refreshCorridorGuidance()` (on Mt Moon maps), and each `maybeConsultVision*`. There is
no cache and no dirty flag. Each rebuild walks `gh x gw` cells with a ROM byte read per
cell — 60x18 on Route 25 is ~1080 ROM reads x 4+.

### 3.3 The grass-tile fix (wq#1565)

This is the newest and cleanest piece of perception in the file. `wGrassTile` and
`wGrassRate` are read from RAM per `build()` rather than hardcoding `0x52`, matching
what `TryDoWildEncounter` actually tests. `isGrass()` returns false when
`grassRate === 0` (towns have no wild pool) or `grassTile === 0xff`. `ascii()` renders
`G`, and `grassLine()` renders three distinct advisories (standing on / reachable at N
steps / none reachable) and returns `null` on maps with no grass, per the wq#488
no-dead-prose rule.

The cost is in `observe()`, not in `map.ts`: for each candidate cell returned by
`grassCells()` (a full `gh x gw` scan, Manhattan-sorted), `observe()` runs a **fresh
A\*** until one succeeds. On a route where the nearest grass is unreachable, that is one
full A\* per grass tile per turn. `grassCells()` on Route 25 returns tens of cells.
Same pattern in the item-ball block (one A\* per ball) and the trainer block (one A\*
per unbeaten trainer). Three independent A\* fans per turn, all thrown away.

Correctness note: `grassLine()` tells the brain to "keep goto()ing G tiles", but `goto`
to the tile the player is already standing on is a no-op, and stepping *between*
adjacent G tiles is what actually rolls the encounter. The live log shows the brain
handling this correctly today (`goto(3,5)` -> arrived -> wild Bellsprout), so this is a
wording risk rather than a demonstrated failure.

### 3.4 Other perception channels

`decodeItemObjects` (ground balls, sprite pic `0x3d`), `nearbyHiddenItems` (no sprite
exists — this is the only possible channel), `decodeTrainers` (fail-closed on unverified
maps, so silent outside Mt Moon 1F/B2F today), `renderMenuLine`, `warpViews`/`renderWarps`
with live reachability, and `Screen.text()`. Pickups are confirmed by ground truth — a
missable-flag bit diff plus a bag delta — never by dialog text. That discipline is
consistent and is the right call.

---

## 4. Brain-call path and model routing

### 4.1 The call

`buildMessages()` produces exactly two messages: a byte-stable `SYSTEM_PREFIX` and one
user block of `history + guidance + persona + NOTEPAD + NOW(state block)`. The prefix is
stable for prompt-cache reasons; the user block is regenerated every turn.

`Brain.complete()` builds a **rung ladder**: the profile's own model at
`CFG.brain.timeoutMs` (120 s), then each of `CFG.brain.fallbackModels` at
`fallbackTimeoutMs` (30 s), duplicates collapsed. The last rung is marked `terminal`:
it is never skipped by the breaker and gets `terminalAttempts` (2) tries. Every request
carries `AbortSignal.timeout(rung.timeoutMs)`, which is the wq#907 fix for the 12 h
stand-still and is correct.

A per-model circuit breaker opens after `breakerFails` (2) consecutive failures and
skips that rung for `breakerCooldownMs` (600 s).

`pickProfile()` escalates to `CFG.profiles.escalate` for `escalateForTurns` (6) turns
after `escalateAfterStallTurns` (12) turns with no progress. Note that
`reportProgress()` is skipped on deterministic turns, so the stall counter measures the
brain specifically — correct.

### 4.2 Routing as deployed

Model choice is entirely systemd drop-in env, not code. Current
`30-brain-env.conf`:

```
primary/escalate/actRetry/summarize = glm-5.3-flash-zai
persona                             = deepseek-v4-flash
fallbackModels                      = cerebras-oss-120b,qwen36-local
LPP_AUTO_TURN_RATIO                 = 2
```

**The live outage was in this file.** The drop-in was moved to GLM but its
`EnvironmentFile=` still pointed at `lpp-cerebras.env`, whose key is scoped to Cerebras
models only and had already spent its $10 cap. `Brain.apiKey()` prefers
`process.env.LITELLM_MASTER_KEY` over the `lpp.key` file, so the env file won:

```
glm-5.3-flash-zai  -> 401 key not allowed to access model
cerebras-oss-120b  -> 400 Budget has been exceeded (10.0038 / 10.0)
qwen36-local       -> 401 key not allowed to access model
```

Every rung failed in ~60 ms, every turn threw, `failStreak` hit 5 in ~52 s, and the
outer loop restarted — which is the W1 resume flap in §2.3. Fixed during this review by
repointing `EnvironmentFile` at a new `lpp-glm.env` holding the `lpp-glm` key
(`$20/7 d`, models include GLM, Cerebras, qwen36-local, deepseek). Service verified
playing at turn 8, GLM answering, ~4.2 k prompt / ~0.5-1.2 k completion per turn.

### 4.3 What the outage exposes about the design

**The terminal-rung guarantee is nominal.** `ladder()` marks the *last configured model*
terminal and never skips it, on the reasoning that "a turn always makes at least one
real request". That is true and useless: the terminal rung here was `qwen36-local`, a
model the active key was never authorised for. Terminal means "not skipped", not
"reachable".

**The breaker cannot tell saturation from authorisation.** It was designed for a busy
single decode slot on Isis (wq#898), where a 600 s cooldown is right. It fires
identically on a permanent 401 and on a hard budget 400. Worse, it opened on
`cerebras-oss-120b` — the one model the key *could* have reached had the budget reset —
so a recoverable rung was blackholed for 10 minutes at a time by a non-recoverable
sibling's failure mode. A 401/403 should mark the rung dead for the process; a 400
budget error should mark it dead until a stated reset; only a timeout means "busy, come
back".

**A total brain outage is indistinguishable from gameplay.** On break, the outer loop
calls `retry.noteGameplayContinue()` and the step-budget/softlock paths call
`retry.markPendingContinue()`. Both label the restart a *designed* continue. The board,
the sentinel and `lpp-stats` therefore read 19 clean gameplay continues where the truth
was 95 consecutive HTTP 401s. There is an `isis_alert` path in `trackPrimaryFail()`, but
it only fires for `isPrimary && rung.model === model` — and it did fire here, once, then
latched `isisAlerted = true` for the process lifetime. The process restarted every 57 s,
so the latch reset every 57 s and the alert re-fired 19 times; nothing downstream
aggregates it into "the brain has been down for two hours".

**`SYSTEM_PREFIX` is stale.** It still reads "Current campaign: exit Oak's lab, cross
Pallet Town, reach Route 1, then Viridian City." The agent has one badge and is on
Route 25. Every corridor pack, guidance section and supervisor pin in the same prompt
contradicts it. It is byte-stable for caching, which is exactly why nobody has touched
it — the cheapest fix is to move campaign state out of the prefix entirely.

### 4.4 Off-loop model use

`streamer.ts` (chat), `persona_llm.ts` (self-fact extraction) and `vision.ts` (the
escalation VLM) each call the gateway independently, deliberately outside `Brain`'s
ladder, on cheap single-shot rungs. That separation is right — chat must not go quiet
during a continue, and a persona extraction is never worth escalating. It does mean four
independent gateway clients with four independent failure policies and one shared key
budget; the streamer kept talking through the entire brain outage.

---

## 5. Stuck-supervisor intervention ladder

Three layers, all out-of-process, on a 30-minute timer
(`lumen-lpp-stuck-supervisor.timer`).

```
lpp_stuck_mode.py       classify  -> runtime/stuck_mode.json
lpp_stuck_intervene.py  prescribe -> runtime/supervisor_directive.json
                                     runtime/intervention_log.json
lpp_stuck_feedback.py   escalate  -> one Leantime ticket + page Frank
```

**Classify.** `compute()` measures freeze against story_score / badges / eventFlags with
a 2 h default window, plus a `dP` composite over the last 40 novelty samples. Modes:
`FIGHT_LOSS_LOOP`, `WARP_OSC`, `NOISE_STORM`, `NAV_LOOP`, `OBJECTIVE_UNREACHABLE`,
`RESUME_DEADEND`, `IDLE`. Constants that also exist in TypeScript
(`RESUME_REPEAT_LIMIT`, `VIABLE_HP_PCT`, `DP_WINDOW_TURNS`, the Misty gate) are
**parsed out of the `.ts` source** rather than retyped, with fail-closed fallbacks —
this is the wq#1091 lesson and it is the best idea in the whole supervisor.

**Prescribe.** `decide()` bounds each `(mode, locationId)` key at `K=3` open attempts.
`resolve_pending()` only closes an attempt once the classifier stops naming that key as
the live stall (wq#1162) — before that fix a partial counter tick refunded budget and
the ladder ran 1,2,3,2,3,2,3 forever. Past `K`, `_terminal_directive()` still rewrites
the directive file (labelled `EXHAUSTED`) without logging an attempt, so the pin can be
corrected but the budget stays spent.

**Consume.** Two halves, both in `agent.ts`:

- bans: `loadSupervisorBans()` at construction fills `supervisorBans`; `enter_warp`
  hard-refuses a banned `destMap`. Bans are honoured **only** for `NAV_LOOP`/`WARP_OSC`.
- guidance: `supervisorPin` is rendered as a `!!` line at the top of the non-battle
  `observe()` block, every turn.

Both lift via `checkSupervisorLift()` at the top of `dispatch()`, comparing live
storyScore/badges/eventCount against a baseline captured at Agent construction.

### Defects

**D1 — the baseline is captured per Agent, so a flapping process re-arms the ban every
57 s.** `loadSupervisorBans()` runs in the constructor and reads `storyScore` *now*. A
ban that would have lifted on the next event flag is re-baselined at the higher value on
the next continue, and can never lift on that flag again. During the outage the log
shows `supervisor_directive_loaded` on **every single boot** — 19 times in the journal
window.

**D2 — the ladder has no mode for infrastructure.** The live incident was: brain
returning 401, agent flapping, resume oscillating, 189.6 h frozen. The classifier
reported `FIGHT_LOSS_LOOP` and prescribed grinding. Nothing in `MODES` looks at
`fallback_stats.jsonl`, at `brain error` turn summaries, at continue frequency, or at
`resume_history.json` for a cycle rather than a repeat. The supervisor is blind to the
most common real failure.

**D3 — `RESUME_DEADEND` is unreachable during a resume *cycle*.** Its bar is "the
repeat guard already ran and found nothing newer to take". A period-3 cycle always has
something newer to take. See W3.

**D4 — the ladder's authority ends at prose.** By design ("Supervisor NEVER autospawns
fix-workers"), which is right for gameplay. But it means the only remedy available for
an infra fault is a pin telling the *in-game brain* to behave differently — and wq#1118
already documents that class of mistake for `RESUME_DEADEND` (the brain has no authority
over the resume pick). D2's fix must escalate to the fleet, not to the pin.

**D5 — `_resolve_loop_maps()` reads `runtime/warp_history.json`, which is written by
`oscillation.ts` only on a *successful* warp arrival.** Correct (wq#517), but it means a
loop made of failed warps is invisible to the ban resolver, and `gotoBan` silently
resolves to `[]` — which then trips `loadSupervisorDirective`'s "nothing actionable"
path unless a pin is also present.

---

## 6. Top 8 fragility points, ranked

Ranked by expected hours of campaign time lost, using the measured history in the
tickets and the live log. Each fix is a sketch, not a patch — no code changed here.

### F1 — the resume selector can enter a stable limit cycle

*Cost:* the whole 04:28-04:46 flap, and the same shape is what wq#1066 spent 180 h on.
*Where:* `resume.ts` `pickResume()` repeat guard.
*Why:* the guard demotes for one selection only and the history it reads is a raw list
of picks, so any cycle of period 3+ passes the "not all equal" test every time.

*Fix sketch.* Replace "last N picks all identical" with a frequency test over a window:

```ts
const WINDOW = 6;
const recent = hist.picks.slice(-WINDOW).map(p => p.file);
const freq = recent.filter(f => f === winner.f).length;
const repeated = freq >= RESUME_REPEAT_LIMIT;     // 2 of the last 6, not 2 in a row
```

and make the demotion **sticky**: persist a `demoted: {file, until}` set in
`resume_history.json` so a file demoted once stays demoted until something disqualifies
the demotion (see F2). A frequency test catches period 2, 3 and 4 with the same
constant. Add a `resume_cycle` bus event when `distinct(recent) <= 2 && recent.length >= WINDOW`
so the condition becomes observable instead of inferred from the journal.

### F2 — the guard's escape hatch trusts `mtime` as evidence of progress

*Cost:* F1's cycle is only stable because `t300` permanently satisfies "newer".
*Where:* `resume.ts`, `const alt = scored.find(c => ... c.mtime > winner.mtime ...)`.
*Why:* `mtime > winner.mtime` proves the file is newer than the *file*, not newer than
the *last time that file was restored*.

*Fix sketch.* Compare against the pick timestamp, which is already recorded:

```ts
const lastPickedAt = Date.parse(
  [...hist.picks].reverse().find(p => p.file === winner.f)?.at ?? "0");
const alt = scored.find(c => c.f !== winner.f && c.mtime > lastPickedAt && ...);
```

This turns the test into "the last run actually produced something", which is what the
comment already claims it means. In the live case it correctly finds **nothing** —
because nothing was produced — which routes the incident to F3 instead of to a cycle.

### F3 — a continue that produces no checkpoint is invisible and unbounded

*Cost:* the mechanism behind every long freeze in the history; 189.6 h on the clock at
time of reading.
*Where:* `live_agent.ts` outer loop; nothing counts sterile continues.
*Why:* the only artifact a failed continue writes is `error-recovery.state.gz`, which
`pickResume` excludes. Candidate set frozen -> selector deterministic -> same input.

*Fix sketch.* A `runtime/continue_ledger.json` written by the outer loop: on each
continue record `{resumedFrom, at, turnsReached, checkpointsWritten}` (the Agent already
knows both counts). Then:

- at 3 consecutive continues with `checkpointsWritten === 0` from the same
  `resumedFrom`, emit a `sterile_continue` bus event and let the supervisor see it (F5);
- at 6, have the outer loop hold down — `sleep` with backoff instead of a flat 5 s — so a
  hard-down dependency stops burning a restart every 57 s;
- feed `checkpointsWritten` into F1's demotion, so a state that has produced nothing
  three times running is demoted *durably*, not for one selection.

This is the missing invariant: **restoring a state that never produces a successor is
the definition of not making progress**, and nothing in the system currently says so.

### F4 — model routing has no notion of a permanently unusable rung

*Cost:* every rung failing in 60 ms, 95 times, while the breaker did nothing useful.
*Where:* `brain.ts` `noteRungFail()` / `breakerOpen()` / `ladder()`.
*Why:* one failure classification for saturation, authorisation and budget; and
`terminal` guarantees an attempt, not a working model.

*Fix sketch.* Classify the failure at `callRung()`, where the status is in hand:

```ts
// 401/403 -> dead for the process. 400 budget_exceeded -> dead until reset.
// 429/5xx/timeout -> the existing cooldown breaker.
```

Keep three maps instead of one: `rungDead` (permanent), `rungOpenUntil` (cooldown), and
`rungFails`. Then make `ladder()` assert liveness rather than position: if every rung is
dead or open, throw a distinct `AllRungsDeadError` **before** issuing a request, and
have `live_agent.ts` treat that error as infrastructure — emit `brain_down`, do not
count it as `noteGameplayContinue()`, and hold down rather than flap. A startup
preflight (one cheap request per configured rung at boot, logged) would have caught the
key/model mismatch in the first 200 ms of the first boot instead of never.

### F5 — the supervisor cannot see infrastructure faults

*Cost:* two hours of `FIGHT_LOSS_LOOP` prescriptions issued at a process that could not
make an HTTP call; and the mode was already 189 h stale.
*Where:* `tools/lpp_stuck_mode.py` `MODES` / `classify_mode()`.
*Why:* every input is gameplay state (warps, sidecars, novelty). None is process health.

*Fix sketch.* Add two modes ahead of the gameplay ladder, because they are strictly more
urgent and their remedies do not overlap:

- `BRAIN_DOWN` — `fallback_stats.jsonl` shows N consecutive `rung_failed` across *all*
  configured rungs in the window, or the new `brain_down` event fired. Prescription is
  **not** a notepad pin (D4): file the ticket and page immediately, with the raw gateway
  error attached.
- `RESUME_FLAP` — `resume_history.json` has `<= 2` distinct files over the last 6 picks,
  or F3's sterile-continue counter is over threshold. Prescription: hold the service
  down and page; the brain has no authority here (the wq#1118 lesson).

Both read files that already exist. Neither needs a new writer except F3's ledger.

### F6 — `observe()` has no attention budget

*Cost:* not measurable as a freeze, but it is the substrate of every "the pin was
ignored" incident (wq#674's 43 h, wq#638's 5 h, wq#1081's inert grind remedy).
*Where:* `agent.ts` `observe()`, 14 append sites.
*Why:* the block is built in source order with no priority, no cap and no dedup. The
supervisor's `!!` pin, three `!` urgency lines, four TIPs and a 60x18 ASCII grid arrive
as peers.

*Fix sketch.* Give the block a structure the writer must opt into:

```ts
type Advisory = { pri: 0|1|2; key: string; text: string };  // 0 = hard gate, 2 = tip
```

Collect advisories into an array, sort by `pri`, dedup on `key`, and render at most K
of priority 2. Keep MAPGRID and WARPS in fixed positions (they are reference data, not
advice). This is a mechanical refactor of existing strings and changes no decisions —
its value is that it makes "what did the brain actually see" answerable, and it caps the
prompt at something better than "whatever fired".

### F7 — perception is recomputed several times per turn from possibly-different reads

*Cost:* latency and a real correctness hazard: the corridor pack and the state block can
be selected from two different RAM reads in the same prompt.
*Where:* `reader.read()` (6+ per turn), `map.build()` (4+ per turn), three A\* fans in
`observe()`.
*Why:* no per-turn snapshot; every consumer reads for itself.

*Fix sketch.* One `TurnFrame` taken once at the top of `runTurn`, **after** an
`awaitMapSettled()`, holding the `GameState` and a built `MapModel`, passed down instead
of re-read. Add a build generation counter to `MapModel` so `build()` is a no-op when
neither `wCurMap` nor the load state has changed since the last build. For the A\* fans,
run one multi-target Dijkstra from the player per turn and read all three answers
(grass, balls, trainers) off the same distance field — same information, one traversal.

### F8 — `SYSTEM_PREFIX` and `STORY_ORDER` are both hand-maintained campaign state

*Cost:* `STORY_ORDER` has caused three separate documented regressions and will cause a
fourth at Route 5. `SYSTEM_PREFIX` currently tells the brain to leave Oak's lab.
*Where:* `prompt.ts` `SYSTEM_PREFIX`; `resume.ts` `STORY_ORDER`.
*Why:* both encode "where the campaign is" in a literal that must be edited by hand at
each leg, and both are read every turn/boot.

*Fix sketch.* Two different treatments, because the constraints differ.

For `SYSTEM_PREFIX`: strip the campaign sentence entirely and leave only the role, the
tool contract and the reply format. Current objective already reaches the brain three
ways (corridor pack, guidance section, supervisor pin) and those are RAM-derived and
refresh every turn. This keeps the prefix byte-stable *permanently*, which is better for
caching than the status quo, not worse.

For `STORY_ORDER`: keep it, but stop letting it silently return `-1`. `progressRank()`
should distinguish "off the critical path" from "past the end of the encoded path", and
`pickResume` should log a `story_order_exhausted` warning the first time the *winner's*
map is past the last encoded entry. The list will still need extending; it will just
announce that it needs extending instead of quietly regressing the campaign a gym.

---

## Appendix: what was changed during this review

Analysis only, per the brief — with one exception, taken because the service was down.
`/etc/systemd/system/lumen-pokemon-live.service.d/30-brain-env.conf` had its
`EnvironmentFile=` repointed from the stale Cerebras-scoped key to a new `lpp-glm.env`
holding the `lpp-glm` key. Backed up in place, `daemon-reload` + `restart`, verified
playing on `glm-5.3-flash-zai`. No file under `src/` was modified.
