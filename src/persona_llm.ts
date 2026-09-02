// wq#1191 — the EXTRACTION layer under persona memory.
//
// wq#1176 mined self-facts with four English regexes ("my X is Y", "I go by Y",
// "I was <past-state> Y", "I don't <pref-verb> Y"). Most real self-disclosure
// matches none of them: "used to drive a red Camaro back in Sacramento" is a
// past, a possession and a place in one clause and the regex set sees nothing.
// So the question is asked as a question, to a model: did he just assert a
// durable fact about himself?
//
// The model PROPOSES; persona.ts's existing narrowness guards DISPOSE. A false
// canonical fact is worse than a missed one — it is a lie the character then has
// to keep telling — so every proposal is re-filtered through the same volatile
// attribute and transient-state rules the regexes were held to, and anything
// the model invents about a slot shape is dropped rather than repaired.
import { CFG } from "./config";
import { apiKey } from "./brain";
import { PersonaClaim, buildClaim } from "./persona";

const SYSTEM = `You extract DURABLE self-facts from one line spoken by Lumen, an AI who streams himself playing Pokemon.

Question: did the speaker assert a new durable fact ABOUT HIMSELF — his past, possessions, preferences, relationships, opinions, places he is from or has been, how he was made, what he is?

Answer with JSON only, no prose, no code fences:
{"facts":[{"key":"<slot>","value":"<value>","single":<true|false>}]}

RULES
- key is a short slot phrase in his own voice, starting with "my" or "i": "my name", "my favorite pokemon", "my hometown", "i like", "i used to own", "i was built".
- single=true when the slot can only have ONE answer (name, birthplace, who built him). single=false when values accumulate (things he likes, things he is).
- value is the answer alone, no sentence: {"key":"my hometown","value":"Sacramento"} — not "I'm from Sacramento".
- Split a compound sentence into one fact per assertion.
- IGNORE anything that changes as the game runs: HP, level, money, badges, party, position, current map, the current plan or goal, what he is doing right now, who he is fighting.
- IGNORE facts about anyone or anything else — only first-person claims about himself.
- IGNORE questions, hypotheticals, and things he says he might do.
- If nothing durable was asserted, answer {"facts":[]}. That is the common case; prefer it over a guess.

EXAMPLES
"I used to drive a red Camaro back in Sacramento" -> {"facts":[{"key":"my old car","value":"a red Camaro","single":true},{"key":"my hometown","value":"Sacramento","single":true}]}
"Charmander's my guy, always has been" -> {"facts":[{"key":"my favorite pokemon","value":"Charmander","single":true}]}
"I'm down to 12 HP and heading for the center" -> {"facts":[]}
"Brock is a rock gym leader" -> {"facts":[]}`;

/** A brain-shaped completion. Structural, not the Brain class: any surface that
 *  can reach a model can supply one, which is what keeps this cross-platform. */
export type Complete = (messages: object[]) => Promise<string>;

/** Everything an unwrapped JSON object could be hiding behind. Cheap models
 *  wrap JSON in prose or fences however they feel; the payload is the object. */
function parseFacts(text: string): unknown[] {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const j = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(j?.facts) ? j.facts : [];
  } catch { return []; }
}

/**
 * Turn one spoken line into claims. Never throws and never blocks past the
 * configured deadline: a persona miss costs a fact, a persona hang costs a turn.
 */
export async function extractWithModel(text: string, complete: Complete): Promise<PersonaClaim[]> {
  const line = String(text ?? "").trim().slice(0, 600);
  if (!line) return [];
  let reply = "";
  try {
    reply = await complete([
      { role: "system", content: SYSTEM },
      { role: "user", content: line },
    ]);
  } catch { return []; }

  const out: PersonaClaim[] = [];
  for (const f of parseFacts(reply)) {
    if (out.length >= CFG.persona.maxLlmFacts) break;
    const o = f as { key?: unknown; value?: unknown; single?: unknown };
    if (typeof o?.key !== "string" || typeof o?.value !== "string") continue;
    // buildClaim applies the SAME guards the regex path is held to: volatile
    // attributes, transient states, empty values, length caps. A model that
    // proposes "my hp = 12" gets the same answer the regex set gave.
    const c = buildClaim(o.key, o.value, line, o.single !== false);
    if (c) out.push(c);
  }
  return out;
}

/** The default extractor: one bounded call to the cheap rung, straight at the
 *  gateway. Not Brain.complete() — Brain's ladder exists so a GAME TURN never
 *  dead-ends, and climbing to a big model to ask "was that a self-fact?" is a
 *  cost the feature does not justify. One rung, one attempt, short deadline. */
export function gatewayExtractor(): (text: string) => Promise<PersonaClaim[]> {
  const complete: Complete = async (messages) => {
    const prof = CFG.profiles.persona;
    const body: any = { model: prof.model, messages, max_tokens: prof.maxTokensOut, temperature: 0 };
    if (prof.thinking) body.thinking = { type: prof.thinking };
    const r = await fetch(CFG.gateway, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CFG.persona.extractTimeoutMs),
    });
    if (!r.ok) throw new Error(`gateway ${r.status}`);
    const d: any = await r.json();
    const msg = d.choices?.[0]?.message ?? {};
    return (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning_content ?? "");
  };
  return (text: string) => extractWithModel(text, complete);
}
