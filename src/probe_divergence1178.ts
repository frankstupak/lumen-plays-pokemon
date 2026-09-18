// wq#1178 acceptance (roadmap item 8): divergence-on-repeat objective
// injection. Section 2d of the improvement plan: "replaying identical
// context from an identical state produces an identical run" -- a recovery
// objective that just repeats "go to map14" forever is exactly that replay.
// This probe proves the property the ticket names directly: repeated
// identical (map,pos,objective) triggers a divergent objective, a DIFFERENT
// position or a cleared goal resets the count, and the injection survives a
// restart (fresh RecoveryTracker, same backing file) the same way
// seedMaxFromSidecars already does for maxStoryScore.
//
// TEST ISOLATION IS LOAD-BEARING (same lesson as probe_ledger1181/
// probe_warpcooldown1178). repeatHistoryFile() resolves the env override at
// CALL time, so setting it before the first evaluate() call is enough.
const TAG = `${process.pid}-${Date.now()}`;
process.env.LPP_RECOVERY_REPEAT_HISTORY = `/tmp/recoveryrepeat1178-${TAG}.json`;

import { existsSync, readFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RecoveryTracker, CORRIDOR, countRepeats, divergentObjective, REPEAT_LIMIT,
  repeatHistoryFile, loadRepeatHistory,
} from "./recovery";
import { GameState, STORY_FLAGS } from "./state";
import { EventBus } from "./events";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const FLAG_IDX = new Map(STORY_FLAGS.map(f => [f.name, f.idx]));
const brockOnly = (idx: number) => idx === FLAG_IDX.get("EVENT_BEAT_BROCK");
const BROCK_POINT = CORRIDOR.find(c => c.afterFlag === "EVENT_BEAT_BROCK")!;

function mkState(over: Partial<GameState> = {}): GameState {
  return {
    map: 59, x: 10, y: 10, partyCount: 1,
    party: [{ level: 12, hp: 30 } as any],
    badges: 1, badgeCount: 1, money: 500, inBattle: 0,
    pokedexOwned: 3, pokedexSeen: 5, playH: 1, playM: 2, playS: 3,
    storyScore: 50, ...over,
  };
}

const SCRATCH = mkdtempSync(join(tmpdir(), "wq1178-divergence-"));
let turn = 0;
function bus() {
  const b = new EventBus(join(SCRATCH, "events"), `probe-${process.pid}-${turn}`);
  return b;
}

function main() {
  // A. Frontier turns (score >= max, no whiteout): null, untouched.
  {
    const rt = new RecoveryTracker(50);
    const r = rt.evaluate(mkState({ storyScore: 50 }), 50, brockOnly, bus(), ++turn);
    chk("A1 no active goal returns null", r === null);
  }

  // B. countRepeats / divergentObjective are pure and directly testable.
  {
    const h = [
      { map: 1, x: 2, y: 3, objective: "go", turn: 1 },
      { map: 1, x: 2, y: 3, objective: "go", turn: 2 },
      { map: 1, x: 2, y: 3, objective: "stop", turn: 3 },
      { map: 9, x: 2, y: 3, objective: "go", turn: 4 },
    ];
    chk("B1 counts only the exact (map,x,y,objective) tuple", countRepeats(h, 1, 2, 3, "go") === 2);
    chk("B2 a different objective at the same spot does not count",
        countRepeats(h, 1, 2, 3, "elsewhere") === 0);
    chk("B3 a different map at the same tile does not count", countRepeats(h, 9, 2, 3, "stop") === 0);
    const s0 = divergentObjective(BROCK_POINT, 0);
    const s1 = divergentObjective(BROCK_POINT, 1);
    const s3 = divergentObjective(BROCK_POINT, 3);
    chk("B4 divergent text names the unchanged frontier target", s0.includes("map14"));
    chk("B5 rotates sub-goals across attempts", s0 !== s1);
    chk("B6 rotation wraps (attempt 3 == attempt 0)", s0 === s3);
  }

  // C. The core property: the SAME (map,x,y,objective) recurring under a
  // live score_regression goal must trigger a divergent objective by
  // REPEAT_LIMIT, and not before.
  {
    const rt = new RecoveryTracker(100);   // maxStoryScore seeded above current score=50
    const st = mkState({ storyScore: 50, map: 59, x: 10, y: 10 });
    const seen: (string | null)[] = [];
    const events: any[] = [];
    const b = bus();
    b.on(e => events.push(e));
    for (let i = 0; i < 4; i++) seen.push(rt.evaluate(st, 50, brockOnly, b, ++turn));

    chk("C1 goal detected: names the frontier corridor point",
        !!seen[0] && seen[0]!.includes("map14"));
    chk("C2 first REPEAT_LIMIT-1 calls stay on the plain objective",
        seen.slice(0, REPEAT_LIMIT - 1).every(s => s && !s.includes("STOP repeating")));
    chk("C3 the REPEAT_LIMIT-th identical call turns divergent",
        !!seen[REPEAT_LIMIT - 1] && seen[REPEAT_LIMIT - 1]!.includes("STOP repeating"));
    chk("C4 it stays divergent on further repeats, not a one-shot",
        !!seen[REPEAT_LIMIT] && seen[REPEAT_LIMIT]!.includes("STOP repeating"));
    chk("C5 the frontier target itself is still named even while diverging",
        seen[REPEAT_LIMIT]!.includes("map14"));
    const divEvents = events.filter(e => (e as any).stage === "divergent_objective");
    chk("C6 each divergent injection is logged on the bus",
        divEvents.length === 2, `got ${divEvents.length}`);
  }

  // D. A different position resets the count -- the guard is keyed on
  // (map,x,y,objective), not on "a recovery goal is active" alone.
  {
    const rt = new RecoveryTracker(100);
    const b = bus();
    for (let i = 0; i < REPEAT_LIMIT; i++)
      rt.evaluate(mkState({ storyScore: 50, x: 10 }), 50, brockOnly, b, ++turn);
    const moved = rt.evaluate(mkState({ storyScore: 50, x: 11 }), 50, brockOnly, b, ++turn);
    chk("D1 moving to a new tile resets the streak (plain objective again)",
        !!moved && !moved.includes("STOP repeating"));
  }

  // E. Persistence: a FRESH RecoveryTracker pointed at the same backing file
  // (simulating a restart) continues the count instead of starting at zero
  // -- otherwise every restart would refund the exact loop it is meant to
  // break (the wq#517 lesson, restated for objectives instead of bans).
  {
    const file = repeatHistoryFile();
    if (existsSync(file)) unlinkSync(file);
    const st = mkState({ storyScore: 50, map: 3, x: 20, y: 20 });
    const rt1 = new RecoveryTracker(100);
    const b = bus();
    for (let i = 0; i < REPEAT_LIMIT - 1; i++) rt1.evaluate(st, 50, brockOnly, b, ++turn);
    chk("E1 the backing file now holds the pre-restart history",
        loadRepeatHistory(file).length === REPEAT_LIMIT - 1);
    const rt2 = new RecoveryTracker(100);   // fresh instance, same file on disk
    const after = rt2.evaluate(st, 50, brockOnly, b, ++turn);
    chk("E2 a restarted tracker inherits the streak and goes divergent immediately",
        !!after && after.includes("STOP repeating"));
    unlinkSync(file);
  }

  console.log(`\nprobe_divergence1178: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
