# ROM battle tables (wq#1180)

Item 4 of the LPP improvement plan. `src/romtables.ts` decodes **Moves**,
**TypeEffects** and **BaseStats** out of `roms/pokeblue.gb` through the pret
symbol table, and `src/moves.ts` runs on the decoded move table instead of the
25 moves someone typed in by hand for wq#587.

This is foundation work. Nothing here decides anything; it removes the guessing
that the winnability verdict (item 5) would otherwise be built on top of.

## What was wrong

`moves.ts` knew 25 of the game's 165 moves. For the other 140 `pickBestMove`
assumed `power = 30`, so:

- every TM and every level-up move past Cerulean was a guess, in a run whose
  whole remaining campaign is past Cerulean;
- `lockIn` — the wq#587 flag that stops the harness picking a move which takes
  the menu away — covered DIG, RAGE and BIDE. Gen 1 has **fifteen** such moves.
  FLY, SOLARBEAM, HYPER BEAM, THRASH and the whole WRAP family read as ordinary
  attackers, and each one is a wedge the moment the party learns it;
- there was no type chart at all, so "is this move any good against that foe"
  had no answer even in principle.

## Layout

Every length is derived from `SymbolTable.nextAddr()`. Nothing below is a
literal in the code; the numbers are here for orientation only.

| Symbol | Where | Stride | Count | Contents |
|---|---|---|---|---|
| `Moves` | `0e:4000` | 6 | 165 | id, effect, power, type, accuracy, PP |
| `MoveNames` | `2c:4000` | var | 165 | `0x50`-terminated Gen 1 text |
| `TypeEffects` | `0f:6474` | 3 | 82 + terminator | attacker type, defender type, multiplier ×10 |
| `BaseStats` | `0e:43de` | 28 | 150 | dex#, HP/Atk/Def/Spd/Spc, both types, catch rate, base exp |
| `MewBaseStats` | `01:425b` | 28 | 1 | Mew, which the ROM itself keeps out of the main table |
| `PokedexOrder` | `10:5024` | 1 | 190 | internal species id → Pokedex number |

Two things that bite:

- **Accuracy is stored as `pct * 255 / 100`.** 100% is `255`, 95% is `242`.
  `RomMove` carries both the rounded percentage and the raw byte, because the
  Gen 1 hit test rolls against the byte.
- **RAM holds internal species ids, `BaseStats` is in Pokedex order.**
  Charmeleon is internal `0xB2` and dex #5. `PokedexOrder` is the ROM's own
  translation, so `decodeBaseStats()` returns the table keyed both ways and
  nothing has to transcribe the mapping.

`MoveNames` is the last symbol in its bank, so `nextAddr()` cannot bound it.
The decoder parses exactly as many names as there are move entries and treats
running out early as an error — the same alignment check from the other side.

## Fail-closed contract

`loadRomTables(rom, sym)` decodes all three, checks each against a small set of
hand-checkable Gen 1 facts (`GOLDEN_MOVES`, `GOLDEN_TYPE_EFFECTS`,
`GOLDEN_BASE_STATS`), and **drops any table that disagrees**, recording why in
`problems`. It never throws. The three are independent: a bad type chart costs
the harness the type chart, not the move table.

The hand-typed table did not disappear, it was demoted. It lives on as
`GOLDEN_MOVES`, whose two remaining jobs are to catch a misaligned decode and to
be the fallback when it catches one. **It must not grow** — a 26th entry would
be a hand-typed fact about a ROM we now read directly.

When no verified table is installed, `moveMeta()` answers out of that fallback,
which is exactly the behaviour that shipped before this ticket: worse coverage,
never wrong coverage. `moveTableSource()` says which one is live.

The anchors are not decoration. `Moves` and `BaseStats` sit back to back in bank
`$0e`; an off-by-one in the entry stride reads plausible numbers for hundreds of
entries before it reads anything obviously wrong. Both decoders also check each
entry's self-identifying byte (a move's animation id equals its move id; a base
stat entry's first byte is its own dex number), which is what actually pins the
alignment.

`GOLDEN_TYPE_EFFECTS` deliberately anchors the two matchups Gen 1 gets wrong —
`GHOST -> PSYCHIC` is ×0 and `PSYCHIC -> GHOST` is neutral — so a chart
transcribed from any later generation fails the check instead of shipping.

## Install points

`installRomMoves(rom, sym)` is called from the `Agent` constructor
(`src/agent.ts`), which covers the live agent and every probe that builds one,
and from `src/link/drive_duel.ts`, which drives duels without an `Agent`. Both
log a one-line summary; the `Agent` also emits a `rom_tables_loaded` tool_call
event carrying `problems`, so a run that silently fell back to 25 moves is
visible in the event log rather than only in the moves it goes on to choose.

`Agent.romTables` holds the whole result. The type chart and base stats have no
consumer yet — they are there for item 5.

## Probes

- `src/probe_romtables1180.ts` — **CI-safe** (`scripts/probes-pure.sh`). Opens
  only `roms/pokeblue.sym`, which is tracked. Covers the symbol layout, the
  fail-closed detection (a synthetic all-zero ROM must drop all three tables and
  say so), the fallback path, and `typeMultiplier` composition.
- `src/probe_romdecode1180.ts` — needs `roms/pokeblue.gb`, so it runs on the
  Lumen host only (`scripts/probes-main.sh`). Checks the decoded tables against
  Gen 1 values a person can look up, and walks the harness across the boundary:
  before install `SKY ATTACK` is `MOVE143` at assumed power 30, after install it
  is a named 140-power lock-in.
