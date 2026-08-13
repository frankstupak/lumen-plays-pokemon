// wq#487 probe: full truth table for the TRANSIT policy (src/transit.ts).
// Pure logic — no emulator, no ROM — so it runs in a second and can be re-run
// after any edit:  npx tsx src/probe_transit.ts
import { decideBattle, decideOverworld, TransitTracker, repelAdvice,
         TransitGoal, BattleCtx, TRANSIT_RESUME_CAP } from "./transit";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const goal = (over: Partial<TransitGoal> = {}): TransitGoal =>
  ({ kind: "goto", map: 59, x: 17, y: 11, attempts: 0, fleeFails: 0, ...over });
const bc = (over: Partial<BattleCtx> = {}): BattleCtx =>
  ({ wild: true, hpFrac: 1, hasUsableMove: true, wanted: false, grind: false, ...over });

console.log("--- decideBattle ---");
ok("no goal -> brain", decideBattle(null, bc()).action === "brain");
ok("wild + goal -> flee", decideBattle(goal(), bc()).action === "flee");
ok("trainer -> brain", decideBattle(goal(), bc({ wild: false })).action === "brain");
ok("HP at floor -> brain", decideBattle(goal(), bc({ hpFrac: 0.25 })).action === "brain");
ok("HP just above floor -> flee", decideBattle(goal(), bc({ hpFrac: 0.26 })).action === "flee");
ok("catch target -> brain", decideBattle(goal(), bc({ wanted: true })).action === "brain");
ok("xp grind -> brain", decideBattle(goal(), bc({ grind: true })).action === "brain");
ok("1 flee fail -> still flee", decideBattle(goal({ fleeFails: 1 }), bc()).action === "flee");
ok("2 flee fails -> fight", decideBattle(goal({ fleeFails: 2 }), bc()).action === "fight");
ok("2 fails + no PP -> brain", decideBattle(goal({ fleeFails: 2 }), bc({ hasUsableMove: false })).action === "brain");
ok("HP gate outranks flee-fail fight",
   decideBattle(goal({ fleeFails: 3 }), bc({ hpFrac: 0.1 })).action === "brain");

console.log("--- decideOverworld ---");
ok("no goal -> brain", decideOverworld(null, { map: 59, x: 5, y: 21 }).action === "brain");
ok("same map, away from target -> resume",
   decideOverworld(goal(), { map: 59, x: 5, y: 21 }).action === "resume");
ok("map changed -> brain", decideOverworld(goal(), { map: 60, x: 5, y: 21 }).action === "brain");
ok("at target -> brain", decideOverworld(goal(), { map: 59, x: 17, y: 11 }).action === "brain");
ok("cap reached -> brain",
   decideOverworld(goal({ attempts: TRANSIT_RESUME_CAP }), { map: 59, x: 5, y: 21 }).action === "brain");
ok("cap-1 -> resume",
   decideOverworld(goal({ attempts: TRANSIT_RESUME_CAP - 1 }), { map: 59, x: 5, y: 21 }).action === "resume");

console.log("--- TransitTracker lifecycle ---");
{
  const t = new TransitTracker();
  ok("idle: no goal", !t.active());
  t.onGoto(17, 11, "arrived", 59);
  ok("arrived without a goal stays idle", !t.active());
  t.onGoto(17, 11, "battle", 59);
  ok("goto interrupted -> goal owned", t.active() && t.goal!.x === 17 && t.goal!.y === 11);
  t.noteFlee("failed");
  t.noteFlee("trapped");
  ok("two failed flees -> fight", t.battleStep(bc()).action === "fight");
  t.noteFlee("fled");
  ok("successful flee resets the fail counter", t.goal!.fleeFails === 0);
  ok("post-flee overworld -> resume", t.overworldStep({ map: 59, x: 5, y: 21 }).action === "resume");
  ok("resume counted", t.goal!.attempts === 1 && t.stats.resumes === 1);
  t.onGoto(17, 11, "battle", 59);
  ok("re-interrupted goto keeps the attempt count", t.goal!.attempts === 1);
  t.onGoto(17, 11, "arrived", 59);
  ok("arrival retires the goal", !t.active() && t.stats.arrivals === 1);
  ok("no handback line on a clean journey", t.advice() === null);
}
{
  const t = new TransitTracker();
  t.onGoto(17, 11, "battle", 59);
  for (let i = 0; i < TRANSIT_RESUME_CAP; i++) t.overworldStep({ map: 59, x: 5, y: 21 });
  const d = t.overworldStep({ map: 59, x: 5, y: 21 });
  ok("cap hands back to the brain", d.action === "brain" && !t.active());
  ok("cap emits a handback line", (t.advice() ?? "").includes("resumed 5 times"));
  ok("handback names a different-target action", (t.advice() ?? "").includes("enter_warp"));
}
{
  const t = new TransitTracker();
  t.onGoto(17, 11, "battle", 59);
  const d = t.overworldStep({ map: 60, x: 3, y: 3 });
  ok("warping away retires the goal silently", d.action === "brain" && !t.active() && t.advice() === null);
}
{
  const t = new TransitTracker();
  t.onGoto(17, 11, "stuck", 59);
  ok("a stuck goto is NOT owned by transit", !t.active());
}

console.log("--- warp goals (enter_warp is transit too) ---");
{
  const W = { x: 14, y: 24, destMap: 60 };
  const t = new TransitTracker();
  t.onWarp(W, "battle", 59);
  ok("interrupted warp -> goal owned", t.active() && t.goal!.kind === "warp" && t.goal!.destMap === 60);
  ok("wild encounter on a warp goal -> flee", t.battleStep(bc()).action === "flee");
  ok("standing ON the warp tile is NOT arrival",
     t.overworldStep({ map: 59, x: 14, y: 24 }).action === "resume");
  t.onWarp(W, "warped", 60);
  ok("warped retires the goal", !t.active() && t.stats.arrivals === 1);
}
{
  const t = new TransitTracker();
  t.onWarp({ x: 14, y: 24, destMap: 60 }, "stuck", 59);
  ok("a stuck warp is NOT owned by transit", !t.active());
}
{
  // a goto goal standing on its target IS arrival (contrast with the warp case)
  const t = new TransitTracker();
  t.onGoto(17, 11, "battle", 59);
  ok("goto goal at its target -> hand back",
     t.overworldStep({ map: 59, x: 17, y: 11 }).action === "brain" && !t.active());
}

console.log("--- repelAdvice ---");
const CAVES = [59, 60, 61];
ok("repel in bag, in a cave, none active -> advise", repelAdvice(59, 2, 0, CAVES) !== null);
ok("no repel -> silent", repelAdvice(59, 0, 0, CAVES) === null);
ok("repel already running -> silent", repelAdvice(59, 2, 47, CAVES) === null);
ok("not a cave map -> silent", repelAdvice(3, 2, 0, CAVES) === null);
ok("advice names the tool", (repelAdvice(59, 1, 0, CAVES) ?? "").includes("use_item(repel)"));
ok("advice states ROM-verified 100 steps", (repelAdvice(59, 1, 0, CAVES) ?? "").includes("100 steps"));

console.log(`\nprobe_transit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
