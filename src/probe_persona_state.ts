// wq#1191 probe — the REAL lumen_state path, end to end.
//
// probe_persona.ts pins the policy against an in-process store. That proves the
// rules and proves nothing about the thing the ticket is actually about: that a
// persona fact lands in the FLEET's bi-temporal store and can be read back out
// of it by anyone. This probe runs the same subprocess the live agent runs —
// tools/lumen_state_json.py over /home/lumen/minerva/lumen_state.py — against a
// throwaway sqlite file, so the supersession code under test is the real one and
// nothing lands in live fleet state.
//
// SKIPS (green) where Minerva is not installed: CI runners have no
// /home/lumen/minerva, and a probe that failed there would only teach people to
// ignore it. Installed-but-unusable is the opposite case and stays RED (wq#1830):
// there it is the LIVE persona path that is broken, and persona.ts answers a dead
// store by bumping a counter nobody reads, so this probe is the only one shouting.
import { PersonaMemory } from "./persona";
import { LumenStateStore } from "./persona_store";
import { planCompaction } from "./persona_compact";
import { CFG } from "./config";
import { spawnSync } from "child_process";
import { mkdtempSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

const LUMEN_STATE_PY = process.env.LPP_LUMEN_STATE_PY ?? "/home/lumen/minerva/lumen_state.py";

/** One cheap adapter call before the first assertion, so a store that is present
 *  but cannot be loaded reports the reason on one line instead of exploding out
 *  of the tenth assertion as an unhandled stack trace (wq#1830: lumen_state.py
 *  imported by file location could not find its sibling minerva_audit). */
function adapterFailure(db: string): string | null {
  const r = spawnSync(CFG.persona.python,
    [CFG.persona.adapter, "current", "lpp-probe-preflight", "--db", db], { encoding: "utf8" });
  if (r.status === 0) return null;
  return String(r.stderr ?? "").trim().split("\n")[0] || `exit ${String(r.status)}`;
}

async function main(): Promise<number> {
  if (!existsSync(CFG.persona.adapter) || !existsSync(LUMEN_STATE_PY)) {
    console.log(`SKIP no lumen_state at ${LUMEN_STATE_PY} — nothing to integrate against`);
    console.log("\n0 PASS / 0 FAIL");
    return 0;
  }

  const dir = mkdtempSync(join(tmpdir(), "lpp-persona-state-"));
  const db = join(dir, "state.db");
  const subject = "lpp-probe-persona";
  const store = () => new LumenStateStore({ subject, db, regen: "" });

  const broken = adapterFailure(db);
  if (broken) {
    ok("lumen_state is loadable — the live persona path depends on it", false, broken);
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    return 1;
  }

  // ── a fact stated on one surface, recalled on another, out of the real store ──
  const streamer = new PersonaMemory();
  streamer.now = () => new Date("2026-09-01T12:00:00.000Z");
  streamer.useStore(store());
  const e1 = await streamer.observe("My favourite pokemon is Bulbasaur", "stream");
  ok("a stated fact is ingested into lumen_state", e1[0]?.outcome === "new", e1[0]?.outcome ?? "none");

  const messenger = new PersonaMemory();
  messenger.now = () => new Date("2026-09-01T12:00:00.000Z");
  messenger.useStore(store());
  ok("the next generation on ANOTHER surface recalls it", messenger.recall().includes("Bulbasaur"),
     messenger.recall().slice(0, 60));
  ok("platform of origin round-trips through source_ref",
     messenger.facts[0]?.platform === "stream", String(messenger.facts[0]?.platform));

  // ── same-day contradiction: refused, and the store still holds the original ──
  const e2 = await messenger.observe("My favourite pokemon is Charmander", "messenger");
  ok("a same-session contradiction is refused", e2[0]?.outcome === "conflict", e2[0]?.outcome ?? "none");
  ok("the refusal never reached the store", store().current()[0]?.value === "Bulbasaur",
     String(store().current()[0]?.value));

  // ── a change of mind a week later: new valid-from, new current value ──
  messenger.now = () => new Date("2026-09-08T12:00:00.000Z");
  const e3 = await messenger.observe("My favourite pokemon is Charmander", "messenger");
  ok("a later-day change of mind is an update", e3[0]?.outcome === "updated", e3[0]?.outcome ?? "none");
  const rows = store().current();
  ok("the new value is what lumen_state now returns",
     rows.length === 1 && rows[0].value === "Charmander" && rows[0].validFrom === "2026-09-08",
     rows.map(r => `${r.value}@${r.validFrom}`).join(" | "));

  // ── lumen_state's OWN cli shows them, which IS the cross-platform claim ──
  // `lumen_state.py current <subject>`, human formatting and all: what an
  // operator or another fleet agent sees when they go looking for who Lumen is.
  const cli = spawnSync(CFG.persona.python,
    [CFG.persona.adapter, "cli", "--db", db, "current", subject], { encoding: "utf8" });
  ok("lumen_state.py current <subject> shows the fact",
     cli.status === 0 && /my_favorite_pokemon\s+= Charmander/.test(cli.stdout ?? ""),
     (cli.stdout ?? cli.stderr ?? "").trim().split("\n")[0] ?? "");

  const viaAdapter = spawnSync(CFG.persona.python,
    [CFG.persona.adapter, "history", subject, "my_favorite_pokemon", "--db", db], { encoding: "utf8" });
  const history = JSON.parse(viaAdapter.stdout || '{"rows":[]}').rows as any[];
  ok("lumen_state keeps the full bi-temporal history",
     history.length === 2 && history[0].value === "Bulbasaur" && history[0].valid_to === "2026-09-08" &&
     history[1].value === "Charmander" && history[1].valid_to === null,
     history.map(r => `${r.value}:${r.valid_from}->${r.valid_to ?? "NOW"}`).join(" | "));

  // ── set-valued facts get one row each rather than evicting one another ──
  await messenger.observe("I like caves", "messenger");
  await messenger.observe("I like Mt Moon", "messenger");
  const all = store().current();
  ok("set members are separate rows in lumen_state",
     all.filter(r => r.predicate.startsWith("i_like__")).length === 2,
     all.map(r => r.predicate).join(" | "));

  // ── migration: wq#1176's JSON store lands in the fleet store on first bind ──
  const legacy = join(dir, "persona.json");
  writeFileSync(legacy, JSON.stringify({
    v: 1, facts: [{ key: "my name", value: "Lumen", single: true, platform: "stream", firstSaid: "2026-08-01T10:00:00.000Z" }],
  }));
  const migrated = new PersonaMemory();
  migrated.now = () => new Date("2026-09-08T12:00:00.000Z");
  migrated.store = store();
  migrated.migrateLegacy(legacy);
  migrated.refresh(true);
  ok("a migrated fact is in lumen_state at its original valid-from",
     migrated.facts.find(f => f.key === "my name")?.validFrom === "2026-08-01",
     String(migrated.facts.find(f => f.key === "my name")?.validFrom));
  ok("the legacy file is renamed aside", !existsSync(legacy), "");

  // ── wq#2237: junk rows can be CLOSED (valid_to), never deleted ──
  const adapter = (...args: string[]) =>
    spawnSync(CFG.persona.python, [CFG.persona.adapter, ...args, "--db", db], { encoding: "utf8" });
  const junkSubject = subject;   // the registry gates predicates per subject, so seed the probe persona itself
  const junkPreds = ["i_am__junk_one", "i_am__junk_two"];
  const junkStore = store();
  for (const p of junkPreds)
    junkStore.ingest({ predicate: p, value: p, validFrom: "2026-09-01", source: "lpp:stream" });
  const openPreds = () =>
    (JSON.parse(adapter("current", junkSubject).stdout || '{"rows":[]}').rows as any[]).map(r => r.predicate);

  const before = openPreds().length;
  const noSelector = adapter("close", junkSubject, "--reason", "probe");
  ok("close refuses to run without a predicate or glob",
     noSelector.status === 1 && openPreds().length === before, `exit ${String(noSelector.status)}`);

  const dry = JSON.parse(adapter("close", junkSubject, "--glob", "i_am__*", "--reason", "probe", "--dry-run").stdout || "{}");
  ok("--dry-run reports the rows and changes nothing",
     dry.closed?.length === 2 && openPreds().length === before, JSON.stringify(dry.closed));

  const closed = JSON.parse(adapter("close", junkSubject, "--glob", "i_am__*", "--reason", "probe").stdout || "{}");
  ok("close reports exactly the matching rows", closed.closed?.join() === junkPreds.join(), JSON.stringify(closed.closed));
  ok("closed rows leave current(); other rows stay open",
     openPreds().length === before - 2 && openPreds().includes("my_favorite_pokemon") && !openPreds().some(p => p.startsWith("i_am__")), openPreds().join(" | "));
  const kept = (JSON.parse(adapter("history", junkSubject, junkPreds[0]).stdout || '{"rows":[]}').rows as any[])[0];
  ok("a closed row is kept as evidence: value intact, valid_to set",
     kept?.value === junkPreds[0] && typeof kept?.valid_to === "string" && kept.valid_to >= "2026-09-01",
     JSON.stringify(kept && [kept.value, kept.valid_to]));
  const again = JSON.parse(adapter("close", junkSubject, "--glob", "i_am__*", "--reason", "probe").stdout || "{}");
  ok("closing twice is a no-op", again.closed?.length === 0, JSON.stringify(again.closed));

  // ── wq#1176: one question is one slot, end to end through real lumen_state ──
  //
  // Live lumen-persona held "San Francisco" at six predicates because the
  // extractor named each slot after the sentence that produced it. Here the
  // pre-fold spelling is seeded the way the live store got it, and the check is
  // that a later statement REVISES that slot instead of opening a parallel one.
  const foldStore = store();
  foldStore.ingest({ predicate: "my_former_city", value: "San Francisco", validFrom: "2026-09-01", source: "lpp:stream" });
  const folded = new PersonaMemory();
  folded.now = () => new Date("2026-09-08T12:00:00.000Z");
  folded.useStore(foldStore);
  const e4 = await folded.observe("My old city is Oakland", "stream");
  ok("a differently-worded slot is an update, not a new row", e4[0]?.outcome === "updated",
     `${e4[0]?.outcome ?? "none"} key=${e4[0]?.key ?? ""}`);
  const cityRows = () => openPreds().filter(p => p.endsWith("_city"));
  ok("lumen_state ends with ONE open city row", cityRows().length === 1 && cityRows()[0] === "my_old_city",
     cityRows().join(" | "));
  const supersededCity = (JSON.parse(adapter("history", subject, "my_former_city").stdout || '{"rows":[]}').rows as any[])[0];
  ok("the pre-fold spelling is closed, with its value kept for the audit",
     supersededCity?.value === "San Francisco" && typeof supersededCity?.valid_to === "string",
     JSON.stringify(supersededCity && [supersededCity.value, supersededCity.valid_to]));
  folded.refresh(true);
  ok("and recall answers the question once", folded.recall().split("\n").filter(s => s.includes("city")).length === 1,
     folded.recall().split("\n").filter(s => s.includes("city")).join(" / "));

  // ── wq#1191 compaction: the rules applied to rows lumen_state ALREADY holds ──
  //
  // The guards only ever ran on the way IN, so the live subject still carries a
  // week of pre-guard rows and every fleet consumer reads them. This is that
  // backlog, closed through the real adapter: the plan is computed from the
  // store's own rows, and the closes have to survive as history.
  const compactStore = store();
  for (const [p, v] of [
    ["i_am__dry", "dry"],
    ["i_am__dry_tired_streamer", "a dry, tired streamer"],
    ["i_am__lumen_dry_and_tired_one_sentence_about_dana_not_about_the_game", "Lumen, dry and tired, one sentence about Dana, not about the game, not repeating recent lines"],
  ] as [string, string][]) compactStore.ingest({ predicate: p, value: v, validFrom: "2026-09-10", source: "lpp:stream" });

  const beforeCompact = openPreds();
  const plan = planCompaction(compactStore.current());
  ok("the plan closes exactly the pre-guard rows, and nothing he actually believes",
     plan.closes.map(c => c.predicate).sort().join(",") ===
       "i_am__dry_tired_streamer,i_am__lumen_dry_and_tired_one_sentence_about_dana_not_about_the_game",
     plan.closes.map(c => c.predicate).join(" | "));
  for (const c of plan.closes) compactStore.close(c.predicate, c.reason);
  const afterCompact = openPreds();
  ok("lumen_state itself is compacted, so every surface sees one self-description",
     afterCompact.length === beforeCompact.length - plan.closes.length &&
     afterCompact.filter(p => p.startsWith("i_am__")).join() === "i_am__dry",
     afterCompact.filter(p => p.startsWith("i_am__")).join(" | "));
  const compacted = (JSON.parse(adapter("history", subject, "i_am__dry_tired_streamer").stdout || '{"rows":[]}').rows as any[])[0];
  ok("a compacted row keeps its value and its days: closed, never deleted",
     compacted?.value === "a dry, tired streamer" && typeof compacted?.valid_to === "string",
     JSON.stringify(compacted && [compacted.value, compacted.valid_to]));
  ok("re-running compaction against the compacted store is a no-op",
     planCompaction(compactStore.current()).closes.length === 0,
     planCompaction(compactStore.current()).closes.map(c => c.predicate).join(" | "));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  return fail ? 1 : 0;
}

main().then(code => process.exit(code)).catch(e => {
  // A throw here is a result too — print it as one, so probes-pure.sh's tail
  // shows the diagnosis rather than five lines of node stack.
  console.log(`FAIL probe threw :: ${String(e?.message ?? e).slice(0, 200)}`);
  process.exit(1);
});
