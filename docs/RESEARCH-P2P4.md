# Research Brief: P2–P4 (for the building agent)
Compiled 2026-08-02 by Claude (claude.ai session). Ground truth below is VERIFIED on this repo/hardware unless marked TO-VERIFY.

## 1. Verified local ground truth
- ROM: pokeblue.gb sha1 d7037c83e1ae5b39bde3c30787637ba1d4c48ce2 = byte-identical to pret build; pokeblue.sym addresses are exact. Red hash gate already in verify.ts (ea9bcae6...).
- serverboy quirks: internal saveState()/returnFromState() exposed via wrapper (public API lacks it); no-arg getMemory() returns LIVE array by reference (cached in Emulator.mem(), invalidated on loadState); reasoning about audio unnecessary (no audioHandle headless).
- Boot gate: wCurMap sets DURING Oak intro before map data loads — gate on wCurMapWidth!=0 && wNumberOfWarps!=0 (already in p1_verify).
- Nav: A* over walk-grid derived from wOverworldMap blocks + Tilesets(03:47be) blockset/collision lists; sprites from wSpriteStateData2 (+4/+5 minus 4); warps from wWarpEntries. Executor self-heals (turn-vs-block, learned-blocked, replan, non-unit-delta guard). 1527fps headless, 25.5x realtime.
- Efficiency arch (deployed, DO NOT regress): byte-stable SYSTEM_PREFIX; append-only History w/ fold-forward compaction (keep 30, compact @80, empty summary aborts); fixed-order state render; screenshots NEVER in history; brain routing primary=cerebras-oss-120b escalate=deepseek-v4-pro summarize=deepseek-v4-flash vision=lumen-vision; 3M token budget; cerebras-oss is a REASONING model — content may be empty under tight caps, fall back to reasoning_content (already handled) and stream it to think_chunk for the kiosk.
- Stream: lumen-pokemon-live.service :8871 (LAN+tailnet open in iptables, persisted). Kiosk = gameboy autologin -> autostart -> firefox --profile ~/kiosk-profile. P3 work should REPLACE live.ts demo with the real agent loop feed, same event kinds.

## 2. Failure intelligence from public runs (recon only — see DOCTRINE.md: we borrow nothing, we build past them)
- Silph Co teleporter maze = the single worst blocker on record (~50k reasoning steps, weeks). Countermeasure: our warp reader generalizes — teleporter pads are warps in RAM; build a warp GRAPH per building and expose "exits/connections" in the state block (harness-provided map connectivity is proven decisive).
- Erika's CUT tree: 4 days circling a gym roof. Countermeasure: HM-obstacle awareness in state (cut-able tree tiles have known tile IDs; TO-VERIFY IDs per tileset) + explicit tool cut_tree(x,y).
- Mt Moon fossil->exit confusion + "found fossil" hallucinations. Countermeasure: RAM-verified claims only — inventory/party checks are free; never let the model assert an acquisition without a state check; post-pickup goal injection.
- Bill quest-trigger blindness ended a run. Countermeasure: milestone table with prerequisites (see §4) surfaced in prompt as "current campaign step".
- Blackout strategy + NOTE DELETION after respawn (model deleted correct notes believing task done). Countermeasure: notepad is APPEND-ONLY with checkpointed copies; rollback restores notes+state together; never let the model bulk-erase.
- Weak-harness bottleneck was pixel vision. We are RAM-first; screenshots are garnish. Keep it that way.
- Normal-run step budgets (stuck detector calibration): Mt Moon ~1k steps for a good run. Per-map budget ~2-3x good-run estimate -> soft alarm -> escalate model; hard budget -> rollback to last milestone.

## 3. P2 specifics
- Six-decision path to Route 1: north exit (Oak intercept auto-walks), dialog mash, STARTER=SQUIRTLE (Brock plan), decline nickname, rival fight (~8 battle_move turns), goto Route 1.
- Dialog detection: TO-VERIFY candidate symbols wJoyIgnore, wTextBoxID, hWY/textbox flags — grep pokeblue.sym; expose "DIALOG ACTIVE" bool in state block + auto_advance affordance so dialog costs ~1 decision.
- Battle state: wIsInBattle(d057) verified; enemy mon HP/species symbols exist in sym (wEnemyMon...); expose both sides' HP/level/moves/PP in battle state; battle_move(slot) executes menu deterministically.
- Turn summary format (cache-stable): "T{n} {tool}({args}) -> map{m} ({x},{y}) {delta}" one line, no timestamps.

## 4. Milestone chain (checkpoint at each; prerequisites explicit)
oak_starter -> route1 -> viridian_pokecenter -> viridian_forest -> pewter_brock(BADGE1) -> route3 -> mt_moon(fossil optional, EXIT is the goal) -> cerulean_misty(BADGE2) -> nugget_bridge -> BILL(mandatory quest trigger) -> vermilion(SS Anne -> CUT -> surge BADGE3) -> ... (extend in P5 doc).

## 5. Coordination
- Fleet facts -> lumen_state.py only. Episodes via lumen_episode.py precheck/commit.
- Do not break: npm run verify, npm run p1 (regression gates). Keep EventBus kinds stable (kiosk depends): state_read, think_chunk, tool_call, buttons, turn_summary, checkpoint, boot, verify.
- Scribe tickets: project 11 "Lumen — capability expansion", pt CLI.
