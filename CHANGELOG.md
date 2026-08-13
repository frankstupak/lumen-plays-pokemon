# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/frankstupak/lumen-plays-pokemon/compare/v0.2.0...v0.3.0) (2026-08-13)


### Features

* **agent:** annotate warps with reachability and explain failed goto ([a19a560](https://github.com/frankstupak/lumen-plays-pokemon/commit/a19a560ddc94d71c26e43e8b6a01f45c78bd8d5e))
* **agent:** offer one reachable trainer as an income and experience goal ([f944ab3](https://github.com/frankstupak/lumen-plays-pokemon/commit/f944ab30ef10dd14317199dd239d401b03b77000))


### Bug Fixes

* **notepad:** re-arm claim verification on every resume ([86a3fbc](https://github.com/frankstupak/lumen-plays-pokemon/commit/86a3fbc1a151ad599a1309e22b5278994b7ce89f))
* **resume:** rank Mt Moon B1F by pocket so the exit side outranks B2F ([88e356c](https://github.com/frankstupak/lumen-plays-pokemon/commit/88e356c1e1a6f6bfd8b4f6cfab043490ef2aaace))

## [0.2.0](https://github.com/frankstupak/lumen-plays-pokemon/compare/v0.1.0...v0.2.0) (2026-08-13)


### Features

* **agent:** select corridor guidance by verified phase, refresh per turn ([74c016c](https://github.com/frankstupak/lumen-plays-pokemon/commit/74c016c534777a34688bc92e4e44a3f45b2df999))
* **agent:** tell the brain when the campaign is broke ([0f5e87c](https://github.com/frankstupak/lumen-plays-pokemon/commit/0f5e87c1ccb2f3f81038b81abbe6098a2f92c770))
* **tools:** detect cross-run stalls, restart loops and deploy drift ([027a228](https://github.com/frankstupak/lumen-plays-pokemon/commit/027a228aa23e957b3e4da6e2d1a7c85a4c2a37ef))
* **tools:** detect zero-displacement and wall-clock stalls ([1fb5b9e](https://github.com/frankstupak/lumen-plays-pokemon/commit/1fb5b9e1bd309841fa654385c891ec98d6759721))


### Bug Fixes

* **agent:** make Mt Moon dead-pocket recovery actionable ([74e4e6c](https://github.com/frankstupak/lumen-plays-pokemon/commit/74e4e6cbb460bf0c7178630ce891c35a3c9b8f3f))
* **agent:** name the forced Mt Moon exit and the fossil blocking it ([2baacb2](https://github.com/frankstupak/lumen-plays-pokemon/commit/2baacb2987dc7f197baf58fedc109091963d8609))
* **notepad:** verify pinned claims and reject duplicate pins ([0e5cec2](https://github.com/frankstupak/lumen-plays-pokemon/commit/0e5cec25ad37df1427a47b2940bc22b2c806408d))
* **resume:** rank route 4 by position so restarts keep mt moon progress ([8a98568](https://github.com/frankstupak/lumen-plays-pokemon/commit/8a98568e4dbfaaa1364dff44334863f0859579a1))
* **tools:** resolve resumed map from checkpoint sidecar, not filename ([449b17e](https://github.com/frankstupak/lumen-plays-pokemon/commit/449b17e63d15aedc164e9a17f13835590dae58ed))

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
