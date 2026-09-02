// wq#1177 — the resume repeat guard compares GAME STATES, not filenames.
//
// THE BUG (LPP plan §2c, resume.ts:400-401 pre-fix):
//   const repeated = recent.every(f => f === winner.f);
// Checkpoint names are unique per run BY DESIGN ("recycling names once resumed
// us straight back into a wedged state, forever"), so every boot of a stuck
// run writes `auto-<newRunTag>-*` files holding the same position, story and
// party as the ones before. To the old guard those were a different choice —
// so the guard never fired on the loop it exists to break, and the escape
// hatch could even step aside ONTO one of them: same trap, later mtime.
// RESUME_DEADEND kept firing with the guard nominally in place.
//
// THE FIX: writers stamp `stateKey` (map@x,y/story/badges/levelSum) into the
// v4 sidecar; the guard compares stateIdentity(), which is that key when known
// and the file path when it is not (pre-v4 sidecars keep the old behaviour
// exactly — unproved sameness is not claimed, wq#518/534).
//
// PURE: repeatGuard() takes scored candidates directly, so sections A-D need
// no ROM, no emulator and no checkpoint corpus. Section E exercises the
// sidecar->key path end to end and SKIPs without a ROM.
import { repeatGuard, stateIdentity, stateKeyOf, readProgress, Candidate,
         RESUME_REPEAT_LIMIT } from "./resume";
import { SymbolTable } from "./symbols";
import { existsSync, writeFileSync, mkdtempSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};
const skipped = (l: string, why: string) => { skip++; console.log(`SKIP ${l} :: ${why}`); };

console.log("== probe_resume1177 (stateKey identity in the resume repeat guard) ==");

/** A scored candidate; defaults describe a healthy, non-warp, mid-Cerulean state. */
const cand = (f: string, over: Partial<Candidate> = {}): Candidate => ({
  f, rank: 24, badges: 1, events: 20, story: 6, fine: 0, onWarp: false,
  key: "", hpPct: 1, ppOk: true, viable: true, mtime: 1000,
  map: 3, x: 5, y: 6, ...over,
});

// ── A. identity: the key when known, the path when not ──────────────────
{
  const k = stateKeyOf({ map: 3, x: 5, y: 6, story: 6, badges: 1, levelSum: 42 });
  chk("A1 stateKeyOf is stable and carries every axis",
      k === stateKeyOf({ map: 3, x: 5, y: 6, story: 6, badges: 1, levelSum: 42 }) &&
      k.includes("m3@5,6") && k.includes("s6") && k.includes("b1") && k.includes("l42"), k);
  chk("A2 a different party strength is a different state",
      k !== stateKeyOf({ map: 3, x: 5, y: 6, story: 6, badges: 1, levelSum: 43 }));
  chk("A3 identity falls back to the path when the key is unknown",
      stateIdentity({ f: "/ck/a.state.gz", key: "" }) === "file:/ck/a.state.gz");
  chk("A4 identity ignores the path when the key is known",
      stateIdentity({ f: "/ck/a.state.gz", key: k }) === k);
}

// ── B. THE REGRESSION: same state, fresh per-run filenames ──────────────
// The live shape — three boots, three names, one situation, plus the newer
// same-state file the old guard would have "escaped" onto.
{
  const K = stateKeyOf({ map: 3, x: 5, y: 6, story: 6, badges: 1, levelSum: 42 });
  const winner = cand("/ck/auto-r1-t10.state.gz", { key: K, mtime: 1000 });
  const twin = cand("/ck/auto-r2-t10.state.gz", { key: K, mtime: 2000 });  // newer, same state
  const recent = ["/ck/auto-r0-t10.state.gz", "/ck/auto-r1-t10.state.gz"];

  const oldStyle = recent.every(f => f === winner.f);   // what the old guard asked
  chk("B1 RED: the old filename test does not even see the repeat", oldStyle === false);

  const g = repeatGuard([winner, twin], winner, [K, K]);
  chk("B2 the guard fires on identical STATES under different filenames",
      g.line !== null && /repeat guard/i.test(g.line!), String(g.line));
  chk("B3 a newer file holding the SAME state is not an escape",
      g.winner.f === winner.f, g.winner.f);
  chk("B4 the log names the state, not just the file",
      !!g.line && g.line.includes(K), String(g.line));
}

// ── C. the escape hatch still works when a genuinely different state exists ─
{
  const K = stateKeyOf({ map: 3, x: 5, y: 6, story: 6, badges: 1, levelSum: 42 });
  const K2 = stateKeyOf({ map: 4, x: 9, y: 2, story: 6, badges: 1, levelSum: 44 });
  const winner = cand("/ck/auto-r1-t10.state.gz", { key: K, mtime: 1000 });
  const twin = cand("/ck/auto-r2-t10.state.gz", { key: K, mtime: 3000 });
  const onWarp = cand("/ck/auto-r2-map4.state.gz", { key: K2, mtime: 2500, onWarp: true, map: 4 });
  const real = cand("/ck/auto-r2-t20.state.gz", { key: K2, mtime: 2000, map: 4 });

  const g = repeatGuard([winner, twin, onWarp, real], winner, [K, K]);
  chk("C1 steps aside to a newer DIFFERENT state", g.winner.f === real.f, g.winner.f);
  chk("C2 wq#1066 preserved: never steps aside onto a warp-tile save",
      g.winner.onWarp === false);

  // Anti-wedge: nothing newer to take -> keep the winner, say so.
  const alone = repeatGuard([winner, twin], winner, [K, K]);
  chk("C3 no newer different state -> keeps the pick (cannot wedge)",
      alone.winner.f === winner.f && /no newer alternative/i.test(alone.line ?? ""));

  // Never trade a viable state for a non-viable one.
  const sick = cand("/ck/auto-r2-t30.state.gz", { key: K2, mtime: 4000, viable: false, hpPct: 0.1 });
  const g2 = repeatGuard([winner, sick], winner, [K, K]);
  chk("C4 a newer NON-VIABLE state is not an escape from a viable one",
      g2.winner.f === winner.f);
}

// ── D. it only fires on an actual repeat, and unknown keys keep old behaviour ─
{
  const K = stateKeyOf({ map: 3, x: 5, y: 6, story: 6, badges: 1, levelSum: 42 });
  const winner = cand("/ck/a.state.gz", { key: K });
  const other = cand("/ck/b.state.gz", { key: K + "x", mtime: 2000 });
  chk("D1 one prior pick is not a repeat (limit is 2)",
      repeatGuard([winner, other], winner, [K]).line === null);
  chk("D2 a different last pick is not a repeat",
      repeatGuard([winner, other], winner, [K + "x", K]).line === null);
  chk("D3 RESUME_REPEAT_LIMIT is what the guard actually enforces",
      repeatGuard([winner, other], winner, Array(RESUME_REPEAT_LIMIT).fill(K)).line !== null &&
      RESUME_REPEAT_LIMIT === 2);
  // Pre-v4 corpus: keys unknown on both sides -> path identity, old semantics.
  const oldW = cand("/ck/a.state.gz");
  const oldAlt = cand("/ck/b.state.gz", { mtime: 2000 });
  const g = repeatGuard([oldW, oldAlt], oldW, ["file:/ck/a.state.gz", "file:/ck/a.state.gz"]);
  chk("D4 keyless (pre-v4) candidates keep the wq#518 filename behaviour",
      g.winner.f === oldAlt.f, g.winner.f);
}

// ── E. end to end: a v4 sidecar's stateKey reaches readProgress ──────────
{
  const BASE = "/home/lumen/pokemon";
  const ROM = `${BASE}/roms/pokeblue.gb`;
  const SYM = `${BASE}/roms/pokeblue.sym`;
  if (!existsSync(ROM) || !existsSync(SYM)) {
    skipped("E1 v4 sidecar -> Progress.key", "no ROM/sym on this host (CI)");
  } else {
    const sym = new SymbolTable(SYM);
    const dir = mkdtempSync(join(tmpdir(), "lpp1177-"));
    const key = stateKeyOf({ map: 3, x: 5, y: 6, story: 6, badges: 1, levelSum: 42 });
    const mk = (stem: string, side: Record<string, unknown>) => {
      const f = join(dir, `${stem}.state.gz`);
      writeFileSync(f, "");
      writeFileSync(join(dir, `${stem}.json`), JSON.stringify({
        v: 4, kind: "periodic", map: 3, x: 5, y: 6, badges: 1, events: 20,
        storyScore: 6, hpPct: 1, ppOk: true, money: 431, ts: Date.now(), ...side,
      }));
      utimesSync(f, Date.now() / 1000 - 100, Date.now() / 1000 - 100);
      return f;
    };
    const withKey = mk("v4", { stateKey: key });
    const without = mk("v3", { v: 3 });
    chk("E1 v4 sidecar carries its stateKey into Progress",
        readProgress(withKey, sym, ROM).key === key, readProgress(withKey, sym, ROM).key);
    chk("E2 v3 sidecar reports an unknown key rather than guessing",
        readProgress(without, sym, ROM).key === "");
  }
}

console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
process.exit(fail ? 1 : 0);
