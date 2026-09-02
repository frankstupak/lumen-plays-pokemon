# Winnability verdict + loss ledger (wq#1181)

Two halves of one answer to `FIGHT_LOSS_LOOP`, the campaign's most expensive
stall: walk into a gym, lose, heal, walk back into the gym, lose.

- **Item 5 — winnability.** Before the fight is lost, say it is unwinnable.
- **Item 6 — the loss ledger.** After it is lost twice, stop walking back in.

Both are pure arithmetic over RAM the harness already reads. **Zero new model
calls.**

## Item 5: the damage calc and the verdict

`src/calc.ts` is the Gen 1 damage formula, `src/battle.ts`'s
`Battle.winnability()` is the verdict.

Nothing here needs a species base-stat table: Gen 1 keeps the **computed** stats
of both combatants in WRAM, so `Battle.state()` reads Attack/Defense/Speed/
Special and both type bytes for both sides straight out of the battle struct
(`wBattleMon*` / `wEnemyMon*` in `roms/pokeblue.sym`), along with the enemy's
moveset (`wEnemyMonMoves`).

The verdict compares two clocks — turns for us to KO it, turns for it to KO us —
respecting who moves first and what the bag can heal:

| Situation | Verdict |
|---|---|
| No move of ours deals a point of damage | `flee`, high confidence |
| It cannot damage us | `fight` |
| We KO it before it KOs us (speed and potions counted) | `fight` |
| It out-races us | `flee` |
| Battle RAM not settled, stats unreadable | `unknown` (hand back to the brain) |

Conservative on purpose, in one direction: the only action a verdict may force
is a **flee**, so every unknown resolves toward staying in the fight.

- An unknown MOVE becomes a neutral 30-power stand-in — it can make a fight look
  winnable, never unwinnable.
- An unknown type is neutral, never an invented immunity.
- Bag heals are counted at full stock, ignoring the turns spent using them.
- A speed tie counts as losing the tie.
- Any stand-in on the foe's side drops the verdict to **low confidence**, and
  low confidence never forces.

### Soak posture (Fable: Medium risk)

`CFG.winnability.force` is **OFF**. Until it is turned on, the verdict is a line
in the state block plus a `winnability` event on every flee verdict — nothing
else. That event carries both turn counts, the confidence, and a `forced` flag
saying what *would* have happened, which is the raw material for deciding
whether forcing is safe.

Flip `LPP_WINNABILITY_FORCE=1` only after a soak week shows the flee verdicts
matching reality. Even then it forces only a **wild** flee, only on a
**high-confidence** verdict, and only inside transit — trainer battles have no
exit and are never touched.

`LPP_WINNABILITY=0` disables the verdict outright.

### The item-4 seam

`src/moves.ts` (move power/type) and `calc.ts`'s `GEN1_MATCHUPS` (the type
chart) are static tables. The chart is transcribed from pokered
`data/types/type_matchups.asm` and is **not** ROM-verified here — `roms/` ships
only `.sym` files. `setTypeChart()` exists so wq#1180's decoded table replaces it
at boot with no change to any caller.

## Item 6: the loss ledger, engagement gates, the grind governor

`src/ledger.ts`. `guidance.ts`'s `mistyGymEntryRefusal` is one leader with
hardcoded thresholds; `engagementRefusal` is the same idea with the leader's name
taken out. Any engagement lost twice arms a gate that refuses re-entry, keyed by
map (`trainer:65`, `wild:36`) — the map id is the one identifier available both
mid-battle and at the door.

The loss signal is wq#547's `BlackoutDetector` — a halved purse plus a
corroborator — and deliberately **not** an all-fainted party read: wq#547
measured 1285 party-carrying state reads and found the all-fainted window in
zero of them, because Red heals and warps you inside one poll interval. In Gen 1
every battle loss ends in a blackout, so the blackout *is* the loss. It lands a
turn or two after the battle, so the engagement is remembered past its own end,
and a battle that ends becomes a **pending win** that only banks once two turns
pass with no blackout attributed to it. Banking it on the spot would reset the
loss run the blackout is about to add to, and the gate would never arm.

### Every gate expires — three ways

This is the wq#517 lesson: a gate whose only release is the thing it blocks is a
permanent gate.

1. **Time.** `gateUntil` is an absolute deadline (default 45 min).
2. **Progress.** The gate stores the progress signature that armed it —
   `L<level>/P<party>/B<badges>/E<events>`. Any change releases it immediately;
   the thing the gate asked for has happened.
3. **Arm cap.** After 3 gates on one key, that key never gates again. If three
   grind cycles did not fix the matchup, the gate is not the remedy and blocking
   further attempts is pure turn-waste.

A win on the key clears it outright.

### The grind governor

A gate without a bounded remedy is a wall. Arming a gate starts a grind with an
explicit finish line **and its own deadline** — grinding forever is the same
turn-waste as losing forever. It ends on the level target (+2), on a new party
member, or on its deadline (60 min), whichever lands first, and the current
target and remaining budget are rendered into the state block every turn.

### Knobs

`CFG.lossLedger`: `LPP_LOSS_LEDGER` (0 disables), `LPP_GATE_AFTER`,
`LPP_GATE_TTL_MS`, `LPP_GATE_MAX_ARMS`, `LPP_GATE_WINDOW_MS`,
`LPP_GRIND_LEVELS`, `LPP_GRIND_MAX_MS`.

The ledger persists to `runtime/loss_ledger.json` so a gate survives the agent
reboot a whiteout usually triggers.

## Tests

`src/probe_calc1181.ts` (pure — no ROM, no emulator, in the CI subset
`scripts/probes-pure.sh`): a known-unwinnable matchup verdicts `flee`, a
known-winnable one `fight`, and all three gate expiries plus all three grind
exits fire.
