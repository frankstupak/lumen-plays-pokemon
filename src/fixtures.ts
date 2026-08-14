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
import { readdirSync, existsSync, readFileSync, copyFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
export function requireFixture(what: string, path: string | null,
                               opts: { copy?: boolean } = {}): string {
  if (path) return opts.copy === false ? path : copyFixture(path);
  console.log(`FAIL FIXTURE MISSING: no checkpoint or save satisfies "${what}"`);
  console.log(`     This is CORPUS ROT, not a defect in the code under test.`);
  console.log(`     Checkpoint rotation removed whatever this probe used to load.`);
  console.log(`     Re-run once the campaign produces a matching state, or widen the predicate.`);
  console.log(`\n0 passed, 1 failed (fixture unavailable)`);
  process.exit(1);
}

/** wq#551 / R4 FIXTURE DELETED MID-RUN: take a private copy of a fixture before
 *  reading it, and return the copy's path.
 *
 *  R1 was "the fixture rotated off disk BEFORE the probe started", and
 *  requireFixture() already turns that into a legible failure. R4 is the other
 *  half and it is nastier: the fixture rotates off disk WHILE the probe is
 *  running. agent.ts pruneAuto() keeps the newest CKPT_KEEP_AUTO auto-*
 *  checkpoints and unlinks the rest, and the LIVE SERVICE calls it on every
 *  checkpoint write — concurrently, against the same checkpoints/ directory
 *  every probe resolves fixtures from. A probe that resolves a path once and
 *  reloads it per iteration can therefore die partway through a loop, and its
 *  earlier iterations have already printed PASS. wq#552 hit exactly this.
 *
 *  Copying is the whole fix: a fixture under mkdtemp is not in a directory
 *  pruneAuto walks, so nothing can take it away mid-loop. The sidecar travels
 *  with the state file because callers read both. Deliberately NOT cleaned up —
 *  these are small, /tmp is swept by the OS, and an unlink here would be one
 *  more deletion path in a ticket about deletion paths. */
export function copyFixture(statePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lpp-fixture-"));
  const base = statePath.split("/").pop()!;
  const dest = join(dir, base);
  copyFileSync(statePath, dest);
  const srcSc = statePath.replace(/\.state\.gz$/, ".json");
  if (existsSync(srcSc)) copyFileSync(srcSc, dest.replace(/\.state\.gz$/, ".json"));
  return dest;
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

// ---------------------------------------------------------------------------
// wq#543: REPO-ROOT RESOLUTION FOR CAMPAIGN DATA (not just probe fixtures).
//
// WHY THIS IS A SECOND HELPER AND NOT JUST `REPO`. wq#540 exported REPO/CKPTS/
// SAVES as consts, which is right for probes: they are read at import time and
// nobody retargets them. The link/ drivers need the same anchor but they also
// need it to be TESTABLE — a guard that cannot point the resolver somewhere
// harmless can only verify the real directory by writing to it, and writing to
// the real events/ is not free (see the retention note below). So these are
// FUNCTIONS reading LPP_REPO at call time, with REPO as the default. Nothing
// sets LPP_REPO in production; probe_linkpaths543.ts sets it, and that is the
// point.
//
// WHY CWD-RELATIVE WAS WRONG IN THE FIRST PLACE, stated by consequence rather
// than by principle, because the two halves of this class fail DIFFERENTLY and
// only one of them is loud:
//   checkpoints/ saves/ events/ runtime/ are GITIGNORED, so a `--worktree`
//   checkout does not have them at all.
//     - `checkpoints/foo.state.gz` -> ENOENT. Loud, immediate, honest.
//     - `new EventBus("events", ...)` -> mkdirSync(recursive) CREATES an empty
//       events/ inside the worktree and returns happily. The run emits into a
//       directory nobody reads, and any later scan of it is the wq#540 R3
//       empty-corpus shape: `[].every(p)` is true, so it goes GREEN.
//   roms/ IS tracked, so it resolves from a worktree root and only breaks from
//   an arbitrary CWD. Same class, narrower blast radius; anchored here anyway
//   rather than left as the one exception a future reader has to re-derive.
//
// SAFETY NOTE FOR ANYONE POINTING A BUS AT THE REAL events/ — CORRECTED BY
// wq#551, AND THE ORIGINAL WARNING WAS RIGHT WHEN IT WAS WRITTEN. It said:
// EventBus's constructor calls retain(), which UNLINKS every .jsonl beyond the
// newest LPP_EVENTS_KEEP_FILES (default 30), so merely CONSTRUCTING a bus there
// deletes the oldest log. It did, and it cost 51 of 61 runs their per-turn
// evidence before anyone ticketed it.
// AS OF wq#551 THAT IS NO LONGER TRUE: the constructor performs no deletion at
// all, and retention lives in the explicitly-called retainEventLogs(), whose
// only caller is live_agent.ts at boot. Constructing a bus against the real
// events/ is now safe. This guard still uses a temporary LPP_REPO anyway,
// because verifying a path resolver by writing into the directory it resolves
// is a bad idea for reasons that have nothing to do with deletion.

/** The repository root that campaign data hangs off. LPP_REPO overrides it for
 *  tests; production never sets it. */
export function repoRoot(): string {
  return process.env.LPP_REPO || REPO;
}

/** Join segments onto the repo root. Always absolute, never CWD-dependent. */
export function repoPath(...segs: string[]): string {
  const root = repoRoot().replace(/\/+$/, "");
  const rest = segs.join("/").replace(/^\/+/, "").replace(/\/+$/, "");
  return rest ? `${root}/${rest}` : root;
}

/** The one events directory the kiosk, metrics and replay actually read. */
export function eventsDir(): string { return repoPath("events"); }

/** wq#555: where LINK drivers and link probes emit, deliberately NOT the same
 *  directory as run history.
 *
 *  Retention is by extension, so every .jsonl in events/ competes for the same
 *  KEEP_FILES budget regardless of what produced it. Cable Club work emits one
 *  log per side per rendezvous, and 24 of them had accumulated against a default
 *  budget of 30 — leaving SIX slots for live-agent run history and directly
 *  causing the scale of the wq#551 loss (51 of 61 runs). A link test evicting a
 *  run log is not a retention policy anybody chose.
 *
 *  Separate directory, separate budget. The kiosk, metrics and the wq#547
 *  backtests all filter on the `live-agent-` prefix, so nothing that reads
 *  events/ ever wanted these files. live_agent.ts sweeps BOTH directories at
 *  boot, so this stays one owner and link logs do not grow unbounded — which is
 *  the 87MB incident the retention machinery exists to prevent. */
export function linkEventsDir(): string { return repoPath("events", "link"); }

/** A ROM or symbol file. Tracked, but anchored so drivers run from any CWD. */
export function romPath(file: string): string { return repoPath("roms", file); }

/** A checkpoint by NAME. Named snapshots (seed-*, center-*) are inputs a driver
 *  legitimately knows; rotating campaign checkpoints must still go through
 *  findFixture(), which resolves BY PROPERTY. */
export function ckptPath(file: string): string { return repoPath("checkpoints", file); }
