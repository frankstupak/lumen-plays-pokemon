// wq#1662 probe — the walk loop names its obstacle instead of discarding it.
//
// THE DEFECT: nav.ts's goto() learned a blocked cell into `learnedBlocked` (a
// bare coordinate set) and threw away everything it briefly knew about WHY
// the step failed. reach.ts's stuckHint then had no choice but to guess
// "something interrupted it (wild encounters or an NPC in the way)" for
// every "reachable but did not finish" case — measured live as a 1318x
// verbatim goto(19,10) on Route 24/map35 that a wandering sprite, not an
// encounter, was blocking (LPP_BEHAVIORAL_ANALYSIS.md M4; only 15 in-battle
// reads across the whole window ruled out encounters).
//
// GREEN CONTRACT (this branch): classifyBlockedCell names a sprite at the
// blocked cell (by pic id) distinctly from bare terrain, and stuckHint's
// message differs by obstacle kind instead of always emitting the old guess.
// No emulator needed — both are pure functions over plain data.
import { classifyBlockedCell, Obstacle } from "./nav";
import { stuckHint } from "./reach";
import { MapModel } from "./map";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// ---- 1. classifyBlockedCell names the sprite, or says terrain ----
const withSprite = { sprites: [{ x: 19, y: 10, y2: 0, pic: 5 } as any] };
const spriteOb = classifyBlockedCell(withSprite, 19, 10);
ok("A1 sprite cell classified as 'sprite' with its pic id",
   spriteOb.kind === "sprite" && spriteOb.spritePic === 5, JSON.stringify(spriteOb));

const empty = { sprites: [] as { x: number; y: number; pic: number }[] };
const terrainOb = classifyBlockedCell(empty, 4, 4);
ok("A2 empty cell classified as 'terrain'", terrainOb.kind === "terrain", JSON.stringify(terrainOb));

// ---- 2. stuckHint's message differs by obstacle kind, and by "no obstacle" ----
// A minimal fixture: player and target both open, one step apart, so pathTo()
// reports reachable and stuckHint takes the "IS reachable" branch that used
// to hard-code the encounter/NPC guess for every case alike.
// MapModel's real constructor wants a live Emulator/SymbolTable/Rom, which
// this pure probe has no business touching — build the instance via its
// prototype instead, so pathTo()/astar() run the SAME passable()/isWarp()
// code a live map does, over a hand-set 5x5 open grid.
const map: MapModel = Object.create(MapModel.prototype);
map.gw = 5; map.gh = 5;
map.grid = Array.from({ length: 5 }, () => new Array(5).fill(true));
map.tileIds = Array.from({ length: 5 }, () => new Array(5).fill(0));
map.landPairs = [];
map.ledges = [];
map.sprites = [];
map.warps = [];

const px = 1, py = 1, tx = 1, ty = 2;
const spriteBlocked: Obstacle = { x: tx, y: ty, kind: "sprite", spritePic: 7 };
const terrainBlocked: Obstacle = { x: tx, y: ty, kind: "terrain" };
const noPathBlocked: Obstacle = { x: tx, y: ty, kind: "no_path" };

const hSprite = stuckHint(map, px, py, tx, ty, [], spriteBlocked);
const hTerrain = stuckHint(map, px, py, tx, ty, [], terrainBlocked);
const hNoPath = stuckHint(map, px, py, tx, ty, [], noPathBlocked);
const hUnknown = stuckHint(map, px, py, tx, ty, [], null);

ok("B1 sprite obstacle names the sprite's pic id",
   hSprite.includes("sprite 7") && hSprite.includes("moved"), hSprite);
ok("B2 terrain obstacle names terrain, not the old guess",
   hTerrain.includes("terrain") && !hTerrain.includes("wild encounters"), hTerrain);
ok("B3 no_path obstacle names the planning failure",
   hNoPath.includes("no route"), hNoPath);
ok("B4 no obstacle falls back to the old honest guess (backcompat)",
   hUnknown.includes("wild encounters or an NPC in the way"), hUnknown);
ok("B5 the three obstacle kinds produce three distinct messages",
   new Set([hSprite, hTerrain, hNoPath, hUnknown]).size === 4, "");

console.log(`\nprobe_walkinterrupt1662: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
