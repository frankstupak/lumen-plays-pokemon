// wq#555 acceptance: link-driver logs live on their OWN retention budget, so a
// Cable Club test can never evict live-agent run history.
//
// WHY THIS EXISTS. Retention is by extension: every .jsonl in events/ competed
// for one KEEP_FILES budget regardless of what wrote it. 24 rdv-A/rdv-B logs had
// accumulated against a default of 30, leaving SIX slots for run history — the
// arithmetic behind wq#551 losing 51 of 61 runs. wq#551 stopped the deletion;
// this stops the budget from meaning something nobody chose.
//
// Usage: npx tsx src/probe_linkevents555.ts
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync,
         statSync, utimesSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus, retainEventLogs } from "./events";
import { eventsDir, linkEventsDir, REPO } from "./fixtures";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};
const scratch: string[] = [];
const tmp = (t: string) => { const d = mkdtempSync(join(tmpdir(), `evt555-${t}-`)); scratch.push(d); return d; };

// ------------------------------------------------- A. the budgets are separate
console.log("=== A. link logs do not share the run-history budget ===");
{
  const root = tmp("root");
  process.env.LPP_REPO = root;
  chk("A1 linkEventsDir sits under events/, so one sweep owner can reach both",
    linkEventsDir() === `${root}/events/link`, linkEventsDir());

  // 24 link logs — the real count observed in events/ on 2026-08-14 — plus 6
  // run logs. Under a shared budget of 30 this is exactly the state that left
  // six slots for run history.
  const linkBus = (i: number) => new EventBus(linkEventsDir(), `rdv-A-${1786630000000 + i}`);
  for (let i = 0; i < 24; i++) linkBus(i).emit("boot", { i });
  const runNames: string[] = [];
  for (let i = 0; i < 6; i++) {
    const tag = `live-agent-${1786660000000 + i * 1000}`;
    new EventBus(eventsDir(), tag).emit("boot", { i });
    runNames.push(`${tag}.jsonl`);
  }

  chk("A2 the 24 link logs are NOT in the run-history directory",
    readdirSync(eventsDir()).filter(f => f.startsWith("rdv-")).length === 0);
  chk("A3 they are all in events/link",
    readdirSync(linkEventsDir()).filter(f => f.endsWith(".jsonl")).length === 24);

  // THE LOAD-BEARING ASSERTION. Sweep run history at the default budget of 30.
  const r = retainEventLogs(eventsDir(), 30);
  chk("A4 sweeping run history at keep=30 deletes NOTHING — 6 runs, 6 slots used, not 30",
    r.deleted.length === 0 && r.scanned === 6,
    `scanned=${r.scanned} deleted=${r.deleted.length}`);
  chk("A5 every run log survives; under the old shared directory 24 of these slots were spoken for",
    runNames.every(f => existsSync(join(eventsDir(), f))));
  chk("A6 sweeping run history does not touch the link directory",
    readdirSync(linkEventsDir()).filter(f => f.endsWith(".jsonl")).length === 24);
  delete process.env.LPP_REPO;
}

// ------------------------------- B. the link budget is swept, not left to grow
console.log("\n=== B. events/link is swept too — a separate dir nobody prunes is the 87MB bug again ===");
{
  const dir = tmp("link");
  const base = Date.now() - 40 * 60_000;
  const names: string[] = [];
  for (let i = 0; i < 40; i++) {
    const f = `rdv-A-${base + i * 60_000}.jsonl`;
    writeFileSync(join(dir, f), `{"i":${i}}\n`);
    utimesSync(join(dir, f), (base + i * 60_000) / 1000, (base + i * 60_000) / 1000);
    names.push(f);
  }
  const r = retainEventLogs(dir, 30);
  chk("B1 the same retention function trims the link budget", r.deleted.length === 10 && r.kept === 30,
    `kept=${r.kept} deleted=${r.deleted.length}`);
  chk("B2 oldest-first, same policy as run history", r.deleted.slice().sort().join() === names.slice(0, 10).sort().join());

  // ONE OWNER. wq#551's whole point was that deletion has exactly one caller;
  // adding a second directory must not add a second owner.
  const la = readFileSync(join(__dirname, "live_agent.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  chk("B3 live_agent sweeps BOTH directories",
    /retainEventLogs\(EVENTS_DIR\)/.test(la) && /retainEventLogs\(`\$\{EVENTS_DIR\}\/link`\)/.test(la));
  chk("B4 the link sweep is existsSync-gated, so a first boot does not log a false ENOENT",
    /existsSync\(`\$\{EVENTS_DIR\}\/link`\)/.test(la));
  chk("B5 the retention event reports the link budget too, or the sweep is invisible",
    /link:\s*\{/.test(la));
}

// -------------------------------------- C. no link driver writes to the root
console.log("\n=== C. every link driver was repointed, not just the three the guard names ===");
{
  const linkSrc = join(__dirname, "link");
  const files = readdirSync(linkSrc).filter(f => f.endsWith(".ts"));
  const strays: string[] = [];
  const repointed = new Set<string>();
  for (const f of files) {
    // Line-based and tag-aware. probe_linkpaths543 MUST construct against
    // eventsDir() — that is how it asserts the root resolver — so the exemption
    // is on THAT LINE only, never the whole file (the E5 lesson in that probe).
    const lines = readFileSync(join(linkSrc, f), "utf8").split("\n");
    for (const line of lines) {
      if (line.includes("wq555-resolver-guard") || line.includes("wq543-fixture")) continue;
      const code = line.replace(/\/\/.*$/, "");
      if (/new EventBus\(\s*eventsDir\(\)/.test(code)) strays.push(f);
      if (/new EventBus\(\s*linkEventsDir\(\)/.test(code)) repointed.add(f);
    }
  }
  chk("C1 zero link drivers still construct against the run-history directory",
    strays.length === 0, strays.length ? strays.join(" | ") : `${files.length} link files checked`);
  chk("C2 and the repointing is not vacuous — drivers were actually found and moved",
    repointed.size >= 13, `${repointed.size} distinct link files on linkEventsDir()`);
}

// ------------------------------------ D. the real directory, measured not moved
console.log("\n=== D. the live events/ directory as it stands right now ===");
{
  let jsonl: string[] = [];
  try { jsonl = readdirSync(`${REPO}/events`).filter(f => f.endsWith(".jsonl")); } catch {}
  if (jsonl.length === 0) {
    console.log("     NOTE: events/ unreadable or empty here — D SKIPPED rather than passed vacuously.");
  } else {
    const rdv = jsonl.filter(f => f.startsWith("rdv-")).length;
    const runs = jsonl.filter(f => f.startsWith("live-agent-")).length;
    console.log(`     events/ .jsonl=${jsonl.length}  rdv-*=${rdv}  live-agent-*=${runs}`);
    console.log(`     Files are MIGRATED BY HAND under the ticket, not by this probe — a test`);
    console.log(`     that moves live data is a test that can lose it.`);
    chk("D1 this probe read the real directory and changed nothing in it",
      readdirSync(`${REPO}/events`).filter(f => f.endsWith(".jsonl")).length === jsonl.length);
  }
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });
console.log(`\nprobe_linkevents555: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
