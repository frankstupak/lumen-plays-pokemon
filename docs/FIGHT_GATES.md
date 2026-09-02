# Winnability verdict + fight loss gates (wq#1181)

Items 5 and 6 of `kb/lpp-improvement-plan.md`, the two halves of
`FIGHT_LOSS_LOOP`:

| Half | Question | Module |
|---|---|---|
| In-battle (item 5) | can I win the fight I am in? | `src/calc.ts`, `src/battle.ts`, `src/softlock.ts` |
| Re-entry (item 6) | should I walk back into the fight I lost? | `src/ledger.ts`, `src/guidance.ts`, `src/agent.ts` |

Zero new model calls. Every decision here is deterministic harness code; the
verdict replaces brain deliberation on turns where the answer is computable.

## Item 5 — the damage calc and the verdict

`calc.ts` implements the Gen 1 formula with its truncations in the cartridge's
order, plus the Gen 1 type chart (including the quirks: Poison↔Bug both super
effective, Ghost does nothing to Psychic, Fire does not resist Ice). Inputs come
from RAM that the engine has already normalised — `wBattleMon*` / `wEnemyMon*`
hold effective stats after stat stages and badge boosts — so there is no
stat-stage math and no species table.

`winnability()` computes the exchange **twice**, and that asymmetry is the whole
design. Each claim is evaluated against the assumption that would refute it:

- **UNWINNABLE** only if I lose at my best damage roll (255) against the foe's
  worst (217), crediting a sleeping/frozen foe one free turn.
- **WINNABLE** only if I win at my worst roll against the foe's best, with no
  status credit and with a speed tie counted against me.
- Everything else is **CLOSE**, which forces nothing and says so out loud —
  which is precisely where a level threshold would have said "you are ready".

Fail-closed on data: any move whose metadata is missing drops confidence to
`low` and downgrades UNWINNABLE to CLOSE. An unknown move might be the one that
wins the fight.

### The soak week is a property of the code

The roadmap rates item 5 Medium risk and asks for advisory-only first.
`CFG.winnability.force` (`LPP_WINNABILITY_FORCE`) **defaults to 0**. While it is
off, every battle turn still emits a `winnability` event carrying the verdict
*and* the action it withheld (`withheld: "advisory mode (...)"`), so the soak
produces exactly the log the flip should be argued from:

```
jq -r 'select(.kind=="winnability") | [.verdict,.confidence,.force,.withheld] | @tsv' \
  events/live-agent-*.jsonl | sort | uniq -c
```

Flipping `LPP_WINNABILITY_FORCE=1` in the systemd unit is the whole change — no
redeploy, no code edit to revert. Forcing additionally requires `confidence:
"high"`, and only ever flees a **wild** battle; Gen 1 forbids fleeing a trainer.

## Item 6 — the loss ledger and its gates

`ledger.ts` records every **trainer** fight keyed `(wCurOpponent, wTrainerNo,
map)` in `runtime/fight_ledger.json`. Wild fights are deliberately not ledgered:
a gate is a refusal to walk back into a place, and gating Route 24 grass because
a Rattata got lucky would ban the very grind the gate is asking for.

A loss is detected by its **durable consequence**, not by catching the
all-fainted window — `blackout.ts` measured zero sightings of that window in
1285 state reads. Money halving plus a Centre/restored corroborator is what
fires, with a few turns of grace because the halving lands behind the white-out
dialog.

A live gate refuses `enter_warp` into that map (and drops a transit goal aimed
at it, so an interrupted goal cannot walk around the gate).

### Every gate expires — four ways

This is the wq#517 lesson, where a guard that could not lift wedged the campaign
on the map it had banned. A gate lifts when **any** of these holds:

1. party `levelSum` rose by `GATE_LEVEL_RISE` (3) since the loss — the intended exit;
2. `GATE_TTL_MS` (6h) of wall clock passed — the "we were wrong about why" exit;
3. a pre-engagement estimate flipped to WINNABLE — the data exit;
4. the gate has already refused `GATE_MAX_FIRES` (10) times — the anti-wedge
   exit: a gate that keeps firing is not steering, it is stuck, so it gives up.

Winning the fight clears it outright. There is no code path that produces a gate
without an expiry, and `probe_ledger1181.ts` section B walks all four plus the
"no ctx produces a gate with no exit" property.

The refusal text always states all three remaining exits (level target, minutes
left, refusals left). A rule the brain cannot see an exit from is how wq#517
wedged.

### Grind governor

Grinding is a justified state, not a default. It is evaluated only while a loss
gate is live — the state the harness itself put the agent into — and asks
whether `levelSum` actually moved over the last `GRIND_WINDOW_TURNS` (30). A
partial window is justified by construction, exactly as `novelty.ts` refuses to
call a partial window flat. When the rate collapses, `grindPressure()` escalates
(`` → `!` → `!!`) and points at the story objective. When the gate *lifts*,
`gateLiftedLine()` says so for a bounded five turns: the lift is the moment
grinding stops being justified, and the live failure this item exists for is an
agent that kept doing the thing it was told to do long after the reason had
gone.

## Item-4 dependency, and what is still owed

Roadmap item 4 (ROM decodes for `Moves`, `TypeEffects`, `BaseStats`, wq#1180)
had **not landed** when this shipped — its branch was empty of commits — so
this work builds against injected interfaces rather than duplicating the decode:

- `MoveSource` — defaults to the ~34-move hand-typed table in `moves.ts`. Until
  item 4 lands, most movesets contain an unknown move, so most verdicts run at
  `confidence: "low"` and **cannot force**. This is the intended degradation,
  not a bug: it also means the soak week measures the advisory quality of a
  partial table.
- `TypeChart` — defaults to `TYPE_EFFECTS`, transcribed from pret/pokered
  `data/types/type_matchups.asm` in the ROM's own `[atk, def, x10]` triple
  shape. It is **unverified against the cartridge** (`roms/*.gb` is untracked);
  item 4's decode is the verification path and drops in through
  `chartFromTriples()` unchanged.
- `GateCtx.estimate` — the pre-engagement roster estimate (expiry 3) needs
  item 4's `BaseStats` to be produced from a decoded trainer roster. Until then
  the caller passes nothing and expiries 1/2/4 carry the gate.

When item 4 lands, wiring it is two call sites in `battle.ts` and one in the
gate context. Nothing in `calc.ts` changes.

## Verification

`npx tsx src/probe_calc1181.ts` — 60 checks: type chart semantics including the
Gen 1 quirks, hand-computed damage values against the formula, a known
unwinnable wild matchup verdicting UNWINNABLE with a withheld force, a known
winnable one verdicting WINNABLE with no directive noise, CLOSE as a real
answer, immunity/all-status as certain UNWINNABLE, and the fail-closed path.

`npx tsx src/probe_ledger1181.ts` — 57 checks: record/gate/persistence across a
reboot, all four expiries through both the pure predicate and the live ledger,
win-clears-gate, corrupt and unwritable files degrading instead of throwing, the
grind governor, and the prose stating every exit.

Both are in `scripts/probes-pure.sh` (no ROM, no emulator, CI-safe).

## Rollback

- `LPP_WINNABILITY=0` — no verdict rendered, no `winnability` events.
- `LPP_WINNABILITY_FORCE=0` (the default) — verdict is advisory only.
- `LPP_FIGHT_GATE=0` — outcomes are still recorded, nothing is ever refused.
- Deleting `runtime/fight_ledger.json` drops the loss history and every gate
  with it; the next fight rebuilds it. Nothing else reads the file.
