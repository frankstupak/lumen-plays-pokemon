// wq#540 acceptance: a standing guard against PROBE ROT — the failure mode where
// a probe reports a passing score while verifying nothing, because it is pinned
// to something outside its own diff that has since moved.
//
// This probe audits the OTHER probes. It is the only test here that reads the
// test suite as data, and it exists because six probes reached that state
// without anyone noticing: probe_battlestuck, probe_cerulean, probe_flee,
// probe_oscillation, probe_wildbattle and probe_resume518 all died with an
// ENOENT stack trace BEFORE their first assertion, so they emitted no FAIL line
// and their last known scores were memories.
//
// THREE RULES ENFORCED HERE
//   R1 NO NAMED FIXTURE THAT IS GONE — a literal .state.gz path a probe loads
//      must exist on disk right now. Better still, resolve by property via
//      fixtures.ts and do not name a file at all.
//   R2 NO TREE-RELATIVE CORPUS PATH — "roms/pokeblue.gb", "checkpoints/..." and
//      "saves/..." are relative to the CWD, and all three are gitignored, so a
//      probe using them cannot run inside a `lumen-pr start --worktree`
//      checkout. That is wq#520's defect (verify_489.py verified the primary
//      tree, never the diff) in a second form, and it affected 26 probes.
//   R3 EMPTY-CORPUS ASSERTIONS MUST BE VISIBLE — [].every(p) is TRUE, so a
//      scanned corpus that rotation empties silently converts a real assertion
//      into a free pass. Probes that scan must show their sample count.
//
// Usage: npx tsx src/probe_fixtures540.ts
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { fixtureIndex, findFixture, haveSamples, REPO } from "./fixtures";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

// Audit the probes in THIS tree, never a fixed path — the rot being guarded
// against is precisely a test that reads the wrong tree. (wq#520.)
const SRC = __dirname;
const SELF = "probe_fixtures540.ts";
const probes = readdirSync(SRC).filter(f => f.startsWith("probe_") && f.endsWith(".ts")).sort();
console.log(`=== auditing ${probes.length} probes in ${SRC} ===\n`);

// A literal PATH, not a log message that happens to mention a filename:
// no whitespace, and it must look like a path.
const LITERAL_STATE = /"([^"\s]*\.state\.gz)"/g;
const RELATIVE_CORPUS = /"(roms\/|checkpoints\/|saves\/)[^"]*"/g;

const r1: string[] = [], r2: string[] = [], scanners: string[] = [];
for (const p of probes) {
  if (p === SELF) continue;
  const text = readFileSync(join(SRC, p), "utf8");

  for (const m of text.matchAll(LITERAL_STATE)) {
    const lit = m[1];
    // /tmp fixtures are produced by a sibling probe earlier in a manual chain,
    // and fixture names inside a mkdtemp harness are not paths at all.
    if (lit.startsWith("/tmp/") || !lit.includes("/")) continue;
    const full = lit.startsWith("/") ? lit : join(REPO, lit);
    if (!existsSync(full)) r1.push(`${p}: ${lit}`);
  }

  for (const m of text.matchAll(RELATIVE_CORPUS)) r2.push(`${p}: ${m[0]}`);

  if (/readdirSync\(/.test(text)) scanners.push(p);
}

console.log("--- R1: named fixtures that are no longer on disk ---");
r1.forEach(s => console.log(`   ${s}`));
chk("R1 no probe loads a named .state.gz that has rotated off disk",
    r1.length === 0,
    r1.length ? `${r1.length} dead reference(s) — resolve by property via fixtures.ts` : "none");

console.log("\n--- R2: corpus paths relative to the CWD ---");
r2.forEach(s => console.log(`   ${s}`));
chk("R2 no probe uses a tree-relative roms/ checkpoints/ or saves/ path",
    r2.length === 0,
    r2.length ? `${r2.length} occurrence(s) — these cannot run from a worktree` : "none");

console.log(`\n--- R3: ${scanners.length} probes scan a directory and must show sample counts ---`);
console.log(`   ${scanners.join(" ")}`);

// The helper itself has to work, or the rules above are unenforceable.
console.log("\n--- fixtures.ts behaviour ---");
const idx = fixtureIndex();
chk("fixtureIndex finds the live corpus", idx.length > 0, `${idx.length} states with sidecars`);
chk("fixtureIndex is sorted newest-first",
    idx.every((f, i) => i === 0 || idx[i - 1].mtime >= f.mtime));
chk("findFixture resolves a property that IS satisfied", findFixture(() => true) !== null);
chk("findFixture returns null rather than throwing on an impossible property",
    findFixture(sc => sc.map === -12345) === null,
    "callers must handle absence explicitly; a load must never be the thing that discovers it");
chk("haveSamples is TRUE on a populated corpus", haveSamples("self-test", 3) === true);
chk("haveSamples is FALSE on an empty one — this is the free-pass this ticket closes",
    haveSamples("self-test (expected note above)", 0) === false);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
