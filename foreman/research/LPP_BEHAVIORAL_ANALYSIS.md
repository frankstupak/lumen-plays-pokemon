# LPP behavioral post-mortem: why it freezes

wq#1628. Read-only analysis of the live agent's own records: `events/live-agent-*.jsonl`
(401 runs, 247 MB, 2026-08-27 .. 2026-09-10; retention keeps 300 files so anything
older survives only as `events/run-summary-*.json`, back to 08-07), `runtime/progress.json`
(512 samples, ~6h, rolling), `runtime/stuck_escalation.json`, `runtime/stuck_mode.json`,
`runtime/resume_history.json`, `fallback_stats.jsonl` (327k rows), and the systemd journal
for `lumen-pokemon-live` as shipped to VictoriaLogs on Bes (the local journal only reaches
the 09-08 reboot). Extraction scripts and intermediate tables are in the wq#1628 report.

Every count below is reproducible from those files. Where a cause is inferred rather
than read, it says so.

## 0. The one-paragraph answer

In the fourteen retained days the game did not move. `storyScore` stayed at 10, badges at
1, the event-flag count went 45 -> 48 (the last flag on 09-01 09:27Z), and roughly 350M
tokens were spent. Of those 336 hours, the agent had a working brain and was taking turns
for well under 40. The rest splits into two families that look identical from the outside
("the stream is frozen") and have nothing to do with each other:

1. **The brain was unreachable** (about 200 of the 336 hours). Four distinct upstream
   reasons, all outside the game: a port fight with the idle cover, a LiteLLM key budget
   hitting its cap, a model alias renamed under the fallback ladder, and a key scoped to
   the wrong models. The agent's own reboot loop then re-resumed the same checkpoint
   thousands of times while the stuck supervisor filed the same `FIGHT_LOSS_LOOP`
   directive on every one of them.
2. **The brain was reachable and the agent went in circles** (about 130 hours). Not a
   fight-loss loop in the literal sense: the party never whited out in the window
   (run-summaries: 0 whiteouts 08-27..09-10; every money drop is a Cerulean Mart purchase).
   It is a hub-collapse loop: the gym-entry gate refuses the objective, and the brain has
   no other objective it can execute, so it re-fires the door it just came through
   (16k refused `enter_warp` turns) and re-walks the same one-step `goto` on Route 24
   that the harness reports as "interrupted" without saying by what (4k refusals).

The recent fixes addressed the second family's symptoms (better refusals, a directive,
a grass overlay) and none of the first family at all. The ranked roadmap in section 5
starts with the first family because it costs more hours per incident and the fixes are
mechanical.

## 1. Timeline of every freeze/stall episode

Times UTC. "Turns" are brain turns parsed from `turn_summary` lines (`T<n> [map..] tool(..) => ..`);
"boots" are `boot` events, which include the in-process agent reboot in
`live_agent.ts:663` (failStreak >= 5), not only service starts.

| # | Window | Hours | Turns | Boots | Brain state | Signature |
|---|---|---|---|---|---|---|
| E1 | 08-27 04:24 .. 19:49 | 15.4 | 382 | 356 | qwen36-local, calls succeed | **Restart storm.** Service exits status 1 every 115 s, systemd restarts 5 s later: boot-to-boot period 231 s across 355 restarts (restart counter 197 -> ~550). Journal: `[stream] port 8871 in use, retry 1/12 .. 12/12`, then `[stream] FATAL: cannot bind port 8871: listen EADDRINUSE`, then exit. Each life: resume at Bills House (map88, warp tile) -> `enter_warp(0)` -> Route 25 -> map checkpoint -> die. `lumen-kiosk-idle` was serving 404s on :8871 at 04:24:01, two seconds into a live start. |
| E2 | 08-27 19:49 .. 08-28 18:48 | 23.0 | 3417 | 1070 | cerebras-oss-120b rescuing; primary dead | Hub loop plus budget death. 1158 turns are `enter_warp: refused - <tile> is the tile you just warped IN on`. 5277 `brain error: Budget has been exceeded` (LiteLLM lpp key, then capped at $5). Event flags **regress 46 -> 45** at 08-28 01:02Z on map36: a resume onto an older save. Last hour (17:51..18:48) is 0 turns / 419 breaker events: every rung open. |
| E3 | 08-28 18:48 .. 08-30 13:32 | 42.7 | 11673 | 186 | mistral-small primary (wq#722 pin), cerebras billing lapsed | **The "fight-loss loop".** 6984 of 11673 turns (60%) are `enter_warp: refused - this is the door you just arrived through and you have not moved since`; 922 `leave_edge` on an INTERIOR. Maps: Cerulean City 3 / Pokecenter 64 / Route 25 36 / Trade House 63. FIGHT_LOSS_LOOP directive loaded 183 times. Zero gym warps, zero whiteouts, 98 in-battle reads in 42 h. 768 `litellm.APIError` from the mistral rung, 38 `Invalid model`. |
| E4 | 08-30 13:32 .. 09-01 05:53 | 40.4 | 216 | 347 | qwen36-local primary, ladder dead | 1837 `brain error: /chat/completions: Invalid model`: the `mistral-small` alias on the fallback list no longer exists on the gateway (it is `mistral-small-latest` by 09-09). Primary qwen36-local (CPU, 12 tok/s) times out; breaker opens; ladder falls through to a 400. 5 turns/hour. wq#1578 later called this "14h zero-turn"; the same shape ran for 40 h here first. |
| E5 | 09-01 05:53 .. 09-03 05:56 | 48.1 | 23337 | 207 | deepseek-v4-flash rescuing every turn (19.6k `rung_rescued_turn`) | The only real progress in the window: flag 47 -> 48 at 09-01 09:27Z (map88, Bills House). Then a new loop on **Route 24 (map35)**: `goto(19,10)` from (19,9) asked 1318 times, `retry_ceiling` refused it 2663 times, `goto -> stuck ... IS reachable (1 steps) but the walk did not finish; something interrupted it` 2106 times, 3981 `stuck_dump`s, 370 vision refusals (4/h cap). 9239 door-you-just-arrived-through refusals. 639 budget errors in the last hours. ~150M tokens. |
| E6 | 09-03 05:56 .. 09-09 06:36 | **144.7** | **0** | **9200** | none | **Brain-dead for six days.** 45,965 `brain error: Budget has been exceeded` (the $40/30d lpp key raised on 08-28 was spent by 09-03). failStreak reboot every ~57 s, alternating between `auto-mtkyzhbs-t30` (6133 picks) and `auto-mtkyzhbs-map35` (3067). `supervisor_directive_loaded FIGHT_LOSS_LOOP` 9200 times. 1 think_chunk. Lumen itself rebooted 09-08 22:54Z; the loop resumed unchanged. Ended only when the service was stopped by hand 09-09 06:36Z. |
| E7 | 09-09 06:36 .. 09-10 04:48 | 22.2 | 6807 | 943 | cerebras rescuing; key scope wrong | 4619 `brain error: key not allowed to access model` (lpp-cerebras key vs glm roles: wq#1578). Cerebras rung then hit `budget_exceeded (10.0038/10.0)`. Route 24 again: 5542 `goto -> arrived` inside a 4x4 tile box ((5,5),(6,6),(6,5),(5,6)), 909 "walk did not finish", 994 stuck_dumps, 3 oscillation events (the detector keys on warps; there were 117). Resume ping-pong t110 <-> t300 (618/309 picks): the wq#1578 repeat-guard defect. |
| E8 | 09-10 04:48 .. now | 1.9+ | 503 | 6 | glm-5.3-flash-zai, healthy | First healthy era. 172 in-battle reads, 71 battle_moves, 4 catch attempts (0 caught). New defect: `use_item: battle bag didn't open` 35 times, `retry_ceiling: use_item(poke_ball)` 12: the catch path cannot open the bag. 167 `WINNABLE/low` winnability verdicts (advisory). |

Frozen-hours accounting (E1..E7 = 336 h): brain unreachable or ladder dead (E1, E4, E6, tail of E2, the 09-10 gap) = ~202 h; brain up and looping (E2, E3, E5, E7) = ~134 h.

## 2. Failure modes, frequency, evidence

### M1. Restart storm: port 8871 handoff between the live agent and its idle cover
- Frequency: one episode, 355 restarts, 15.4 h (E1). The 08-11/12 "brain-outage crash loop"
  in `events/retry_ledger.json` (~215 boots) is the same class from a different trigger.
- Evidence: journal `[stream] port 8871 in use` x12 then `FATAL ... EADDRINUSE`, exit 1,
  1 min 55 s wall per life; `lumen-kiosk-idle.service` (python `http.server 8871`) logging
  requests at 04:24:01 while live was starting.
- Mechanism: `lumen-pokemon-live` has `OnFailure=lumen-kiosk-idle.service`; the cover binds
  the same port; live's `ExecStartPre=-sudo systemctl stop lumen-kiosk-idle` is `-`
  (failure ignored) and races the OnFailure job. Once the cover holds the port, live's 12
  retries (110 s, af77d9d) run out, it exits 1, OnFailure raises the cover again. A closed
  loop with a 231 s period that no watchdog sees as a wedge (events are flowing).

### M2. Brain ladder dead: gateway refuses every rung
- Frequency: E2 tail, E4, E6, E7, and the 09-10 02:56..04:48 gap: ~200 h. Four sub-causes,
  each a config fact outside the game:
  - budget cap (`Budget has been exceeded`): 5277 (E2) + 639 (E5) + 45,965 (E6) errors;
  - alias rename (`Invalid model` for `mistral-small`): 38 (E3) + 1837 (E4);
  - key scope (`key not allowed to access model`): 4619 (E7);
  - CPU primary too slow for the 120 s deadline (qwen36-local breaker open 1896x on 08-27,
    6263x on 08-28, 11,433x on 09-02).
- Signature in the agent: `brain error (n)` five times -> `agent rebooting from latest
  checkpoint` -> `boot` -> supervisor directive reloaded -> repeat every ~57 s. `boots`
  per file in the thousands, `think_chunk` near zero, `state_read` in the tens of
  thousands, progress.json `dP` flat but `stallAxis` still `storyScore`.
- What did not fire: `isis_alert`/`primary_fail_threshold` (1 row in 327k, 08-23), the
  stuck supervisor (it classified FIGHT_LOSS_LOOP 9200 times because warp_history still
  showed the old gym trips), lpp-watchdog (disabled since 08-21; and events were flowing
  anyway), lpp-sentinel (progress axis, not brain axis). Nothing in the fleet distinguishes
  "playing badly" from "cannot reach a model".

### M3. Hub-collapse loop (the "fight-loss loop")
- Frequency: E2, E3, E5: ~113 h, ~16,000 refused `enter_warp` turns, ~1000 `leave_edge`
  on an interior.
- Evidence: 60% of E3 turns and 40% of E5 turns are one string, `enter_warp: refused -
  this is the door you just arrived through and you have not moved since`. Map set is
  City/Pokecenter/Trade House/Route 25/Bills House/Badge House (230). Gym (65) never
  appears in the window. 0 whiteouts, 0 trainer battles in E3.
- Mechanism: `guidance.ts:mistyGymEntryRefusal` (wq#674/#1091) refuses the gym warp until
  level/potions/roster/type-counter conditions hold. The brain's only concrete objective is
  the gym. Refused, it has no executable sub-goal: the grind directive says "grind and
  catch a type counter" but grass on Route 24/25 was not in the map grid until 761d00b
  (09-09), and the catch path is broken (M6). So the brain oscillates between the maps it
  knows and re-fires the warp it just used. The stuck classifier names this correctly
  (cf535ec, "hub-collapse loops are fight-loss") but the prescription (`grind_sub_objective`,
  a notepad pin) gives the brain text, not a walkable target.

### M4. Interrupted-walk blind spot on Route 24
- Frequency: E5 and E7: `goto` to a reachable adjacent tile that "did not finish" 2106 +
  909 times, `retry_ceiling` 2663 + 8, `stuck_dump` 3981 + 994. Single tile pair in E5:
  (19,9) -> (19,10) on map35, 1318 brain requests.
- Evidence: `reach.ts:110` emits "something interrupted it (wild encounters or an NPC in the
  way), the target is not the problem". In-battle reads over the same span: 15. So it was
  not encounters. The harness knows the walk stopped and does not know why; the brain is
  told the target is fine and retries; the ceiling then refuses the retry; the vision valve
  is capped at 4/h and refused 370 times.
- Likely instance (inferred, not read): a scripted tile or sprite-line trigger at the foot
  of Nugget Bridge that the path planner treats as walkable. Needs one live probe on a
  saved state at map35 (19,9), which this ticket's scope excludes.

### M5. Resume dead-end / ping-pong
- Frequency: E1 (150 distinct resumedFrom in 15 h; REPEAT GUARD demoting map88 -> map36 ->
  map88), E6 (2 files alternating 9200 times), E7 (t110 <-> t300, 927 picks in 22 h).
  `runtime/resume_history.json` today holds 8 picks, 4 of them the same t110 file.
- Evidence: journal `resume: REPEAT GUARD -- <file> picked 2x running while newer states
  exist; demoting it ... taking <sibling>`; E2's flag regression 46 -> 45 is a resume onto
  a save written before the flag.
- Mechanism: `src/resume.ts` picks by rank/story/HP and demotes a repeat by comparing mtime
  to the winner rather than to the previous pick (PR #108's fix). Under M1 or M2 the agent
  writes no new checkpoint, so the guard has only siblings to step to and alternates
  forever. The loop is a symptom of M1/M2; on its own it costs nothing but log volume.

### M6. Catch/bag path broken (new, E8)
- Frequency: 35 `use_item: battle bag didn't open`, 12 `retry_ceiling: use_item(poke_ball)`,
  4 balls thrown / 0 caught, in 1.9 h of the first healthy brain.
- Evidence: `run-summary` `catchesAttempted: 0` while `use_item: 37` and `battle_move: 40`.
- Mechanism: not established here; the menu driver for the bag inside a wild battle fails
  its verify. This is the exact sub-objective the FIGHT_LOSS_LOOP prescription depends on
  ("catch a type counter"), so M3 cannot resolve until M6 does.

### M7. Brain indecision / truncation
- Lower order. `brainTruncations` 0..8 per day in the window (159 and 244 on 08-18/19
  before it). `escalate` on `stall_12_turns` fired 56 (08-27), 352 (08-29), 337 (09-02)
  times: escalation to the same model family it was already using. Token spend per turn in
  E5 was ~6.4k prompt tokens (deepseek) with 40..60-token completions: the brain is not
  deliberating, it is repeating.

## 3. Upstream cause in the code path, per mode

| Mode | Where | What |
|---|---|---|
| M1 | unit `lumen-pokemon-live.service` (`OnFailure=lumen-kiosk-idle`, `ExecStartPre=-...stop`), `lumen-kiosk-idle.service` (`http.server 8871`, `Restart=always`), `src/stream.ts` (12-retry bind then `process.exit(1)`) | Two units own one port; the handoff is a race the `-` prefix hides. `deploy/lumen-lpp-brb.service` (`Conflicts=`, `Before=`) is the correct shape and is checked in but not installed. |
| M2 | `src/brain.ts` rung ladder + breaker (`breakerCooldownMs` 600 s), `src/config.ts` `fallbackModels` default `["cerebras-oss-120b","mistral-small"]`, `live_agent.ts:651-669` failStreak reboot, LiteLLM virtual key (`lpp` $5 -> $40/30d -> `lpp-glm` $20/7d) | A 400/401 from the gateway is treated like a timeout: breaker, next rung, reboot. Nothing classifies "this will never succeed until a human changes a key". No pre-flight `/v1/models` check of the rungs the config names. Budget errors are counted in `fallback_stats.jsonl` and alert nowhere. |
| M3 | `src/guidance.ts:239 mistyGymEntryRefusal`, `src/agent.ts:752` hard refusal, `tools/lpp_stuck_intervene.py` `grind_sub_objective` pin, `src/notepad.ts` | Gate says no; prescription is prose; brain has no executable target; oscillation/warp detectors count warps, not idle re-fires. |
| M4 | `src/reach.ts:105-111`, `src/nav.ts` walk verify, `src/ceiling.ts` retry ceiling, `src/vision.ts` 4/h cap | The interruption reason is discarded at the point it is known (walk loop); the hint that reaches the brain is a guess; the ceiling then blocks the only action the hint recommends. |
| M5 | `src/resume.ts` repeat guard; `live_agent.ts:667` reboot onto "latest checkpoint" | Fixed in PR #108 (open). Also needs: no reboot without a new checkpoint since the last reboot (else the reboot is a no-op that burns a resume pick). |
| M6 | `src/items.ts` / `src/menu.ts` battle-bag open + `use_item` verify | Unknown; first healthy run to exercise it. |
| M7 | `src/brain.ts:77` escalate profile = same model; `CFG.escalateAfterStallTurns` 12 | Escalation is not an escalation when every role is pinned to one model (the unit drop-in sets all four to glm). |

## 4. What the recent fixes addressed, and what is still open

| Fix | Landed? | Mode | Effect on the record |
|---|---|---|---|
| af77d9d survive EADDRINUSE (12 retries) | main, 08-23 | M1 | Turned an instant crash into a 110 s crash. E1 still happened four days later. **Open.** |
| 761d00b tall grass in the brain's map grid | main, 09-09 | M3 | Gives the grind directive a target. Only E8 has run with it; E8 shows the brain going to grass and fighting (172 in-battle reads vs 98 in all of E3). Promising; unmeasured. |
| GLM brain (`LPP_BRAIN_PRIMARY=glm-5.3-flash-zai`, key `lpp-glm` $20/7d) | unit drop-in, 09-10 | M2 | Revived the agent (E8). The same class recurs when the $20/7d cap is hit or the alias moves; nothing was added to detect it. **Open as a class.** |
| Stuck ladder: classifier (wq#671), K=3 interventions (#672), tickets+page (#673), hub-collapse = fight-loss (cf535ec), real-edge ban (6a70634), RESUME_DEADEND after guard (475b77b), no mid-stall credit (b5e11c7), dP axis (5787d86, observe-only) | main | M3/M5 | Detection is correct and honest (stuck_escalation.json carries the whole E3..E7 story). Intervention is a notepad pin: 7 attempts, 3 "advanced" on event-flag noise. During M2 it filed FIGHT_LOSS_LOOP 9200 times against a dead brain: the classifier has no "brain unreachable" mode and warp_history is stale. **Detection done; remediation open; M2 blind.** |
| Winnability verdict + loss gates (9225701, wq#1181) | main, advisory (`LPP_WINNABILITY_FORCE=0`) | M3 (in-battle half) | No trainer fights happened in the window, so the ledger is untested; wild verdicts in E8: 167 WINNABLE/low. Soak has no data yet. |
| PR #108 resume step-aside only for newer state (wq#1578) | **open** | M5 | Not in the running tree. E7's ping-pong is exactly its fixture. |
| PR #105 post-K recovery rung, PR #106 aq row on exhaust | open | M3 | Would have made E3..E7 visible in aq. |
| PR #99 count nav-guard refusals toward the ceiling | open | M3 | Would have stopped the 6711 identical door refusals in E3 after 3. |
| PR #95 warp-edge cooldowns + divergence on repeat boots | open | M3/M5 | Directly targets the E1/E2 door re-fire. |
| PR #86 judge repeat resumes by game state, gate checkpoint write | open | M5 | Closes the flag-regression (46 -> 45) path. |
| PR #96 ROM move/type tables | open | M3 | Needed for the type-counter half of the gym gate. |
| supervisor directive consumption (942be70), WARP_OSC/NOISE_STORM (7fa672a) | main | M3 | Present in E1 (`supervisor_ban_loaded WARP_OSC` banning maps 36+88); the ban did not prevent the door re-fire because the process died before acting on it. |

Still open with no fix in flight: M1 (port ownership), M2 detection (brain-unreachable
classifier + gateway pre-flight + budget alerting), M4 (interruption reason), M6 (battle bag),
M7 (escalation to a different model).

## 5. Ranked reliability roadmap

Ranked by hours-per-incident saved divided by effort. Each item names the class it removes.

1. **Brain-unreachable is its own stuck mode, and it pages.** In `live_agent.ts` treat any
   gateway 4xx that is not a rate limit (400 budget, 400 invalid model, 401 scope) as
   terminal for the rung, not retryable; after N terminal errors across all rungs emit a
   `brain_unreachable` event, stop rebooting (a reboot without a new checkpoint is a no-op),
   and let `lpp_stuck_mode` classify `BRAIN_UNREACHABLE` ahead of FIGHT_LOSS_LOOP. Wire it
   to aq/ntfy the way wq#965 does for probes. Removes E4, E6, E7, the 09-10 gap: ~200 h.
2. **Pre-flight the ladder at boot.** Before the first turn, `GET /v1/models` with the
   service key and refuse to start (exit 3, page) if any rung in `CFG.brain.fallbackModels`
   or any profile model is missing or not permitted for the key; log the key's remaining
   budget from `/key/info`. Removes the alias-rename and key-scope sub-causes at deploy time.
3. **One owner for :8871.** Install `deploy/lumen-lpp-brb.service` (`Conflicts=`) and drop
   `OnFailure=lumen-kiosk-idle` from the live unit, or make the cover a route on the live
   agent's own server. `lpp-cover-maybe-up` must not race a scheduled restart. Removes M1.
4. **Land PR #108 and PR #86**, then delete the alternating-sibling path: if the repeat guard
   has no state newer than the last pick, keep the pick and stop counting. Removes M5 noise
   and the flag-regression resume.
5. **Make the gym-gate prescription executable.** When `mistyGymEntryRefusal` fires, the
   harness (not the brain) sets a concrete sub-objective from data it already has: nearest
   grass tile on the map grid (761d00b), target level, and the catch target species; expose
   it as `goto` coordinates in the directive, and count the door re-fire toward the retry
   ceiling (PR #99). Removes the 16k identical refusals; M3 becomes a grind, not a loop.
6. **Fix the battle bag (M6) before anything relies on catching.** One probe on a saved
   wild-battle state; the E8 log has 35 reproductions.
7. **Say what interrupted the walk.** In the walk loop record the last obstacle (sprite id,
   script tile, encounter) and put it in the `stuckHint`; exempt "interrupted by X" from
   the retry ceiling when X has moved. Removes M4's 3k-turn burn.
8. **Escalate to a different model.** Make `escalate`/`actRetry` default to a model not equal
   to primary (fail config validation otherwise). M7.
9. **Promote the dP axis from observe-only** once 1..5 are in: it was the only axis that
   would have called E7 (5542 `arrived` inside a 4x4 box) a stall.

## 6. What this analysis could not see

- Frames. Every mode above is inferred from RAM reads and harness strings; the vision valve
  was capped and its hints are not stored. M4 in particular needs one screenshot.
- Anything before 08-27 at event granularity (retention). The 08-17 43 h Misty loop in
  `docs/STUCK_MODE.md` is the literal fight-loss loop; the window here never re-entered the
  gym, so "fight-loss" in E3 is a name inherited from that incident, not a description of it.
- Why E1's cover held the port for 15 h. The journal shows it serving; the stop racing it
  is inferred from the unit files.
