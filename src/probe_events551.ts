// wq#551 acceptance: CONSTRUCTING an EventBus deletes nothing, retention is an
// explicit call with exactly one owner, and no probe can reach the destructive
// path by accident.
//
// WHY THIS EXISTS. src/events.ts:24 used to call this.retain() from the
// CONSTRUCTOR. retain() unlinked every .jsonl past the newest KEEP_FILES
// (default 30) inside a bare `catch {}`, so instantiating a class — the single
// most common thing a probe or one-off script does — permanently destroyed
// history, silently, with no run, no write and no flag. 51 of 61 runs lost
// their per-turn event logs to it before it was ticketed.
//
// THIS PROBE NEVER POINTS A BUS AT /home/lumen/pokemon/events. Not because
// that is still unsafe — after this change it is safe, which is the whole
// point — but because a probe whose job is to prove "we no longer delete
// history" must not be capable of deleting history when it FAILS. Section E
// re-enacts the real directory's shape in a temp dir instead.
//
// Usage: npx tsx src/probe_events551.ts
import { readFileSync, readdirSync, writeFileSync, mkdtempSync,
         existsSync, statSync, utimesSync, unlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus, retainEventLogs } from "./events";
import { copyFixture, requireFixture, findFixture, CKPTS, SAVES } from "./fixtures";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};
const scratch: string[] = [];
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `evt551-${tag}-`));
  scratch.push(d);
  return d;
}

/** A directory of `n` .jsonl logs with strictly increasing mtimes, oldest
 *  first, plus the non-.jsonl companions retention must never touch. */
function seed(n: number): { dir: string; names: string[] } {
  const dir = tmp("seed");
  const names: string[] = [];
  const base = Date.now() - n * 60_000;
  for (let i = 0; i < n; i++) {
    const f = `live-agent-${base + i * 60_000}.jsonl`;
    writeFileSync(join(dir, f), `{"t":"seed","i":${i}}\n`);
    const s = (base + i * 60_000) / 1000;
    utimesSync(join(dir, f), s, s);
    names.push(f);
  }
  writeFileSync(join(dir, "run-summary-live-agent-1.json"), "{}");
  writeFileSync(join(dir, "live-agent-archived.jsonl.gz"), "gz");
  return { dir, names };
}

// ------------------------------------------- A. construction deletes nothing
console.log("=== A. constructing a bus is side-effect-free on existing files ===");
{
  const { dir, names } = seed(40);
  const before = readdirSync(dir).sort();
  const bodies = before.map(f => readFileSync(join(dir, f), "utf8"));

  const bus = new EventBus(dir, "probe551-construct");

  const after = readdirSync(dir).sort();
  chk("A1 40 logs + 2 non-log companions seeded, all 42 files survive construction at the default keep=30",
    after.length === before.length && before.length === 42 &&
    after.filter(f => f.endsWith(".jsonl")).length === 40,
    `before=${before.length} after=${after.length}, ` +
    `${after.filter(f => f.endsWith(".jsonl")).length} .jsonl (old code would have left 30)`);
  chk("A2 every file is the SAME file, by name",
    JSON.stringify(after) === JSON.stringify(before));
  chk("A3 contents are untouched, not just the names",
    after.every((f, i) => readFileSync(join(dir, f), "utf8") === bodies[i]));
  chk("A4 the oldest log — the first casualty of the old constructor — is still there",
    existsSync(join(dir, names[0])), names[0]);
  chk("A5 construction did not even create its own log file yet (first emit does)",
    !existsSync(join(dir, "probe551-construct.jsonl")));

  // A bus that cannot write is not a fix, it is a different bug.
  bus.emit("boot", { probe: "551" });
  const line = readFileSync(join(dir, "probe551-construct.jsonl"), "utf8");
  chk("A6 the bus still works: emit lands on disk with the pinned envelope",
    /"kind":"boot"/.test(line) && /"probe":"551"/.test(line));
  chk("A7 emitting still deletes nothing",
    readdirSync(dir).length === before.length + 1);
}

// ------------------------------------- B. explicit retention still does its job
console.log("\n=== B. retainEventLogs() still trims when the owner asks ===");
{
  const { dir, names } = seed(40);
  const r = retainEventLogs(dir, 30);

  chk("B1 it reports what it scanned", r.scanned === 40, `scanned=${r.scanned}`);
  chk("B2 it kept exactly `keep`", r.kept === 30, `kept=${r.kept}`);
  chk("B3 it deleted the remainder", r.deleted.length === 10, `deleted=${r.deleted.length}`);
  chk("B4 it deleted the OLDEST ten, by mtime — not an arbitrary ten",
    r.deleted.slice().sort().join() === names.slice(0, 10).sort().join());
  chk("B5 the newest thirty are still on disk",
    names.slice(10).every(f => existsSync(join(dir, f))));
  chk("B6 the deleted ten are actually gone from disk, not just from the report",
    names.slice(0, 10).every(f => !existsSync(join(dir, f))));
  chk("B7 nothing failed silently — failures are a returned list, not a swallowed catch",
    r.failed.length === 0, `failed=${JSON.stringify(r.failed)}`);

  // The thing that made the damage so wide: 24 rdv-* link-test logs share the
  // events dir and count against the same budget. Retention is BY EXTENSION,
  // which is the documented behaviour; asserted here so a future change to the
  // filter is a deliberate decision and not a surprise.
  chk("B8 non-.jsonl companions are never touched (run-summary json, .jsonl.gz)",
    existsSync(join(dir, "run-summary-live-agent-1.json")) &&
    existsSync(join(dir, "live-agent-archived.jsonl.gz")));

  const under = retainEventLogs(dir, 100);
  chk("B9 keep > population is a no-op, not an error",
    under.deleted.length === 0 && under.kept === 30 && under.failed.length === 0);

  const missing = retainEventLogs(join(dir, "does-not-exist"));
  chk("B10 an unreadable directory REPORTS instead of swallowing (the old catch {})",
    missing.failed.length === 1 && missing.deleted.length === 0,
    missing.failed[0] ?? "no failure recorded");
}

// --------------------------------- C. the destructive path is out of reach
console.log("\n=== C. a probe-constructed bus cannot reach the deletion path ===");
{
  const dir = tmp("reach");
  const bus = new EventBus(dir, "probe551-reach") as any;
  chk("C1 no retain() method survives on the instance", typeof bus.retain === "undefined");
  chk("C2 no method on the bus deletes anything: the public surface is emit/on only",
    ["emit", "on"].every(m => typeof bus[m] === "function") &&
    Object.getOwnPropertyNames(Object.getPrototypeOf(bus))
      .filter(m => m !== "constructor").sort().join() === "emit,on");

  const src = readFileSync(join(__dirname, "events.ts"), "utf8");
  // Brace-match the constructor body rather than regexing the whole file, so
  // this cannot be greened by the word "retain" merely moving elsewhere.
  const i = src.indexOf("constructor(");
  const open = src.indexOf("{", i);
  let depth = 0, end = open;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) { end = k; break; }
  }
  const ctor = src.slice(open, end + 1);
  chk("C3 the constructor body calls no retention and no unlink — the regression that reopens this ticket",
    !/retain/i.test(ctor) && !/unlink/i.test(ctor), ctor.replace(/\s+/g, " ").slice(0, 90));
  chk("C4 unlinkSync appears exactly once in events.ts, inside retainEventLogs",
    (src.match(/unlinkSync\(/g) || []).length === 1 &&
    src.indexOf("unlinkSync(") > src.indexOf("export function retainEventLogs"));

  // Exactly ONE owner. This is the assertion that keeps the fix true as the
  // repo grows: a second caller is how "explicit and owned" quietly becomes
  // "explicit and everywhere".
  const srcDir = __dirname;
  const callers: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!n.endsWith(".ts") || p === join(srcDir, "events.ts")) continue;
      // Strip comments first. A detector that counts the word "retainEventLogs"
      // inside prose reports a caller that does not exist — this check failed
      // on its own author's doc comment in fixtures.ts before the strip.
      const code = readFileSync(p, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/retainEventLogs\s*\(/.test(code)) callers.push(p.slice(srcDir.length + 1));
    }
  };
  walk(srcDir);
  const nonProbe = callers.filter(f => !/probe_/.test(f));
  chk("C5 exactly one production caller of retainEventLogs, and it is the live service",
    nonProbe.length === 1 && nonProbe[0] === "live_agent.ts",
    `callers=${JSON.stringify(callers)}`);
}

// ------------------- D. second deletion path: live rotation vs probe fixtures
console.log("\n=== D. a fixture cannot be deleted underneath a running probe ===");
{
  // Re-enact agent.ts pruneAuto(): the LIVE service unlinks auto-* checkpoints
  // from the shared checkpoints/ dir while a probe is looping over one.
  const ck = tmp("ckpt");
  const state = join(ck, "auto-1786600000000.state.gz");
  writeFileSync(state, "STATE-BYTES");
  writeFileSync(state.replace(/\.state\.gz$/, ".json"), JSON.stringify({ map: 61, x: 33, y: 11 }));

  const copy = copyFixture(state);
  chk("D1 the copy is outside the directory the live service prunes",
    !copy.startsWith(ck), copy);
  chk("D2 the sidecar travels with it — callers read both",
    existsSync(copy.replace(/\.state\.gz$/, ".json")));
  chk("D3 the copy is byte-identical to the original",
    readFileSync(copy, "utf8") === "STATE-BYTES");

  unlinkSync(state);                      // <- pruneAuto(), mid-loop
  unlinkSync(state.replace(/\.state\.gz$/, ".json"));
  chk("D4 the original is gone, exactly as wq#552 experienced it",
    !existsSync(state));
  chk("D5 THE PROBE SURVIVES: the copy is still readable after rotation took the original",
    existsSync(copy) && readFileSync(copy, "utf8") === "STATE-BYTES");

  // And the shared helper is safe BY DEFAULT, not only when a probe remembers.
  const live = findFixture(() => true);
  if (live) {
    const got = requireFixture("any checkpoint with a sidecar", live);
    chk("D6 requireFixture returns a copy by default — no probe has to remember",
      !got.startsWith(CKPTS) && !got.startsWith(SAVES), got);
    chk("D7 the escape hatch still returns the real path when asked explicitly",
      requireFixture("same", live, { copy: false }) === live);
  } else {
    console.log("     NOTE: no live checkpoint corpus on this machine — D6/D7 SKIPPED, " +
                "counted as neither pass nor fail (wq#540 R3: a vacuous pass is worse than a gap).");
  }
}

// ---------------------------- E. counterfactual on the REAL directory's shape
console.log("\n=== E. what the old constructor would do to events/ RIGHT NOW ===");
{
  // Names and mtimes only. No bus is constructed against the real directory and
  // nothing in it is opened, moved or removed.
  const real = "/home/lumen/pokemon/events";
  let entries: { f: string; m: number }[] = [];
  try {
    entries = readdirSync(real).filter(f => f.endsWith(".jsonl"))
      .map(f => ({ f, m: statSync(join(real, f)).mtimeMs }));
  } catch { /* not on this machine */ }

  if (entries.length === 0) {
    console.log("     NOTE: events/ unreadable or empty here — E SKIPPED rather than passed vacuously.");
  } else {
    const shape = tmp("shape");
    for (const { f, m } of entries) {
      writeFileSync(join(shape, f), "");           // zero-byte stand-in
      utimesSync(join(shape, f), m / 1000, m / 1000);
    }
    const r = retainEventLogs(shape, 30);          // exactly the old sweep
    const liveAgent = r.deleted.filter(f => f.startsWith("live-agent-"));
    const rdv = entries.filter(e => e.f.startsWith("rdv-")).length;
    console.log(`     events/ holds ${entries.length} .jsonl, of which ${rdv} are rdv-* link-test`);
    console.log(`     logs sharing the same retention budget. The old constructor's sweep`);
    console.log(`     deletes ${r.deleted.length} of them, ${liveAgent.length} being live-agent run logs.`);
    chk("E1 the re-enactment ran against a stand-in, never the real directory",
      !shape.startsWith(real) && readdirSync(real).filter(f => f.endsWith(".jsonl")).length === entries.length,
      `${entries.length} .jsonl still in events/`);
    // Deliberately NOT asserted as "> 0". The casualty count is a property of
    // today's directory, not of the code under test, and an assertion on it
    // goes red the day the budget stops being exceeded — a probe failing for a
    // reason that is not a regression is the wq#553 shape. Reported, not graded.
    console.log(`     live-agent logs that were one construction away: ${liveAgent.length}` +
                (liveAgent.length ? ` (${liveAgent.join(" ")})` : " — budget not currently exceeded"));
    chk("E2 the counterfactual arithmetic is faithful: the old sweep drops everything past the newest 30",
      r.deleted.length === Math.max(0, entries.length - 30) && r.kept === Math.min(30, entries.length),
      `scanned=${r.scanned} deleted=${r.deleted.length} kept=${r.kept}`);
  }
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });
console.log(`\nprobe_events551: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
