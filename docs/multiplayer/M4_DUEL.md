# M4 — DUEL: two brains, two BrainProfiles, one link cable (COMPLETE 2026-08-10)

Two independent Game Boys, each driven by its **own model**, fighting a real
Gen1 Cable Club link battle over our SerialBus.

```
*** DUEL VERIFIED — cerebras-oss-120b vs deepseek-v4-flash, winner B ***
started=true ended=true turns=6 mirrored=6 rngMatch=true exchanges=1250
  A cerebras-oss-120b: calls=7 parsed=7 rejected=0 picks=[0,0,7,0] tok=2007+565 avg=259ms
  B deepseek-v4-flash: calls=7 parsed=7 rejected=0 picks=[6,0,1,0] tok=1543+817 avg=2085ms
```

The two models played visibly different games: Cerebras committed to EMBER every
turn, DeepSeek preferred SCRATCH and switched to EMBER once. A longer earlier run
(20 turns, `evidence/m4-duel-full-20turn.log`) shows the same split and the
asymmetric picks crossing the cable:

```
TURN 4: A picked 52/sees 10 | B picked 10/sees 52 | mirror=true
```

Each side picked a different move and read the *other's* move out of its own
`wEnemySelectedMove`. That is the move-exchange proof the same-slot runs could
not give.

Entry point: `npx tsx src/link/drive_duel.ts`. Evidence:
`evidence/m4-duel-verified.log`.

## Configuration (no code edits — the wq#426 rule)

```
LPP_DUEL_A_MODEL / LPP_DUEL_B_MODEL     any LiteLLM alias (qwen36-local,
                                        cerebras-oss-120b, deepseek-v4-flash,
                                        isis-qwen3-32b, hapi-* when it lands)
LPP_DUEL_A_MAXTOK / LPP_DUEL_B_MAXTOK   output budget per side
LPP_DUEL_A_EFFORT / LPP_DUEL_B_EFFORT   low | medium | high
DUEL_PORT                               duel grid stream (omit = no server)
ROUNDS, FINE, SNAP                      session knobs
```

All calls go through the LiteLLM gateway on `localhost:4000`, like everything
else in the fleet.

## The design rule that keeps this safe

**A brain may only ever choose a move SLOT.** It never touches keys, timing or
the bus. Everything the link depends on — the no-input window during the
selection exchange, the one-indexed move cursor, the staleness deadman — stays
inside `LinkBattleSession`, where M3 verified it. A confused or slow model can
lose the battle; it cannot desync the cable.

The hook is `pickMove(view) => slot`, and **it is called from the move menu, not
the battle menu**. The battle menu is on screen for only a few rounds between
turns and the driver often steps straight past it; a hook there fired about once
per battle. The emulators do not advance while a request is in flight — both
cores are stepped only after both sides' keys have resolved — so a slow model
costs wall-clock time and nothing else.

`pickMove` is keyed on the TURN NUMBER, not a boolean latch. An un-dispatched
commit press un-commits the side, and a boolean would re-ask (and re-bill) the
brain for a turn it had already decided; the 20-turn run shows those duplicate
calls before the fix.

## Two measurement bugs worth remembering

**Double-escaped regex.** The slot parser was written into the file through a
shell heredoc as `/MOVE\s*([1-4])/` with a doubled backslash, so it matched a
literal `\s` and rejected *every* reply. The logs showed both models answering
`MOVE 3` correctly while the harness scored 0 parsed / 100% fallback — i.e. a
run that looked like a model-quality problem and was entirely a harness bug. The
fix came from logging the rejected reply text; rejecting silently would have
hidden it.

**Torn sampling, again.** Settled HP is necessary but not sufficient: a side can
pause mid damage animation with its HP momentarily still. A turn is now recorded
only when both sides are **back on a menu** as well as settled — the only moment
the two RAM views are directly comparable. Before that, a correct 20-turn duel
scored 13/20 mirrored, with every "false" immediately followed by a "true"
carrying the same numbers.

## The grid

`src/link/duel_stream.ts` serves both screens side by side with per-side HUD
(model, HP bar, last move, turn, tokens) and a pick log, over one HTTP+WS
server. Deliberately **separate from `src/stream.ts`**: that server is wired
into the live single-player service and its page assumes one screen, so forking
a small dedicated server costs a hundred lines and keeps the live kiosk
untouchable. Same throttling discipline — 10fps per side, skip clients whose
send buffer is already deep, keep the freshest frame for `/snapA.png` pollers.

## Status of the former open items (2026-08-10)

**Species names — CLOSED.** `src/link/species.ts` reads `MonsterNames`
($07:421E) straight out of the running cart: 10 bytes per entry, internal index
order starting at 1, 190 entries. Nothing is hardcoded, so the names always
match the ROM actually loaded and there is no list to drift. Verified against
known internal indices — `$01` RHYDON, `$15` MEW, `$54` PIKACHU, `$99`
BULBASAUR, `$B0` CHARMANDER, `$B2` CHARMELEON. RHYDON at index 1 is the tell
that the table is internal-ordered rather than Pokedex-ordered. Prompts now read
`a CHARMELEON (#178)` instead of `species #178`; the number is kept alongside
the name since it is still the value in RAM. Unknown indices degrade to
`SPECIES_n` rather than throwing.

**Nudges — root cause found**, and it is a link-clock problem, not a keypress
problem. See `M3_BATTLE.md`: SC shows the follower armed and the master idle,
and the nudge is what makes the master issue a clock. Nudging *sooner* is a
measured regression.

- **Single-mon parties.** Faint-and-switch (`ChooseNextMon.notLinkBattle`) is
  still untested and a multi-mon duel needs it.
- **Local models untried in a duel.** `qwen36-local` runs ~12 tok/s on CPU, so a
  turn costs minutes; it is the obvious first tenant of hapi-1 when the blade
  boots. Hardware-gated, not code-gated.
