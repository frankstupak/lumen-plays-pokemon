// wq#1179 acceptance: the tile-novelty tracker sees a re-entry loop that every
// existing axis calls "fine", flags it in TURNS rather than hours, and does not
// flag ordinary exploration or a productive grind.
//
// TEST ISOLATION IS LOAD-BEARING (the wq#517 lesson, applied). novelty.ts
// persists to runtime/visited_tiles.json and runtime/progress.json under
// process.cwd(), which in production is the LIVE deployment. A probe that did
// not redirect both paths would inject synthetic tiles into the running agent's
// visited set — permanently suppressing real novelty on those tiles — and fake
// samples into the axis the stuck detector reads. ESM hoists the imports above
// these assignments, which is FINE and is why novelty.ts resolves both paths in
// tilesFile()/progressFile() at CONSTRUCTION time rather than at module load:
// no tracker exists until the first statement below runs.
const TAG = `${process.pid}-${Date.now()}`;
process.env.LPP_VISITED_TILES = `/tmp/novelty1179-tiles-${TAG}.json`;
process.env.LPP_PROGRESS_LOG = `/tmp/novelty1179-prog-${TAG}.json`;

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import {
  NoveltyTracker, StateLike, ProgressSample, composite, deltaP, levelSum, tileKey,
  WEIGHTS, DP_WINDOW_TURNS, KEEP_SAMPLES, MAX_NEW_TILES_PER_SAMPLE,
  tilesFile, progressFile, loadTiles, loadSamples,
} from "./novelty";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const st = (map: number, x: number, y: number, o: Partial<StateLike> = {}): StateLike => ({
  map, x, y, partyCount: 1, party: [{ level: 12 }],
  badgeCount: 1, pokedexOwned: 5, storyScore: 10, ...o,
});

/** Run a fixed sequence of states through a fresh tracker. */
function replay(states: StateLike[], window = DP_WINDOW_TURNS) {
  const t = new NoveltyTracker({ windowTurns: window });
  const samples: ProgressSample[] = [];
  const flats: boolean[] = [];
  states.forEach((s, i) => {
    samples.push(t.observe(i + 1, s));
    flats.push(t.delta(window).flat);
  });
  return { tracker: t, samples, flats };
}

const clean = () => {
  for (const f of [tilesFile(), progressFile()]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
};

// ------------------------------------------------- A. the composite scalar
console.log("=== A. composite P: tiers non-fungible per sample ===");
{
  const base = { storyScore: 0, badges: 0, levelSum: 0, pokedexOwned: 0, uniqueTiles: 0 };
  chk("A1 empty state scores 0", composite(base) === 0, String(composite(base)));
  // The property that matters is per-SAMPLE: one turn can add at most one tile
  // (end-of-turn sampling), so no turn of wandering can imitate the point value
  // of the cheapest real advance. Absolute fungibility (1000 tiles == 1 story
  // flag) is irrelevant — every consumer tests dP != 0, never P vs a threshold.
  const perTurnTile = WEIGHTS.tile * MAX_NEW_TILES_PER_SAMPLE;
  chk("A2 a tile cannot outweigh a dex entry", perTurnTile < WEIGHTS.dex);
  chk("A3 tiers strictly ordered", WEIGHTS.tile < WEIGHTS.dex && WEIGHTS.dex < WEIGHTS.level &&
      WEIGHTS.level < WEIGHTS.badge && WEIGHTS.badge < WEIGHTS.story,
      JSON.stringify(WEIGHTS));
  chk("A4 every component moves P", [
    composite({ ...base, storyScore: 1 }), composite({ ...base, badges: 1 }),
    composite({ ...base, levelSum: 1 }), composite({ ...base, pokedexOwned: 1 }),
    composite({ ...base, uniqueTiles: 1 }),
  ].every(v => v > 0));
  chk("A5 levelSum honours partyCount over array length",
      levelSum({ ...st(1, 1, 1), partyCount: 1, party: [{ level: 7 }, { level: 99 }] }) === 7);
  chk("A6 tileKey is (map,x,y)", tileKey(65, 4, 5) === "65,4,5");
}

// ------------------------------------------------- B. novelty under a loop
console.log("\n=== B. tile novelty collapses in a re-entry loop, not in exploration ===");
{
  clean();
  // The live shape this ticket exists for: warp into the gym, get refused or
  // beaten, warp back out to the city, repeat. Two tiles, forever.
  const loop: StateLike[] = [];
  for (let i = 0; i < 60; i++) loop.push(i % 2 === 0 ? st(65, 4, 5) : st(3, 10, 12));
  const L = replay(loop);
  const firstTwo = L.samples.slice(0, 2).reduce((s, x) => s + x.newTiles, 0);
  const rest = L.samples.slice(2).reduce((s, x) => s + x.newTiles, 0);
  chk("B1 loop discovers its two tiles once", firstTwo === 2, `first two: ${firstTwo}`);
  chk("B2 novelty is 0 for every later turn of the loop", rest === 0, `rest: ${rest}`);

  clean();
  // Ordinary exploration: each turn ends somewhere it has not ended before.
  const walk: StateLike[] = [];
  for (let i = 0; i < 60; i++) walk.push(st(3, 5 + (i % 20), 5 + Math.floor(i / 20)));
  const W = replay(walk);
  const newT = W.samples.reduce((s, x) => s + x.newTiles, 0);
  chk("B3 exploration discovers a tile every turn", newT === 60, `newTiles: ${newT}`);
  chk("B4 novelty never exceeds one per sample",
      W.samples.every(s => s.newTiles <= MAX_NEW_TILES_PER_SAMPLE));
}

// ------------------------------------------------- C. dP flags the loop, in turns
console.log("\n=== C. dP: flags the loop within the window, spares real progress ===");
{
  clean();
  const loop: StateLike[] = [];
  for (let i = 0; i < DP_WINDOW_TURNS * 2; i++) loop.push(i % 2 === 0 ? st(65, 4, 5) : st(3, 10, 12));
  const L = replay(loop);
  const firstFlat = L.flats.indexOf(true);
  chk("C1 loop is flagged", firstFlat >= 0);
  // "Within N turns": the window has to fill with flat samples first, and the
  // loop's first two turns are genuinely novel, so onset + window + 2 is the
  // honest bound. Asserting the BOUND rather than the exact index keeps this
  // from being a change-detector on the window constant.
  chk("C2 flagged within window+2 turns of onset",
      firstFlat >= 0 && firstFlat + 1 <= DP_WINDOW_TURNS + 2,
      `first flat at turn ${firstFlat + 1}, window ${DP_WINDOW_TURNS}`);
  chk("C3 dP is 0 across the flat window", L.tracker.delta().dP === 0,
      String(L.tracker.delta().dP));

  clean();
  const walk: StateLike[] = [];
  for (let i = 0; i < DP_WINDOW_TURNS * 2; i++) walk.push(st(3, 5 + (i % 20), 5 + Math.floor(i / 20)));
  const W = replay(walk);
  chk("C4 exploration is never flagged", W.flats.every(f => !f));

  clean();
  // The discrimination the 2h clock cannot make: standing in one grass patch,
  // walking tiles already walked, but LEVELLING. Story/badges/tiles are all
  // flat; levelSum is not. This must NOT be called a stall.
  const grind: StateLike[] = [];
  for (let i = 0; i < DP_WINDOW_TURNS * 2; i++)
    grind.push(st(51, 8, 9, { party: [{ level: 12 + Math.floor(i / 10) }] }));
  const G = replay(grind);
  chk("C5 productive grinding is never flagged", G.flats.every(f => !f),
      `flats: ${G.flats.filter(Boolean).length}`);

  clean();
  // One story flag inside an otherwise dead window clears the flag — the axis
  // reports the window in front of it, it does not latch. And once that flag
  // ages out of the window while the loop continues, it flags AGAIN: an agent
  // that scores once and goes straight back to the doorway is still stuck.
  const mixed: StateLike[] = [];
  for (let i = 0; i < DP_WINDOW_TURNS * 3; i++) {
    const s = i % 2 === 0 ? st(65, 4, 5) : st(3, 10, 12);
    mixed.push(i >= DP_WINDOW_TURNS * 2 ? { ...s, storyScore: 11 } : s);
  }
  const M = replay(mixed);
  chk("C6 flagged before the story flag", M.flats.slice(0, DP_WINDOW_TURNS * 2).some(f => f));
  chk("C7 clears on the turn the story flag lands", M.flats[DP_WINDOW_TURNS * 2] === false);
  chk("C8 re-flags once the flag ages out and the loop continues",
      M.flats[M.flats.length - 1] === true);
}

// ------------------------------------------------- D. persistence across runs
console.log("\n=== D. persistence: the loop the tracker must see spans reboots ===");
{
  clean();
  const a = new NoveltyTracker({});
  for (let i = 0; i < 10; i++) a.observe(i + 1, st(3, 5 + i, 5));
  const tilesAfterA = a.uniqueTiles();
  // A reboot: new Agent, new tracker, turn counter back to 1.
  const b = new NoveltyTracker({});
  chk("D1 visited tiles survive a reboot", b.uniqueTiles() === tilesAfterA,
      `${b.uniqueTiles()} vs ${tilesAfterA}`);
  const s = b.observe(1, st(3, 5, 5));      // a tile run A already stood on
  chk("D2 a re-visit after reboot is not novel", s.newTiles === 0);
  chk("D3 seq is monotonic across reboots, unlike turn", s.seq === 11 && s.turn === 1,
      `seq=${s.seq} turn=${s.turn}`);
  const win = b.delta(5);
  chk("D4 window spans both runs", win.samples === 5 && win.spanTurns === 4,
      JSON.stringify({ samples: win.samples, span: win.spanTurns }));

  clean();
  const c = new NoveltyTracker({});
  for (let i = 0; i < KEEP_SAMPLES + 25; i++) c.observe(i + 1, st(3, i % 40, Math.floor(i / 40)));
  chk("D5 sample log stays bounded", loadSamples(progressFile()).samples.length === KEEP_SAMPLES,
      String(loadSamples(progressFile()).samples.length));
  chk("D6 tile file holds the visited set",
      loadTiles(tilesFile()).tiles.size === c.uniqueTiles());
}

// ------------------------------------------------- E. fail-closed behaviour
console.log("\n=== E. fail-closed: a bookkeeping failure never breaks a turn ===");
{
  clean();
  writeFileSync(tilesFile(), "{not json");
  writeFileSync(progressFile(), "[]");
  let threw = "";
  let t: NoveltyTracker | null = null;
  try { t = new NoveltyTracker({}); t.observe(1, st(3, 5, 5)); } catch (e: any) { threw = String(e?.message ?? e); }
  chk("E1 corrupt files load as empty, no throw", threw === "" && t!.uniqueTiles() === 1, threw);

  const partial = deltaP(t!.recent(), DP_WINDOW_TURNS);
  chk("E2 a partial window is never flat", partial.complete === false && partial.flat === false);
  chk("E3 fewer than two samples reports not-ok", deltaP([], 10).ok === false);

  clean();
  // An unwritable path must not stop the tracker from producing its sample.
  // The blocker is a regular FILE standing where a directory would have to be,
  // so mkdirSync fails with ENOTDIR — and it stays inside /tmp, because a probe
  // that pokes at paths outside the sandbox hangs on a permission gate instead
  // of failing.
  const blocker = `/tmp/novelty1179-blocker-${TAG}`;
  writeFileSync(blocker, "not a directory");
  process.env.LPP_VISITED_TILES = `${blocker}/tiles.json`;
  const u = new NoveltyTracker({});
  let sample: ProgressSample | null = null;
  try { sample = u.observe(1, st(3, 5, 5)); } catch (e: any) { threw = String(e?.message ?? e); }
  chk("E4 unwritable tile file still yields a sample", !!sample && threw === "", threw);
  process.env.LPP_VISITED_TILES = `/tmp/novelty1179-tiles-${TAG}.json`;
  try { unlinkSync(blocker); } catch {}

  clean();
  // The bus contract the tools read: one `progress` event per observe, carrying
  // both the sample and the window verdict.
  const seen: any[] = [];
  const g = new NoveltyTracker({ bus: { emit: (kind: any, d: object) => seen.push({ kind, ...d }) }, windowTurns: 4 });
  for (let i = 0; i < 5; i++) g.observe(i + 1, st(65, 4, 5));
  chk("E5 one progress event per turn", seen.length === 5 && seen.every(e => e.kind === "progress"));
  chk("E6 event carries P, novelty and the dP verdict",
      seen[4].P > 0 && seen[4].newTiles === 0 && seen[4].dP === 0 && seen[4].dPFlat === true,
      JSON.stringify(seen[4]));
}

// ------------------------------------------------- F. the log the tools parse
console.log("\n=== F. runtime/progress.json is what lpp_stuck_mode.py expects ===");
{
  clean();
  const t = new NoveltyTracker({});
  t.observe(1, st(3, 5, 5));
  const raw = JSON.parse(readFileSync(progressFile(), "utf8"));
  const s = raw.samples[0];
  const need = ["seq", "turn", "ts", "map", "x", "y", "newTiles", "P",
                "storyScore", "badges", "levelSum", "pokedexOwned", "uniqueTiles"];
  chk("F1 sample carries every field the python axis reads",
      need.every(k => k in s), need.filter(k => !(k in s)).join(",") || "all present");
  // The python side re-derives P from these components with weights parsed out
  // of this module; if the two ever disagree it refuses to trust the axis. Prove
  // the identity holds at the source.
  chk("F2 logged P equals P recomputed from its own components",
      s.P === WEIGHTS.story * s.storyScore + WEIGHTS.badge * s.badges +
             WEIGHTS.level * s.levelSum + WEIGHTS.dex * s.pokedexOwned +
             WEIGHTS.tile * s.uniqueTiles, String(s.P));
  clean();
}

console.log(`\nprobe_novelty1179: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
