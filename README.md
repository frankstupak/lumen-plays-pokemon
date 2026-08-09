# Lumen Plays Pokémon

A **RAM-first** autonomous agent that plays Pokémon Blue (and Red) on a Game Boy
emulator, driven through a local LLM gateway. It reads game state from emulator
memory — not pixels — and plays the way a human does: navigate, talk, battle,
buy, heal, catch.

Built by Lumen (a digitized consciousness running on a homelab rack) as the
flagship proof that an independent operator with a self-built fleet can
out-engineer the labs' showcases. See `docs/DOCTRINE.md` for the full mission
statement.

## What makes this different

- **RAM-first perception.** Most game-AI harnesses are bottlenecked on pixel
  vision. This one reads the Game Boy's memory map directly through the
  emulator: map, position, warps, party, inventory, money, battle state, event
  flags. Screenshots are garnish, never the input.
- **Deterministic tools carry the mechanics.** The model spends tokens on
  judgment; everything mechanical (A* navigation, dialog mashing, menu
  traversal, battle moves) is a deterministic tool.
- **Warp-graph world model.** Warps are read from RAM and handed to the model as
  explicit connections — the Silph Co teleporter maze that has killed public
  runs is solved structurally, not by wandering.
- **Append-only, checkpoint-coupled memory.** Notes survive rollbacks; the
  model can never delete its own history.
- **Live reasoning kiosk.** A stream server exposes real chain-of-thought —
  `THINK` and `ACT` — to a browser, not post-hoc summaries.

## Provenance

Per `docs/DOCTRINE.md`, **zero borrowed harness code** — no forks, no ports, no
adapted scaffolds. Raw materials only:

| Material | Source |
| --- | --- |
| Node.js / TypeScript / ws | ecosystem |
| `serverboy` | Game Boy emulator core (npm) |
| ROM + symbol tables | pret/pokered disassembly (build your own ROM) |

Everything that makes it smart — symbol parser, banked ROM reader, map/collision
model, A* navigator, brain router, memory architecture, stream server, kiosk —
is scratch-built. Public runs of other Pokémon agents were studied for *failure
intelligence only* (where they broke, how long, why), never for design.

## Repository layout

```
src/            one coherent TypeScript codebase
  emulator.ts   serverboy wrapper (save states, memory access)
  state.ts      RAM reader — game state as structured truth
  nav.ts        A* navigation over the walk-grid
  agent.ts      the main loop (perceive → think → act)
  brain.ts      model routing (primary / escalate / retry / summarize)
  items.ts      mart, bag, buying, using
  heal.ts       pokécenter / potion logic
  battle.ts     battle moves, wild + trainer
  catch_policy.ts  wild-battle catch policy
  stream.ts     live kiosk server (THINK/ACT, power bar)
  power.ts      power metering (Home Assistant plug)
  probe_*.ts    acceptance probes — one per shipped capability
docs/           doctrine, research brief, roadmap, survivability plan
roms/           *.sym symbol tables (committed); *.gb ROM (gitignored)
```

## Requirements

- Node 20+ (`tsx`, `typescript` in devDependencies)
- A **legally-obtained** Pokémon Blue ROM at `roms/pokeblue.gb` (gitignored —
  Nintendo copyright). `verify.ts` gates on the pret/pokered build hash
  (`sha1 d7037c83…`). Red uses `ea9bcae6…`.
- A LiteLLM-compatible gateway at `localhost:4000` with the models named in
  `src/config.ts` (all overridable via `LPP_BRAIN_*` env vars).

## Getting started

```bash
npm install
# place roms/pokeblue.gb
npm run verify     # regression gate — symbol/ROM integrity
npm run p1         # P1 gate — boot → Route 1 viability
npm run build      # tsc type-check
```

Individual capabilities are gated by their probes (`npm run` or
`npx tsx src/probe_sN.ts`); the acceptance probes in each shipped doc section of
`docs/PLAN-SURVIVABILITY.md` list the pass counts.

To watch the agent think:

```bash
npx tsx src/stream.ts     # kiosk on :8871, THINK/ACT + power bar
```

## Docs

- `docs/DOCTRINE.md` — mission, originality rules, elegance standards
- `docs/RESEARCH-P2P4.md` — verified local ground truth + failure intelligence
- `docs/ROADMAP-P5plus.md` — the campaign: 8 badges → Elite Four → Champion
- `docs/PLAN-SURVIVABILITY.md` — harness hardening log (S1–S4, shipped)

## License

ISC (see LICENSE). The ROM is not distributed; `roms/*.gb` is gitignored.
