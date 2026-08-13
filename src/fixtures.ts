// wq#540: shared fixture resolution for probes.
//
// WHY THIS EXISTS. Six probes in this repo have reported a passing score that
// was fiction, all for the same reason: the probe was pinned to something
// OUTSIDE its own diff that then moved. Three failure shapes, all confirmed by
// running them, not inferred:
//
//   R1 MISSING FIXTURE   a hardcoded checkpoint filename that has since rotated
//                        off disk. The probe dies with an ENOENT stack trace
//                        BEFORE its first assertion, so it emits no FAIL line
//                        at all and its advertised score is a memory of the last
//                        time anyone ran it. Five probes were in this state:
//                        probe_battlestuck, probe_cerulean, probe_flee,
//                        probe_oscillation, probe_wildbattle. probe_resume518
//                        was the sixth and was fixed in 88e356c.
//   R2 HARDCODED TREE    a hardcoded /home/lumen/pokemon/src path, so a
//                        `lumen-pr start --worktree` run verifies the PRIMARY
//                        tree and goes green without ever executing the diff
//                        under review (wq#520, verify_489.py).
//   R3 EMPTY CORPUS      an assertion over a directory scan that rotation has
//                        emptied. `[].every(...)` is TRUE, so this shape can
//                        also go GREEN while checking nothing (wq#535,
//                        probe_phase514).
//
// THE RULE: resolve a fixture BY PROPERTY, NEVER BY NAME. Checkpoint rotation
// is normal and expected; a probe that names one file is a probe with an expiry
// date nobody wrote down.
import { readdirSync, existsSync, readFileSync } from "fs";

export const REPO = "/home/lumen/pokemon";
export const CKPTS = `${REPO}/checkpoints`;
export const SAVES = `${REPO}/saves`;

export interface FixtureSidecar {
  map: number; x: number; y: number; badges?: number;
  hpPct?: number; ppOk?: boolean; storyScore?: number;
}

/** Every checkpoint/save with a readable sidecar, newest first. Sidecar-only:
 *  this deliberately does NOT boot an emulator, so it stays cheap enough to
 *  call at the top of any probe. */
export function fixtureIndex(dirs: string[] = [CKPTS, SAVES]):
    { path: string; sc: FixtureSidecar; mtime: number }[] {
  const out: { path: string; sc: FixtureSidecar; mtime: number }[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const state = `${dir}/${n.replace(/\.json$/, ".state.gz")}`;
      if (!existsSync(state)) continue;
      try {
        const sc = JSON.parse(readFileSync(`${dir}/${n}`, "utf8"));
        if (typeof sc.map !== "number") continue;
        let mtime = 0;
        try { mtime = require("fs").statSync(state).mtimeMs; } catch {}
        out.push({ path: state, sc, mtime });
      } catch { /* not a sidecar */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Resolve a fixture by PROPERTY. Returns null when nothing matches — callers
 *  must handle that explicitly rather than letting a load throw. */
export function findFixture(pred: (sc: FixtureSidecar) => boolean,
                            dirs?: string[]): string | null {
  const hit = fixtureIndex(dirs).find(f => pred(f.sc));
  return hit ? hit.path : null;
}

/** A fixture the probe cannot run without. Prints a FAIL-shaped line naming the
 *  property that could not be satisfied, then exits 1.
 *
 *  The point is that this is a LEGIBLE failure with a name and a reason, not an
 *  ENOENT stack trace out of readFileSync. A reader of CI output can tell
 *  "the corpus no longer contains what this test needs" apart from
 *  "the code under test is broken", which was impossible before. */
export function requireFixture(what: string, path: string | null): string {
  if (path) return path;
  console.log(`FAIL FIXTURE MISSING: no checkpoint or save satisfies "${what}"`);
  console.log(`     This is CORPUS ROT, not a defect in the code under test.`);
  console.log(`     Checkpoint rotation removed whatever this probe used to load.`);
  console.log(`     Re-run once the campaign produces a matching state, or widen the predicate.`);
  console.log(`\n0 passed, 1 failed (fixture unavailable)`);
  process.exit(1);
}

/** Guard an assertion that quantifies over a scanned corpus.
 *
 *  `[].every(p)` is TRUE, so an emptied corpus turns a real assertion into a
 *  free pass without changing a line of code. Call this FIRST and report the
 *  sample count in the detail of whatever assertion follows, so a green tick
 *  can never mean "nothing was checked". */
export function haveSamples(label: string, n: number, min = 1): boolean {
  if (n >= min) return true;
  console.log(`     NOTE: ${label} — ${n} samples on disk (need ${min}). ` +
              `Any assertion over this set is VACUOUS, not passing.`);
  return false;
}
