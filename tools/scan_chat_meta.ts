// wq#1176 — offline auditor for a live chat log.
//
// Answers one question against real data: how much of what Lumen said to the
// audience was the model talking about its own homework? Run it on the log the
// live generator wrote, before and after a guard change, and the delta is the
// evidence.
//
//   npx tsx tools/scan_chat_meta.ts /home/lumen/pokemon/runtime/chat.jsonl
//   npx tsx tools/scan_chat_meta.ts <log> --show 20   # sample the hits
//   npx tsx tools/scan_chat_meta.ts <log> --pass 20   # sample what survives
//
// Read --pass before trusting a screen change: the hit rate is only half the
// story, and the half that matters is whether real lines are still getting
// through.
//
// Read-only. It never writes, never calls the gateway, and never touches
// lumen_state, so it is safe to point at a production log mid-stream.
import { readFileSync } from "fs";
import { isMetaText } from "../src/meta_text";

const [, , path, ...rest] = process.argv;
if (!path) {
  console.error("usage: npx tsx tools/scan_chat_meta.ts <chat.jsonl> [--show N]");
  process.exit(2);
}
const numArg = (flag: string) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? Number(rest[i + 1] ?? 10) : 0;
};
const show = numArg("--show");
const keep = numArg("--pass");

const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
const byReason = new Map<string, number>();
const samples: string[] = [];
const passed: string[] = [];
let total = 0, flagged = 0;

for (const raw of lines) {
  let text: string;
  try { text = String(JSON.parse(raw).text ?? ""); } catch { continue; }
  if (!text.trim()) continue;
  total++;
  const why = isMetaText(text);
  if (!why) {
    // Every Nth survivor rather than the first N: the head of a log is one
    // afternoon's mood, and a sample of one afternoon proves nothing.
    if (passed.length < keep && total % 37 === 0) passed.push(`  ${text.slice(0, 110)}`);
    continue;
  }
  flagged++;
  byReason.set(why, (byReason.get(why) ?? 0) + 1);
  if (samples.length < show) samples.push(`  [${why}] ${text.slice(0, 96)}`);
}

const pct = total ? ((100 * flagged) / total).toFixed(1) : "0.0";
console.log(`${path}: ${total} lines, ${flagged} scaffolding (${pct}%)`);
for (const [why, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${why}`);
if (samples.length) console.log("\nscreened:\n" + samples.join("\n"));
if (passed.length) console.log("\nspoken:\n" + passed.join("\n"));
