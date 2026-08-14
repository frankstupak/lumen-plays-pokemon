// wq#543 GUARD — link driver paths resolve against the REPO ROOT, not the CWD.
//
// WHAT THIS EXISTS TO CATCH, and why a simpler probe would not catch it. The
// defect class is a bare CWD-relative directory string in a link driver. Half
// of it fails loudly (checkpoints/ saves/ are gitignored, so a --worktree run
// gets ENOENT) and half of it fails SILENTLY: EventBus's constructor does
// mkdirSync(dir, {recursive:true}), so `new EventBus("events", ...)` from a
// worktree cheerfully creates an empty events/ there and emits into a directory
// nobody reads. Nothing throws. The run looks fine. Any later scan of that
// directory is wq#540's R3 empty-corpus shape and goes GREEN over zero samples.
//
// THE TRAP THIS PROBE IS WRITTEN TO AVOID, quoting the ticket: "A guard that
// only passes from the primary tree is the exact bug being fixed." A probe that
// merely calls eventsDir() and likes the answer would pass from anywhere and
// prove nothing, because it never establishes that the CWD could have differed.
// So every section here CHDIRs into a scratch directory first, and section E
// runs the detector against known-bad input to show it can still fail. That is
// the discrimination check rabbit17b found missing in probe_evt522 section B at
// 16:52Z: a section whose fixture cannot express the bug scores 3/3 on a broken
// build.
//
// HONEST LIMITATION, stated rather than papered over: this does NOT boot an
// emulator or execute a real driver end to end — importing one would run its
// top-level IIFE and drive two Game Boys. It asserts the resolution mechanism
// from a scratch CWD (A, B, D), asserts the drivers textually go through that
// mechanism (C, F), and proves the detector discriminates (E). A true end-to-end
// run belongs to whoever next exercises the link stack under wq#484.
//
// RUN: npx tsx src/link/probe_linkpaths543.ts   (from ANY directory, by design)

import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { EventBus } from "../events";
import { eventsDir, linkEventsDir, romPath, ckptPath, repoPath, repoRoot, REPO, haveSamples } from "../fixtures";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// TWO DIFFERENT ANCHORS, AND CONFLATING THEM IS ITSELF THE BUG CLASS.
//
// This probe originally wrote `${REPO}/src/link` here and it FAILED ON ITS OWN
// DIFF: REPO is the primary tree, so a --worktree run scanned the UNFIXED code
// while the fix sat unexamined in the worktree next door. That is exactly
// wq#540's R2 (hardcoded tree -> probe verifies the wrong checkout and can go
// green without ever executing the change under review). Recording it here
// because the same helper cannot serve both jobs:
//
//   CODE UNDER TEST  (src/link/*.ts) -> anchor to THIS MODULE. It must travel
//                    with the diff, so a worktree run scans the worktree.
//   CAMPAIGN DATA    (events/ roms/ checkpoints/) -> anchor to REPO. It is
//                    shared state that must NOT fork per worktree; that is the
//                    whole point of wq#543.
//
// Same word "root", two meanings. The drivers want the second; a probe wants
// the first.
// (__dirname, not import.meta: NodeNext + a package.json without "type":"module"
// builds these to CommonJS, and tsc rejects import.meta there — TS1470.)
const LINK = __dirname;

// The detector, factored out so section E can aim it at known-bad input.
// Strips // comments first: wq#540 Finding 3 — an audit that flags its own
// documentation is an audit people delete. Excludes the CURE forms
// romPath("x") / ckptPath("x") / repoPath("x") so it does not flag the fix.
const BARE = /(?<![\w.])"(events|runtime|saves|logs-24h|checkpoints|roms)(\/[^"]*)?"/;
export function bareLiterals(src: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  src.split("\n").forEach((raw, i) => {
    const s = raw.trimStart();
    if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return;
    const code = raw.replace(/\/\/.*$/, "")
                    .replace(/\b(romPath|ckptPath|repoPath)\(\s*"[^"]*"\s*(,\s*"[^"]*"\s*)*\)/g, "$1(_)");
    // A probe that tests a detector must contain the very strings the detector
    // hunts. Blanket-excluding this file would blind the scan to a real
    // regression living in it, so the exemption is per-LINE and explicit:
    // only lines tagged wq543-fixture are skipped. E5 proves the tag is not a
    // blanket off-switch.
    if (raw.includes("wq543-fixture")) return;
    if (BARE.test(code)) hits.push({ line: i + 1, text: raw.trim() });
  });
  return hits;
}

const scratch = mkdtempSync(`${tmpdir()}/wq543-`);
const origCwd = process.cwd();
process.chdir(scratch);   // <-- everything below runs from a directory that is
                          //     NOT the repo and NOT any worktree.

// --- A: resolution from a scratch CWD still finds the REAL directories -------
ok("A1 cwd is not the repo", !process.cwd().startsWith(REPO), `cwd=${process.cwd()}`);
ok("A2 eventsDir absolute + anchored", eventsDir() === `${REPO}/events`, eventsDir());
ok("A3 real events/ exists", existsSync(eventsDir()), eventsDir());
ok("A4 romPath resolves to a real ROM", existsSync(romPath("pokeblue.gb")), romPath("pokeblue.gb"));
ok("A5 ckptPath anchored", ckptPath("x.state.gz") === `${REPO}/checkpoints/x.state.gz`);

// --- B: the fix is load-bearing (old behaviour would have differed) ---------
const oldWay = resolve("events");   // wq543-fixture
ok("B1 CWD-relative would have resolved elsewhere", oldWay !== eventsDir(),
   `old=${oldWay} new=${eventsDir()}`);
ok("B2 and that elsewhere is inside the scratch dir", oldWay.startsWith(scratch), oldWay);

// --- C: no bare CWD-relative literal remains in any link driver -------------
const files = readdirSync(LINK).filter(f => f.endsWith(".ts"));
ok("C0 corpus is non-empty (not a vacuous scan)",
   haveSamples("src/link/*.ts", files.length, 10), `${files.length} files scanned`);
const offenders: string[] = [];
for (const f of files) {
  for (const h of bareLiterals(readFileSync(`${LINK}/${f}`, "utf8"))) {
    offenders.push(`${f}:${h.line}: ${h.text}`);
  }
}
ok("C1 zero bare CWD-relative resource literals in src/link",
   offenders.length === 0, offenders.length ? offenders.join(" | ") : `${files.length} files clean`);

// --- D: a bus built the driver's way writes to the ROOT, not the CWD --------
const fakeRoot = mkdtempSync(`${tmpdir()}/wq543root-`);
process.env.LPP_REPO = fakeRoot;
ok("D0 LPP_REPO retargets the resolver", repoRoot() === fakeRoot, repoRoot());
const bus = new EventBus(eventsDir(), "wq543-guard");   // wq555-resolver-guard: MUST use the root resolver — this line asserts D1/D3
bus.emit("boot", { probe: "wq543" });
ok("D1 event landed under the ROOT", existsSync(`${fakeRoot}/events/wq543-guard.jsonl`),
   `${fakeRoot}/events/wq543-guard.jsonl`);
ok("D2 nothing was written into the CWD", !existsSync(`${scratch}/events`),
   "scratch/events absent");
delete process.env.LPP_REPO;
ok("D3 resolver restored to the real repo", eventsDir() === `${REPO}/events`, eventsDir());

// --- D4/D5 (wq#555): link drivers emit to their OWN retention budget --------
// The wq#543 property being guarded here is "root-anchored, never CWD-relative",
// and linkEventsDir() must satisfy it exactly as eventsDir() does. The NEW
// property is separation: 24 rdv-* logs were competing with live-agent run
// history for one KEEP_FILES budget, which is how wq#551 lost 51 runs.
ok("D4 linkEventsDir is absolute, anchored, and UNDER events/ — not a sibling nobody sweeps",
   linkEventsDir() === `${REPO}/events/link`, linkEventsDir());
{
  const linkRoot = mkdtempSync(`${tmpdir()}/wq555root-`);
  process.env.LPP_REPO = linkRoot;
  const lbus = new EventBus(linkEventsDir(), "wq555-guard");   // exactly the link-driver call shape
  lbus.emit("boot", { probe: "wq555" });
  ok("D5 a link driver's events land in events/link, NOT in the run-history directory",
     existsSync(`${linkRoot}/events/link/wq555-guard.jsonl`) &&
     !existsSync(`${linkRoot}/events/wq555-guard.jsonl`),
     `${linkRoot}/events/link/wq555-guard.jsonl`);
  delete process.env.LPP_REPO;
  rmSync(linkRoot, { recursive: true, force: true });
}

// --- E: the detector actually discriminates (negative control) --------------
const BAD = `import { EventBus } from "../events";\nconst b = new EventBus("events", "x");`;   // wq543-fixture
ok("E1 detector FLAGS a bare EventBus dir", bareLiterals(BAD).length === 1,
   JSON.stringify(bareLiterals(BAD)));
const BAD2 = `loadSnapshotFile(emu, "checkpoints/center-m2b.state.gz");`;   // wq543-fixture
ok("E2 detector FLAGS a bare checkpoint path", bareLiterals(BAD2).length === 1);
const CURED = `const b = new EventBus(eventsDir(), "x");\nloadSnapshotFile(emu, ckptPath("center-m2b.state.gz"));`;   // wq543-fixture
ok("E3 detector PASSES the cured form", bareLiterals(CURED).length === 0);
const DOC = `// historically this said new EventBus("events", tag) and that was the bug`;   // wq543-fixture
ok("E4 detector ignores its own documentation", bareLiterals(DOC).length === 0);

ok("E5 fixture tag exempts ONLY its own line, not the file",
   bareLiterals(`const a = new EventBus("events", "x");   // wq543-fixture\nconst b = new EventBus("events", "y");`).length === 1,
   "second line still flagged");

// --- F: representative drivers really go through the helper -----------------
// wq#555 RE-POINTED, NOT WEAKENED. The wq#543 property is "resolves through a
// root-anchored helper from ../fixtures, never a bare literal", and that is
// unchanged and still asserted. Only WHICH helper moved, because link drivers
// now emit to their own retention budget. Note `/eventsDir\(\)/` does NOT match
// `linkEventsDir()` (capital E), so leaving this alone would have failed rather
// than passed silently — and C1's bare-literal detector, which is the real
// guard here, was not touched at all.
for (const f of ["drive_trade.ts", "drive_duel.ts", "rdv_side.ts"]) {
  const src = readFileSync(`${LINK}/${f}`, "utf8");
  ok(`F ${f} imports the root helper`,
     /from "\.\.\/fixtures"/.test(src) && /linkEventsDir\(\)/.test(src));
}

// F2 (wq#555): no link driver may still emit into the shared run-history dir.
{
  const strays: string[] = [];
  for (const f of readdirSync(LINK).filter(n => n.endsWith(".ts"))) {
    for (const [i, line] of readFileSync(`${LINK}/${f}`, "utf8").split("\n").entries()) {
      if (line.includes("wq555-resolver-guard") || line.includes("wq543-fixture")) continue;   // narrow, per-line, per E5
      if (/new EventBus\(\s*eventsDir\(\)/.test(line.replace(/\/\/.*$/, ""))) strays.push(`${f}:${i + 1}`);
    }
  }
  ok("F2 zero link drivers construct a bus against the run-history events dir",
     strays.length === 0, strays.length ? strays.join(" | ") : `${readdirSync(LINK).filter(n => n.endsWith(".ts")).length} link files clean`);
}

process.chdir(origCwd);
rmSync(scratch, { recursive: true, force: true });
rmSync(fakeRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
