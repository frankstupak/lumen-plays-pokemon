// wq#1178 acceptance: the directed warp-edge ledger, its WARPS annotations and
// time-boxed door cooldowns (item 7), and divergence-on-repeat (item 8).
//
// THE STALL THIS IS MEASURED AGAINST. lpp-pstack showed LPP with 60% of turns
// returning `enter_warp: refused - this is the door you just arrived through`,
// stuck_mode=None, the frontier frozen at Route 25 for 407h / 8110 turns /
// 187.7M tokens. Every guard involved was working as written: the refusal was
// correct, and the WARPS line above it was telling the brain — in the same
// state block — that `enter_warp(i)` on the warp underfoot "still uses it".
// The two disagreed, and the brain believed the state block. So the assertions
// below are about AGREEMENT and about EXPIRY, not about adding one more rule:
//   * the state block must not advertise the action the executor refuses (D);
//   * a door that keeps refusing, or a pair that keeps bouncing, must become
//     unavailable FOR A WHILE and then come back (B, C) — wq#517's lesson is
//     that a permanent ban wedges the one corridor that runs backward;
//   * a state that boots twice must be handed different inputs, not the same
//     ones with a different checkpoint filename (E).
//
// TEST ISOLATION IS LOAD-BEARING (the wq#517 lesson, as in probe_novelty1179).
// Both modules persist under process.cwd()/runtime, which in production is the
// LIVE deployment: an unredirected probe would write synthetic warp edges and
// synthetic boots into the running agent's ledgers, inventing cooldowns and
// repeat-boots for a game it never played. ESM hoists imports above these
// assignments, which is why both modules resolve their paths at CALL time.
const TAG = `${process.pid}-${Date.now()}`;
process.env.LPP_WARP_EDGES = `/tmp/warpedge1178-edges-${TAG}.json`;
process.env.LPP_BOOT_LEDGER = `/tmp/warpedge1178-boots-${TAG}.json`;

import { existsSync, unlinkSync } from "fs";
import {
  WarpEdge, WarpCooldown, edgeKey, edgesFile, loadEdges, saveEdges,
  doorUsage, doorAnnotation, roundTrips, assessCooldowns, coolActive,
  activeCooldown, pruneCooldowns, dropRefusalCooldowns, coolMinutesLeft,
  EDGE_WINDOW, EDGE_ANNOTATE_MIN, PAIR_TRIPS, COOLDOWN_MS,
} from "./oscillation";
import { renderWarps, WarpView } from "./reach";
import {
  DivergenceTracker, stateKey, corridorNext, corridorPoint, priorOutcome,
  bootLedgerFile, loadBoots, BootRecord, CORRIDOR,
} from "./recovery";
import { StateLike } from "./novelty";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const T0 = 1_800_000_000_000;   // fixed clock: nothing here may depend on wall time
const e = (from: number, idx: number, to: number, tiles: number, dt = 0): WarpEdge =>
  ({ from, idx, to, ts: T0 + dt, tiles });

/** The live shape: Bills House(88) <-> Route 25(36), the pair the stall ran on.
 *  Door 0 on 36 goes in, door 0 on 88 comes back out. */
const bounce = (trips: number, tiles = 100): WarpEdge[] => {
  const out: WarpEdge[] = [];
  for (let i = 0; i < trips; i++) {
    out.push(e(36, 0, 88, tiles, i * 2000), e(88, 0, 36, tiles, i * 2000 + 1000));
  }
  return out;
};

// ------------------------------------------- A. the ledger: usage + annotation
console.log("=== A. directed edges: per-DOOR usage, not per-map arrivals ===");
{
  const edges = bounce(2);
  chk("A1 a door used twice reports count 2",
    doorUsage(edges, 36, 0).count === 2, JSON.stringify(doorUsage(edges, 36, 0)));
  chk("A2 the OPPOSITE door is a different edge",
    edgeKey(36, 0, 88) !== edgeKey(88, 0, 36));
  chk("A3 a door never used reports 0",
    doorUsage(edges, 36, 3).count === 0);
  // Direction is the whole point: an arrival-map history (the wq#517 list)
  // holds 88,36,88,36 for this and cannot say which door produced it.
  chk("A4 same map pair, different doors, counted apart",
    doorUsage(edges, 36, 0).count === 2 && doorUsage(edges, 88, 0).count === 2);

  const anno = doorAnnotation(edges, 36, 0, 100);
  chk("A5 annotation names the count, the window and the novelty",
    !!anno && /taken 2x in last \d+ warps, 0 new tiles since/.test(anno), String(anno));
  chk("A6 novelty since is real subtraction, not a constant",
    doorAnnotation(edges, 36, 0, 137)?.includes("37 new tiles since") === true,
    String(doorAnnotation(edges, 36, 0, 137)));
  chk(`A7 a door used once is below EDGE_ANNOTATE_MIN (${EDGE_ANNOTATE_MIN}): no annotation, no tokens`,
    doorAnnotation([e(36, 0, 88, 10)], 36, 0, 10) === null);
  // The window is what keeps the line honest about "lately".
  const old = [...Array(EDGE_WINDOW)].map((_, i) => e(99, i % 4, 98, 10, i));
  chk("A8 usage outside the window is not counted",
    doorUsage([...bounce(2), ...old], 36, 0).count === 0);
}

// ------------------------------------------------ B. round trips and cooldowns
console.log("\n=== B. an alternating pair that buys nothing goes on cooldown ===");
{
  const one = roundTrips(bounce(1));
  chk("B1 one there-and-back is ONE round trip",
    [...one.values()][0]?.trips === 1, JSON.stringify([...one.entries()]));
  chk("B2 the pair is unordered (36<->88 either way is one key)",
    one.has("36<->88"), [...one.keys()].join(","));
  chk(`B3 one trip is below PAIR_TRIPS (${PAIR_TRIPS}): no cooldown`,
    assessCooldowns(bounce(1), T0, 100, []).length === 0);

  const cools = assessCooldowns(bounce(2), T0, 100, []);
  chk("B4 two trips with 0 new tiles cools BOTH directed doors",
    cools.length === 2 &&
    cools.some(c => c.key === edgeKey(36, 0, 88)) &&
    cools.some(c => c.key === edgeKey(88, 0, 36)),
    cools.map(c => c.key).join(" "));
  chk("B5 the cooldown says why, in the ledger's own terms",
    /36<->88 alternated 2x with 0 new tiles/.test(cools[0].reason), cools[0].reason);

  // The novelty conjunct is what separates a bounce from a corridor. Mt Moon's
  // only exit runs back the way you came (wq#535); if that back-and-forth is
  // covering new ground it is a route, and banning it would wedge the campaign.
  const productive = bounce(2).map((x, i) => ({ ...x, tiles: 100 + i * 3 }));
  chk("B6 the same pattern with new tiles found is NOT a bounce",
    assessCooldowns(productive, T0, 112, []).length === 0);

  // A->B, somewhere else, B->A is a route with a detour, not an oscillation.
  const detour = [e(36, 0, 88, 5), e(88, 1, 12, 5), e(12, 0, 88, 5), e(88, 0, 36, 5)];
  chk("B7 non-adjacent returns are not round trips",
    ![...roundTrips(detour).values()].some(t => t.trips >= PAIR_TRIPS),
    JSON.stringify([...roundTrips(detour).entries()]));

  chk("B8 an already-live cooldown is not duplicated",
    assessCooldowns(bounce(2), T0, 100, cools).length === 0);

  // Trips are whole there-and-backs, not sliding-window reversals: A->B->A->B
  // is one and a half, and must not buy a cooldown at PAIR_TRIPS=2.
  const oneAndAHalf = bounce(2).slice(0, 3);
  chk("B9 three warps is ONE round trip, not two: no cooldown yet",
    [...roundTrips(oneAndAHalf).values()][0]?.trips === 1 &&
    assessCooldowns(oneAndAHalf, T0, 100, []).length === 0,
    JSON.stringify([...roundTrips(oneAndAHalf).values()].map(t => t.trips)));
}

// ------------------------------------------------------ C. cooldowns EXPIRE
console.log("\n=== C. every cooldown dies two ways (wq#517: a permanent ban wedges) ===");
{
  const [c] = assessCooldowns(bounce(2), T0, 100, []);
  chk("C1 live at the moment it is set", coolActive(c, T0, 100));
  chk("C2 dead once the wall-clock deadline passes",
    !coolActive(c, T0 + COOLDOWN_MS + 1, 100));
  chk("C3 dead the instant ONE new tile is reached, long before the deadline",
    !coolActive(c, T0 + 1000, 101));
  chk("C4 minutes-left is reported, so the refusal can be honest about the wait",
    coolMinutesLeft(c, T0) === Math.round(COOLDOWN_MS / 60_000) &&
    coolMinutesLeft(c, T0 + COOLDOWN_MS + 5000) === 0,
    `${coolMinutesLeft(c, T0)} / ${coolMinutesLeft(c, T0 + COOLDOWN_MS + 5000)}`);
  chk("C5 lookup by key respects both expiries",
    activeCooldown([c], c.key, T0, 100) !== null &&
    activeCooldown([c], c.key, T0, 101) === null &&
    activeCooldown([c], "7:0->8", T0, 100) === null);
  chk("C6 pruning drops the dead and keeps the live",
    pruneCooldowns([c], T0, 100).length === 1 &&
    pruneCooldowns([c], T0 + COOLDOWN_MS + 1, 100).length === 0);

  // A refusal cooldown asks for one thing — a move — so the move retires it.
  // Without this, complying with the refusal would leave the door shut for ten
  // more minutes, which is exactly the wedge wq#517 warns about.
  const refusal: WarpCooldown = { ...c, kind: "refusal", reason: "refused 3x in a row without moving" };
  chk("C7 a real move drops REFUSAL cooldowns",
    dropRefusalCooldowns([refusal]).length === 0);
  chk("C8 ...and keeps BOUNCE cooldowns: a step does not make a round trip pay",
    dropRefusalCooldowns([c]).length === 1 && c.kind === "bounce");
  chk("C9 a record written before `kind` existed is treated as a bounce",
    dropRefusalCooldowns([{ ...c, kind: undefined }]).length === 1);
}

// ----------------------------------------------------------- D. the WARPS line
console.log("\n=== D. the state block and the executor now agree about the door ===");
{
  const views: WarpView[] = [
    { i: 0, x: 5, y: 7, destMap: 36, dest: "Route 25", state: "here", steps: 0 },
    { i: 1, x: 9, y: 2, destMap: 12, dest: "map12", state: "reachable", steps: 4 },
  ];
  const plain = renderWarps(views);
  chk("D1 unchanged with no options: the wq#538 line is intact",
    plain.startsWith("WARPS 0:(5,7)->Route 25 [STANDING-ON-IT]") &&
    plain.includes("1:(9,2)->map12 [4 steps]") &&
    plain.includes("enter_warp(0) still uses it"), plain.split("\n")[0]);

  // THE BUG, ASSERTED. Before wq#1178 this hint told the brain to fire the door
  // it had just arrived through — the exact call agent.ts refuses — and it said
  // so on every one of the 8110 stalled turns.
  const arrived = renderWarps(views, { arrivedIdx: 0 });
  chk("D2 on the arrival door the hint INVERTS instead of advising the refusal",
    arrived.includes("ARRIVED through warp 0") && arrived.includes("REFUSED") &&
    !arrived.includes("still uses it"), arrived.split("\n")[1] ?? "");
  chk("D3 it names the way out (a real step first), not just the prohibition",
    /goto a different tile/i.test(arrived));
  chk("D4 a DIFFERENT arrival door leaves the standing-on hint alone",
    renderWarps(views, { arrivedIdx: 1 }).includes("still uses it"));

  const annotated = renderWarps(views, { anno: v => (v.i === 0 ? "COOLDOWN 7m, taken 4x in last 10 warps" : null) });
  chk("D5 annotations ride on the warp they describe, and only there",
    annotated.includes("[STANDING-ON-IT] {COOLDOWN 7m, taken 4x in last 10 warps}") &&
    annotated.includes("1:(9,2)->map12 [4 steps]  ".trim()) &&
    !annotated.includes("map12 [4 steps] {"), annotated.split("\n")[0]);
  chk("D6 no warps on the map is still the same one-liner",
    renderWarps([], { arrivedIdx: 0 }) === "WARPS none on this map");
}

// ------------------------------------------------------------ E. persistence
console.log("\n=== E. the ledger survives the reboot the loop outlives ===");
{
  const file = edgesFile();
  chk("E1 the env override is honoured (a probe never writes the live ledger)",
    file === process.env.LPP_WARP_EDGES, file);
  chk("E2 a missing file loads empty, not thrown",
    loadEdges("/tmp/warpedge1178-does-not-exist.json").edges.length === 0);

  const cools = assessCooldowns(bounce(2), T0, 100, []);
  saveEdges(file, { edges: bounce(2), cools });
  const back = loadEdges(file);
  chk("E3 edges and cooldowns both round-trip",
    back.edges.length === 4 && back.cools.length === 2 &&
    back.edges[0].from === 36 && back.cools[0].untilTs === cools[0].untilTs,
    `${back.edges.length} edges / ${back.cools.length} cools`);
  chk("E4 a cooldown loaded after a reboot is still live",
    activeCooldown(back.cools, edgeKey(36, 0, 88), T0, 100) !== null);
  chk("E5 garbage on disk degrades to empty (bookkeeping never breaks a turn)",
    (() => { saveEdges(file, { edges: [null as any, e(1, 0, 2, 3)], cools: [] });
             return loadEdges(file).edges.length === 1; })());
  try { if (existsSync(file)) unlinkSync(file); } catch {}
}

// ------------------------------------- F. item 8: identity, not the filename
console.log("\n=== F. state identity: a new checkpoint name is the same trap ===");
{
  const st = (o: Partial<StateLike> = {}): StateLike => ({
    map: 36, x: 5, y: 7, partyCount: 2, party: [{ level: 14 }, { level: 9 }],
    badgeCount: 1, pokedexOwned: 12, storyScore: 21, ...o,
  });
  chk("F1 two boots at the same position/story/levels share a key",
    stateKey(st(), 21) === stateKey(st(), 21));
  chk("F2 a step of position is a different state",
    stateKey(st(), 21) !== stateKey(st({ x: 6 }), 21));
  chk("F3 story progress is a different state",
    stateKey(st(), 21) !== stateKey(st(), 22));
  chk("F4 a level-up is a different state (the grind IS progress)",
    stateKey(st(), 21) !== stateKey(st({ party: [{ level: 15 }, { level: 9 }] }), 21));
  chk("F5 a badge is a different state",
    stateKey(st(), 21) !== stateKey(st({ badgeCount: 2 }), 21));

  // The corridor alternative the directive names.
  const beatBrock = (idx: number) => idx === 12;   // whichever flag index we feed
  chk("F6 corridorNext is the milestone ABOVE the current point",
    (() => { const all = () => true;   // every flag set -> most advanced entry
             return corridorPoint(all) === CORRIDOR[0] && corridorNext(all) === null; })());
  chk("F7 with nothing set, next is the first milestone of the campaign",
    corridorNext(() => false) === CORRIDOR[CORRIDOR.length - 1], String(corridorNext(() => false)?.desc));
  void beatBrock;

  chk("F8 prior outcome reads the last COMPLETE run from that key",
    (() => {
      const boots: BootRecord[] = [
        { key: "k", ts: 1, bootP: 100, endP: 100, turns: 40 },
        { key: "other", ts: 2, bootP: 1, endP: 9, turns: 3 },
        { key: "k", ts: 3, bootP: 200, endP: 200, turns: 61 },
      ];
      const o = priorOutcome(boots, "k");
      return o?.dP === 0 && o?.turns === 61 && priorOutcome(boots, "unseen") === null;
    })());
}

// ------------------------------------------ G. divergence on the SECOND boot
console.log("\n=== G. the second boot from a state gets different inputs ===");
{
  const file = bootLedgerFile();
  try { if (existsSync(file)) unlinkSync(file); } catch {}
  const flags = (idx: number) => idx === -1;   // no story flag set: bottom of the corridor
  const st: StateLike = {
    map: 36, x: 5, y: 7, partyCount: 1, party: [{ level: 14 }],
    badgeCount: 1, pokedexOwned: 12, storyScore: 21,
  };

  const first = new DivergenceTracker(file);
  first.onBoot(st, 21, flags);
  chk("G1 the FIRST boot from a state says nothing", first.directive() === null);
  // A run that achieved exactly nothing — the 8110-turn shape.
  for (let t = 1; t <= 40; t++) first.noteProgress(5000, t);
  chk("G2 ...even after a flat run: the evidence is for the NEXT boot",
    first.directive() === null);

  const second = new DivergenceTracker(file);
  second.onBoot(st, 21, flags);
  const d = second.directive();
  chk("G3 the SECOND boot from the same state injects a divergence objective",
    d !== null && d.startsWith("!! DIVERGENCE REQUIRED"), String(d).slice(0, 60));
  chk("G4 it quotes the MEASURED outcome of the previous run, not a guess",
    !!d && /ran 40 turns and achieved dP=\+0/.test(d), String(d));
  chk("G5 it names a concrete alternative objective from the corridor",
    !!d && /MANDATORY ALTERNATIVE OBJECTIVE/.test(d) && /map\d+/.test(d));
  chk("G6 it forbids replaying the plan, and says what 'different' means",
    !!d && /DO NOT REPEAT THAT PLAN/.test(d) && /warp index you have not used/.test(d));

  // It is an OBJECTIVE, not a ban: it clears itself the moment the run produces.
  second.noteProgress(5000, 1);
  chk("G7 still active while the composite is flat", second.directive() !== null);
  second.noteProgress(5001, 2);
  chk("G8 clears itself as soon as P rises: the repeat is over", second.directive() === null);
  chk("G9 and stays cleared", second.directive() === null);

  const boots = loadBoots(file);
  chk("G10 both boots are on disk for the third one to read",
    boots.filter(b => b.key === stateKey(st, 21)).length === 2, `${boots.length} boots`);

  // A DIFFERENT state booting is the ordinary case and must stay silent.
  const third = new DivergenceTracker(file);
  third.onBoot({ ...st, x: 9 }, 21, flags);
  chk("G11 a different state boots silently", third.directive() === null);
  try { if (existsSync(file)) unlinkSync(file); } catch {}
}

console.log(`\n${fail === 0 ? "PROBE GREEN" : "PROBE RED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
