// wq#534 acceptance: prove from RAM+ROM that Mt Moon B1F (map 60) is FOUR
// mutually unreachable pockets, that exactly one of them holds the (27,3) exit,
// that the only way into that pocket is DOWN FROM B2F, and that progressRank
// now orders those pockets correctly.
//
// WHY THE POCKET IS A STATIC TABLE AND NOT A RUNTIME FLOOD FILL: readProgress()
// ranks a checkpoint from its sidecar JSON — {map,x,y} and nothing else. There
// is no emulator, no ROM and no loaded map at that point, and booting one per
// candidate would turn resume selection into a minute-long operation. So the
// pocket ships as a literal tile set in POCKET_MAPS, and section A re-derives
// that set from the live map on every run and fails if it drifts by one tile.
// That is the same contract SPLIT_MAPS keeps for map 15.
//
// HONESTY NOTE ABOUT SECTION D, stated here rather than buried: ZERO of the six
// map60 checkpoints on disk are in the exit pocket — all six sit on (17,11), a
// ladder in a dead pocket. The campaign has never stood in the pocket that
// holds the exit, so the exit-pocket half of the ranking CANNOT be graded
// against the real corpus and is graded against a SYNTHESISED sidecar instead.
// Section D says which of its cases are real and which are synthetic.
//
// Usage: npx tsx src/probe_pocket534.ts
import { readdirSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Emulator, loadSnapshotFile } from "./emulator";
import { SymbolTable } from "./symbols";
import { Rom } from "./rom";
import { MapModel } from "./map";
import { StateReader } from "./state";
import { pickResume, readProgress, progressRank, rankLabel, POCKET_MAPS, SPLIT_MAPS, STORY_ORDER } from "./resume";

const ROM = "/home/lumen/pokemon/roms/pokeblue.gb";
const SYM = "/home/lumen/pokemon/roms/pokeblue.sym";
const CKPTS = "/home/lumen/pokemon/checkpoints";

let pass = 0, fail = 0;
const chk = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sym = new SymbolTable(SYM);
const rom = new Rom(ROM);

/** Every checkpoint sitting on `wantMap`, newest-first is irrelevant here — we
 *  want the whole set for section D and one loaded model for sections A/B. */
function checkpointsOn(wantMap: number): { emu: Emulator; x: number; y: number; file: string }[] {
  const out: { emu: Emulator; x: number; y: number; file: string }[] = [];
  for (const f of readdirSync(CKPTS).filter(f => f.endsWith(".state.gz")).sort()) {
    const emu = new Emulator(ROM);
    try { loadSnapshotFile(emu, `${CKPTS}/${f}`); } catch { continue; }
    const st = new StateReader(emu, sym).read();
    if (st.map === wantMap) out.push({ emu, x: st.x, y: st.y, file: f });
  }
  return out;
}

/** All connected components of walkable TERRAIN. Sprites are deliberately
 *  excluded: NPCs move, and a static rank table must not depend on where one
 *  happened to be standing. Section A checks that this choice is free here. */
function components(mm: MapModel, useSprites: boolean): Set<string>[] {
  const open = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < mm.gw && y < mm.gh && mm.grid[y][x] &&
    (!useSprites || !mm.sprites.some(s => s.x === x && s.y === y));
  const seen = new Set<string>();
  const comps: Set<string>[] = [];
  for (let y = 0; y < mm.gh; y++) for (let x = 0; x < mm.gw; x++) {
    const k0 = `${x},${y}`;
    if (!open(x, y) || seen.has(k0)) continue;
    const c = new Set<string>([k0]); const q: [number, number][] = [[x, y]];
    seen.add(k0);
    while (q.length) {
      const [cx, cy] = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`;
        if (!seen.has(k) && open(nx, ny)) { seen.add(k); c.add(k); q.push([nx, ny]); }
      }
    }
    comps.push(c);
  }
  return comps.sort((a, b) => b.size - a.size);
}

const b1 = checkpointsOn(60);
const b2 = checkpointsOn(61);

console.log("=== A. map60 is four pockets, and POCKET_MAPS names the right one ===");
if (!b1.length) {
  chk("a map60 checkpoint exists to build the model from", false, "none found");
} else {
  const mm = new MapModel(b1[0].emu, sym, rom); mm.build();
  console.log(`  using ${b1[0].file} — grid ${mm.gw}x${mm.gh}, ${mm.sprites.length} sprites, ${mm.warps.length} warps`);

  const terrain = components(mm, false);
  chk("map60 flood-fills into exactly FOUR components",
    terrain.length === 4, terrain.map(c => c.size).join("/"));
  chk("component sizes are 84/84/48/16",
    terrain.map(c => c.size).join("/") === "84/84/48/16", terrain.map(c => c.size).join("/"));

  // The pocket table must not be sensitive to NPCs. On map60 there are none, so
  // both fills must agree — if a future ROM or state puts a sprite here, this
  // fails loudly rather than letting the static table quietly go wrong.
  const spriteAware = components(mm, true);
  chk("sprite-aware fill gives the IDENTICAL decomposition (no NPC is load-bearing)",
    spriteAware.length === terrain.length &&
    spriteAware.every((c, i) => c.size === terrain[i].size),
    `${mm.sprites.length} sprites; ${spriteAware.map(c => c.size).join("/")}`);

  const exitComp = terrain.find(c => c.has("27,3"));
  chk("exactly one component contains the (27,3) exit",
    terrain.filter(c => c.has("27,3")).length === 1);

  // THE CENTRAL ASSERTION: the shipped table equals the measured pocket, tile
  // for tile, in both directions.
  const table = POCKET_MAPS[60].tiles;
  const measured = exitComp ?? new Set<string>();
  const missing = [...measured].filter(t => !table.has(t));
  const extra = [...table].filter(t => !measured.has(t));
  chk("POCKET_MAPS[60] equals the measured exit pocket exactly, tile for tile",
    missing.length === 0 && extra.length === 0 && table.size === measured.size,
    `table=${table.size} measured=${measured.size} missing=[${missing}] extra=[${extra}]`);

  console.log("\n=== B. the exit pocket is reachable ONLY from B2F ===");
  const inExit = (w: { x: number; y: number }) => measured.has(`${w.x},${w.y}`);
  const exitWarps = mm.warps.filter(inExit);
  chk("the exit pocket has exactly two warps",
    exitWarps.length === 2, exitWarps.map(w => `(${w.x},${w.y})->map${w.destMap}`).join(" "));
  const outside = exitWarps.find(w => w.destMap === 255);
  chk("one of them is (27,3) leading OUTSIDE",
    !!outside && outside.x === 27 && outside.y === 3, JSON.stringify(outside));
  const inward = exitWarps.find(w => w.destMap !== 255);
  chk("the ONLY other one is (23,3), and it leads to map61 (B2F), not to B1F or 1F",
    !!inward && inward.x === 23 && inward.y === 3 && inward.destMap === 61, JSON.stringify(inward));

  // The bijection. rabbit13 proved the (23,3)->(5,7) direction; this checks the
  // return trip too, so neither warp index can drift without failing here.
  if (b2.length && inward) {
    const mm61 = new MapModel(b2[0].emu, sym, rom); mm61.build();
    const target = mm61.warps[inward.destWarp];
    chk("map60 (23,3).destWarp resolves to map61 (5,7)",
      !!target && target.x === 5 && target.y === 7, JSON.stringify(target));
    const back = mm61.warps.find(w => w.x === 5 && w.y === 7);
    const backTile = back ? mm.warps[back.destWarp] : undefined;
    chk("and map61 (5,7) points back at map60 (23,3) — the pair is bijective",
      !!backTile && backTile.x === 23 && backTile.y === 3, JSON.stringify(backTile));
    chk("map61's warps ALL lead to map60 (B2F hangs off B1F and nothing else)",
      mm61.warps.length > 0 && mm61.warps.every(w => w.destMap === 60),
      mm61.warps.map(w => `(${w.x},${w.y})->${w.destMap}`).join(" "));
  } else {
    chk("a map61 checkpoint exists to verify the warp bijection", false, "none found");
  }

  // The ticket's premise, tested as a falsifiable claim rather than argued.
  for (const land of [[17, 11], [21, 17], [13, 27]] as const) {
    const comp = terrain.find(c => c.has(`${land[0]},${land[1]}`));
    chk(`the B2F landing tile (${land[0]},${land[1]}) CANNOT reach the exit — B2F is not optional`,
      !!comp && !comp.has("27,3"), `${comp?.size ?? 0}-tile pocket`);
  }
  chk("wq#534's premise 'B2F IS A DEAD END' is FALSE: no 1F ladder reaches (27,3)",
    terrain.filter(c => c.has("27,3")).every(c => !c.has("17,11") && !c.has("21,17") && !c.has("13,27")));
}

console.log("\n=== C. ranking (pure, no emulator) ===");
{
  const exitP = progressRank(60, 27, 3);
  const exitP2 = progressRank(60, 20, 2);      // the far corner of the same pocket
  const deadA = progressRank(60, 17, 11);
  const deadB = progressRank(60, 21, 17);
  const deadC = progressRank(60, 13, 27);
  const b2f = progressRank(61);
  const mm1 = progressRank(59);
  const east = progressRank(15, 30, 10);
  console.log(`   1F=${mm1} deadPockets=${deadA}/${deadB}/${deadC} B2F=${b2f} exitPocket=${exitP} Route4E=${east}`);

  chk("C1 the exit pocket outranks B2F — the trap this ticket exists to close",
    exitP > b2f, `${exitP} > ${b2f}`);
  chk("C2 every dead pocket ranks BELOW B2F (leaving B2F for a dead pocket is a real regression)",
    deadA < b2f && deadB < b2f && deadC < b2f, `${deadA}/${deadB}/${deadC} < ${b2f}`);
  chk("C3 the whole exit pocket ranks together, not just the exit tile",
    exitP === exitP2, `${exitP} === ${exitP2}`);
  chk("C4 Mt Moon 1F still ranks below every B1F pocket",
    mm1 < deadA && mm1 < exitP);
  chk("C5 Route 4 EAST still outranks the exit pocket — outside beats standing at (27,3)",
    east > exitP, `${east} > ${exitP}`);
  chk("C6 map60 with UNKNOWN coordinates resolves to the dead-pocket rank",
    progressRank(60) === deadA, "never claim progress that cannot be proved");
  chk("C7 rankLabel names the pockets apart",
    rankLabel(60, 27, 3) !== rankLabel(60, 17, 11),
    `${rankLabel(60, 27, 3)} | ${rankLabel(60, 17, 11)}`);
  chk("C8 unranked maps are untouched", progressRank(52) === -1 && progressRank(53) === -1);
  chk("C9 map15's split still works (POCKET_MAPS must not shadow SPLIT_MAPS)",
    progressRank(15, 30, 10) > progressRank(15, 11, 6));
  chk("C10 no map is in BOTH tables — the two mechanisms must never fight",
    !Object.keys(POCKET_MAPS).some(k => k in SPLIT_MAPS));
  chk("C11 map60 appears exactly twice in STORY_ORDER",
    STORY_ORDER.filter(m => m === 60).length === 2, STORY_ORDER.join(","));
}

console.log("\n=== D. selection behaviour ===");
interface Fix { map: number; x: number; y: number; age: number }
function fixture(files: Record<string, Fix>): string {
  const dir = mkdtempSync(`${tmpdir()}/wq534fx-`);
  for (const [stem, f] of Object.entries(files)) {
    writeFileSync(`${dir}/${stem}.state.gz`, "placeholder");
    writeFileSync(`${dir}/${stem}.json`, JSON.stringify({
      v: 2, kind: "map", map: f.map, x: f.x, y: f.y, badges: 1,
      events: 24, storyScore: 6, hpPct: 1, ppOk: true, money: 431, ts: 0,
    }));
    const t = 1_700_000_000 + f.age;
    utimesSync(`${dir}/${stem}.state.gz`, t, t);
  }
  return dir;
}
const newHist = () => `${mkdtempSync(`${tmpdir()}/wq534h-`)}/history.json`;
const pick = (dir: string) =>
  pickResume([dir], sym, ROM, { historyFile: newHist(), log: () => {} }).split("/").pop();

// D1 and D2 are SYNTHETIC and I am labelling them so. No checkpoint in the exit
// pocket has ever existed, so there is nothing real to grade this against.
{
  const dir = fixture({
    "b2f-fossil-room": { map: 61, x: 25, y: 11, age: 90 },
    "b1f-exit-pocket": { map: 60, x: 23, y: 3, age: 10 },
  });
  const got = pick(dir);
  chk("D1 [SYNTHETIC] the exit pocket beats the fossil room even though it is OLDER",
    got === "b1f-exit-pocket.state.gz", String(got));
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = fixture({
    "b2f-fossil-room": { map: 61, x: 25, y: 11, age: 10 },
    "b1f-dead-pocket": { map: 60, x: 17, y: 11, age: 90 },
  });
  const got = pick(dir);
  chk("D2 [SYNTHETIC] a dead pocket does NOT beat the fossil room even though it is NEWER",
    got === "b2f-fossil-room.state.gz", String(got));
  rmSync(dir, { recursive: true, force: true });
}

// D3 is REAL: every map60 checkpoint that actually exists, and where it ranks.
{
  console.log(`   REAL map60 checkpoints on disk: ${b1.length}`);
  let inPocket = 0;
  for (const s of b1) {
    const p = readProgress(`${CKPTS}/${s.file}`, sym, ROM);
    if (POCKET_MAPS[60].tiles.has(`${s.x},${s.y}`)) inPocket++;
    console.log(`     ${s.file} @(${s.x},${s.y}) rank=${p.rank} ${rankLabel(p.map, p.x, p.y)}`);
  }
  chk("D3 [REAL] every map60 checkpoint on disk ranks as a dead pocket, below B2F",
    b1.length > 0 && b1.every(s => progressRank(60, s.x, s.y) < progressRank(61)),
    `${b1.length} checkpoints`);
  console.log(`   REALITY CHECK, reported whichever way it falls: ${inPocket} of ${b1.length} ` +
    `map60 checkpoints are in the exit pocket. Zero means D1/D2 above are the ONLY ` +
    `evidence for the exit-pocket rank, and they are synthetic.`);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
