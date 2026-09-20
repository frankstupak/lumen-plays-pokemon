# wq#1837 — verify-pass of wq#1828 (PR #121, ed74145): CONTRADICT (Step 2)

Verifier: claude-sonnet-5@high. Checked at HEAD af80c0b; the predicate and `start()` are unchanged since ed74145.

## Confirmed

- Step 1 `dominant_patch` (src/explore.ts:134-196) fires on STALL_WINDOW (patch map35 (5,23), share 0.567,
  patchNew 0) and is silent on PROGRESS_WINDOW. Sliding production-size (150) windows across the two merged fixtures
  (204 rows): fires at seq 26696..26715 while the strip dominates (share 0.57 -> 0.50), silent from 26716, including
  the window ending 26750 that contains the Route 25 stretch. Gap: probe A10 (probe_explore1731.ts:110) runs the
  silent case at windowTurns=60, not the production 150.
- Edge cases at production cfg: no throw on an empty window, missing `newTiles`, or NaN radius. The 50% boundary
  fires. A long backtrack line and a 4x4 room with 0 new tiles fire the older `no_new_ground`, not the new trigger.
- `probe_explore1731`: 105 PASS / 0 FAIL. `scripts/probes-pure.sh`: PROBES GREEN 21/21.
- The 363/363 -> 260/363 replay is not reproducible: runtime/progress.json has rolled (seq 28023..28534, agent on
  map3, max patch share 0.347, 0/363 stalled, correctly silent). Only the 204 fixture rows survive.

## Contradicted: Step 2 bans the wrong map

`ExplorationOverride.start()` (explore.ts:539-547) builds the exclusion from `v.tiles.filter(t => t.map === p.map)`,
where `p` is the map the player stands on when the tick fires. `assessStall` judges the whole window and never checks
that the player is inside the patch. The shuttle this ticket targets is exactly that case. The first window that
fires on the checked-in live data (seq 26696, last row of STALL_WINDOW) has the player on map36 (Route 25, x7 y4)
while the patch is on map35.

Driving the real `ExplorationOverride` + `ExclusionGate` over `rehydrate(STALL_WINDOW)` with `pos()` = last row:

```
live window last sample: map 36 x 7 y 4
exclusion.map 36 tiles total 10 on map35 (the strip): 0 on map36 (Route 25): 10
goto(35,4,24) refused while standing on 35? false
goto(36,x,y) refused on Route 25? true
```

Across the 20 firing windows in the merged fixtures, 19 have the player off the patch's map (all 20 off its cells).
The ban lands on Route 25, the progressing ground, and the strip stays open, so the walk back into map35 x=4..5 is
not refused. The escape planner also runs on map36 (`footprintHere`), walking the player off Route 25 rather than off
the strip. The comment above `excludeTiles` names this failure ("banning Route 25 because the agent paced Route 24")
but guards it only when `p.map` equals the patch map.

The PR's evidence missed it because `accept_explore1731` phase A and the `stripWorld` probes start the player on the
strip. wq#1839 (seq-keyed budget) and wq#1746 (escape verdict) left the map choice alone, and the wq#1746 re-entry
watch keys off `run.map`, so it inherits the wrong map.

Suggested fix (not done, verify only): for `dominant_patch`, take the exclusion map and footprint from `v.patch.map`
instead of `p.map`, and either defer the fire until `pos().map === patch.map` or escape toward it. Add a probe case
whose window ends on the excursion map.

Fixed after merge, for the record: v1 exclusion was turn-keyed and reset on restart; wq#1839 moved it to seq.

## Repro

Save as `repro.ts` at the repo root and run `npx tsx repro.ts`:

```ts
import { STALL_WINDOW, rehydrate } from "./src/fixture_stall1828";
import { ExplorationOverride } from "./src/explore";
import { ExclusionGate } from "./src/exclusion";
import { rmSync } from "fs";

const win = rehydrate(STALL_WINDOW);
const last = win[win.length - 1];
const g: any = { gw: 60, gh: 60, passableFrom: (_a: number, _b: number, tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < 60 && ty < 60,
  isGrass: () => false, isWarp: () => false, hops: () => [], build() {}, loadPending: () => false };
let pos = { map: last.map, x: last.x, y: last.y };
const exFile = "/tmp/verify1837-ex.json", log = "/tmp/verify1837-log.jsonl";
rmSync(exFile, { force: true }); rmSync(log, { force: true });
const gate = new ExclusionGate(exFile);
const cfg = { enabled: true, prompt: true, windowTurns: 150, minTiles: 5, stepsK: 30, expireFactor: 3, urgencyTurns: 60,
  catchParty: 3, clearance: 3, patchShare: 0.5, patchRadius: 5, patchNew: 0, excludeTurns: 60, verdictTurns: 0 } as any;
const move = async (dx: number, dy: number) => { pos = { ...pos, x: pos.x + dx, y: pos.y + dy }; return "moved"; };
const ov = new ExplorationOverride({ map: g, pos: () => ({ ...pos }), step: move, hop: move, samples: () => win,
  blocked: () => null, exclude: e => gate.set(e), logFile: log, cfg } as any);
(async () => {
  for (let t = 1; t <= 45; t++) await ov.tick(t);
  const e = gate.current()!;
  const onMap = (m: number) => e.tiles.filter(k => k.startsWith(`${m},`)).length;
  console.log("exclusion.map", e.map, "on map35 (strip):", onMap(35), "on map36 (Route 25):", onMap(36));
  console.log("goto(35,4,24) refused?", gate.refuse(e.fromSeq + 1, 35, 4, 24, "map35") !== null);
})();
```
