// wq#1176 probe — persona memory. Pure logic: no emulator, no ROM, no network.
// Pins the four properties the feature is worth having for:
//   1. extraction is NARROW (game chatter must not become canonical)
//   2. canonical means FIRST (a later contradiction never rewrites the answer)
//   3. it survives a process boundary (bind -> observe -> new instance -> recall)
//   4. it is CROSS-PLATFORM (a fact stated on messenger recalls on stream)
import { PersonaMemory, extractPersonaClaims, normValue, normKey, MAX_FACTS } from "./persona";
import { existsSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// ---- 1. extraction: what counts as a self-fact ----
const keysOf = (t: string) => extractPersonaClaims(t).map(c => `${c.key}=${c.value}`);

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

// normalization: casing/articles/punctuation must not fake a contradiction
ok("normalizer ignores case+articles+punct", normValue("The Bulbasaur!") === normValue("bulbasaur"),
   `${normValue("The Bulbasaur!")} vs ${normValue("bulbasaur")}`);
// one question = one slot, or the same question has two canonical answers
ok("spelling variants fold to one slot", normKey("my favourite pokémon") === normKey("My Favorite Pokemon"),
   `${normKey("my favourite pokémon")} vs ${normKey("My Favorite Pokemon")}`);

// ---- 2. canonical means FIRST ----
const m = new PersonaMemory();
const e1 = m.observe("My favourite pokemon is Bulbasaur", "stream");
ok("first statement is new", e1[0]?.outcome === "new", e1[0]?.outcome ?? "none");
const e2 = m.observe("my favorite pokemon is BULBASAUR.", "stream");
ok("restating the same value reaffirms (not a duplicate fact)",
   e2[0]?.outcome === "reaffirmed" && m.facts.length === 1, `facts=${m.facts.length}`);
const e3 = m.observe("My favourite pokemon is Charmander", "messenger");
ok("contradiction is reported, not applied", e3[0]?.outcome === "conflict", e3[0]?.outcome ?? "none");
ok("canonical value survives the contradiction",
   m.facts[0].value === "Bulbasaur" && m.facts[0].conflicts.length === 1, m.facts[0].value);
ok("conflict notice names both values",
   PersonaMemory.conflictNotice(e3).includes("Bulbasaur") && PersonaMemory.conflictNotice(e3).includes("Charmander"),
   PersonaMemory.conflictNotice(e3).slice(0, 70));
ok("no conflict notice when nothing conflicted", PersonaMemory.conflictNotice(e1) === "", "");

// set-valued keys accumulate instead of conflicting
const s = new PersonaMemory();
s.observe("I like caves", "stream");
s.observe("I like Bulbasaur", "stream");
ok("set-valued key accumulates values", s.facts.length === 2 && s.facts.every(f => f.key === "i like"),
   s.facts.map(f => f.value).join("/"));
ok("set-valued restatement still reaffirms", s.observe("I like caves", "stream")[0]?.outcome === "reaffirmed", "");

// ---- 3. persistence across a process boundary ----
const dir = mkdtempSync(join(tmpdir(), "lpp-persona-"));
const file = join(dir, "persona.json");
const w = new PersonaMemory();
w.bind(file);
w.observe("My name is Lumen", "stream");
w.observe("I am an AI playing Pokemon Blue", "stream");
ok("store file written", existsSync(file), file);

const r = new PersonaMemory();
r.bind(file);
ok("facts restored from disk", r.facts.length === 2, `facts=${r.facts.length}`);
ok("recall renders the restored facts", r.recall().includes("Lumen"), r.recall().slice(0, 60));
ok("recall is empty for an empty store", new PersonaMemory().recall() === "", "");
ok("recall honours its budget", r.recall(40).length <= 40, `len=${r.recall(40).length}`);
ok("identity slots rank ahead of set-valued ones", r.recall().split("\n")[0].startsWith("- my name"), r.recall().split("\n")[0]);

// ---- 4. cross-platform: stated on messenger, recalled on stream ----
const bridge = new PersonaMemory();
bridge.bind(file);
bridge.observe("My favourite colour is blue", "messenger");
const streamSide = new PersonaMemory();
streamSide.bind(file);
ok("a messenger fact is canonical on the stream", streamSide.recall().includes("blue"),
   streamSide.recall().split("\n").find(l => l.includes("colour")) ?? "");
ok("platform of origin is retained",
   streamSide.facts.find(f => f.key === "my favorite color")?.platform === "messenger",
   streamSide.facts.map(f => f.key).join("|"));
// asked in the OTHER spelling on purpose: a question must reach its slot
ok("search finds a fact by question words", streamSide.search("favourite colour")[0]?.value === "blue",
   String(streamSide.search("favourite colour")[0]?.value));
ok("search misses on an unknown subject", streamSide.search("hometown").length === 0, "");

// contradiction across platforms is still refused
const back = new PersonaMemory();
back.bind(file);
const xp = back.observe("My name is Ash", "messenger");
ok("cross-platform contradiction rejected", xp[0]?.outcome === "conflict" &&
   back.facts.find(f => f.key === "my name")?.value === "Lumen",
   String(back.facts.find(f => f.key === "my name")?.value));

// ---- 5. bounded growth ----
const big = new PersonaMemory();
for (let i = 0; i < MAX_FACTS + 40; i++) big.observe(`I like filler-item-${i}`, "stream");
ok("store is capped", big.facts.length <= MAX_FACTS, `facts=${big.facts.length}/${MAX_FACTS}`);
big.observe("I like filler-item-0", "stream");   // survivors are the most-stated
ok("eviction keeps the most-stated facts", big.facts.some(f => f.value === "filler-item-0"), "");

// ---- 6. never throws on junk ----
let threw = false;
try {
  const j = new PersonaMemory();
  j.observe("", "stream"); j.observe("   ", ""); j.observe("I am", "x"); j.observe("my  is  ", "x");
  j.bind(join(dir, "nope", "deep", "persona.json"));
} catch { threw = true; }
ok("junk input and a fresh nested path do not throw", !threw, "");

try { unlinkSync(file); } catch {}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
