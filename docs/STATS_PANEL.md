# Kiosk trainer-stats panel (wq#503)

The tablet shows the game frame, a small HUD and the power bar. At the kiosk's
measured 1368x912 CSS viewport the game frame is height-bound at 833x750px,
which left roughly 314px of horizontal dead space. This panel fills it with
trainer progress, and with a stuck signal an observer across the room can act
on.

## The one rule

**Every value is read from RAM, from the ROM, or from an existing ledger.**
Nothing is inferred, remembered from a prompt, or filled in "close enough".
Where a value is unavailable the panel shows `--`, and where a name cannot be
resolved it shows the raw id (`MAP 11`). A raw id is a fact; a plausible-looking
invented name is the failure this ticket exists to prevent.

## Where each field comes from

| Panel field | Source | Notes |
| --- | --- | --- |
| Location name | `MapHeaderPointers` (00:01ae) + `MapHeaderBanks` (03:423d) | Pointer is reverse-looked-up in the symbol table; pokered labels every header `<Name>_h`. Map 59 -> `MtMoon1F_h` -> "Mt Moon 1F". |
| Map id / x / y | `wCurMap`, `wXCoord`, `wYCoord` | Shown small, under the name. |
| Badges | `wObtainedBadges` | Count = popcount. Names in pokered badge-constant order; bit 0 is RAM-verified (badge bit set while `EVENT_BEAT_BROCK` is set). |
| Pokedex owned / seen | `wPokedexOwned`, `wPokedexSeen` | Popcount over `[start, *End)` — the length comes from the `*End` symbols, not a literal. |
| Money | `wPlayerMoney` | 3-byte BCD, as the existing HUD already decoded. |
| Play time | `wPlayTimeHours` / `Minutes` / `Seconds` | `wPlayTimeMaxed` sits between hours and minutes, which is what proves hours is one byte rather than a word. |
| Party species | `MonsterNames` (07:421e), 10 bytes/entry | Indexed by INTERNAL species id - 1, not the Pokedex number (internal 0xB2 = Charmeleon, dex #5). |
| Party level / HP / status | `wPartyMon*` via `StateReader` | Status bits per pokered: 0-2 sleep, 3 poison, 4 burn, 5 freeze, 6 paralysis. |
| Story score | `STORY_FLAGS` popcount (wq#471) | Shown as `n/25`. |
| Objective | first `GOAL:` line in the guidance channel (wq#486) | The same text the brain was handed this turn. |
| Milestone | a `STORY_FLAGS` bit turning on | Never a dialog line and never a brain claim. See "seeded" below. |
| Pace | `tools/lpp-stats --json` | Reused, not reimplemented — two implementations of one rate is how the tablet ends up contradicting the board. |
| Stuck | in-process loop watch + `lpp-sentinel` state | See below. |

ROM table LENGTHS are derived with `SymbolTable.nextAddr()`, so a different ROM
build throws at boot instead of quietly reading past the end of a table.

## Milestones and the "seeded" flag

A milestone is recorded when a story flag transitions from clear to set while
the tracker is watching. Flags that are already set the first time the tracker
looks — everything earned before this process started, including everything
that arrives with a resumed checkpoint — are recorded as `seeded`, and the
panel says "first seen" rather than "reached". The tracker knows when it
noticed a flag; it does not know when the player earned it, and it will not
pretend otherwise. The ledger persists to `runtime/milestones.json` so a
service restart does not erase the history.

## Stuck signal

Two independent triggers, either of which raises the red banner:

1. **Loop watch** (in-process): same map, and the position bounding box stays
   within 3 tiles across the last 20 turns. Deliberately identical to the
   `loop` check in `tools/lpp-sentinel` (wq#489) so the tablet and the ntfy
   alert can never disagree about what stuck means. Battle-only `state_read`s
   carry no map/x/y and are skipped — standing still through a long battle is
   not a loop.
2. **Sentinel alerts**: any key in `runtime/sentinel_state.json` fired within
   the sentinel's own one-hour dedupe window. Read-only; the sentinel owns
   that file.

## Endpoints

| Path | Cadence | Contents |
| --- | --- | --- |
| `/names.json` | once per page load | map, species, badge and status tables (static per ROM) |
| `/progress.json` | every 10s | story score, objective, milestone, rates, stuck |
| `/viewport` | once per page load (write), any time (read) | the kiosk's self-reported geometry |

The RAM-fast fields ride the existing `state_read` event instead of a poll, so
the panel updates the instant the game does, and the event stream stays numeric
— names live in `/names.json`, which keeps the ticker underneath readable.

`/viewport` exists so the layout is never argued from an assumed resolution:
the page reports its own `innerWidth`/`innerHeight`/`devicePixelRatio` plus the
rendered game and panel widths, and the server hands the last report back.

## Not shrinking the game frame

`#game { flex:none }`. The panel is a flex sibling, so without that the browser
is free to shrink the game to make room. This makes the requirement structural
rather than an arithmetic coincidence that holds only at one viewport size.

## Verification

- `npx tsx src/probe_names.ts` — 48 checks: name tables, decode, prettifier,
  stuck-detector false-positive guards, milestone seeding.
- `npx tsx src/probe_panel.ts` — 20 checks: endpoint shapes on a spare port
  (8899, never the live 8871), including the null-provider boot path.
