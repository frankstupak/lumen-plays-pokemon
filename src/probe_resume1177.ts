// wq#1177 item 1 — resume repeat guard: IDENTITY, not filename.
//
// THE DEFECT (lpp-improvement-plan.md section 2c / "1", resume.ts:400-401
// pre-fix): `recent.every(f => f === winner.f)` compares the picked
// FILENAME across the last RESUME_REPEAT_LIMIT boots. A fresh checkpoint
// written at the exact same game state (same map/x/y/story/badges/
// levelSum, but a new auto-* filename because writeCheckpoint names every
// file uniquely) sorts ahead on mtime and reads as "a newer alternative" to
// the guard — while being the identical trap. This is RESUME_DEADEND: the
// same checkpoint booting twice under different names, undetected.
//
// THE FIX: resume.ts now stamps a deterministic `stateKey` (map, x, y,
// storyScore, badges, levelSum) into the sidecar at write time and into
// resume_history.json at pick time; the repeat guard and its alt-selection
// both compare stateKeys when both sides have one, falling back to filename
// comparison only for pre-v4 sidecars/history (never worse-guarded than
// before).
//
// Usage: npx tsx src/probe_resume1177.ts (synthetic sidecars in a mkdtemp
// dir; real ROM+symbols only for coordsPlausible; nothing under
// /home/lumen/pokemon is written)
import { mkdtempSync, writeFileSync, utimesSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SymbolTable } from "./symbols";
import { pickResume, stateKey } from "./resume";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const sym = new SymbolTable("/home/lumen/pokemon/roms/pokeblue.sym");

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

// State X: map 3 (Cerulean), (10,10), story 5, badges 1, levelSum 30 — the
// coordinates probe_resume628 already proved plausible for map 3.
const KEY_X = stateKey(3, 10, 10, 5, 1, 30);
// State Y: genuinely further along (different position + higher story).
const KEY_Y = stateKey(3, 10, 12, 6, 1, 34);
chk("sanity: distinct positions/story produce distinct stateKeys", KEY_X !== KEY_Y, `${KEY_X} vs ${KEY_Y}`);
chk("sanity: identical inputs produce the identical stateKey",
  stateKey(3, 10, 10, 5, 1, 30) === KEY_X, "");

function mk(dir: string, stem: string, side: Record<string, unknown>, mtimeMs: number) {
  const statePath = join(dir, `${stem}.state.gz`);
  writeFileSync(statePath, "x");
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify({
    v: 4, kind: "auto", map: 3, x: 10, y: 10, badges: 1, events: 20, storyScore: 5,
    hpPct: 1, ppOk: true, money: 500, ts: mtimeMs, ...side,
  }));
  const t = new Date(mtimeMs);
  utimesSync(statePath, t, t);
}

console.log("-- A: same STATE under a fresh filename must still count as a repeat --");
{
  const dir = mkdtempSync(join(tmpdir(), "lpp1177a-"));
  const historyFile = join(dir, "history.json");
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  // fileA1: state X, oldest. Mtimes are wall-clock-anchored because the repeat
  // guard (wq#1578) compares candidate mtimes against the history's pick
  // timestamps, which pickResume records at real time.
  mk(dir, "auto-r1-fileA1", { stateKey: KEY_X }, Date.now() - 3_600_000);
  const p1 = pickResume([dir], sym, ROM, { log, historyFile });
  chk("boot 1 picks the only candidate (fileA1)", p1.endsWith("auto-r1-fileA1.state.gz"), p1);

  // Second boot: still only fileA1 on disk -> picked again, history now has 2
  // consecutive picks of fileA1's stateKey.
  const p2 = pickResume([dir], sym, ROM, { log, historyFile });
  chk("boot 2 picks fileA1 again (only candidate)", p2.endsWith("auto-r1-fileA1.state.gz"), p2);

  // Snapshot history exactly as boot 3's decision will see it (before its own
  // pick is appended) -- this is what the OLD filename-only comparator would
  // have compared against.
  const histBeforeBoot3 = JSON.parse(readFileSync(historyFile, "utf8")) as { picks: { file: string }[] };
  const recentFilesOld = histBeforeBoot3.picks.slice(-2).map(p => p.file);

  // Between boot 2 and boot 3, the run wrote a FRESH checkpoint at the exact
  // SAME state X (new filename, newer mtime, identical map/x/y/story/badges)
  // -- the measured RESUME_DEADEND shape -- plus a genuinely different,
  // lower-ranked-but-newer state Y that only the repeat guard's alt search
  // can reach (it never wins on raw score).
  mk(dir, "auto-r1-fileA2", { stateKey: KEY_X }, Date.now() + 1_000);       // same state, new name, postdates boot 2's pick
  mk(dir, "auto-r1-fileB", { stateKey: KEY_Y, badges: 0, storyScore: 3 }, Date.now() + 2_000); // distinct, newest

  logs.length = 0;
  const p3 = pickResume([dir], sym, ROM, { log, historyFile });
  chk("boot 3: repeat guard fires on IDENTITY and steps aside to the distinct state (fileB), " +
      "not the same-state fileA2 that would win on raw score/mtime",
      p3.endsWith("auto-r1-fileB.state.gz"), p3);
  chk("REPEAT GUARD log line fired", logs.some(l => l.includes("REPEAT GUARD")), logs.join(" | "));

  // RED: replay the exact same third boot with the OLD filename-only
  // comparator (byte-for-byte pre-fix logic) to prove the defect was real --
  // it must NOT catch the repeat, because winner.f differs from the two
  // recorded filenames even though the STATE is identical.
  const oldWinnerFile = join(dir, "auto-r1-fileA2.state.gz"); // natural score winner pre-guard: same rank as fileA1, newest mtime
  const oldRepeated = recentFilesOld.length >= 2 && recentFilesOld.every(f => f === oldWinnerFile);
  chk("RED confirmed: the pre-fix filename-only comparator does NOT detect this repeat",
      !oldRepeated, `recent=${JSON.stringify(recentFilesOld)} winner=${oldWinnerFile}`);
}

console.log("\n-- B: no distinct alternative on disk -- guard must not wedge (wq#517 lesson) --");
{
  const dir = mkdtempSync(join(tmpdir(), "lpp1177b-"));
  const historyFile = join(dir, "history.json");
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  mk(dir, "auto-r2-fileA1", { stateKey: KEY_X }, 1_000_000);
  pickResume([dir], sym, ROM, { log, historyFile });
  pickResume([dir], sym, ROM, { log, historyFile });

  // A second file at the SAME state (new name, newer mtime) -- no distinct
  // state exists anywhere on disk, so the guard has nothing to step aside to.
  mk(dir, "auto-r2-fileA2", { stateKey: KEY_X }, 2_000_000);
  logs.length = 0;
  const p3 = pickResume([dir], sym, ROM, { log, historyFile });
  chk("boot 3: with only same-state files on disk, guard keeps resuming (does not wedge/refuse)",
      p3.endsWith("auto-r2-fileA2.state.gz"), p3);
  chk("log explains no newer alternative existed", logs.some(l => l.includes("no newer alternative")), logs.join(" | "));
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
