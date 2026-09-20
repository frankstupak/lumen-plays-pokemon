// wq#1176 — the scaffolding screen: text the MODEL produced about the job of
// producing text, rather than the line Lumen meant to say.
//
// WHY THIS EXISTS. Read runtime/chat.jsonl from the first week of the live
// generator: 1920 of 2775 lines are the model's scratchpad, not chat.
//
//   "Let me think about the screen state: Cerulean City, at coordinates 0,19"
//   "The user wants one sentence from Lumen about a film or show watched"
//   "One sentence, dry, about Frank — affectionate and exasperated, ticket"
//   "The topic is my ex-wife Dana."
//
// Two separate bugs put those on a public stream, and this file is the second
// of the two fixes. The first is in streamer.ts: gatewayLLM used to fall back
// to `reasoning_content` when `content` came back empty, which is the reasoning
// model handing you its chain of thought and being told to read it out. That
// fallback is gone. But a model with thinking disabled still occasionally
// restates its instructions in `content`, so the line itself has to be screened
// for the SHAPE of scaffolding, exactly as streamer.ts screens it for the shape
// of a secret.
//
// It is also the persona store's gate. Scaffolding that reaches extraction
// becomes a durable "fact": lumen-persona currently holds 36 `i_am__*` rows,
// among them
//   i_am__lumen_a_pokemon_streamer_dry_and_tired_one_sentence_about_a_film_...
// which is not something Lumen believes about himself, it is the topic mixer's
// instruction text wearing a fact's clothes. A character assembled out of its
// own prompt is the wq#1176 persona feature failing at its one job.
//
// The rules are about the ACT OF COMPOSING, never about subject matter: Lumen
// is allowed every opinion, and nothing here may refuse a line for being rude,
// sad or about California. A false positive costs one skipped line — the
// generator reschedules and speaks 60-120s later — so the screen is tuned to
// catch scaffolding, not to be certain.

/** First-person narration of the act of writing the line, rather than the line.
 *  "Let me ..." is banned outright as an opener: on a one-sentence chat line it
 *  is a scratchpad tell every time, and the one real sentence it could cost
 *  ("let me tell you about Dana") is worth less than the ten it catches. */
const SCRATCHPAD_OPENER = new RegExp(
  [
    `^\\s*(?:let(?:'s| me| us)|lets)\\b`,
    // "We need to output one sentence" — the editorial we, which Lumen has no
    // reason to use about himself and a model uses constantly about its task.
    `^\\s*we\\s+(?:need to|must|should|have to|want to|are going to)\\b`,
    `^\\s*i(?:'ll| will| need to| should| am going to| have to)\\s+(?:think|thinking|look|check|consider|pick|choose|start|begin|draft|write|say something|come up with|go with|keep it|make it|try)\\b`,
  ].join("|"),
  "i",
);

/** The machinery of the request named out loud. Each term is one the audience
 *  can only be hearing because the prompt said it first. Deliberately NOT here:
 *  "the character", "the voice", "the answer", "the rules" — all of which a
 *  streamer says about a film, a singer, a quiz or a gym. */
const TASK_VOCABULARY: [RegExp, string][] = [
  [/\bthe (?:user|assistant|model|prompt|system prompt|instructions?|request)\b/i, "names the request"],
  [/^\s*the task\b|\bthe task (?:is|here|was)\b/i, "names the task"],
  [/\bthe (?:topic|subject) (?:is|here is|should be)\b/i, "names the topic"],
  [/\bthe persona\b|\bin character\b|\bas lumen\b/i, "names the persona"],
  [/\b(?:recent|previous|last) lines\b/i, "names the recent-lines block"],
  [/\b(?:screen|game|current) state\b/i, "names the state block"],
  [/\bone sentence\b/i, "restates the one-sentence rule"],
  [/\b(?:do not|don'?t|not) repeat(?:ing)?\b|\bno preamble\b|\boff[- ]topic\b/i, "restates a hard rule"],
  [/\bnot tied to the game\b|\bnot about the game\b/i, "restates a topic constraint"],
];

/** A prompt section header read out verbatim ("RECENT LINES:", "HARD RULES:").
 *  Four+ shouting characters before a colon is not a sentence anyone speaks. */
const SECTION_HEADER = /^\s*[A-Z][A-Z \t]{3,}:/;

/**
 * Returns the reason `text` reads as model scaffolding rather than speech, or
 * null if it may be spoken and believed.
 */
export function isMetaText(text: string): string | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;                       // empty is screen()'s call, not this one
  if (SECTION_HEADER.test(t)) return "prompt section header";
  if (SCRATCHPAD_OPENER.test(t)) return "scratchpad opener";
  for (const [re, why] of TASK_VOCABULARY) if (re.test(t)) return why;
  return null;
}
