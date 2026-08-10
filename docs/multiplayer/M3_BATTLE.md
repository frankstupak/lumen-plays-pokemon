# M3 — Link Cable BATTLE (COMPLETE, verified 2026-08-10)

Two independent serverboy cores fight a real Gen1 Cable Club **link battle** over
our SerialBus, cold start to knockout. Every turn mirrors on both cores.

```
started=true ended=true turns=10 mirrored=10 rngMatch=true exchanges=843 winner=A
TURN  1: A picked 10/sees 10 hp 48(foe 57) | B picked 10/sees 10 hp 57(foe 48)
TURN 10: A picked 10/sees 10 hp 12(foe  0) | B picked 10/sees 10 hp  0(foe 12)
```

Entry point: `npx tsx src/link/drive_link_battle.ts` (standalone; never inside
the live service). Implementation: `src/link/battle.ts`.
Evidence: `evidence/m3-linkbattle-verified.log`.

---

## The verdict, and why it is this one

A link battle is verified by **mirroring**, which no single-core bug can fake:

- each side's `wPlayerSelectedMove` (`$CCDC`) must equal the other side's
  `wEnemySelectedMove` (`$CCDD`), and
- each side's `wBattleMonHP` must equal the other side's `wEnemyMonHP`.

Both cores also end up holding the same `wLinkBattleRandomNumberList` (`$D148`),
which the master generates and sends — identical lists prove the block crossed
our bus and make a link battle reproducible (research/link/R3).

```
rng list A=[120,233,92,209,72,193,59,183,53]
rng list B=[120,233,92,209,72,193,59,183,53]   match=true
```

**Sample only settled state.** The two cores run their damage animations a few
rounds apart, so at the instant both selections populate, one side has already
applied the hit and the other has not. An instantaneous HP comparison there
reports a mismatch that resolves itself one round later — it scored a correct
run 1/11. `LinkBattleSession` records a turn only after the HP tuple has held
still for `settleRounds`, so it compares like with like.

## ROM facts this depends on

Read out of `roms/pokeblue.gb` with `roms/pokeblue.sym`, not remembered.

**`LoadSpecialWarpData`, bank 1.** `$62FE` `cp $EF` selects TRADE CENTER,
`$6314` `cp $F0` selects **COLOSSEUM**. Seven bytes are copied to
`wCurMap` (`$D35E`) .. `wXBlockCoord` (`$D364`):

| spec | bytes | meaning |
|---|---|---|
| `$6438` colosseum, `$FFAA`==2 (master) | `f0 0b c7 04 03 00 01` | map `$F0` at (3,4) |
| `$6440` colosseum, friend | `f0 0d c7 04 06 00 00` | map `$F0` at (6,4) |

Those are the **same coordinates as the trade tables**, so both sides spawn
already standing where they need to be and only have to face each other.

**`CableClub_DoBattleOrTradeAgain`, bank 1 `$54D8`** — where trade and battle
diverge, and it pins the state values:

```
54D8  ld a,[wLinkState] / cp 3        ; 3 = start battle
54DD  ld a,$32 / ld [wLinkState],a    ; 50 = TRADING   (trade path)
54E2  jr nz,.trading
54E4  ld a,4   / ld [wLinkState],a    ; 4  = BATTLING
54E9  ld a,$E1 / ld [wCurOpponent],a  ; $E1 = link-battle opponent
```

So a link battle is `wLinkState` 1 → 3 → 4. **4 is BATTLING, not "reset"**,
whatever other numbering suggests. Confirmed in vivo: both cores sit at
`wLinkState` 4 with `wIsInBattle` 2 (trainer battle).

**The move list is ONE-INDEXED.** `wMenuWatchedKeys` (`$CC29`) is `$C3`
(UP|DOWN|B|A) and `wCurrentMenuItem` runs 1..4 over the four moves, with
`wPlayerSelectedMove` following the highlighted entry as the cursor moves.
Targeting slot 0 therefore never matches and the driver walks the cursor
forever — which is exactly what the first build did.

## Sequence that works

1. **Connect** — both sides walk to the attendant `(11,3)`, face UP, tap A
   through the dialog. A side already parked on the room menu gets **no** press;
   blind-tapping both desyncs them (wq#434).
2. **Room select** — walk to entry 1 (COLOSSEUM) with the cursor **read back**
   from `$CC26`, never counted. Entry 2 is CANCEL and selecting it drops the
   session.
3. **Settle** — 180 coarse frames after the warp. Without it both sides sit at
   `wLinkState` 1 forever; the presses land during the warp and do nothing.
4. **Party block** — fine-slice to ~one serial window (divisor 64) with
   `deferTicks = 1` and peer catch-up armed, stand on the spawn tiles, face
   RIGHT/LEFT, tap A. ~674 exchanges, both sides reach `wLinkState` 4 /
   `wIsInBattle` 2.
5. **Turns** — press a key ONLY on a menu that is waiting for one.

## The input law (same law as the trade nybble sync)

**Measured:** with A held on both sides the bus never moved past the party
block — exchanges frozen at 720 — while `wPlayerSelectedMove` cycled through all
four move ids forever. Move selection is exchanged through
`Serial_ExchangeLinkMenuSelection`, and a keypress during that window knocks a
waiting side out of the loop, so the selection is never agreed and the menu
simply reopens.

Battle narration is therefore **not** advanced with A at all:
`ManualTextScroll` has an in-link-battle path (`ManualTextScroll.inLinkBattle`)
that scrolls on a timer. Silence is correct; A is actively harmful.

**Silence needs a deadman.** A side that commits and then goes quiet forever
deadlocks the run on its own latch when the A did not dispatch. The nudge is
driven by **staleness** — screen and both HP values unchanged for `stuckRounds`
— not by a timer and not by `wEnemySelectedMove`, which stays populated from the
previous turn and would block a retry forever.

**A nudge must not be a blind A.** On the move menu that commits whatever
happens to be highlighted, which silently overrode the requested slot and made
both sides fight with move 1 regardless of configuration. The nudge un-commits
and falls back through the normal cursor logic.

## Test-fixture note

Differentiate the two sides by **trainer name, ID and nickname only — not by
level**. Rewriting `mon1Level` does not recompute the stat block, so the sending
side keeps its old HP while the receiving side recalculates from the level it
was sent; the two views of the same mon then disagree by construction and the
HP-mirror check reports a link fault that is really a fixture bug. Observed
directly: A read the foe at 57 HP while B's own mon sat at 31.

## Open items

- **Both sides currently pick the same move slot each turn.** The move mirror is
  still a real check (each side reads the other's id out of its own
  `wEnemySelectedMove`), but a run with differing slots would make it
  non-trivial. The plumbing is there: `SLOT_A` / `SLOT_B`.
- **Nudges fire roughly once per turn** on the move menu, i.e. the first commit
  press regularly fails to dispatch. It self-corrects, but the root cause is not
  established — worth a trace of what the ROM does with that first press.
- Single-mon parties only. Faint-and-switch (`ChooseNextMon.notLinkBattle`) is
  untested, and M4 will need it.
