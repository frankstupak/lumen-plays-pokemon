// wq#696 — catch-sticky transit mode probe.
// Verifies: (1) decideBattle returns "catch" for a WANTED species when
// catchSticky=true, (2) returns "fight" (weaken) when foeHpFrac > 0.5,
// (3) respects noWeaken (ABRA), (4) still flees non-WANTED species,
// (5) still hands to brain when catchSticky=false (backcompat).
import { decideBattle, TransitGoal, BattleCtx } from "./transit";
import { pickWeakestMove } from "./moves";
import assert from "assert";

const goal: TransitGoal = { kind: "goto", map: 35, x: 10, y: 8, attempts: 0, fleeFails: 0 };

// Helper: base context (healthy, wild, has moves, not grinding)
const base: BattleCtx = {
  wild: true, hpFrac: 0.8, hasUsableMove: true, wanted: true,
  grind: false, catchSticky: true, noWeaken: false, foeHpFrac: 0.9,
};

// --- Section A: catch-sticky + WANTED, foe HP high -> weaken (fight) ---
{
  const d = decideBattle(goal, { ...base, foeHpFrac: 0.9 });
  assert.strictEqual(d.action, "fight", "A1: should weaken when foeHpFrac > 0.5");
  assert.ok(d.why.includes("weaken"), "A2: why should mention weakening");
}

// --- Section B: catch-sticky + WANTED, foe HP low -> throw ball (catch) ---
{
  const d = decideBattle(goal, { ...base, foeHpFrac: 0.4 });
  assert.strictEqual(d.action, "catch", "B1: should catch when foeHpFrac <= 0.5");
}

// --- Section C: catch-sticky + WANTED + noWeaken -> immediate catch ---
{
  const d = decideBattle(goal, { ...base, noWeaken: true, foeHpFrac: 1.0 });
  assert.strictEqual(d.action, "catch", "C1: noWeaken = throw immediately even at full HP");
  assert.strictEqual(d.noWeaken, true, "C2: decision carries noWeaken flag");
}

// --- Section D: catch-sticky + NOT wanted -> flee (normal transit) ---
{
  const d = decideBattle(goal, { ...base, wanted: false });
  assert.strictEqual(d.action, "flee", "D1: non-wanted species = flee under transit");
}

// --- Section E: catchSticky=false + WANTED -> brain (backcompat) ---
{
  const d = decideBattle(goal, { ...base, catchSticky: false });
  assert.strictEqual(d.action, "brain", "E1: without catchSticky, WANTED hands to brain");
}

// --- Section F: HP critical overrides catch-sticky ---
{
  const d = decideBattle(goal, { ...base, hpFrac: 0.2 });
  assert.strictEqual(d.action, "brain", "F1: HP critical always hands to brain");
}

// --- Section G: no transit goal -> brain regardless of catchSticky ---
{
  const d = decideBattle(null, { ...base });
  assert.strictEqual(d.action, "brain", "G1: no goal = brain");
}

// --- Section H: catch-sticky + WANTED + no usable move -> catch (throw as-is) ---
{
  const d = decideBattle(goal, { ...base, hasUsableMove: false, foeHpFrac: 0.9 });
  assert.strictEqual(d.action, "catch", "H1: no usable move = throw ball as-is");
}

// --- Section I: pickWeakestMove prefers status over damage ---
{
  // moves: 0=EMBER(40pow), 1=GROWL(0pow/status), 2=LEER(0pow/status), 3=RAGE(20pow,lockIn)
  const moves = [52, 45, 43, 99];  // EMBER, GROWL, LEER, RAGE (per moves.ts MOVES table)
  const pp = [25, 40, 30, 20];
  const w = pickWeakestMove(moves, pp);
  // Should pick a status move (GROWL=45 or LEER=43), never RAGE (lockIn)
  assert.ok(w === 1 || w === 2, `I1: pickWeakestMove should pick status move, got slot ${w}`);
}

console.log("probe_catch696: ALL PASS (9 sections, A-I)");
