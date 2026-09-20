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

Five filters, in order:

0. The transport takes `content` and **never** `reasoning_content`. After the
   2026-09-10 switch to `glm-5.3-flash-zai` — a rung whose reasoning is
   mandatory — a 160-token ceiling was spent entirely on thinking and the
   completion came back `content: ""` with `finish_reason: "length"`, so
   reading the notes instead put `Let me think about the screen state` on a
   public stream for three days. An empty `content` is now a failure with a
   reason on `/streamer.json`, not a line. Two settings support that rule
   without being the rule: `thinking: disabled` (`LPP_STREAMER_THINKING`) where
   the rung honours it, and a budget with **reasoning headroom**
   (`LPP_STREAMER_MAX_TOKENS`, `LPP_BRAIN_PERSONA_MAXTOK`) — the line is still
   one sentence, but a rung that reasons for 2-4k tokens before writing any
   content needs room to reach it, and a cap is not a charge. The extractor
   (`persona_llm.ts`) had the identical bug and the identical fix: it parses its
   text for claims, so a monologue there becomes a *fact about Lumen*.
   A hand-written hotfix for the same leak (2026-09-13, never committed) was
   discarded from the primary tree in wq#2236: this rule supersedes it, and
   differs in one place — the hotfix returned `''` (a screened skip) on empty
   content where `gatewayLLM` throws.
1. `firstSentence()` strips model preamble (`Sure! Here's a line:`) and keeps
   one sentence, and `unterminated()` drops a completion with no sentence
   terminator anywhere — half a thought (`Frank used to ping me at`) reads as a
   crash on the overlay.
2. `screen()` refuses anything carrying an address, a key, a token, a
   filesystem path, a URL, a host:port, an internal hostname, or an
   infrastructure name. These are **structural patterns, not a word list**: the
   risk is not that the model says a rude thing, it is that it repeats
   something out of its own context that belongs to the fleet, and shapes
   survive a model swap in a way that a list of forbidden nouns does not.
   `LPP_STREAMER_DENY` adds terms, and is env-only — a deny list checked into
   the repo is itself a disclosure of the thing it protects.
3. `isMetaText()` (`src/meta_text.ts`) refuses the model talking about its own
   homework: a scratchpad opener (`Let me…`, `We need to…`), the machinery of
   the request named out loud (`the user`, `the task`, `the persona`, `recent
   lines`, `one sentence`), or a prompt section header read back verbatim. The
   rules are about the **act of composing**, never about subject matter — Lumen
   keeps every opinion he has. Measure any change to them with
   `npx tsx tools/scan_chat_meta.ts <chat.jsonl> --pass 20`, which reports both
   the hit rate and what still gets through; the screen was tuned against the
   first live week, where **2261 of 2775 lines (82%) were scaffolding**.
4. `isRepeat()` compares against the last ten spoken lines by content-word
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

Junk rows (wq#2237: scaffolding that persona extraction canonised as `i_am__*`)
are closed, not deleted, so the incident stays on record:

```
python3 tools/lumen_state_json.py close lumen-persona --glob 'i_am__*' \
  --reason 'wq#1176 chain-of-thought canonised' --source wq#2237 --dry-run
```

`close` sets `valid_to`/`invalidated_at`, leaves value and `source_ref`, writes a
`memory_audit` row per closure, and refuses to run without a predicate or glob.
Drop `--dry-run` to apply. Choose predicates with the read-side filter's verdict
(`quarantine()`), not the glob alone — some `i_am__*` rows are legitimate.

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

Also rejected, and for the same reason a line is screened before it is spoken:
**scaffolding** (`isMetaText`) and **run-on self-description**. When the
generator was reading its own scratchpad aloud, extraction dutifully canonised
it, and `lumen-persona` grew 36 `i_am__*` rows — among them
`i am: Lumen, a Pokemon streamer, dry and tired, one sentence about a film or
show I watched recently, not tied to the game`, which is the topic mixer's
instructions wearing a fact's clothes. A character assembled out of his own
prompt is this feature failing at its one job.

The copular slot (`i am`) accumulates adjective piles rather than distinct
claims, so it has two extra rules the other slots do not: a restatement that
contains, or is contained by, a value already stored is the **same claim said
again** (`a dry, tired streamer` ≡ `a dry, tired Pokemon streamer`) and
reaffirms rather than adding a row; and anything with three commas or more than
nine words is the system prompt being read back. Everywhere else the tighter
word-set rule stands — `caves` and `caves at night` are two different things to
like.

Rows written before those guards existed are still in lumen_state, so
`PersonaMemory.refresh()` holds them back on **read**: scaffolding values,
run-on self-descriptions, and any set slot past `MAX_SET_MEMBERS` (6) never
reach a prompt on any surface. Nothing is deleted — the rows stay queryable for
an audit, `stats().suppressed` counts them, and reversing the judgement is a
deploy rather than a restore.

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

### One question is one slot

All of the above matches on the slot, so two spellings of one question are two
facts that can never disagree. That is not hypothetical: after a week live,
`lumen-persona` answered "where is he from?" at six open predicates — `my city`,
`my former city`, `my old city`, `my previous city`, `my hometown`, `my old
home`, every one of them "San Francisco" — because the extractor names a slot in
whatever words the sentence used.

`normKey` (`src/persona.ts`) folds the spellings that ask the same question:
`former`/`previous`/`prior` → `old`, `work`/`workplace` → `job`, `town` → `city`.
The fold stops at the modifier — `my old job` stays distinct from `my job`, and
`my hometown` from `my city` — because merging those would manufacture a
contradiction out of two true answers. A wrong fold costs a refused fact; a
missed one costs a duplicate row, which the reader below still survives.

Normalization runs on **load**, not just on write, so rows already in lumen_state
re-key when they are read. Where that lands several rows on one single-valued
slot, the newest `valid-from` is the one rendered — the bi-temporal answer to
"what does he believe today" — and the rest are counted in `stats().suppressed`.
Nothing is deleted by a read. When Lumen himself revises a slot whose previous
answer sat at a pre-fold spelling, that row is `close`d (a `valid_to`, never a
delete) so it stops resurfacing on the next refresh.

Rows written before the fold stay open until he next revises that slot. To
retire a batch of known junk deliberately, the adapter takes a glob and reports
first:

```bash
python3 tools/lumen_state_json.py close lumen-persona --glob 'i_am__*' \
    --reason 'wq#1176 scaffolding rows' --dry-run
```

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
| `LPP_CHAT_ENABLE` | `1` | master kill-switch: `0` = nothing is ever spoken |
| `LPP_CHAT_MIN_INTERVAL_MS` | `20000` | transport backstop; keep it ≤ the event floor |
| `LPP_CHAT_RING` | `60` | messages kept for the overlay |
| `LPP_CHAT_LOG` | `runtime/chat.jsonl` | append-only transcript |
| `LPP_STREAMER_ENABLE` | `1` | `0` = the generator never runs |
| `LPP_STREAMER_KILLFILE` | `runtime/chat.off` | touch to silence a live stream, delete to resume |
| `LPP_STREAMER_MODEL` | `deepseek-v4-flash` | the cheap rung; nothing substitutes it |
| `LPP_STREAMER_THINKING` | `disabled` | DeepSeek thinking switch; empty sends nothing |
| `LPP_STREAMER_MIN_MS` / `LPP_STREAMER_MAX_MS` | `60000` / `120000` | jittered cadence window |
| `LPP_STREAMER_EVENT_GAP_MS` | `25000` | floor between event-triggered lines |
| `LPP_STREAMER_OFFTOPIC` | `0.4` | share of lines that are not about the game |
| `LPP_STREAMER_RECENT` | `10` | lines shown back to the model, and checked for repeats |
| `LPP_STREAMER_DENY` | (empty) | extra refused terms, on top of the structural patterns |
| `LPP_STREAMER_TIMEOUT_MS` | `20000` | hard deadline on the one request |
| `LPP_STREAMER_MAX_TOKENS` | `2400` | reasoning headroom, not sentence length — see below |
| `LPP_STREAMER_TEMP` | `0.9` | he is supposed to have a voice |
| `LPP_PERSONA_ENABLE` | `1` | `0` = nothing recorded, no `PERSONA` block |
| `LPP_PERSONA_SUBJECT` | `lumen-persona` | lumen_state subject holding the facts |
| `LPP_PERSONA_PATH` | `/home/lumen/pokemon/runtime/persona.json` | wq#1176 store, migrated once |
| `LPP_PERSONA_PLATFORM` | `stream` | platform recorded for the agent's own lines |
| `LPP_PERSONA_RECALL_BUDGET` | `900` | chars of persona per prompt |
| `LPP_PERSONA_LLM_EXTRACT` | `1` | `0` = regex fast path only, no model call |
| `LPP_BRAIN_PERSONA` | `deepseek-v4-flash` | extraction rung; keep it cheap |
| `LPP_BRAIN_PERSONA_MAXTOK` | `2400` | reasoning headroom for extraction, same arithmetic |
| `LPP_PERSONA_CACHE_TTL_MS` | `60000` | how long a turn may reuse the last store read |
| `LPP_PERSONA_ADAPTER` | `tools/lumen_state_json.py` | the lumen_state door |
| `LPP_LUMEN_STATE_DB` | *(unset)* | tests only: a throwaway sqlite file |

## Probes

`src/probe_persona.ts` (85 checks), `src/probe_persona_state.ts` (22 checks),
`src/probe_chat.ts` (27 checks) and `src/probe_streamer.ts` (83 checks) run in
`scripts/probes-pure.sh`, so CI covers all four. `probe_persona`, `probe_chat`
and `probe_streamer` are pure logic — no ROM, no emulator, no network.
`probe_persona_state` drives the real `lumen_state.py` subprocess against a
throwaway sqlite file and skips green where Minerva is not installed, which is
how CI stays honest without either mocking the store or writing to live fleet
state.

`probe_streamer` injects the clock, the RNG and the model call, so the cadence
tests are exact rather than timing-dependent. Its central case simulates twenty
minutes of purely deterministic turns — `state_read` events with no gameplay LLM
call anywhere — and asserts Lumen keeps talking through all of it. That is the
wq#1189 defect, written down as a test.

One thing to know before adding a case: the anti-repeat filter is aggressive and
it is right to be. `"Line 1"` and `"Line 2"` are a paraphrase pair as far as it
is concerned, so a test that needs N spoken lines has to supply N lexically
disjoint ones — use the `varied()` helper.
