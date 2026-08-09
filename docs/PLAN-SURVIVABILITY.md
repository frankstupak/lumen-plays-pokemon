# LPP — Survivability Campaign (pre-Brock hardening)
_2026-08-06. Overall plan skeleton. Sections filled in as work progresses — do not pre-detail future sections._
_Origin: post-launch outage review + external research notes, re-verified against live harness (turn 383, map 51, $22, 0 items, ranking sort at live_agent.ts:71)._

## S1 — Harness truth fixes (SHIPPED 2026-08-06)
Goal: brain can no longer be lied to or left blind by the harness. No new capabilities, only correctness.
1. Trainer-battle gate: when inBattle=2, goto/enter_warp/leave_edge/press(B-out) return "trainer battle — must fight (battle_move)". Battle state block announces type (wild/trainer).
2. State-block imperatives (harness-injected, context-aware):
   - HP below threshold + NOT in battle -> "HP CRITICAL — heal before anything else."
   - HP below threshold + in trainer battle -> "HP CRITICAL — win or faint; healing unavailable."
   - Any move PP exhausted -> surface per-move PP; all-zero -> "PP EXHAUSTED — Struggle only" warning.
3. Read party move PP into state (symbols: wPartyMon1PP..; verify in pokeblue.sym first).
Acceptance PASSED: src/probe_s1.ts 10/10 on rival1-battle checkpoint (gates refuse, TRAINER announced, imperatives threshold-correct, PP in party line masked &0x3f for PP-Ups). Regression: npm run verify + p1 both PASS. Deployed via service restart, resume confirmed. Baks: src/*.bak.20260807_000548.

## S2 — Checkpoint viability ranking (SHIPPED 2026-08-06)
Built: (1) src/resume.ts — viability-gated resume (viable = lead HP>=50% AND any PP; sort viable > badges > eventCount > storyRank > mtime; falls back to best non-viable, never refuses). Sidecar-first (.json per checkpoint), legacy emulator-load fallback. (2) agent.ts maybeCheckpoint — stability guard (no snapshot mid-battle/dialog/script), sidecar metadata (map/pos/badges/events/hpPct/ppOk/money), milestone checkpoints on badge gain + full-heal transitions (Center heal or white-out respawn = the safe states), rolling prune keep-40 autos (milestones+saves never pruned). (3) StateReader.eventCount() — popcount over wEventFlags 320B (0xd747-0xd886 symbol-verified). (4) One-time: 807 stale checkpoints archived to checkpoints/archive-pre-s2/ (moved, not deleted).
Verified: Gen1 white-out = half money on hand, full heal at last Center (Bulbapedia) — negligible at current wallet; white-out = designed recovery, codified.
Acceptance PASSED: probe_s2.ts 11/11; verify+p1 PASS. Live proof: pre-S2 ranker resumed 5HP Charmander L15; post-S2 first boot resumed Charmeleon L16 41/47 healthy — recovered the lost evolution. Boot scan 80s -> ~10s. Baks: src/*.bak.20260807_002501.

## S3 — Item & economy layer (SHIPPED 2026-08-07: probe_s3 12/12, verify+p1 PASS, deployed+resumed, bagLine live)
Scope: bag reader -> money+bag in state block -> use_item (overworld + battle) -> buy_item (mart) -> catch (ball via battle item path). Acceptance: probe_s3.ts 12/12. Regression: P0 verify + P1 + probe_s1 10/10 + probe_s2 11/11 ALL PASS (job pkm-s3reg-1786078164).

**Empirical findings that shaped the build (do not re-derive):**
- cf91/wCurItem is written with the selected item id on A-press in list menus (hover does NOT update it; init leaves it stale on the last-printed item) -> the deterministic post-select verify for mart list AND bag.
- First tap after any menu init gets eaten -> normalize-to-top + verified stepping + verified-A retries everywhere.
- Mart price-confirm is multi-part dialog with a scroll prompt that WAITS for a press (textUp reads false at the wait) -> passive waits starve; advance with A while no cursor is up (cursor only appears with YES/NO). Name-verify the confirm text before YES; B during printing does NOT cancel.
- Catch/battle text sequences same scroll-wait behavior -> drive actively; cursor up mid-catch = nickname prompt -> B (NO).
- exitMart must be state-verified (!dlg && !textUp): blind A facing the clerk reopens the shop; a pending YES/NO freezes the overworld -> nav "stuck" forever.
- START menu opens SLOWLY (~1s) and its text renders fine once drawn (earlier "invisible outdoors" was a pre-draw sampling artifact). wMaxMenuItem on the START menu reads entry COUNT (7 w/ dex+party), not count-1 -> ITEM row located by row text with max-5 fallback; never read max before the cursor is drawn (stale-list race).
- Fix history: wrong-row purchase (stale cur + missing name-verify) -> three-layer selection; trainer-card detour (max-4 off-by-one); eaten BUY press on 2nd purchase same visit -> verified retry.
- probe_sm4 retired (superseded by research probes + probe_s3). Research artifacts: src/probe_s3_research.ts, src/probe_s3_research2.ts. Baks: src/items.ts.bak.20260807_035254.

## S4 — heal_at_center macro + shopping policy (SHIPPED 2026-08-07 ~06:35 PDT; deployed via service restart)
Built: (1) src/heal.ts — heal_at_center() macro. (2) agent.ts: heal_at_center tool+case, HP-CRITICAL imperative now routes to heal_at_center() when inside a known center, data-driven shopping TIP (MART_ORDER-based: flags balls<3 / heals<2 / no antidote when standing in a mart with money). (3) prompt.ts tool doc. (4) items.ts: exported MART_ORDER + ITEM. (5) src/nav.ts: enterWarp raw-press fallback (see finding below).
Acceptance: probe_s4.ts 12/12. Regression: P0 verify + P1 + probe_s1 10/10 + probe_s2 11/11 + probe_s3 12/12 ALL PASS (job pkm-s4reg-1786109564). Deployed: lumen-pokemon-live restarted 13:36 UTC, resumed clean (turn 1, in battle, stream :8871).

**Empirical findings that shaped the build (do not re-derive):**
- Pokemon Center layout (map 41 Viridian, probe-verified): nurse = topmost sprite, static behind counter; approach (nurse.x, nurse.y+2), face UP, A. Heal dialog: Welcome -> heal pitch -> "Shall we heal your POKeMON?" YES/NO (first A at the choice gets EATEN -> verified-press retry). HP+PP+status all restore (Gen1 canon; HP/PP RAM-verified). game mem is WRITABLE for test setup.
- CENTER_NURSE table in heal.ts is probe-verified only (map 41). Extend per-town by probing first; never guess map ids.
- **Nurse dialog soft-lock (critical):** the nurse's closing line leaves a textbox that dlg.open()/textUp() both read FALSE while movement is still frozen -> goto returns "stuck" at the counter forever. Fixed with clearUntilMovable(): attempt a real step and check wXCoord/wYCoord actually changed; only then is the player provably movable. This is the ONLY reliable overworld-control predicate after a scripted NPC dialog. Reuse this pattern for any future NPC macro.
- **Building-exit warps (nav.ts fix, benefits all buildings):** Center/Mart/house door warps sit on the visible bottom row but the tile BELOW is collision-wall, so step() refuses and enterWarp's push loop never fired -> agent could get healed then be stuck inside forever. Gen1 fires these on the walk-into-wall animation. Added a raw-press fallback to enterWarp: after the grid-based push loop, raw-tap the outward direction (never up) up to 4x, watching for a map change. Probe-verified: exit fires on the 2nd-3rd press.
- Baks: src/heal.ts.bak.*, src/nav.ts.bak.*.
- **RE-VALIDATED 2026-08-07 22:44 UTC** (cross-agent check, this session): probe_s4.ts 12/12 again on current build (poison mon 10hp/st8 -> 23/23 st0, PP 35/40 restored, control returned, already-full short-circuit, mart shopping TIP renders w/ live inventory), verify+p1 PASS, heal_at_center advertised in prompt + dispatched in agent, service on current build. S4 built by parallel agent while this session ran S1-S3; confirmed genuine, not scaffolding.

## S5 — Resume Brock campaign + metrics (COMPLETE 2026-08-07: BADGE 1 WON)
Goal: with S1-S4 live, drive an uninterrupted run to BADGE1 (Brock, Pewter Gym) and instrument it so we can SEE whether the survivability work actually changed outcomes. Two parts: (A) close the last capability gaps the road to Brock needs, (B) stand up metrics.

Prereqs the road to Brock actually hits (verify, don't assume):
1. Pewter Mart stock order -> extend MART_ORDER (wq#417). Pewter sells POTIONs; without it the shopping policy can't recommend the item that matters most before a gym. Probe on arrival.
2. Pewter Pokemon Center nurse tile -> extend CENTER_NURSE in heal.ts by probing map id on arrival (never guess). heal_at_center refuses unknown centers by design.
3. Viridian Forest is the pre-Brock grind: Weedle/Kakuna/Caterpie/Metapod/Pikachu. Catch path (S3) gets a 2nd mon here; type matchup vs Brock (Rock) = our Charmeleon is BAD (Fire vs Rock), so a caught Pikachu/Mankey/bug is leverage. Policy nudge, not hard-coded.

Metrics (B): add lightweight run-scoped counters emitted to events + a summary. Track per-run: turns, wall time, tokens (prompt+completion, already in think_chunk events), white-outs, resume events + which checkpoint kind resumed, battles won/lost/fled, items bought/used, catches attempted/succeeded, badges. Derive: steps/badge, tokens/badge, white-outs/badge. Store a per-run JSON summary at events/run-summary-<runTag>.json on badge gain or shutdown. This is what proves S1-S4 worth: compare white-outs/badge and tokens/badge against the pre-campaign baseline (the launch run that triggered this whole effort).

Acceptance: one clean run reaches BADGE1 (event flag verified via eventCount jump / wObtainedBadges bit0); run-summary JSON written; no harness soft-lock (trainer-flee, PP/Struggle, nurse, building-exit all held). Then delete checkpoints/archive-pre-s2/.

Ordering within S5: (A1) metrics harness first (cheap, observe-only, informs everything) -> (A2) extend Pewter mart+center tables when the run arrives -> (A3) let it run to Brock, watch, patch soft-locks as they surface. Detail each sub-step when reached.

**BADGE 1 ACHIEVED 2026-08-07** — full corridor traversed autonomously: Viridian Forest -> map47 -> map13(3,11) -> Pewter City -> Center heal (tileset detection) -> Gym -> Brock defeated (Onix downed with SCRATCH). Charmeleon L17->L19. The final badge segment: 0 whiteouts, 0 reboots, full HP/PP - vs 6 blackouts before the survivability work. 

S5-A1 metrics: SHIPPED (metrics.ts, run-summary JSON, tokens/whiteouts/battles per badge).
S5 fixes shipped this session (all found by watching the live run + researching root cause):
1. battle_move timeout (RAM-gated useMove w/ PP-decrement verify) - was blocking EVERY battle.
2. Anti-oscillation guard (map-history -> ! OSCILLATION directive).
3. Navigation corridor CORRECTED by tracing a past successful run (forest TOP warps, not bottom).
4. flee() tool (wild-battle escape, wEscapedFromBattle-confirmed) - PP-exhaustion recovery.
5. Universal tileset-based Center detection (tileset 6) - works at ALL centers, no per-map config.
6. Exact Pewter building warps (Center 13,25->m58; Gym 16,17->m54) probed by tileset.
7. Brock strategy corrected: SCRATCH (Normal 1x) not EMBER (Fire 0.5x vs Rock/Ground).

NEXT CAMPAIGN (S6+, when resumed): Route 3 -> Mt Moon -> Cerulean (Misty). Deferred battle soft-lock detector becomes relevant (more trainers, tougher fights). Extend MART_ORDER for Pewter (wq#417). checkpoints/archive-pre-s2/ now safe to delete (S5 done).

## Dashboard: CONTINUES counter (SHIPPED 2026-08-08)
Lifetime reset counter on the stream bar: CONTINUES = harness boots (every (re)start = one reset), sub-count = in-game white-outs (mirrors metrics.ts all-fainted edge). src/retry.ts (RetryCounter, ledger events/retry_ledger.json, atomic writes, fold-on-new-run, idempotent same-run reload), /retries.json endpoint + gold bar element in stream.ts, wired in live_agent.ts. Backfill: boots=36 (complete boot-event census of all surviving logs since 2026-08-02) + whiteouts=7 (6 documented pre-metrics blackouts + 1 from run-summaries). Deploy boot ticked it to 37. Smoke test 5/5; tsc clean; battle-gated restart at inBattle=0; kiosk relaunched. Baks: stream.ts/live_agent.ts .bak.20260808_040358.

## Deferred notes (do not build yet)
- [DONE 2026-08-06] Events rotation SHIPPED same-day per Frank fix-flaws-now rule: EventBus 25MB size rotation (-pN parts) + boot-time keep-30 retention (env LPP_EVENTS_ROTATE_BYTES/LPP_EVENTS_KEEP_FILES), smoke-tested, deployed; historical 87MB logs gzipped (events/ 101MB->32MB). Bak src/events.ts.bak.*.
- checkpoints/archive-pre-s2/ (807 files) safe to delete after S5 confirms nothing needed from it.
- Battle soft-lock detector: turn budget per battle -> escalate/reset. Gen1 engine loops are real (Struggle is Normal-type -> whiffs forever vs Ghost; Transform-vs-Transform PP reset loop; 1/256 universal miss). Becomes mandatory before Pokémon Tower. Pairs with S1 PP tracking.
- External Gemini research doc reviewed 2026-08-06: PyBoy/RL multi-agent plan = wrong paradigm (RL reward shaping vs our LLM-brain harness) and behind shipped state (wrapper/orchestrator layers already live). Salvaged only the 3 items above. Its hex addresses ignored — symbol table is authoritative.

## Ordering rationale
S1 is pure correctness and cheapest; S2 stops regressions compounding; S3/S4 add the capability the run is currently starving without; S5 is the payoff. Sections detailed only when reached.
