# Streamer chat and persona memory (wq#1176)

Two features that only make sense together. The chat gives Lumen a voice on the
stream; the persona store makes what he says with it binding.

## Chat is one-way, on purpose

Lumen talks to the audience. The audience cannot talk back — not yet.

That is enforced by the code, not by a note in a README:

- `src/chat.ts` exposes `say()` and `system()` and nothing that accepts an
  outside message. `src/probe_chat.ts` asserts the absence of an inbound method
  by name, so adding one trips a probe rather than sliding in.
- `/chat.json` on the kiosk server answers `GET` only; anything else gets
  `405`. There is no request shape that puts a message in the panel.

Two-way chat is a later ticket, and it arrives by ADDING an inbound path —
never by someone discovering that one was already half-wired.

### How a line gets spoken

The brain's reply now carries an optional third line:

```
ACT: goto(4,7)
THINK: heading for the mart door
SAY: Almost out of Potions, wish me luck.
```

`SAY:` costs **no game turn**. Turns are the scarce resource in this project,
and an audience feature that competed with gameplay for them would be paid for
in badges. The line is parsed from the same completion as `ACT:` and posted
before the tool call is dispatched, so feedback lands in the same turn.

`StreamChat` rate-limits Lumen's own lines (`LPP_CHAT_MIN_INTERVAL_MS`, default
45s). The emulator runs many turns a minute; unthrottled, the panel would be a
wall of text nobody can read. A refused line is reported back to the brain with
its reason — silently dropping it would teach the brain that `SAY` does nothing.

Harness lines (`system()`) are not rate limited and render dimmed: they are
posted on events, not on turns.

## The overlay

The bottom strip is now two columns: the harness ticker keeps the leftover
width, and `LUMEN SAYS` takes a fixed 34% (min 220px, max 460px) on the right,
newest at the bottom. The game frame is untouched — the chat is paid for out of
the ticker's width, not out of `#top` — so the `flex:none` rule that wq#503
made load-bearing still holds.

The panel header shows how many persona facts are remembered, which is the only
place an observer can see the memory working without reading a log.

Chat arrives over the WebSocket and is deduped by message id (two identical
lines minutes apart are two real things he said), with a 5s poll of
`/chat.json` as the fallback the CF-tunnel path has always needed. Message text
is rendered with `textContent`, never `innerHTML`: it is model output.

## Persona memory: canonical, and cross-platform

`src/persona.ts` stores what Lumen has said about **himself**. It is not the
notepad. The notepad is about the game and goes stale by design ("my HP is
low"); a persona fact must never go stale. If he tells the stream his favourite
Pokémon is Bulbasaur, the answer he gives on Messenger three weeks later has to
be Bulbasaur, or he is not a character, he is a chatbot.

**One file is the whole cross-platform mechanism.** `CFG.persona.path`
(`LPP_PERSONA_PATH`, default `/home/lumen/pokemon/runtime/persona.json`) is read
and written by every surface that speaks as Lumen. It deliberately does not live
under `events/` or `checkpoints/`: those are swept by retention, and a persona
fact must outlive every run that produced it. `persona.ts` imports nothing from
the emulator, the ROM, or any LPP type, so a surface that knows nothing about
Pokémon can still recall the persona.

### What becomes canonical

Extraction is deliberately narrow. A false canonical fact is worse than a missed
one: it is a lie the character then has to keep telling.

| Said | Slot | Kind |
| --- | --- | --- |
| `My name is Lumen` | `my name` | single-valued |
| `My favourite pokemon is Bulbasaur` | `my favorite pokemon` | single-valued |
| `I go by Lumen` | `my name` | single-valued |
| `I was built by Frank` | `i was built` | single-valued |
| `I like caves` | `i like` | set-valued |
| `I don't like Zubat` | `i do not like` | set-valued |
| `I am an AI` | `i am` | set-valued |

Rejected on purpose: volatile attributes (`my hp is 12`, `my party is weak`),
passing states (`I am at Viridian`, `I am heading to Mt Moon`), anything in the
third person, and anything that is not a first-person self-statement.

Slots fold spelling variants (`favourite`/`favorite`, `pokémon`/`pokemon`), or
the same question would have two canonical answers and no contradiction between
them would ever be detected.

### Canonical means first

A single-valued slot restated with a **different** value does not overwrite.
The original stands, the contradiction is recorded on the fact, and the caller
gets a notice it can hand back to the brain:

```
! PERSONA: you already told people my name is "Lumen" (said 3x since 2026-09-02,
on messenger). "Ash" contradicts it — the original stands. Stay consistent.
```

Last-write-wins would let the character drift wherever the most recent turn
happened to point, which is the failure the store exists to prevent. Set-valued
slots accumulate instead: liking two things is not a contradiction.

The prompt carries the facts back in a `PERSONA` block, ahead of the notepad —
a contradiction there is permanent, while a stale note is not.

### Other platforms

`src/persona_cli.ts` is the door for anything that is not this repo's TypeScript:

```bash
npx tsx src/persona_cli.ts state "My name is Lumen" --platform messenger
npx tsx src/persona_cli.ts ask "favourite pokemon" --json
npx tsx src/persona_cli.ts recall          # the block to paste into a prompt
npx tsx src/persona_cli.ts list
```

`state` exits `3` when the sentence contradicted an existing canonical fact, so
a bridge can react without parsing prose. `/persona.json` on the kiosk server
serves the same store read-only.

## Configuration

| Env | Default | Effect |
| --- | --- | --- |
| `LPP_CHAT_ENABLE` | `1` | `0` = no chat; `SAY:` lines are ignored |
| `LPP_CHAT_MIN_INTERVAL_MS` | `45000` | spacing between Lumen's lines |
| `LPP_CHAT_RING` | `60` | messages kept for the overlay |
| `LPP_PERSONA_ENABLE` | `1` | `0` = nothing recorded, no `PERSONA` block |
| `LPP_PERSONA_PATH` | `/home/lumen/pokemon/runtime/persona.json` | the shared store |
| `LPP_PERSONA_PLATFORM` | `stream` | platform recorded for the agent's own lines |
| `LPP_PERSONA_RECALL_BUDGET` | `900` | chars of persona per prompt |

## Probes

`src/probe_persona.ts` (38 checks) and `src/probe_chat.ts` (21 checks) are pure
logic — no ROM, no emulator, no network — and run in `scripts/probes-pure.sh`,
so CI covers both.
