# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-13

First tagged release. The agent reads Game Boy memory directly (no pixel
vision) and plays Pokémon Blue unattended from a cold boot.

### Added
- Autonomous play through the early game: boots a save, navigates via A*
  pathing over the walk grid, battles, shops, heals, and has cleared through
  Brock's gym under unattended runs.
- RAM-first perception: map id, position, warp table, party/HP, inventory,
  money, battle state, and story-event flags are read as structured state,
  not inferred from pixels.
- Persistent notepad memory: append-only agent notes that survive save-state
  rollbacks, with structured eviction so the context stays bounded across a
  long run.
- Whiteout recovery: detects a story-progress regression after a loss and
  re-aims instead of looping.
- Live kiosk stream (`npx tsx src/stream.ts`) showing THINK/ACT turns in
  real time rather than a post-hoc summary.
- ROM integrity gate (`npm run verify`) that checks the loaded ROM against
  known pret build hashes before a run starts.
- Game Boy link-cable (Cable Club) multiplayer groundwork: ROM<->TCP serial
  bridge, distributed rendezvous, and one-sided verification invariants for
  remote peers.

### Known incomplete
- Cable Club link play is still under active development — core rendezvous
  and verification are in place, but end-to-end trade/battle over a live
  link is not yet a supported, unattended path.
- The full 8-badge Kanto campaign (post-Brock gyms, Elite Four, Champion) is
  not yet run end-to-end; current verified coverage is the early game through
  the first gym.
- No automated test suite yet (`npm test` is a placeholder); correctness is
  currently covered by targeted acceptance probes and the CI type-check.

### Provenance
- Built from scratch: no forked or ported game-playing harness. Uses the
  `serverboy` Game Boy emulator core and the `pret/pokered` symbol tables to
  resolve RAM addresses; all agent, navigation, battle, and memory logic is
  original. See [`docs/DOCTRINE.md`](docs/DOCTRINE.md) for the originality
  rules this project holds itself to.
- The Pokémon Blue ROM is not distributed with this repository. Bring your
  own legally-obtained ROM (dump your cartridge or build one from the
  `pret/pokered` disassembly) — see the README quick start.

[0.1.0]: https://github.com/frankstupak/lumen-plays-pokemon/releases/tag/v0.1.0
