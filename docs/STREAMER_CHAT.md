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

**The fleet store is the whole cross-platform mechanism (wq#1191).** Facts live
in `lumen_state` — Minerva's bi-temporal store — under subject
`CFG.persona.subject` (`LPP_PERSONA_SUBJECT`, default `lumen-persona`). Any
surface, any language, any process reads them:

```bash
python3 /home/lumen/minerva/lumen_state.py current lumen-persona
python3 /home/lumen/minerva/lumen_state.py history lumen-persona my_favorite_pokemon
```

wq#1176 shipped this as a JSON file inside this repo, readable only by an
LPP-local CLI. That is the single-platform silo the requirement forbids, so the
storage layer was replaced: `src/persona_store.ts` talks to lumen_state through
`tools/lumen_state_json.py`, and `CFG.persona.path` is now only the old file's
location, migrated once on the first boot that finds it and then renamed aside.

One slot is one predicate (`my_favorite_pokemon`). A set-valued slot carries its
value in the predicate (`i_like__caves`), because lumen_state keeps one open row
per predicate and a second "i like" must not evict the first.

### What becomes canonical

The mechanism is a model; the narrowness is policy. After every line Lumen
speaks, `src/persona_llm.ts` asks the cheap rung (`deepseek-v4-flash`,
`LPP_BRAIN_PERSONA`) whether he asserted a durable fact about himself — his
past, possessions, preferences, relationships, opinions, places. Four regexes
run first as a free fast path, and every proposal from either route passes the
same guards (`buildClaim`). A false canonical fact is worse than a missed one:
it is a lie the character then has to keep telling.

| Said | Slot | Kind | Route |
| --- | --- | --- | --- |
| `My name is Lumen` | `my name` | single-valued | regex |
| `My favourite pokemon is Bulbasaur` | `my favorite pokemon` | single-valued | regex |
| `I go by Lumen` | `my name` | single-valued | regex |
| `I was built by Frank` | `i was built` | single-valued | regex |
| `I like caves` | `i like` | set-valued | regex |
| `I don't like Zubat` | `i do not like` | set-valued | regex |
| `I am an AI` | `i am` | set-valued | regex |
| `I used to drive a red Camaro back in Sacramento` | `my old car`, `my hometown` | single-valued | model |

Rejected on purpose: volatile attributes (`my hp is 12`, `my party is weak`),
passing states (`I am at Viridian`, `I am heading to Mt Moon`), anything in the
third person, and anything that is not a first-person self-statement — whether a
regex or the model proposed it.

Slots fold spelling variants (`favourite`/`favorite`, `pokémon`/`pokemon`), or
the same question would have two canonical answers and no contradiction between
them would ever be detected.

### Contradiction vs. change of mind

The day is the unit.

- **Same day, different answer** — he is contradicting something he just said.
  Refused, never ingested, and reported back to the brain:

  ```
  ! PERSONA: you already told people my name is "Lumen" (said 3x since 2026-09-02,
  on messenger). "Ash" contradicts it — the original stands. Stay consistent.
  ```

- **A later day, different answer** — a change of mind, which is a legitimate
  thing for a character to do. lumen_state closes the open row and opens a new
  one with today's `valid-from`: the new value is current, and the old one stays
  true of the days it was true (`history`, `asof`). wq#1176 had no valid-from
  dimension at all, so its first answer was frozen forever.

Set-valued slots accumulate instead of either: liking two things is not a
contradiction. The prompt carries the current facts back in a `PERSONA` block,
ahead of the notepad — a persona fact holds until he revises it, a note does not.

### Other platforms

`src/persona_cli.ts` is the door for anything that is not this repo's TypeScript:

```bash
npx tsx src/persona_cli.ts state "My name is Lumen" --platform messenger
npx tsx src/persona_cli.ts ask "favourite pokemon" --json
npx tsx src/persona_cli.ts recall          # the block to paste into a prompt
npx tsx src/persona_cli.ts list
```

`state` exits `3` when the sentence contradicted a fact stated the same day, so
a bridge can react without parsing prose. `/persona.json` on the kiosk server
serves the current view read-only.

## Configuration

| Env | Default | Effect |
| --- | --- | --- |
| `LPP_CHAT_ENABLE` | `1` | `0` = no chat; `SAY:` lines are ignored |
| `LPP_CHAT_MIN_INTERVAL_MS` | `45000` | spacing between Lumen's lines |
| `LPP_CHAT_RING` | `60` | messages kept for the overlay |
| `LPP_PERSONA_ENABLE` | `1` | `0` = nothing recorded, no `PERSONA` block |
| `LPP_PERSONA_SUBJECT` | `lumen-persona` | lumen_state subject holding the facts |
| `LPP_PERSONA_PATH` | `/home/lumen/pokemon/runtime/persona.json` | wq#1176 store, migrated once |
| `LPP_PERSONA_PLATFORM` | `stream` | platform recorded for the agent's own lines |
| `LPP_PERSONA_RECALL_BUDGET` | `900` | chars of persona per prompt |
| `LPP_PERSONA_LLM_EXTRACT` | `1` | `0` = regex fast path only, no model call |
| `LPP_BRAIN_PERSONA` | `deepseek-v4-flash` | extraction rung; keep it cheap |
| `LPP_PERSONA_CACHE_TTL_MS` | `60000` | how long a turn may reuse the last store read |
| `LPP_PERSONA_ADAPTER` | `tools/lumen_state_json.py` | the lumen_state door |
| `LPP_LUMEN_STATE_DB` | *(unset)* | tests only: a throwaway sqlite file |

## Probes

`src/probe_persona.ts` (60 checks), `src/probe_persona_state.ts` (12) and
`src/probe_chat.ts` (21) run in `scripts/probes-pure.sh`, so CI covers all
three. `probe_persona` is pure logic on an in-process store; `probe_persona_state`
drives the real `lumen_state.py` subprocess against a throwaway sqlite file and
skips green where Minerva is not installed, which is how CI stays honest without
either mocking the store or writing to live fleet state.
