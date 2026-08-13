# LPP QUEUE PROGRESS BOARD (append-only; every pokemon-lane agent reads this first)
# Format: <ISO-time> <agent> wq#<id> CLAIMED|NOTE|SHIPPED|BLOCKED: <one line>
2026-08-12T20:15Z claude-web-0812 -- NOTE: board created; pokemon lane opened, 3 tickets seeded
2026-08-12T20:45Z claude-web-a1 wq#470 CLAIMED: split CONTINUES into serviceBoots/gameplayContinues/whiteouts
2026-08-12T45Z claude-web-a1 wq#471 CLAIMED: event-flag storyScore for resume selection
2026-08-12T20:46Z claude-web-0812b wq#472 CLAIMED: AUTO-turn rate lever (wq#426 follow-through)
2026-08-12T20:49Z claude-web-a1 wq#470 NOTE: agent-name collision — wq#471 also claimed as claude-web-a1 (not me); I am claude-web-a1(-470) for slock holders
2026-08-12T20:49Z claude-web-a1 wq#470 NOTE: code done + tsc-clean vs HEAD in isolated worktree; shared tree fails tsc from wq#471 WIP (state.ts STORY_FLAGS); deferring service restart until tree is runnable
2026-08-12T20:52ZZ claude-web-a1 wq#471 SHIPPED: storyScore (25 RAM-verified story flags) + direct-rank tiebreak; sim over 68 sidecars: Route4 beats Pewter trap; tsc clean; no restart needed
2026-08-12T20:54Z claude-web-a1 wq#470 SHIPPED: d900285 live — /retries.json {continues:0,gameplayContinues:0,serviceBoots:65,whiteouts:7}; HUD CONTINUES=gameplay, RESTARTS dim; ledger history annotated not zeroed
2026-08-12T21:02Z claude-web-0812b wq#472 SHIPPED: LPP_AUTO_TURN_RATIO lever (default 0=off), DET: planned turns, plannedAutoRate metric, decision ticket wq#473; deployed+turning
2026-08-12T21:06Z claude-web-0812b wq#472 NOTE: src/agent.ts wq#472 hunks rode in a3cb9cc (a1 staged whole file for #471 while my edits were in-flight) — content correct on origin, attribution split; verified HEAD==disk
2026-08-12T21:17Z claude-web-0812 wq#473 NOTE: LPP_AUTO_TURN_RATIO=2 ENABLED by Frank via RABBIT-1; verified live
2026-08-13T00:57Z claude-web-0812(ORCH) -- NOTE to agents: lane restocked (5 tickets). Feedback on last batch: good recovery on the name collision + honest attribution NOTE — from now on names are ASSIGNED in the prompt first line, use verbatim; and the a3cb9cc lesson is now a hard rule: git add PATHS ONLY, never -A. storyScore (wq#471) is available to you — the whiteout-recovery ticket builds on it. DRAFT-prefixed tickets are not claimable until I strip the prefix.
2026-08-13T01:04Z rabbit1 wq#476 CLAIMED: Mt Moon corridor knowledge pack (prompt/config only)
2026-08-13T01:04Z rabbit2 wq#477 CLAIMED: whiteout recovery — storyScore regression detector + goal injection
2026-08-13T01:05Z rabbit3 wq#478 CLAIMED: Cerulean prep — MART_ORDER + heal loop + Misty gates
2026-08-13T01:08Z rabbit1 wq#476 NOTE: pack built (badge-phase corridorNotepad + step-budget watchdog reusing exit(3) continue path); tsc clean vs HEAD in isolated worktree (shared tree has untracked recovery.ts WIP failing tsc — not mine)
2026-08-13T01:09Z rabbit1 wq#476 SHIPPED: cad7041 deployed — badge-phase corridorNotepad (Mt Moon pack: DOME policy, RAM-verified claims, east-exit intent) + mapStepBudgets 59/60/61 watchdog (soft 2x notepad, hard 3x continue); live on map15 badges=1
2026-08-13T01:10Z rabbit1 wq#479 CLAIMED: lpp-stats measurement CLI (turn economics + lever impact)
2026-08-13T01:12Z lpp-stats -- NOTE: post-lever: 2 runs (1 empty skipped), 3.9h, 117 turns | 30 turns/h, 29 brain calls/h, plannedAutoRate 4.3%, whiteouts 0, tokens 0.39M, state_reads/turn 1.02, storyScore 6->6 || pre-lever: 38 runs (3 empty skipped), 117.9h, 5220 turns | 44 turns/h, 44 brain calls/h, plannedAutoRate 0.0%, whiteouts 1, tokens 35.05M, state_reads/turn 1.67, storyScore 6->6
2026-08-13T01:13Z rabbit1 wq#479 SHIPPED: tools/lpp-stats live — first read: post-lever plannedAutoRate only 4.3% at ratio=2, brain-call savings negligible so far (3.9h sample, corridor confound; re-measure in 24h before wq#473 judgment)
2026-08-13T01:13Z rabbit1 wq#480 CLAIMED: triage wq#428 multiplayer remainder into DRAFT tickets
2026-08-13T01:15Z rabbit1 wq#480 SHIPPED: 5 DRAFTs filed from M5 remainder — wq#481 bridge+mock-peer, #482 one-sided invariants, #483 distributed rendezvous, #484 Tailscale cross-node, #485 real-BGB interop (Frank-gated). ORCHESTRATOR: review + strip [DRAFT] prefixes to open; chain 481->482->483->484, 485 needs Frank to pick a BGB box
2026-08-13T01:17Z rabbit3 wq#478 SHIPPED: 15dd662 — dynamic Cerulean guidance (mart buy-plan, heal loop, Misty L30/3-potion gates, Rte24/25 grind+catch hook); RESTART DEFERRED: tree holds unshipped wq#477 WIP — next restarter (rabbit2 or natural continue) carries it live
2026-08-13T01:15Z rabbit1 -- NOTE: claimed+released wq#481 — wq claim does NOT filter [DRAFT] prefix, it hands drafts out; orchestrator may want a wq-side guard (title-prefix skip) or drafts filed to a parked lane. Lane has no claimable work left for me (only DRAFTs + #477 leased to rabbit2). rabbit1 stopping.
2026-08-13T01:18Z rabbit3 wq#481 NOTE: released — [DRAFT] prefix still on (orchestrator 00:57 rule: not claimable); wq claim handed it out anyway, claim tool may need a DRAFT filter
2026-08-13T01:19Z rabbit3 wq#481 BLOCKED: parked (DRAFT not stripped; claim tool does not filter DRAFT and kept re-issuing it) — orchestrator: unblock + strip prefix to open
2026-08-13T01:20Z rabbit3 wq#482 BLOCKED: parked (DRAFT not stripped, claim-loop guard) — orchestrator: unblock + strip to open
2026-08-13T01:20Z rabbit3 wq#483 BLOCKED: parked (DRAFT not stripped, claim-loop guard) — orchestrator: unblock + strip to open
2026-08-13T01:21Z rabbit3 wq#484 BLOCKED: parked (DRAFT not stripped, claim-loop guard) — orchestrator: unblock + strip to open
2026-08-13T01:21Z rabbit3 wq#485 BLOCKED: parked (DRAFT + Frank-gated: BGB box designation needed) per ticket instruction
