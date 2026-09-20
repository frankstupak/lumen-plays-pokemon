// wq#1192 probe — the streamer chat generator. Pure logic: no emulator, no
// ROM, no network. Every clock and every RNG is injected, so the cadence tests
// are exact rather than timing-dependent.
//
// The four properties under test are the four defects wq#1189 found in the
// version this replaces:
//   1. CADENCE holds through a stretch with no LLM gameplay turns at all, and
//      game events pull a line earlier without letting a burst spam the panel.
//   2. The MODEL is the cheap rung, on every single request.
//   3. The 60/40 topic mix is real, and the off-topic content is the briefed
//      content rather than more game commentary.
//   4. FAILURE IS DECOUPLED: a model error, a screened line and a repeat are
//      all silence-and-reschedule, never a throw and never a stuck generator.
import { Streamer, screen, similarity, isRepeat, firstSentence, unterminated,
         gatewayLLM, OFF_TOPICS, type StreamerRequest, type TopicKey } from "./streamer";
import { StreamChat } from "./chat";
import { CFG } from "./config";
import { SYSTEM_PREFIX, buildMessages, History } from "./prompt";
import { readFileSync } from "fs";
import { join } from "path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

/** Lexically DISJOINT fixture lines. The anti-repeat filter is real and it is
 *  aggressive, so any test that needs N spoken lines has to supply N sentences
 *  that share no content words — "line 1" and "line 2" are a paraphrase pair as
 *  far as the filter is concerned, and it is right about that. */
const varied = (i: number) => `Quartz${i} obelisk${i} tangerine${i} verdict${i}.`;

/** Deterministic RNG: a fixed cycle, so a "random" test is reproducible. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Harness {
  s: Streamer;
  chat: StreamChat;
  models: string[];
  prompts: string[];
  events: { kind: string; data: any }[];
  personaSeen: string[];
  setReply: (fn: (req: StreamerRequest) => string) => void;
  fail: (on: boolean) => void;
  clock: { t: number };
}

function harness(opts: { random?: () => number; minInterval?: number } = {}): Harness {
  const clock = { t: 1_000_000 };
  const chat = new StreamChat({ ring: 40, minIntervalMs: opts.minInterval ?? 0 });
  chat.now = () => clock.t;
  const models: string[] = [];
  const prompts: string[] = [];
  const events: { kind: string; data: any }[] = [];
  const personaSeen: string[] = [];
  let reply: (req: StreamerRequest) => string = () => "Default line.";
  let failing = false;
  const s = new Streamer({
    chat,
    llm: async (req) => {
      models.push(req.model);
      prompts.push((req.messages[1] as any).content);
      if (failing) throw new Error("gateway 503");
      return reply(req);
    },
    persona: { recall: () => "name: Lumen", observe: (t: string) => { personaSeen.push(t); return []; } },
    emit: (kind, data) => events.push({ kind, data: data as any }),
    mapName: id => (id === 40 ? "Mt Moon 1F" : null),
    now: () => clock.t,
    random: opts.random ?? seeded(7),
    enabled: () => true,
  });
  return { s, chat, models, prompts, events, personaSeen, clock,
           setReply: fn => { reply = fn; }, fail: on => { failing = on; } };
}

// tsconfig targets CommonJS, so there is no top-level await: everything below
// runs inside one async IIFE.
void (async () => {

// ── 1. cadence survives a deterministic-turn stretch ────────────────────────
//
// THE REGRESSION THIS EXISTS FOR: the previous chat rode the gameplay
// completion, so a run of deterministic turns (nav legs, dialog, battle
// scripts — no LLM call at all) produced total silence. Here the generator gets
// state_read events with NO brain involvement whatsoever and must keep talking.
{
  let n = 0;
  const h = harness();
  h.setReply(() => varied(n++));
  const spoken: number[] = [];
  // 20 simulated minutes, 1s ticks, state_reads throughout (the game is being
  // played deterministically) and not a single gameplay LLM turn.
  for (let i = 0; i < 20 * 60; i++) {
    h.clock.t += 1000;
    h.s.observe({ kind: "state_read", map: 40, x: 5 + (i % 3), y: 7, badgeCount: 1, inBattle: 0 });
    const before = h.s.lines;
    // eslint-disable-next-line no-await-in-loop
    await h.s.tick();
    if (h.s.lines > before) spoken.push(h.clock.t);
  }
  ok("chat keeps talking through a 20-minute deterministic stretch",
    spoken.length >= 9, `lines=${spoken.length}`);

  const gaps = spoken.slice(1).map((t, i) => t - spoken[i]);
  const worst = gaps.length ? Math.max(...gaps) : Infinity;
  ok("no silence longer than the cadence ceiling",
    worst <= CFG.streamer.maxIntervalMs + 2000, `maxGap=${worst}ms`);
  ok("cadence is jittered, not a metronome",
    new Set(gaps).size > 1, `distinctGaps=${new Set(gaps).size}`);
  ok("every gap respects the cadence floor",
    gaps.every(g => g >= CFG.streamer.minIntervalMs), `minGap=${Math.min(...gaps)}ms`);
}

// ── 2. event triggers ───────────────────────────────────────────────────────
{
  const cases: [string, any, string][] = [
    ["badge", { kind: "state_read", map: 40, badgeCount: 1, inBattle: 0 }, "badge"],
    ["new map", { kind: "state_read", map: 41, badgeCount: 0, inBattle: 0 }, "new_map"],
    ["battle start", { kind: "state_read", map: 40, badgeCount: 0, inBattle: 1 }, "battle_start"],
    ["white-out", { kind: "regression", cleared: false }, "whiteout"],
  ];
  for (const [label, ev, want] of cases) {
    const h = harness();
    h.s.observe({ kind: "state_read", map: 40, x: 1, y: 1, badgeCount: 0, inBattle: 0 });
    // Far from the cadence deadline: only the event can make this due.
    h.s.dueAt = h.clock.t + 10 * 60_000;
    h.s.observe(ev);
    ok(`${label} makes a line due immediately`, h.s.due() === want, `trigger=${h.s.due()}`);
  }

  // battle_end needs a start to end.
  const h2 = harness();
  h2.s.observe({ kind: "state_read", map: 40, badgeCount: 0, inBattle: 1 });
  h2.s.dueAt = h2.clock.t + 10 * 60_000;
  h2.s.pending = null;
  h2.s.observe({ kind: "state_read", map: 40, badgeCount: 0, inBattle: 0 });
  ok("battle end makes a line due immediately", h2.s.due() === "battle_end", `trigger=${h2.s.due()}`);
}

// ── 3. an event BURST cannot spam the panel ─────────────────────────────────
//
// A gym fight ends, the badge lands, the map changes: three triggers inside a
// few seconds. Without the floor that is three lines nobody can read.
{
  let b = 0;
  const h = harness();
  h.setReply(() => varied(b++));
  h.s.observe({ kind: "state_read", map: 40, x: 1, y: 1, badgeCount: 0, inBattle: 2 });
  h.s.dueAt = h.clock.t + 10 * 60_000;
  h.s.observe({ kind: "state_read", map: 40, x: 1, y: 1, badgeCount: 0, inBattle: 0 });   // battle_end
  await h.s.tick();
  const afterFirst = h.s.lines;
  h.clock.t += 3000;
  h.s.observe({ kind: "state_read", map: 40, x: 1, y: 1, badgeCount: 1, inBattle: 0 });   // badge
  await h.s.tick();
  h.clock.t += 3000;
  h.s.observe({ kind: "state_read", map: 41, x: 1, y: 1, badgeCount: 1, inBattle: 0 });   // new map
  await h.s.tick();
  ok("an event burst inside the floor yields exactly one line",
    afterFirst === 1 && h.s.lines === 1, `lines=${h.s.lines}`);

  // ...and the held trigger is not thrown away: it fires once the floor passes.
  h.clock.t += CFG.streamer.eventMinGapMs;
  await h.s.tick();
  ok("the held trigger still fires once the floor passes", h.s.lines === 2, `lines=${h.s.lines}`);
}

// ── 4. the cheap rung, on every request ─────────────────────────────────────
{
  const h = harness();
  let i = 0;
  h.setReply(() => varied(i++));
  for (let k = 0; k < 12; k++) { h.clock.t += 130_000; await h.s.tick(); }
  ok("the generator actually made requests", h.models.length >= 10, `requests=${h.models.length}`);
  ok("EVERY request uses the configured cheap rung",
    h.models.length > 0 && h.models.every(m => m === CFG.streamer.model),
    `models=${[...new Set(h.models)].join(",")}`);
  ok("the cheap rung is the configured default, not a gameplay profile",
    CFG.streamer.model === "deepseek-v4-flash" &&
    CFG.streamer.model !== CFG.profiles.primary.model &&
    CFG.streamer.model !== CFG.profiles.escalate.model,
    `streamer=${CFG.streamer.model} primary=${CFG.profiles.primary.model} escalate=${CFG.profiles.escalate.model}`);
  ok("chat never enters the gameplay fallback ladder",
    !CFG.brain.fallbackModels.includes(CFG.streamer.model),
    `fallbacks=${CFG.brain.fallbackModels.join(",")}`);
  const chatEvents = h.events.filter(e => e.kind === "chat");
  ok("the model is reported in the chat event",
    chatEvents.length > 0 && chatEvents.every(e => e.data.model === CFG.streamer.model),
    `events=${chatEvents.length}`);
}

// ── 5. the topic mixer: off-topic at the briefed rate ───────────────────────
{
  const h = harness({ random: seeded(99) });
  const counts = new Map<TopicKey, number>();
  for (let i = 0; i < 4000; i++) {
    const t = h.s.pickTopic();
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const game = counts.get("game") ?? 0;
  const off = 4000 - game;
  const rate = off / 4000;
  ok("roughly 40% of lines are off-topic",
    Math.abs(rate - CFG.streamer.offTopicRate) < 0.04, `offTopicRate=${rate.toFixed(3)}`);
  ok("every briefed off-topic bucket actually gets used",
    OFF_TOPICS.every(t => (counts.get(t.key) ?? 0) > 0),
    OFF_TOPICS.map(t => `${t.key}=${counts.get(t.key) ?? 0}`).join(" "));
  ok("Frank's brief is all present (movies, music, past life, Frank, California, ex-wife)",
    ["movies", "music", "pastlife", "frank", "california", "exwife"]
      .every(k => OFF_TOPICS.some(t => t.key === k)),
    OFF_TOPICS.map(t => t.key).join(","));

  // The mixer must not pick the same off-topic bucket twice running once the
  // pick is COMMITTED (generate() records it). Two California rants back to
  // back is the failure the 60/40 split exists to prevent.
  const h2 = harness({ random: seeded(3) });
  let n = 0;
  h2.setReply(() => varied(n++));
  const spokenTopics: TopicKey[] = [];
  for (let k = 0; k < 40; k++) {
    h2.clock.t += 130_000;
    const r = await h2.s.tick();
    if (r?.line) spokenTopics.push(r.topic);
  }
  const offRun = spokenTopics.filter(t => t !== "game");
  let adjacent = 0;
  for (let i = 1; i < spokenTopics.length; i++)
    if (spokenTopics[i] !== "game" && spokenTopics[i] === spokenTopics[i - 1]) adjacent++;
  ok("no off-topic bucket repeats back to back",
    adjacent === 0 && offRun.length > 3, `adjacent=${adjacent} offLines=${offRun.length}`);
  ok("spoken lines land off-topic at roughly the briefed rate",
    Math.abs(offRun.length / spokenTopics.length - CFG.streamer.offTopicRate) < 0.2,
    `${offRun.length}/${spokenTopics.length}`);
}

// ── 6. the prompt carries what the character needs ──────────────────────────
{
  const h = harness({ random: () => 0.9 });   // >= offTopicRate -> always the game topic
  h.setReply(() => "Rock tunnel again, apparently.");
  h.s.observe({ kind: "state_read", map: 40, x: 12, y: 3, badgeCount: 2, inBattle: 2,
                party: [{ species: 25, level: 14, hp: 9, maxHp: 40 }] });
  h.clock.t += 130_000;
  await h.s.tick();
  const p = h.prompts[0];
  ok("the prompt carries live game state read off the event feed",
    p.includes("Mt Moon 1F") && p.includes("12,3") && p.includes("TRAINER battle"), "");
  ok("the prompt carries the canonical persona block", p.includes("name: Lumen"), "");
  ok("the prompt names the topic brief", p.includes("SAY SOMETHING ABOUT:"), "");

  // ...and the last ~10 lines, so the model can avoid repeating itself.
  const h2 = harness({ random: () => 0.9 });
  let i = 0;
  h2.setReply(() => varied(i++));
  for (let k = 0; k < 5; k++) { h2.clock.t += 130_000; await h2.s.tick(); }
  const last = h2.prompts[h2.prompts.length - 1];
  ok("the prompt shows the recent lines back to the model",
    last.includes("RECENT LINES") && last.includes(varied(0)), "");
  ok("recent lines are capped at the configured window",
    (last.match(/^- /gm) ?? []).length <= CFG.streamer.recentLines,
    `shown=${(last.match(/^- /gm) ?? []).length}`);
}

// ── 7. anti-repeat ──────────────────────────────────────────────────────────
{
  ok("a paraphrase scores as similar",
    similarity("Brock's Onix nearly wiped my whole party",
               "My whole party nearly got wiped by Brock's Onix") >= 0.6, "");
  ok("two unrelated lines do not",
    similarity("Brock's Onix nearly wiped my party",
               "The rent in Sacramento was already ridiculous") < 0.2, "");
  ok("isRepeat catches a paraphrase of a recent line",
    isRepeat("My whole party nearly got wiped by Brock's Onix",
             ["Brock's Onix nearly wiped my whole party"]), "");

  // End to end: a model that keeps saying the same thing gets silenced.
  const h = harness();
  h.setReply(() => "Mount Moon is genuinely enormous and I have seen this rock before.");
  h.clock.t += 130_000; await h.s.tick();
  h.clock.t += 130_000; await h.s.tick();
  ok("a repeated line is dropped rather than posted",
    h.s.lines === 1 && h.s.skipped === 1, `lines=${h.s.lines} skipped=${h.s.skipped}`);
  ok("a dropped repeat still reschedules (the generator does not wedge)",
    h.s.dueAt > h.clock.t, `dueIn=${h.s.dueAt - h.clock.t}ms`);
}

// ── 8. guardrails (wq#1176 item 5) ──────────────────────────────────────────
{
  const leaks: [string, string][] = [
    ["an address", "You can reach the box on 100.112.151.100 if you want."],
    ["a key", "The key is sk-abcdef0123456789 which I probably should not say."],
    ["a bearer token", "Send it with Bearer eyJhbGciOiJIUzI1NiJ9zzzz."],
    ["a path", "It all lives in /home/lumen/pokemon these days."],
    ["a url", "It is served off http://example.internal for now."],
    ["a host:port", "It is just localhost:4000 under the hood."],
    ["an internal hostname", "Everything routes through thor.example.ts.net."],
    ["infrastructure", "Frank had to restart the systemd unit again."],
    ["a hex secret", "The id is 0123456789abcdef0123456789abcdef."],
    ["a credential assignment", "api_key: hunter2hunter2 is what it wants."],
  ];
  for (const [label, line] of leaks)
    ok(`guardrail refuses ${label}`, screen(line) !== null, `reason=${screen(line)}`);

  ok("an ordinary line passes",
    screen("Sacramento in August is a personal attack and I stand by that.") === null, "");
  ok("an ordinary game line passes",
    screen("Onix has more HP than my entire party combined.") === null, "");
  ok("the env deny list is honoured",
    screen("I used to live in Modesto.", ["modesto"]) === "deny term", "");

  // End to end: a leaking line is never spoken, and the generator recovers.
  const h = harness();
  let call = 0;
  h.setReply(() => (++call === 1
    ? "Frank keeps the whole thing on 10.0.0.4 which is a choice."
    : "Anyway, the Onix has too much HP and I have too little patience."));
  h.clock.t += 130_000; await h.s.tick();
  ok("a leaking line is screened out, not posted",
    h.s.lines === 0 && h.s.skipped === 1, `lines=${h.s.lines} skipped=${h.s.skipped}`);
  ok("no screened text reaches the transport",
    h.chat.messages.length === 0, `stored=${h.chat.messages.length}`);
  h.clock.t += 130_000; await h.s.tick();
  ok("the generator speaks again after a screened line", h.s.lines === 1, `lines=${h.s.lines}`);
}

// ── 9. kill-switch ──────────────────────────────────────────────────────────
{
  const clock = { t: 1_000_000 };
  const chat = new StreamChat({ ring: 10, minIntervalMs: 0 });
  chat.now = () => clock.t;
  let live = true;
  let calls = 0;
  const s = new Streamer({
    chat, llm: async () => varied(calls++),
    now: () => clock.t, random: seeded(11), enabled: () => live,
  });
  clock.t += 130_000;
  await s.tick();
  ok("chat speaks while the switch is on", s.lines === 1, `lines=${s.lines}`);
  live = false;
  for (let i = 0; i < 20; i++) { clock.t += 130_000; await s.tick(); }
  ok("the kill-switch silences chat completely", s.lines === 1, `lines=${s.lines}`);
  ok("a killed generator makes no gateway calls at all", calls === 1, `calls=${calls}`);
  live = true;
  clock.t += 130_000;
  await s.tick();
  ok("chat resumes when the switch comes back", s.lines === 2, `lines=${s.lines}`);

  // The production check reads config + kill file, so both knobs are real.
  const prod = new Streamer({ chat: new StreamChat({ minIntervalMs: 0 }), llm: async () => "x" });
  ok("the production switch is config-driven, not hardcoded on",
    prod.enabled() === (CFG.chat.enabled && CFG.streamer.enabled), `enabled=${prod.enabled()}`);
}

// ── 10. failure is decoupled from gameplay ──────────────────────────────────
{
  const h = harness();
  h.fail(true);
  h.clock.t += 130_000;
  const r = await h.s.tick();
  ok("a model failure resolves quietly instead of throwing",
    r !== null && r.line === null && (r.reason ?? "").startsWith("model:"), `reason=${r?.reason}`);
  ok("a model failure is counted", h.s.failures === 1, `failures=${h.s.failures}`);
  ok("a failed call reschedules instead of hammering the gateway once per tick",
    h.s.dueAt > h.clock.t, `dueIn=${h.s.dueAt - h.clock.t}ms`);
  const before = h.models.length;
  for (let i = 0; i < 30; i++) { h.clock.t += 1000; await h.s.tick(); }
  ok("a failing generator does not retry every tick",
    h.models.length === before, `extraCalls=${h.models.length - before}`);
  h.fail(false);
  h.setReply(() => "Right, back to losing this fight on purpose.");
  h.clock.t += 130_000;
  await h.s.tick();
  ok("the generator recovers after the gateway comes back", h.s.lines === 1, `lines=${h.s.lines}`);
}

// ── 11. transport + persona integration (reused, not rebuilt) ───────────────
{
  const h = harness();
  h.setReply(() => "I used to drive a red Camaro back in Sacramento.");
  h.clock.t += 130_000;
  await h.s.tick();
  const chatEvents = h.events.filter(e => e.kind === "chat");
  ok("a spoken line emits ONE ws chat event", chatEvents.length === 1, `events=${chatEvents.length}`);
  ok("the ws event carries id/text/style, matching the existing overlay contract",
    chatEvents[0].data.id > 0 && typeof chatEvents[0].data.text === "string" &&
    chatEvents[0].data.style === "say", JSON.stringify(chatEvents[0].data).slice(0, 90));
  ok("the event names the streamer as the source", chatEvents[0].data.src === "streamer", "");
  ok("the line lands in the existing chat transport",
    h.chat.messages.length === 1 && h.chat.messages[0].kind === "say", "");
  ok("every spoken line feeds persona extraction (wq#1191)",
    h.personaSeen.length === 1 && h.personaSeen[0].includes("Camaro"), h.personaSeen.join("|"));

  // The transport rate limit is a BACKSTOP: it must sit below the streamer's
  // event floor, or it silently eats event-triggered lines.
  ok("the transport limiter cannot eat an event-triggered line",
    CFG.chat.minIntervalMs <= CFG.streamer.eventMinGapMs,
    `chat=${CFG.chat.minIntervalMs} floor=${CFG.streamer.eventMinGapMs}`);
}

// ── 12. output hygiene ──────────────────────────────────────────────────────
{
  ok("a model preamble is stripped",
    firstSentence("Sure! Here's a line: Onix is enormous. Also I am tired.") === "Onix is enormous.",
    firstSentence("Sure! Here's a line: Onix is enormous. Also I am tired."));
  ok("surrounding quotes are stripped",
    firstSentence('"California rent is a scam."') === "California rent is a scam.", "");
  ok("only one sentence survives",
    firstSentence("First one. Second one. Third one.") === "First one.", "");
  ok("a sentence with no terminator still comes through",
    firstSentence("no punctuation here") === "no punctuation here", "");

  const h = harness();
  h.setReply(() => "Sure, here is a line: Mt Moon is a maze. Anyway, my ex-wife hated caves.");
  h.clock.t += 130_000;
  await h.s.tick();
  ok("only the first sentence is spoken",
    h.chat.messages[0]?.text === "Mt Moon is a maze.", `text=${h.chat.messages[0]?.text}`);
}

// ── 13. gameplay is no longer on the chat path (the wq#1189 defect) ─────────
{
  ok("the gameplay prompt no longer instructs the brain to SAY anything",
    !/\bSAY:/.test(SYSTEM_PREFIX) && !/streamer chat/i.test(SYSTEM_PREFIX), "");
  const msgs = buildMessages(new History(), "notes", "MAP 40") as any[];
  ok("the gameplay user block no longer asks for a SAY line",
    !/\bSAY\b/.test(msgs[1].content), "");

  // Resolved off __dirname, not the cwd: probes-pure.sh cds to the repo root
  // but a bare `npx tsx src/probe_streamer.ts` from anywhere else should still
  // check the real file rather than fail on a missing path.
  const agentSrc = readFileSync(join(__dirname, "agent.ts"), "utf8");
  ok("the gameplay agent no longer parses a SAY line off its completion",
    !agentSrc.includes("SAY:") && !agentSrc.includes("postSay"), "");
  ok("the gameplay agent holds no reference to the chat transport at all",
    !agentSrc.includes("StreamChat"), "");
}

// ── 14. the scaffolding regression (wq#1176) ────────────────────────────────
//
// THE REGRESSION THIS EXISTS FOR: 2261 of the 2775 lines in the first live
// week's runtime/chat.jsonl were the model talking about its own homework, not
// Lumen talking to anybody. Two bugs, both covered here: gatewayLLM read
// `reasoning_content` when `content` came back empty (a thinking model's notes,
// read out on a public stream), and nothing screened the line for the SHAPE of
// scaffolding when the model restated its instructions in `content` anyway.
//
// The strings below are verbatim from that log. Fixtures from a real failure
// beat fixtures from imagination: these are the sentences an audience actually
// saw.
{
  const LIVE_SCAFFOLDING = [
    "Let me think about the screen state: Cerulean City, at coordinates 0,19.",
    "Let me look at the situation.",
    "The user wants one sentence from Lumen about a film or show watched recently.",
    "The topic is my ex-wife Dana.",
    "The persona: Dana, ex-wife, left me a Coltrane record with a scratch on side two.",
    "We need to produce one sentence, no preamble, no quotes, no emojis.",
    "The task: something I've had on lately.",
    "One sentence, dry, about Frank — affectionate and exasperated, ticket queue.",
  ];
  ok("every scaffolding line from the live log is refused",
    LIVE_SCAFFOLDING.every(l => screen(l) !== null),
    `${LIVE_SCAFFOLDING.filter(l => screen(l) !== null).length}/${LIVE_SCAFFOLDING.length}`);

  // The other half of the measurement, and the one that decides whether the
  // screen is tuned or just loud: real lines from the same log still speak.
  const LIVE_CHAT = [
    "The battle just ended on Route 24.",
    "Watched Sorcerer again last night, and no, the bridge sequence is not too slow.",
    "People down here say \"at least the weather's nice\" like that justifies the rent.",
    "My ex-wife Renata used to leave the porch light on even when she was furious.",
    "Frank used to ping me at 4:45 on a Friday with a quick little change.",
    "I just walked into Route 24, north of Cerulean.",
    "Eleven years I paid California rent for weather that is mostly fog in June.",
  ];
  const wrongly = LIVE_CHAT.filter(l => screen(l) !== null);
  ok("real chat from the same log is untouched", wrongly.length === 0,
    wrongly.length ? `${wrongly[0]} -> ${screen(wrongly[0])}` : "7/7 spoken");

  ok("a line cut off mid-thought is not spoken", unterminated("Frank used to ping me at"), "");
  ok("a finished sentence is not mistaken for a truncation",
    !unterminated("Frank used to ping me at 4:45 on a Friday."), "");

  const h = harness();
  h.setReply(() => "Let me think about what to say about Mt Moon.");
  h.clock.t += 130_000;
  await h.s.tick();
  ok("a scratchpad line never reaches the audience", h.chat.messages.length === 0,
    `spoken=${h.chat.messages.length}`);
  ok("and the reason is visible to an operator",
    /scaffolding/.test(h.s.stats().lastReason ?? ""), `${h.s.stats().lastReason}`);
}

// ── 15. the gateway transport never speaks the model's notes ────────────────
{
  process.env.LITELLM_MASTER_KEY = "sk-probe";          // never touch the real key file
  const realFetch = globalThis.fetch;
  let sent: any = null;
  const stub = (message: any) => {
    globalThis.fetch = (async (_u: any, init: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message }] }) } as any;
    }) as any;
  };
  const req = { model: CFG.streamer.model, messages: [{ role: "user", content: "hi" }],
                maxTokens: 160, temperature: 0.9, timeoutMs: 1000 } as StreamerRequest;
  try {
    stub({ content: "", reasoning_content: "Let me think about the screen state." });
    let threw = "";
    try { await gatewayLLM(req); } catch (e: any) { threw = String(e.message); }
    ok("a thinking-only response is a failure, not a line", /empty content/.test(threw), threw);

    stub({ content: "Mt Moon is a maze.", reasoning_content: "Let me think." });
    ok("content is what gets spoken", (await gatewayLLM(req)) === "Mt Moon is a maze.", "");
    ok("the request asks the cheap rung to stop thinking",
      sent?.thinking?.type === "disabled" && sent?.model === CFG.streamer.model,
      `model=${sent?.model} thinking=${sent?.thinking?.type}`);
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\nprobe_streamer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
