#!/usr/bin/env npx tsx
// wq#698 one-shot sweep: demote position-stamped nav-goal pins in the live
// notepad. Run once after merging the notepad.ts change. Prints before/after.
import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { Notepad, isPositionStampedNavGoal, NotepadState } from "../src/notepad";

const PAD_PATH = process.argv[2] || "/home/lumen/pokemon/runtime/notepad.txt";
const raw = readFileSync(PAD_PATH, "utf8");
const state: NotepadState = JSON.parse(raw);

console.log("=== BEFORE ===");
console.log(`pinned: ${state.pinned.length}`);
for (const p of state.pinned) {
  const tag = isPositionStampedNavGoal(p) ? "NAV " : "FACT";
  console.log(`  ${tag} | ${p.slice(0, 90)}`);
}
console.log(`rolling: ${state.rolling.length}`);
console.log(`summary: ${state.summary.length} chars`);

// Back up then sweep
const bak = PAD_PATH + ".bak.pre698";
copyFileSync(PAD_PATH, bak);
console.log(`\nbackup: ${bak}`);

const pad = new Notepad();
pad.pinned = state.pinned.slice();
pad.summary = state.summary;
pad.rolling = state.rolling.slice();

const demoted = pad.sweepStalePositionPins();

console.log(`\n=== AFTER ===`);
console.log(`demoted: ${demoted.length}`);
for (const d of demoted) console.log(`  - ${d.slice(0, 90)}`);
console.log(`pinned: ${pad.pinned.length}`);
for (const p of pad.pinned) console.log(`  FACT | ${p.slice(0, 90)}`);
console.log(`rolling: ${pad.rolling.length}`);
console.log(`summary: ${pad.summary.length} chars`);

if (demoted.length === 0) {
  console.log("\nnothing to sweep — pad is clean");
  process.exit(0);
}

// Write the swept state
const out: NotepadState = { v: 1, pinned: pad.pinned, summary: pad.summary, rolling: pad.rolling };
writeFileSync(PAD_PATH, JSON.stringify(out));
console.log(`\nwrote swept pad to ${PAD_PATH}`);
