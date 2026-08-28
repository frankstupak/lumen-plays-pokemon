# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0](https://github.com/frankstupak/lumen-plays-pokemon/compare/v0.3.0...v0.4.0) (2026-08-28)


### Features

* add escalation-only vision verdict valve ([e3e6772](https://github.com/frankstupak/lumen-plays-pokemon/commit/e3e6772f7a46290ce0c532f1a70b9369fc36ca51))
* add kiosk avg tokens per turn/call metric ([0acff47](https://github.com/frankstupak/lumen-plays-pokemon/commit/0acff47b0a17eb6a6050990ed8e95464da05a068))
* **catch:** catch-sticky transit mode + cerulean catch leg ([a1f35a7](https://github.com/frankstupak/lumen-plays-pokemon/commit/a1f35a713312727de2c3b9e6636287030f00f630))
* decode hidden-items table for itemfinder perception ([2628157](https://github.com/frankstupak/lumen-plays-pokemon/commit/2628157f66bd2ca211e6a4a7e6bbd9bfc276a256))
* decode menu font tiles, navigate buy/heal by reading ([192d2eb](https://github.com/frankstupak/lumen-plays-pokemon/commit/192d2eb226f177617c778d8e20278ba3bbd5ab82))
* feed oscillation trips into the vision valve ([0c44721](https://github.com/frankstupak/lumen-plays-pokemon/commit/0c44721c9db73761eed498086aa10c29bf01dc8e))
* **link:** stranded-slave retry for distributed rendezvous ([bada788](https://github.com/frankstupak/lumen-plays-pokemon/commit/bada788ebb4610b1412507d5b75e41fa452e8f05))
* **nav:** trace per-step path intent versus actual movement ([acf22fc](https://github.com/frankstupak/lumen-plays-pokemon/commit/acf22fc3383732c46410502194b1b624a270cd16))
* perceive ground item balls, confirm pickups by flag ([05bea9e](https://github.com/frankstupak/lumen-plays-pokemon/commit/05bea9e33c72a88ae388d76e13078683d3d258fd))
* require Grass/Rock type counter in Misty entry gate ([21323eb](https://github.com/frankstupak/lumen-plays-pokemon/commit/21323eb98e9f991ebe8dac60d2b664446658d1ce))
* **resume:** rank Mt Moon saves by route leg, mark warp-tile checkpoints ([c94f27b](https://github.com/frankstupak/lumen-plays-pokemon/commit/c94f27bbe23da2ae37c7aa2f1fac8f6ede66c015))
* stuck-agent supervision, kiosk log box, resume story order ([98bfb13](https://github.com/frankstupak/lumen-plays-pokemon/commit/98bfb132e66643c3181a000a1f72cbb5a9edf782))
* **stuck:** consume supervisor directive to break nav loops ([942be70](https://github.com/frankstupak/lumen-plays-pokemon/commit/942be70ad02869450dcabb304b80d886f191bb6f))
* **stuck:** WARP_OSC + NOISE_STORM classifier signatures + noise breaker ([7fa672a](https://github.com/frankstupak/lumen-plays-pokemon/commit/7fa672a032dcdd6ed77507043d404e8d5498a055))
* verify and retire stale arrival-claim notepad pins ([ee12c46](https://github.com/frankstupak/lumen-plays-pokemon/commit/ee12c46ed2599004e05fcfc6ad5890affa086a84))


### Bug Fixes

* **agent:** catch adjacent-landing warp bounce ([ddfb72f](https://github.com/frankstupak/lumen-plays-pokemon/commit/ddfb72fb999a4b01fafc8742d46b1cceabdb4129))
* **agent:** count warp loops from real arrivals only ([13207a2](https://github.com/frankstupak/lumen-plays-pokemon/commit/13207a2c4ec926dc78c322fc5fcd05413ef6710e))
* **battle:** lock-in-aware move picking, moveset-true Misty guidance ([518964e](https://github.com/frankstupak/lumen-plays-pokemon/commit/518964e33e7e5b6512b1596e70f6088f548257ac))
* **brain:** bound every brain call with a rung ladder ([86844df](https://github.com/frankstupak/lumen-plays-pokemon/commit/86844dfa8cdafb2821ac940babc8c6cdc3f978d5))
* **brain:** reroute LPP fallback from DeepSeek to cerebras ([0fa30e0](https://github.com/frankstupak/lumen-plays-pokemon/commit/0fa30e06d044ec644e78bd6f28240f5dcc29057d))
* **ci:** on-main probe set wired, reach538 rebased green ([f5f0ca8](https://github.com/frankstupak/lumen-plays-pokemon/commit/f5f0ca8b4b184f96527c19ff83a21b0b60a51945))
* **events:** give link drivers their own retention budget ([ef7f73e](https://github.com/frankstupak/lumen-plays-pokemon/commit/ef7f73eb638fe8b19986804670b527298557c753))
* **events:** stop deleting event logs when an EventBus is constructed ([e220532](https://github.com/frankstupak/lumen-plays-pokemon/commit/e220532deb492bb47c01db886b1d412c141b9202))
* **frontier:** reject torn-read sidecars via ROM plausibility check ([0342153](https://github.com/frankstupak/lumen-plays-pokemon/commit/0342153f31aa112091ac874e77da9c79da9ec7ff))
* **guidance:** balls-first mart plan rendering real tool names ([4cce473](https://github.com/frankstupak/lumen-plays-pokemon/commit/4cce47383c56578b4aaf69ba21d8c8fcdd4141a0))
* **guidance:** resolve Mt Moon exit route per pocket from reachable tiles ([9927192](https://github.com/frankstupak/lumen-plays-pokemon/commit/99271922b6c277f0b3ab2e9f5cc842f28d663454))
* **link:** resolve driver data paths against repo root, not CWD ([a555413](https://github.com/frankstupak/lumen-plays-pokemon/commit/a555413643fd6f70feade2d81fa0af6048964e97))
* **metrics:** pin the event envelope and detect blackouts by consequence ([972bfab](https://github.com/frankstupak/lumen-plays-pokemon/commit/972bfab5df89cc992059246fb72679415a193ba8))
* model ledge hops as directed nav edges ([af85eb1](https://github.com/frankstupak/lumen-plays-pokemon/commit/af85eb173c9cf0911d825ba5edbbe15daee80431))
* **nav:** fire warps when already standing on the warp tile ([e043d4b](https://github.com/frankstupak/lumen-plays-pokemon/commit/e043d4bb1ad85ccd395949e0a6128aa83dd8fb01))
* **nav:** reject tile-pair collisions the passable list cannot express ([5d137ea](https://github.com/frankstupak/lumen-plays-pokemon/commit/5d137ea8082e2982d3c571617e719636fe434b38))
* **nav:** stop goto planning onto sprite-occupied targets ([2569ee8](https://github.com/frankstupak/lumen-plays-pokemon/commit/2569ee81b2e6708da453d4bc6f04f8d4b3e5d010))
* **nav:** wait for the map load before reporting a warp ([bd2583f](https://github.com/frankstupak/lumen-plays-pokemon/commit/bd2583fbc21a5d874e85660c2e4c76c3c2fb2ecc))
* **notepad:** direction-aware corrector with deduped, staleness-swept pins ([cad4869](https://github.com/frankstupak/lumen-plays-pokemon/commit/cad4869680dea66b8881392ea5f9b5e6d6fe11e9))
* **notepad:** downgrade position-stamped nav-goal pins at write time ([d0308f7](https://github.com/frankstupak/lumen-plays-pokemon/commit/d0308f71051a0a362335d0602b36c7aef0162ea7))
* poll position stability after a warp instead of a fixed wait ([7692e3a](https://github.com/frankstupak/lumen-plays-pokemon/commit/7692e3a3e3b7c590ad4035040565fe3106862a73))
* read only the lpp service key in apiKey ([4359e6b](https://github.com/frankstupak/lumen-plays-pokemon/commit/4359e6bc5c4f9f1c3dd7578b080108e273221d9b))
* refuse cross-map targets, interior edges, retry burns ([3518f92](https://github.com/frankstupak/lumen-plays-pokemon/commit/3518f92c279148b6b9786a574f22413793b07def))
* soften resume viability gate to spare story progress ([9009abd](https://github.com/frankstupak/lumen-plays-pokemon/commit/9009abd54879e018f0e418188db5fcce96ea0888))
* stop guidance chasing east after Cerulean arrival ([f7c3814](https://github.com/frankstupak/lumen-plays-pokemon/commit/f7c3814bfaa6e0b15f9ce49ce7d6c37878e2ec16))
* survive EADDRINUSE + protect retention from crash loops ([af77d9d](https://github.com/frankstupak/lumen-plays-pokemon/commit/af77d9d4c3e45132f0e5acf45fef606160448998))
* **test:** keep the on-main probe set green across corpus rotation ([0ad6be1](https://github.com/frankstupak/lumen-plays-pokemon/commit/0ad6be1157d4aea7e8d6253ad89f5352a67e1c78))

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
