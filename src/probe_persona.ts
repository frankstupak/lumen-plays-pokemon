// wq#1176/wq#1191 probe — persona memory. Pure logic: no emulator, no ROM, no
// network, no subprocess (probe_persona_state.ts covers the real lumen_state).
// Pins the properties the feature is worth having for:
//   1. extraction is NARROW whoever proposed the fact (regex OR model)
//   2. a same-day contradiction is refused and reported
//   3. a change of mind on a LATER day is a new valid-from, and it becomes current
//   4. it is CROSS-PLATFORM (one store, two surfaces, either direction)
//   5. wq#1176's JSON store migrates into the fleet store on first bind
import {
  PersonaMemory, extractPersonaClaims, buildClaim, nearDuplicate,
  normValue, normKey, MAX_FACTS, PersonaClaim,
} from "./persona";
import { MemoryPersonaStore, decodePredicate, encodePredicate } from "./persona_store";
import { extractWithModel } from "./persona_llm";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

/** A PersonaMemory on an in-process store, with a pinned clock so a change of
 *  mind can be asserted without waiting a day. */
function mem(day = "2026-09-01", store = new MemoryPersonaStore()) {
  const m = new PersonaMemory();
  m.now = () => new Date(`${day}T12:00:00.000Z`);
  m.useStore(store);
  return { m, store, at: (d: string) => { m.now = () => new Date(`${d}T12:00:00.000Z`); } };
}

const keysOf = (t: string) => extractPersonaClaims(t).map(c => `${c.key}=${c.value}`);

async function main(): Promise<number> {
  // ---- 1. extraction: what counts as a self-fact ----
  ok("captures 'my X is Y'", keysOf("My favourite pokemon is Bulbasaur").join() === "my favorite pokemon=Bulbasaur",
     keysOf("My favourite pokemon is Bulbasaur").join());
  ok("captures 'I am ...' as set-valued", extractPersonaClaims("I am an AI").every(c => c.key === "i am" && !c.single), "");
  ok("'my name is' is single-valued", extractPersonaClaims("My name is Lumen")[0]?.single === true, "");
  ok("captures a preference", keysOf("I like caves").join() === "i like=caves", keysOf("I like caves").join());
  ok("negation gets its own slot", keysOf("I don't like Zubat").join() === "i do not like=Zubat", keysOf("I don't like Zubat").join());
  ok("captures origin", keysOf("I was built by Frank").join() === "i was built=by Frank", keysOf("I was built by Frank").join());
  ok("'I go by X' folds into the name slot", keysOf("I go by Lumen").join() === "my name=Lumen", "");
  ok("splits a compound sentence", keysOf("My name is Lumen and I like caves").length === 2,
     keysOf("My name is Lumen and I like caves").join(" | "));

  // the narrowness half: transient game state must NOT become permanent
  ok("rejects volatile attribute (hp)", extractPersonaClaims("My hp is 12").length === 0, "");
  ok("rejects volatile attribute (party)", extractPersonaClaims("My party is weak").length === 0, "");
  ok("rejects transient state (location)", extractPersonaClaims("I am at Viridian City").length === 0, "");
  ok("rejects transient state (-ing)", extractPersonaClaims("I am heading to Mt Moon").length === 0, "");
  ok("rejects third-person text", extractPersonaClaims("Brock is a rock gym leader").length === 0, "");
  ok("rejects a bare tool call", extractPersonaClaims("goto(4,7)").length === 0, "");

  // wq#1191: the SAME guards apply to a model's proposals — the model proposes,
  // buildClaim disposes. A narrowness only the regexes obeyed would be no
  // narrowness at all once the model became the main mechanism.
  ok("guards reject a model-proposed volatile fact", buildClaim("my hp", "12", "raw", true) === null, "");
  ok("guards reject a model-proposed third-person slot", buildClaim("brock's type", "rock", "raw", true) === null, "");
  ok("guards reject a model-proposed passing state", buildClaim("i am", "at Viridian City", "raw", false) === null, "");
  ok("guards accept a durable model-proposed fact",
     buildClaim("my hometown", "Sacramento", "raw", true)?.norm === "sacramento", "");

  // the LLM path itself: JSON in prose, junk, and a throwing gateway
  const modelSays = (reply: string) => extractWithModel("whatever he said", async () => reply);
  const camaro = await modelSays(`Sure! {"facts":[{"key":"my old car","value":"a red Camaro","single":true},` +
    `{"key":"my hometown","value":"Sacramento","single":true}]}`);
  ok("model extraction survives prose around the JSON", camaro.length === 2 && camaro[0].value === "a red Camaro",
     camaro.map((c: PersonaClaim) => `${c.key}=${c.value}`).join(" | "));
  ok("model extraction gets what the regexes miss",
     extractPersonaClaims("I used to drive a red Camaro back in Sacramento").length === 0 && camaro.length === 2, "");
  ok("model extraction drops volatile proposals",
     (await modelSays(`{"facts":[{"key":"my hp","value":"12","single":true}]}`)).length === 0, "");
  ok("unparseable model output yields nothing, not a throw", (await modelSays("no idea, sorry")).length === 0, "");
  ok("a throwing model yields nothing",
     (await extractWithModel("x", async () => { throw new Error("gateway down"); })).length === 0, "");

  // normalization: casing/articles/punctuation must not fake a contradiction
  ok("normalizer ignores case+articles+punct", normValue("The Bulbasaur!") === normValue("bulbasaur"),
     `${normValue("The Bulbasaur!")} vs ${normValue("bulbasaur")}`);
  // one question = one slot, or the same question has two canonical answers
  ok("spelling variants fold to one slot", normKey("my favourite pokémon") === normKey("My Favorite Pokemon"),
     `${normKey("my favourite pokémon")} vs ${normKey("My Favorite Pokemon")}`);
  ok("near-duplicates are the same claim",
     nearDuplicate("red camaro", "camaro red") && !nearDuplicate("caves", "caves at night"), "");

  // ---- 2. predicate encoding: one slot per question, one row per set member ----
  ok("single slot encodes to a flat predicate",
     encodePredicate("my favorite pokemon", true, "bulbasaur") === "my_favorite_pokemon", "");
  ok("set member carries its value in the predicate", encodePredicate("i like", false, "caves") === "i_like__caves", "");
  ok("predicates decode back to their slot",
     decodePredicate("my_favorite_pokemon").key === "my favorite pokemon" && decodePredicate("my_favorite_pokemon").single &&
     decodePredicate("i_like__caves").key === "i like" && !decodePredicate("i_like__caves").single, "");

  // ---- 3. same-day contradiction is refused ----
  const a = mem("2026-09-01");
  const e1 = await a.m.observe("My favourite pokemon is Bulbasaur", "stream");
  ok("first statement is new", e1[0]?.outcome === "new", e1[0]?.outcome ?? "none");
  const e2 = await a.m.observe("my favorite pokemon is BULBASAUR.", "stream");
  ok("restating the same value reaffirms (not a second row)",
     e2[0]?.outcome === "reaffirmed" && a.store.current().length === 1, `rows=${a.store.current().length}`);
  const e3 = await a.m.observe("My favourite pokemon is Charmander", "messenger");
  ok("same-day contradiction is reported, not applied", e3[0]?.outcome === "conflict", e3[0]?.outcome ?? "none");
  ok("the value he stated today survives the contradiction",
     a.m.facts[0].value === "Bulbasaur" && a.m.facts[0].conflicts.length === 1, a.m.facts[0].value);
  ok("a refused contradiction never reaches the store",
     a.store.rows.length === 1 && a.store.rows[0].value === "Bulbasaur", `rows=${a.store.rows.length}`);
  ok("conflict notice names both values",
     PersonaMemory.conflictNotice(e3).includes("Bulbasaur") && PersonaMemory.conflictNotice(e3).includes("Charmander"),
     PersonaMemory.conflictNotice(e3).slice(0, 70));
  ok("no conflict notice when nothing conflicted", PersonaMemory.conflictNotice(e1) === "", "");

  // ---- 4. a change of mind on a LATER day is bi-temporal, not a conflict ----
  a.at("2026-09-08");
  const e4 = await a.m.observe("My favourite pokemon is Charmander", "stream");
  ok("a later-day restatement is an update, not a conflict", e4[0]?.outcome === "updated", e4[0]?.outcome ?? "none");
  ok("the new value is current", a.m.facts.find(f => f.key === "my favorite pokemon")?.value === "Charmander",
     String(a.m.facts.find(f => f.key === "my favorite pokemon")?.value));
  ok("the new value carries the new valid-from",
     a.m.facts.find(f => f.key === "my favorite pokemon")?.validFrom === "2026-09-08", "");
  const hist = a.store.history("my_favorite_pokemon");
  ok("the old value stays true of the days it was true",
     hist.length === 2 && hist[0].value === "Bulbasaur" && hist[0].validTo === "2026-09-08" && hist[1].validTo === null,
     hist.map(r => `${r.value}:${r.validFrom}->${r.validTo ?? "NOW"}`).join(" | "));
  ok("a change of mind produces no conflict notice", PersonaMemory.conflictNotice(e4) === "", "");
  const e5 = await a.m.observe("My favourite pokemon is Bulbasaur", "stream");
  ok("contradicting the NEW value the same day is refused again", e5[0]?.outcome === "conflict", e5[0]?.outcome ?? "none");

  // set-valued keys accumulate instead of conflicting
  const s = mem("2026-09-01");
  await s.m.observe("I like caves", "stream");
  await s.m.observe("I like Bulbasaur", "stream");
  ok("set-valued key accumulates values", s.m.facts.length === 2 && s.m.facts.every(f => f.key === "i like"),
     s.m.facts.map(f => f.value).join("/"));
  ok("set-valued restatement still reaffirms",
     (await s.m.observe("I like caves", "stream"))[0]?.outcome === "reaffirmed", "");

  // ---- 5. cross-platform: one store, two surfaces ----
  const shared = new MemoryPersonaStore();
  const bridge = mem("2026-09-01", shared);
  await bridge.m.observe("My favourite colour is blue", "messenger");
  await bridge.m.observe("My name is Lumen", "messenger");
  await bridge.m.observe("I like caves", "messenger");
  const streamSide = mem("2026-09-01", shared);
  ok("a messenger fact is canonical on the stream", streamSide.m.recall().includes("blue"),
     streamSide.m.recall().split("\n").find(l => l.includes("color")) ?? "");
  ok("platform of origin survives the store round-trip",
     streamSide.m.facts.find(f => f.key === "my favorite color")?.platform === "messenger",
     streamSide.m.facts.map(f => `${f.key}@${f.platform}`).join("|"));
  ok("recall is empty for an empty store", mem("2026-09-01").m.recall() === "", "");
  ok("recall honours its budget", streamSide.m.recall(40).length <= 40, `len=${streamSide.m.recall(40).length}`);
  const ranked = streamSide.m.recall().split("\n");
  ok("identity slots rank ahead of set-valued ones",
     ranked.findIndex(l => l.startsWith("- i like")) === ranked.length - 1 &&
     ranked.slice(0, -1).every(l => l.startsWith("- my ")),
     ranked.join(" / "));
  // asked in the OTHER spelling on purpose: a question must reach its slot
  ok("search finds a fact by question words", streamSide.m.search("favourite colour")[0]?.value === "blue",
     String(streamSide.m.search("favourite colour")[0]?.value));
  ok("search misses on an unknown subject", streamSide.m.search("hometown").length === 0, "");
  // contradiction across platforms is still refused on the same day
  const xp = await streamSide.m.observe("My name is Ash", "stream");
  ok("cross-platform same-day contradiction rejected", xp[0]?.outcome === "conflict" &&
     streamSide.m.facts.find(f => f.key === "my name")?.value === "Lumen",
     String(streamSide.m.facts.find(f => f.key === "my name")?.value));

  // ---- 6. migration off wq#1176's JSON store ----
  const dir = mkdtempSync(join(tmpdir(), "lpp-persona-"));
  const legacy = join(dir, "persona.json");
  writeFileSync(legacy, JSON.stringify({
    v: 1, facts: [
      { key: "my name", value: "Lumen", single: true, platform: "stream", firstSaid: "2026-08-01T10:00:00.000Z" },
      { key: "i like", value: "caves", single: false, platform: "messenger", firstSaid: "2026-08-02T10:00:00.000Z" },
      { key: "my hp", value: "12", single: true, platform: "stream", firstSaid: "2026-08-03T10:00:00.000Z" },
    ],
  }));
  const mig = mem("2026-09-01");
  mig.m.migrateLegacy(legacy);
  mig.m.refresh(true);
  ok("legacy facts land in the fleet store", mig.m.facts.length === 2,
     mig.m.facts.map(f => `${f.key}=${f.value}`).join(" | "));
  ok("migration keeps the day each fact was first said",
     mig.m.facts.find(f => f.key === "my name")?.validFrom === "2026-08-01", "");
  ok("migration re-applies the guards (junk stays out)", !mig.m.facts.some(f => f.key === "my hp"), "");
  ok("the legacy file is renamed aside, not re-migrated",
     !existsSync(legacy) && existsSync(`${legacy}.migrated-2026-09-01`), "");

  // ---- 7. bounded recall view ----
  const big = mem("2026-09-01");
  for (let i = 0; i < MAX_FACTS + 40; i++) await big.m.observe(`I like filler-item-${i}`, "stream");
  ok("recall view is capped", big.m.facts.length <= MAX_FACTS, `facts=${big.m.facts.length}/${MAX_FACTS}`);
  ok("the fleet store keeps everything the view drops", big.store.current().length === MAX_FACTS + 40,
     `rows=${big.store.current().length}`);

  // ---- 8. never throws on junk, and degrades when the store is down ----
  let threw = false;
  try {
    const j = mem("2026-09-01");
    await j.m.observe("", "stream");
    await j.m.observe("   ", "");
    await j.m.observe("I am", "x");
    await j.m.observe("my  is  ", "x");
  } catch { threw = true; }
  ok("junk input does not throw", !threw, "");

  const dead = new PersonaMemory();
  dead.now = () => new Date("2026-09-01T12:00:00.000Z");
  dead.store = {
    kind: "dead",
    current() { throw new Error("store unreachable"); },
    ingest() { throw new Error("store unreachable"); },
  };
  const deadEvents = await dead.observe("My name is Lumen", "stream");
  ok("an unreachable store yields no fact and no throw", deadEvents.length === 0 && dead.storeErrors > 0,
     `errors=${dead.storeErrors}`);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  return fail ? 1 : 0;
}

main().then(code => process.exit(code));
