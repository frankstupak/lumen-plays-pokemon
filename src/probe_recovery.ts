// wq#477 probe: RecoveryTracker + corridor mapping, no emulator needed.
import { RecoveryTracker, corridorPoint, CORRIDOR } from "./recovery";
import { STORY_FLAGS, GameState } from "./state";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// fake bus capturing regression events
const events: any[] = [];
const bus: any = { emit: (kind: string, e: any) => { if (kind === "regression") events.push(e); } };

const IDX = new Map(STORY_FLAGS.map(f => [f.name, f.idx]));
const flagsSet = new Set<number>();
const flagAt = (idx: number) => flagsSet.has(idx);
const st = (map: number, hp: number): GameState => ({
  map, x: 0, y: 0, partyCount: 1,
  party: [{ species: 1, hp, status: 0, level: 10, maxHp: 20, moves: [1, 0, 0, 0], pp: [10, 0, 0, 0] }],
  badges: 0, badgeCount: 0, money: 0, inBattle: 0,
} as GameState);

// 1) corridor ordering: no flags -> fallback Pallet
ok("corridor fallback", corridorPoint(flagAt).targetMap === 0, JSON.stringify(corridorPoint(flagAt)));
// 2) BEAT_BROCK set -> Route 3 (map14); most-advanced-first wins over earlier flags
flagsSet.add(IDX.get("EVENT_GOT_POKEDEX")!);
flagsSet.add(IDX.get("EVENT_BEAT_BROCK")!);
ok("corridor brock->route3", corridorPoint(flagAt).targetMap === 14, corridorPoint(flagAt).desc);
// 3) fossil grabbed -> Route 4 east beats Brock entry
flagsSet.add(IDX.get("EVENT_GOT_HELIX_FOSSIL")!);
ok("corridor fossil->route4", corridorPoint(flagAt).targetMap === 15, corridorPoint(flagAt).desc);

// --- tracker: frontier never fires ---
const tr = new RecoveryTracker(0);
let g = tr.evaluate(st(59, 20), 9, flagAt, bus, 1);
ok("frontier no-fire (first sight of score 9)", g === null, String(g));
ok("max tracked", tr.maxStoryScore === 9, `max=${tr.maxStoryScore}`);
g = tr.evaluate(st(59, 20), 9, flagAt, bus, 2);
ok("frontier steady no-fire", g === null && events.length === 0, `events=${events.length}`);

// --- whiteout: fires on the all-fainted edge, clears on reaching target map ---
g = tr.evaluate(st(59, 0), 9, flagAt, bus, 3);
ok("whiteout fires", g !== null && g.includes("BLACKED OUT"), (g ?? "").slice(0, 70));
ok("whiteout event", events.length === 1 && events[0].reason === "whiteout" && events[0].targetMap === 15, JSON.stringify(events[0] ?? {}));
g = tr.evaluate(st(2, 20), 9, flagAt, bus, 4);   // respawned in Pewter, healed
ok("goal persists off-target", g !== null, (g ?? "").slice(0, 50));
g = tr.evaluate(st(15, 20), 9, flagAt, bus, 5);  // reached Route 4 = target
ok("whiteout clears on target map", g === null, String(g));
ok("cleared event", events.length === 2 && events[1].stage === "cleared", JSON.stringify(events[1] ?? {}));

// --- no re-fire while fainted-state persists (edge, not level) ---
g = tr.evaluate(st(15, 0), 9, flagAt, bus, 6);
ok("second whiteout edge fires again", g !== null, (g ?? "").slice(0, 40));
tr.evaluate(st(15, 20), 9, flagAt, bus, 7);      // clears immediately (on target map)

// --- score regression: resume onto older checkpoint ---
const tr2 = new RecoveryTracker(9);              // seeded from sidecars
events.length = 0;
g = tr2.evaluate(st(2, 20), 7, flagAt, bus, 1);  // resumed with score 7 < 9
ok("score regression fires", g !== null && g.includes("BEHIND") && g.includes("7/9"), (g ?? "").slice(0, 80));
ok("regression event", events[0]?.reason === "score_regression", JSON.stringify(events[0] ?? {}));
g = tr2.evaluate(st(2, 20), 9, flagAt, bus, 2);  // re-attained
ok("score regression clears at max", g === null, String(g));

// --- seed constructor respected ---
ok("seed respected", tr2.maxStoryScore === 9, `max=${tr2.maxStoryScore}`);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
