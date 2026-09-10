// wq#1578 — the repeat guard's escape hatch must only fire when a state was
// written SINCE THE LAST RESUME.
//
// THE DEFECT. The hatch's test was `alt.mtime > winner.mtime`: newer than the
// FILE BEING DEMOTED. Its own comment claims something stronger and correct —
// "the previous run demonstrably produced something newer" — but that was never
// what the code asked. MEASURED (2026-09-09 14:11Z -> 2026-09-10 04:40Z):
// lumen-pokemon-live rebooted every ~57s for 14h taking zero turns, because the
// brain gateway key could not reach any configured model. Selection ping-ponged
// auto-mtu5q40w-t110 (map36, rank 24) <-> auto-mtu5q40w-t300 (map35, rank 23),
// two checkpoints written 14 minutes apart the PREVIOUS DAY. t300 is newer than
// t110 forever, so the hatch fired on every other selection while nothing on
// disk had anything to do with the run in progress.
//
// THE FIX: the alternative must also postdate the last recorded history pick.
// That is the only evidence on disk that a RUN produced it. The anti-wedge
// guarantee is untouched — a genuinely newer state is still taken (section B).
//
// Usage: npx tsx src/probe_resume1578.ts   (copies real checkpoints into a
// mkdtemp dir; nothing under /home/lumen/pokemon is written)
import { mkdtempSync, copyFileSync, existsSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SymbolTable } from "./symbols";
import { pickResume, readProgress, RESUME_REPEAT_LIMIT } from "./resume";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const CK = `${BASE}/checkpoints`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

// The two files from the incident. Copied (not read in place) so mtimes can be
// pinned to the measured values without touching the live corpus.
const OLDER = "auto-mtu5q40w-t110";   // map36 @45,4 rank 24 — the correct pick
const NEWER = "auto-mtu5q40w-t300";   // map35 @8,6  rank 23 — 14 min later, worse
const T110_MS = Date.parse("2026-09-09T13:57:05Z");
const T300_MS = Date.parse("2026-09-09T14:11:28Z");

/** Copy a real checkpoint pair into `dir` under `as`, with a pinned mtime. */
function place(stem: string, dir: string, as: string, mtimeMs: number): boolean {
  const j = `${CK}/${stem}.json`, s = `${CK}/${stem}.state.gz`;
  if (!existsSync(j) || !existsSync(s)) return false;
  copyFileSync(j, join(dir, `${as}.json`));
  copyFileSync(s, join(dir, `${as}.state.gz`));
  const t = mtimeMs / 1000;
  utimesSync(join(dir, `${as}.state.gz`), t, t);
  return true;
}

/** A history file whose last RESUME_REPEAT_LIMIT picks are all `file`, taken at
 *  `atMs` and the cycles before it — i.e. the state the guard is about to see. */
function seedHistory(dir: string, file: string, atMs: number): string {
  const picks = Array.from({ length: RESUME_REPEAT_LIMIT }, (_, i) => ({
    file, at: new Date(atMs - (RESUME_REPEAT_LIMIT - 1 - i) * 57_000).toISOString(),
  }));
  const f = join(dir, "history.json");
  writeFileSync(f, JSON.stringify({ v: 1, picks }));
  return f;
}

console.log("-- A: the measured incident, replayed from the real fixture pair --");
const dirA = mkdtempSync(join(tmpdir(), "lpp1578a-"));
const haveOld = place(OLDER, dirA, OLDER, T110_MS);
const haveNew = place(NEWER, dirA, NEWER, T300_MS);
// The last resume happened LONG after both files were written — that is the
// whole shape of the bug: 14h of picks, nothing new on disk behind them.
const lastPickMs = Date.parse("2026-09-10T04:38:27Z");

if (!haveOld || !haveNew) {
  skip++;
  console.log(`SKIP sections A/B -- fixtures rotated off disk (${OLDER}: ${haveOld}, ` +
    `${NEWER}: ${haveNew}). Corpus rot, not a code defect.`);
} else {
  const pOld = readProgress(`${dirA}/${OLDER}.state.gz`, sym, ROM);
  const pNew = readProgress(`${dirA}/${NEWER}.state.gz`, sym, ROM);
  chk("fixture OLDER is the further-along state (rank 24, viable)",
      pOld.rank === 24 && pOld.viable, `rank=${pOld.rank} viable=${pOld.viable}`);
  chk("fixture NEWER is the state the hatch kept stepping aside to (rank 23, viable)",
      pNew.rank === 23 && pNew.viable, `rank=${pNew.rank} viable=${pNew.viable}`);
  chk("RED half: the OLD predicate (mtime > winner.mtime) is satisfied here",
      pNew.mtime > pOld.mtime, `${pNew.mtime} > ${pOld.mtime}`);
  chk("and the NEW predicate (mtime > last pick) is not: nothing was written since",
      !(pNew.mtime > lastPickMs), `${pNew.mtime} vs lastPick ${lastPickMs}`);

  const logs: string[] = [];
  const winner = pickResume([dirA], sym, ROM,
    { log: l => logs.push(l), historyFile: seedHistory(dirA, `${dirA}/${OLDER}.state.gz`, lastPickMs) });
  chk("GREEN: the guard no longer demotes — selection settles on the best state",
      winner.endsWith(`${OLDER}.state.gz`), winner.split("/").pop()!);
  chk("no REPEAT GUARD demotion line fires", !logs.some(l => l.includes("REPEAT GUARD")),
      logs.join(" | "));
  chk("the reason is logged, not silent",
      logs.some(l => l.includes("nothing has been") && l.includes("since the last resume")),
      logs.join(" | "));
}

console.log("\n-- B: anti-wedge guarantee intact -- a state written SINCE the last pick --");
if (haveOld && haveNew) {
  const dirB = mkdtempSync(join(tmpdir(), "lpp1578b-"));
  const lastPickB = Date.parse("2026-09-10T04:38:27Z");
  place(OLDER, dirB, OLDER, T110_MS);
  place(NEWER, dirB, NEWER, T300_MS);
  // Same game state as NEWER, but written a minute AFTER the last resume — the
  // signature of a run that actually played and checkpointed.
  const fresh = place(NEWER, dirB, "auto-mtu5q40w-t420", lastPickB + 60_000);
  const logsB: string[] = [];
  const winnerB = pickResume([dirB], sym, ROM,
    { log: l => logsB.push(l), historyFile: seedHistory(dirB, `${dirB}/${OLDER}.state.gz`, lastPickB) });
  chk("fixture placed", fresh);
  chk("GREEN: a genuinely new state IS still taken — the hatch has not been disabled",
      winnerB.endsWith("auto-mtu5q40w-t420.state.gz"), winnerB.split("/").pop()!);
  chk("and it says so", logsB.some(l => l.includes("REPEAT GUARD")), logsB.join(" | "));
}

console.log("\n-- C: no history at all (first boot) behaves exactly as before --");
if (haveOld && haveNew) {
  const dirC = mkdtempSync(join(tmpdir(), "lpp1578c-"));
  place(OLDER, dirC, OLDER, T110_MS);
  place(NEWER, dirC, NEWER, T300_MS);
  const logsC: string[] = [];
  const winnerC = pickResume([dirC], sym, ROM,
    { log: l => logsC.push(l), historyFile: join(dirC, "no-history.json") });
  chk("best state wins on a cold boot, guard silent",
      winnerC.endsWith(`${OLDER}.state.gz`) && !logsC.some(l => l.includes("REPEAT GUARD")),
      winnerC.split("/").pop()!);
}

console.log(`\nprobe_resume1578: ${pass} pass, ${fail} fail, ${skip} skip`);
process.exit(fail ? 1 : 0);
