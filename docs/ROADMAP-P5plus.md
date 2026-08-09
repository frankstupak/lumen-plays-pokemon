# Roadmap: past P4 (planning doc, 2026-08-02)
P0-P1 SHIPPED (emulator+state+A* nav). P2-P4 in progress (other agent): brain loop, kiosk THINK/ACT display, overnight autonomy + Brock.

## P5 — Full Kanto campaign (8 badges -> Elite Four -> Champion)
Milestone chain w/ per-map step budgets + rollback; warp-graph connectivity in state (Silph Co killer); HM tooling (cut/surf/strength/flash as explicit tools + obstacle tiles in state); Safari Zone step-limit awareness; boulder puzzles as scripted micro-tools if needed. Success metric: steps/badge and tokens/badge tracked per run.

## P6 — Multi-game: Blue + Red parallel
Same binary layout + pokered.sym already staged. One process per game, shared StreamServer with grid layout; per-run event streams. Proves harness generality cheaply.

## P7 — Hapi local inference (the $0 run)
Qwen3-30B-A3B on BC-250 cluster via llama.cpp Vulkan behind LiteLLM. Swap CFG.models.primary -> local. Doubles as Hapi burn-in workload. Bonus: model eval bench — same milestone checkpoints replayed across cerebras/deepseek/local, compare steps+tokens/milestone. Showcase-grade benchmark content.

## P8 — Gen 2: Gold/Silver
Spike serverboy vs GBC+MBC3 RTC first (WasmBoy fallback). pokegold symbols branch mirrors pokered pattern -> second StateReader adapter. New mechanics in tools/prompt (held items, day/night, phone). Own mini-project; do not start before P5 stable.

## P9 — Public + showcase
pokemon.lumennode.uk via existing Cloudflare tunnel, read-only stream page (auth-free viewing, no controls). Tinywhale write-up + per-run self-contained trace HTML export (frames+reasoning+costs) as the portfolio artifact. Grafana: badges/steps/tokens panels on power-dash stack; Langfuse traces per turn.

## Cross-cutting invariants
RAM-first perception; deterministic tools for mechanics; cache-stable prompts; append-only memory w/ checkpointed notes; every fact verifiable from state; no Anthropic API spend (gateway only).
