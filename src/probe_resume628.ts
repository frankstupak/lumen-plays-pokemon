// wq#628 — resume selector: marginal viability miss silently trades away
// story progress. Red/green against the EXACT measured fixture pair.
//
// THE DEFECT THIS FIXES. pickResume's primary sort key used to be the hard
// VIABLE_HP_PCT gate (hpPct >= 0.5 && ppOk): `(Number(b.viable) -
// Number(a.viable))` sorted first, before story. MEASURED CASE (2026-08-15
// 06:07Z restart, fable8-5bc434): auto-mstxk9uq-map3 carried story=9,
// hpPct=0.494, money=996 (post-rival win); auto-mstoq0ir-map3 carried
// story=8, hpPct=1, money=401. 0.494 is 0.6% under the 0.5 threshold, so the
// old comparator picked the story=8 save and the campaign silently re-lost
// the rival win and $595 on the deploy. Both fixtures are still on disk —
// this probe drives pickResume over copies of the real files, not synthetic
// stand-ins, so the acceptance is anchored to the actual incident.
//
// THE FIX: the primary gate is now criticalCondition (hpPct < 0.25 or
// !ppOk) instead of the (stricter) VIABLE_HP_PCT — a state one encounter
// from a whiteout loop still cannot be bought back by story, but a single
// bar of HP no longer outvotes a permanent story flag. VIABLE_HP_PCT itself
// is unchanged and still governs the repeat-guard escape hatch and the
// `viable=` boot-log field (deliberately not touched — wq#628 deliverable 4).
//
// Usage: npx tsx src/probe_resume628.ts   (copies real checkpoints into a
// mkdtemp dir; nothing under /home/lumen/pokemon is written)
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SymbolTable } from "./symbols";
import { pickResume, readProgress, criticalCondition, CRITICAL_HP_PCT } from "./resume";

const BASE = "/home/lumen/pokemon";
const ROM = `${BASE}/roms/pokeblue.gb`;
const CK = `${BASE}/checkpoints`;
const sym = new SymbolTable(`${BASE}/roms/pokeblue.sym`);

let pass = 0, fail = 0, skip = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

// Copy a REAL checkpoint pair (sidecar + state) into an isolated dir so
// pickResume sees only these two candidates, with captured log lines.
function copyReal(stem: string, dir: string): boolean {
  const j = `${CK}/${stem}.json`, s = `${CK}/${stem}.state.gz`;
  if (!existsSync(j) || !existsSync(s)) return false;
  copyFileSync(j, join(dir, `${stem}.json`));
  copyFileSync(s, join(dir, `${stem}.state.gz`));
  return true;
}

console.log("-- A: the exact measured incident, replayed from the real fixture pair --");
const higherStoryLowerHp = "auto-mstxk9uq-map3";   // story 9, hpPct 0.494
const lowerStoryFullHp = "auto-mstoq0ir-map3";     // story 8, hpPct 1

const dirA = mkdtempSync(join(tmpdir(), "lpp628a-"));
const haveHigh = copyReal(higherStoryLowerHp, dirA);
const haveLow = copyReal(lowerStoryFullHp, dirA);
if (!haveHigh || !haveLow) {
  skip++;
  console.log(`SKIP section A -- one or both fixtures rotated off disk ` +
    `(${higherStoryLowerHp}: ${haveHigh}, ${lowerStoryFullHp}: ${haveLow}). ` +
    `This is corpus rot, not a code defect; sections B/C still run.`);
} else {
  const pHigh = readProgress(`${dirA}/${higherStoryLowerHp}.state.gz`, sym, ROM);
  const pLow = readProgress(`${dirA}/${lowerStoryFullHp}.state.gz`, sym, ROM);
  chk("fixture pHigh really is the measured case: story 9, hpPct ~0.494, non-viable",
      pHigh.story === 9 && Math.abs(pHigh.hpPct - 0.494) < 0.001 && !pHigh.viable,
      `story=${pHigh.story} hp=${pHigh.hpPct} viable=${pHigh.viable}`);
  chk("fixture pLow really is the measured trade target: story 8, hpPct 1, viable",
      pLow.story === 8 && pLow.hpPct === 1 && pLow.viable,
      `story=${pLow.story} hp=${pLow.hpPct} viable=${pLow.viable}`);
  chk("pHigh is NOT critical (0.494 is well above CRITICAL_HP_PCT)",
      !criticalCondition(pHigh), `hp=${pHigh.hpPct} threshold=${CRITICAL_HP_PCT}`);

  const logs: string[] = [];
  const winner = pickResume([dirA], sym, ROM,
    { log: l => logs.push(l), historyFile: join(dirA, "history.json") });
  chk("GREEN: the higher-story, marginally-under-VIABLE_HP_PCT save now wins",
      winner.endsWith(`${higherStoryLowerHp}.state.gz`), winner.split("/").pop()!);
  chk("no silent trade: no WARNING line fires when the story-leading save wins",
      !logs.some(l => l.includes("WARNING")), logs.join(" | "));
}

console.log("\n-- B: RED half, in-probe -- the OLD comparator on these same two files --");
{
  const dirB = mkdtempSync(join(tmpdir(), "lpp628b-"));
  if (copyReal(higherStoryLowerHp, dirB) && copyReal(lowerStoryFullHp, dirB)) {
    const cands = [
      { f: `${dirB}/${higherStoryLowerHp}.state.gz`, ...readProgress(`${dirB}/${higherStoryLowerHp}.state.gz`, sym, ROM) },
      { f: `${dirB}/${lowerStoryFullHp}.state.gz`, ...readProgress(`${dirB}/${lowerStoryFullHp}.state.gz`, sym, ROM) },
    ];
    // byte-for-byte the pre-fix comparator (VIABLE_HP_PCT-gated, not critical-gated)
    const oldSort = [...cands].sort((a, b) =>
      (Number(b.viable) - Number(a.viable)) || (b.badges - a.badges) ||
      ((a.story >= 0 && b.story >= 0) ? (b.story - a.story) : 0));
    chk("RED confirmed: the pre-fix comparator picks the LOWER-story save",
        oldSort[0].f.endsWith(`${lowerStoryFullHp}.state.gz`), oldSort[0].f.split("/").pop()!);
  } else {
    skip++;
    console.log("SKIP section B -- fixtures unavailable (see section A note).");
  }
}

console.log("\n-- C: the safety net still holds -- truly critical health still loses to story --");
{
  const dirC = mkdtempSync(join(tmpdir(), "lpp628c-"));
  const mk = (stem: string, side: Record<string, unknown>) => {
    writeFileSync(join(dirC, `${stem}.state.gz`), "");
    writeFileSync(join(dirC, `${stem}.json`), JSON.stringify({
      v: 3, kind: "periodic", map: 3, x: 10, y: 10, badges: 1, events: 20,
      money: 500, ts: Date.now(), ...side,
    }));
  };
  // a truly critical save (hp 0.1, below CRITICAL_HP_PCT) with HIGHER story
  // must still lose to a healthy save with lower story.
  mk("critical-high-story", { storyScore: 9, hpPct: 0.1, ppOk: true });
  mk("healthy-low-story", { storyScore: 8, hpPct: 1, ppOk: true });
  const logsC: string[] = [];
  const winnerC = pickResume([dirC], sym, ROM,
    { log: l => logsC.push(l), historyFile: join(dirC, "history.json") });
  chk("critically-low-hp save (story 9, hp 0.1) does NOT win over a healthy story-8 save",
      winnerC.endsWith("healthy-low-story.state.gz"), winnerC.split("/").pop()!);
  chk("the story trade is NOT silent here: a WARNING line fires naming the higher-story candidate",
      logsC.some(l => l.includes("WARNING") && l.includes("critical-high-story")),
      logsC.join(" | "));

  // a no-usable-move save must also still lose, even at full HP and higher story.
  const dirC2 = mkdtempSync(join(tmpdir(), "lpp628c2-"));
  const mk2 = (stem: string, side: Record<string, unknown>) => {
    writeFileSync(join(dirC2, `${stem}.state.gz`), "");
    writeFileSync(join(dirC2, `${stem}.json`), JSON.stringify({
      v: 3, kind: "periodic", map: 3, x: 10, y: 10, badges: 1, events: 20,
      money: 500, ts: Date.now(), ...side,
    }));
  };
  mk2("move-dead-high-story", { storyScore: 9, hpPct: 1, ppOk: false });
  mk2("healthy-low-story2", { storyScore: 8, hpPct: 1, ppOk: true });
  const winnerC2 = pickResume([dirC2], sym, ROM,
    { log: () => {}, historyFile: join(dirC2, "history.json") });
  chk("move-dead save (ppOk=false, story 9) does NOT win over a healthy story-8 save",
      winnerC2.endsWith("healthy-low-story2.state.gz"), winnerC2.split("/").pop()!);
}

console.log(`\nRESULT pass=${pass} fail=${fail} skip=${skip}`);
process.exit(fail ? 1 : 0);
