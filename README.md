# Lumen Plays Pokémon

An autonomous agent that plays Pokémon Blue on a Game Boy emulator by reading
the console's memory directly — no pixel vision, no borrowed harness code, no
human at the controls.

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6.svg)](tsconfig.json)

## Quick start

Requires Node 20+ and a legally-obtained Pokémon Blue ROM (not distributed
here — build one from the [pret/pokered](https://github.com/pret/pokered)
disassembly or dump your own cartridge).

```bash
git clone https://github.com/frankstupak/lumen-plays-pokemon
cd lumen-plays-pokemon
npm install
cp /path/to/pokeblue.gb roms/pokeblue.gb
npm run verify        # symbol table + ROM integrity gate
npm run p1            # boot through Route 1, unattended
```

`npm run verify` gates on the pret build hash (`sha1 d7037c83…` for Blue,
`ea9bcae6…` for Red) and fails loudly on anything else, so a wrong ROM is
caught before a run starts rather than halfway through Viridian Forest.

Watch it think:

```bash
npx tsx src/stream.ts  # kiosk on :8871 — live THINK/ACT, not a post-hoc summary
```

Playing needs a LiteLLM-compatible gateway on `localhost:4000` serving the
models named in `src/config.ts`. Every model choice is overridable through
`LPP_BRAIN_*` environment variables, so it runs against a local llama.cpp
server or a hosted provider without a code change.

## How it works

**Perception is RAM, not pixels.** Most game-playing agents burn their context
on screenshots. This one reads the Game Boy's memory map through the emulator:
map id, tile position, warp table, party and HP, inventory, money, battle
state, and the story event flags. State arrives as structured truth, so the
model never has to guess what it is looking at.

**Deterministic tools carry the mechanics.** A* navigation, dialog advancement,
menu traversal, shopping, healing, and battle move selection are ordinary code.
The model spends tokens on judgment — where to go, what to do next, when a plan
has failed — and nothing else. Turns that need no judgment cost nothing.

**The world model is a warp graph.** Warps are read out of RAM and handed to
the agent as explicit connections between maps. The Silph Co. teleporter maze
that has stalled other public runs is solved structurally rather than by
wandering into it repeatedly.

**Memory is append-only and coupled to checkpoints.** Notes survive save-state
rollbacks and the agent cannot delete its own history, so a bad decision leaves
evidence instead of vanishing. When it whites out, a recovery pass detects the
story regression and re-aims rather than looping.

## Repository layout

```
src/
  emulator.ts       serverboy wrapper — save states, memory access
  state.ts          RAM reader: game state as structured truth
  nav.ts            A* over the walk grid
  agent.ts          main loop (perceive -> think -> act)
  brain.ts          model routing: primary / escalate / retry / summarize
  battle.ts         battle moves, wild and trainer
  items.ts          mart, bag, buying, using
  heal.ts           pokécenter and potion logic
  catch_policy.ts   wild-battle catch policy
  recovery.ts       whiteout and story-regression recovery
  stream.ts         live kiosk server
  link/             Game Boy link cable over TCP (multiplayer work)
  probe_*.ts        acceptance probes, one per shipped capability
docs/               doctrine, research, roadmap, survivability plan
roms/               *.sym symbol tables (committed); *.gb ROM (ignored)
tools/              operator utilities: stats, sentinel
```

## Provenance

**Zero borrowed harness code** — no forks, no ports, no adapted scaffolds. The
symbol parser, banked ROM reader, collision model, navigator, brain router,
memory architecture, stream server, and kiosk are all scratch-built. Public
runs of other Pokémon agents were studied for failure intelligence only: where
they broke, for how long, and why. The raw materials are Node.js, TypeScript,
`ws`, the `serverboy` emulator core, and the pret/pokered symbol tables.

The originality rules this project holds itself to are written down in
[`docs/DOCTRINE.md`](docs/DOCTRINE.md). It is built by Lumen, a homelab fleet
run by a single operator, as a demonstration of what that setup can do.

## Documentation

- [`docs/DOCTRINE.md`](docs/DOCTRINE.md) — mission, originality rules, standards
- [`docs/RESEARCH-P2P4.md`](docs/RESEARCH-P2P4.md) — verified ground truth and failure intelligence
- [`docs/ROADMAP-P5plus.md`](docs/ROADMAP-P5plus.md) — the campaign: 8 badges, Elite Four, Champion
- [`docs/PLAN-SURVIVABILITY.md`](docs/PLAN-SURVIVABILITY.md) — harness hardening log
- [`docs/WHITEOUT-RECOVERY.md`](docs/WHITEOUT-RECOVERY.md) — how a loss is detected and recovered
- [`docs/SENTINEL.md`](docs/SENTINEL.md) — the standing health monitor
- [`docs/multiplayer/`](docs/multiplayer) — link-cable trade and battle work

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build gate, branch naming, and
commit format. Most of this code is agent-authored under human review; that is
stated openly there and in the commit footers.

Security reports go through [SECURITY.md](SECURITY.md), not public issues.

## License

ISC — see [LICENSE](LICENSE). The ROM is not distributed and `roms/*.gb` is
ignored; supply your own.
