# Streamer chat and persona memory (wq#1176, wq#1192)

Two features that only make sense together. The chat gives Lumen a voice on the
stream; the persona store makes what he says with it binding.

Lumen is a streamer, not a walkthrough. He has a life outside the game and he
talks about it: films, records, the job he had before this, his boss Frank,
California, an ex-wife. Roughly 60% of what he says is the game and 40% is not,
and that split is the feature — nobody watches a stream for the commentary on
the corridor.

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

`src/streamer.ts` is a generator that runs on its own clock, next to the agent
and independent of it. It is not a step in the turn loop and the gameplay brain
does not know it exists.

The first version of this feature (wq#1176) put chat on the gameplay
completion — an optional `SAY:` third line next to `ACT:` and `THINK:`. wq#1189
rejected that, and the three reasons are the three properties this design is
built around:

**Cadence is wall-clock, not turns.** Deterministic turns — nav legs, dialog
runs, battle scripts — need no LLM call at all and can hold the emulator for
minutes. Chat carried on the gameplay completion therefore went silent for
exactly the stretches a viewer is most likely to be watching. Here a timer is
the source of truth: a line every 60–120s, jittered so it does not tick like a
metronome, no matter what the game is doing. Game events do not create lines —
they pull the next one earlier.

Those events are read off the same `EventBus` feed the kiosk gets
(`state_read`, `regression`), so the generator needs no cooperation from the
brain:

| Trigger | Fires on |
| --- | --- |
| `badge` | `badgeCount` rises |
| `whiteout` | a `regression` event that is not a clear |
| `battle_start` / `battle_end` | `inBattle` crosses zero |
| `new_map` | `map` changes |
| `cadence` | the 60–120s timer |

An event pull is floored at `LPP_STREAMER_EVENT_GAP_MS` (25s). A gym fight ends,
a badge lands, and the map changes, all inside ten seconds — without the floor
that one interesting moment is four lines nobody can read. The held trigger is
not discarded, it just waits.

**The model is the cheap rung, always.** One bounded single-shot request to
`LPP_STREAMER_MODEL` (`deepseek-v4-flash`), through `gatewayLLM` and *not*
through `Brain.complete`. `Brain` walks a fallback ladder, can escalate to a
bigger profile, and charges the run token budget that exists to finish the game.
All three are right for a game turn and wrong for a chat line: a line that needs
a second, more expensive attempt is a line worth skipping. `probe_streamer`
asserts the model on every request, and asserts it is neither the primary
profile nor anything in the gameplay fallback ladder.

**Failure is decoupled.** A model error, a screened line, and a repeat are all
the same outcome — silence, and reschedule. The generator holds nothing the
agent wants and cannot fail a turn. Every path through `generate()` moves
`dueAt` forward, so a broken gateway costs one request per cadence window rather
than one per tick.

### Topics

`OFF_TOPICS` in `src/streamer.ts` is the brief, one entry per subject, each with
a weight and a paragraph of direction. `pickTopic()` goes off-topic at
`LPP_STREAMER_OFFTOPIC` (0.4) and then picks a weighted bucket that is not one
of the last two it committed to — an unguarded weighted pick lands on the same
bucket twice in a row about a fifth of the time, and two California rants back
to back is the exact failure the 60/40 split exists to avoid.

### Before a line reaches the panel

Three filters, in order:

1. `firstSentence()` strips model preamble (`Sure! Here's a line:`) and keeps
   one sentence. A narrated answer on a stream overlay is worse than silence.
2. `screen()` refuses anything carrying an address, a key, a token, a
   filesystem path, a URL, a host:port, an internal hostname, or an
   infrastructure name. These are **structural patterns, not a word list**: the
   risk is not that the model says a rude thing, it is that it repeats
   something out of its own context that belongs to the fleet, and shapes
   survive a model swap in a way that a list of forbidden nouns does not.
   `LPP_STREAMER_DENY` adds terms, and is env-only — a deny list checked into
   the repo is itself a disclosure of the thing it protects.
3. `isRepeat()` compares against the last ten spoken lines by content-word
   Jaccard. The model is also *shown* those lines and told not to repeat them,
   which mostly works; this catches the rest. A paraphrase of something said
   four lines ago reads worse than silence, because the viewer who noticed now
   knows it is a loop.

`StreamChat`'s rate limit (`LPP_CHAT_MIN_INTERVAL_MS`) survives underneath all
of this as a backstop, and is deliberately set *below* the streamer's event
floor: cadence is a policy the generator owns, and a limiter set above the floor
silently starts eating event-triggered lines instead.

Every line that is actually spoken feeds persona extraction. A fact he told the
audience is a fact he has to live up to; a line nobody heard is not.

Harness lines (`system()`) are not rate limited and render dimmed: they are
posted on events, not on turns.

### Kill-switch

`LPP_CHAT_ENABLE=0` or `LPP_STREAMER_ENABLE=0` turns the channel off at boot.
For a live stream, `touch /home/lumen/pokemon/runtime/chat.off`
(`LPP_STREAMER_KILLFILE`) silences it within a second without restarting the
agent that is playing, and removing the file brings it back. A killed generator
makes no gateway calls at all.

### Where the lines go

- `{kind:"chat"}` on the `EventBus`, which the kiosk already broadcasts over the
  WebSocket — the same event the overlay has consumed since wq#1176.
- `runtime/chat.json`, the ring the overlay polls.
- `runtime/chat.jsonl`, append-only. The ring is rewritten whole on every line
  and forgets past `LPP_CHAT_RING`, which is right for an overlay and wrong for
  a record: everything Lumen has ever said is the corpus for who he is.
- `/streamer.json` on the kiosk server serves the counters — lines, off-topic
  share, screened, failures, model. The off-topic share is the one number that
  says whether the channel still has a personality or has quietly decayed into a
  walkthrough.

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
| `LPP_CHAT_ENABLE` | `1` | master kill-switch: `0` = nothing is ever spoken |
| `LPP_CHAT_MIN_INTERVAL_MS` | `20000` | transport backstop; keep it ≤ the event floor |
| `LPP_CHAT_RING` | `60` | messages kept for the overlay |
| `LPP_CHAT_LOG` | `runtime/chat.jsonl` | append-only transcript |
| `LPP_STREAMER_ENABLE` | `1` | `0` = the generator never runs |
| `LPP_STREAMER_KILLFILE` | `runtime/chat.off` | touch to silence a live stream, delete to resume |
| `LPP_STREAMER_MODEL` | `deepseek-v4-flash` | the cheap rung; nothing substitutes it |
| `LPP_STREAMER_MIN_MS` / `LPP_STREAMER_MAX_MS` | `60000` / `120000` | jittered cadence window |
| `LPP_STREAMER_EVENT_GAP_MS` | `25000` | floor between event-triggered lines |
| `LPP_STREAMER_OFFTOPIC` | `0.4` | share of lines that are not about the game |
| `LPP_STREAMER_RECENT` | `10` | lines shown back to the model, and checked for repeats |
| `LPP_STREAMER_DENY` | (empty) | extra refused terms, on top of the structural patterns |
| `LPP_STREAMER_TIMEOUT_MS` | `20000` | hard deadline on the one request |
| `LPP_STREAMER_MAX_TOKENS` | `160` | it is one sentence |
| `LPP_STREAMER_TEMP` | `0.9` | he is supposed to have a voice |
| `LPP_PERSONA_ENABLE` | `1` | `0` = nothing recorded, no `PERSONA` block |
| `LPP_PERSONA_PATH` | `/home/lumen/pokemon/runtime/persona.json` | the shared store |
| `LPP_PERSONA_PLATFORM` | `stream` | platform recorded for the agent's own lines |
| `LPP_PERSONA_RECALL_BUDGET` | `900` | chars of persona per prompt |

## Probes

`src/probe_persona.ts` (38 checks), `src/probe_chat.ts` (21 checks) and
`src/probe_streamer.ts` (71 checks) are pure logic — no ROM, no emulator, no
network — and run in `scripts/probes-pure.sh`, so CI covers all three.

`probe_streamer` injects the clock, the RNG and the model call, so the cadence
tests are exact rather than timing-dependent. Its central case simulates twenty
minutes of purely deterministic turns — `state_read` events with no gameplay LLM
call anywhere — and asserts Lumen keeps talking through all of it. That is the
wq#1189 defect, written down as a test.

One thing to know before adding a case: the anti-repeat filter is aggressive and
it is right to be. `"Line 1"` and `"Line 2"` are a paraphrase pair as far as it
is concerned, so a test that needs N spoken lines has to supply N lexically
disjoint ones — use the `varied()` helper.
