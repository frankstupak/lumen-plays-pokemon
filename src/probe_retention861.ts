// wq#861 probe: crash-loop boots must never evict real run history.
// Simulates N zero-turn boots (small files) into a directory that also
// contains real run logs, then asserts that retainEventLogs keeps every
// real log and only prunes trivial ones past the cap.
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from "fs";
import { retainEventLogs } from "./events";
import { join } from "path";

const DIR = "/tmp/probe_retention861_" + Date.now();
const KEEP = 10;  // small keep to make the test fast

function setup() {
  mkdirSync(DIR, { recursive: true });

  // Create 15 "real run" logs (> 2048 bytes each), spaced 1s apart in mtime
  const realContent = JSON.stringify({ kind: "turn_summary", line: "x".repeat(3000) }) + "\n";
  for (let i = 0; i < 15; i++) {
    const name = `live-agent-real-${1000 + i}.jsonl`;
    writeFileSync(join(DIR, name), realContent);
    // Set mtime so oldest real files are first in sort
    const mtime = new Date(Date.now() - (15 - i) * 60000);
    const { utimes } = require("fs");
    utimes(join(DIR, name), mtime, mtime, () => {});
  }

  // Simulate 200 crash-loop boots (each ~500 bytes, well under TRIVIAL_BYTES)
  const crashContent = JSON.stringify({ kind: "boot", mode: "crash" }) + "\n" +
    JSON.stringify({ kind: "retention", keep: 30, scanned: 0 }) + "\n";
  for (let i = 0; i < 200; i++) {
    const name = `live-agent-crash-${2000 + i}.jsonl`;
    writeFileSync(join(DIR, name), crashContent);
    // Crash files are NEWER than real files (this is the attack scenario)
    const mtime = new Date(Date.now() - (200 - i) * 1000);
    const { utimesSync } = require("fs");
    utimesSync(join(DIR, name), mtime, mtime);
  }
}

function main() {
  setup();

  const before = readdirSync(DIR).filter(f => f.endsWith(".jsonl"));
  console.log(`[probe] setup: ${before.length} files (15 real + 200 crash)`);

  // Run retention with keep=10
  const result = retainEventLogs(DIR, KEEP);
  console.log(`[probe] retention: scanned=${result.scanned}, kept=${result.kept}, deleted=${result.deleted.length}`);

  const after = readdirSync(DIR).filter(f => f.endsWith(".jsonl"));
  const realAfter = after.filter(f => f.includes("-real-"));
  const crashAfter = after.filter(f => f.includes("-crash-"));

  console.log(`[probe] after: ${after.length} total, ${realAfter.length} real, ${crashAfter.length} crash`);

  let pass = true;

  // CRITICAL ASSERTION: all 15 real files must survive (15 < keep is not the
  // point — even if there were 50 real files, the 200 crash files must not
  // have pushed any of them out. With keep=10, the oldest 5 real files are
  // the ones that would have been evicted under the old code.)
  // With the fix: keep=10 means keep the 10 newest substantial files, so 5
  // of the 15 real files will be deleted (that's correct — they're the oldest
  // REAL files). But the 200 crash files must NOT have eaten those slots.
  if (realAfter.length < KEEP) {
    console.error(`[probe] FAIL: only ${realAfter.length} real files survived (expected >= ${KEEP})`);
    pass = false;
  } else {
    console.log(`[probe] OK: ${realAfter.length} real files survived (keep=${KEEP})`);
  }

  // Crash files should be capped at TRIVIAL_CAP (100)
  if (crashAfter.length > 100) {
    console.error(`[probe] FAIL: ${crashAfter.length} crash files survived (expected <= 100)`);
    pass = false;
  } else {
    console.log(`[probe] OK: ${crashAfter.length} crash files survived (trivial cap)`);
  }

  // OLD BEHAVIOR REGRESSION: under the old code with keep=10, 200 crash files
  // (all newer) would fill all 10 keep slots, deleting ALL 15 real files.
  // This is the exact bug. Verify it did NOT happen.
  if (realAfter.length === 0) {
    console.error("[probe] FAIL: ALL real files evicted — this is the wq#861 bug!");
    pass = false;
  }

  // Cleanup
  rmSync(DIR, { recursive: true, force: true });

  if (pass) {
    console.log("[probe] PASS: crash-loop boots cannot evict real run history");
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
