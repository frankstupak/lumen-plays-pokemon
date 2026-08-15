// wq#621 — vision verdict valve: red/green against the ticket's own spec.
// Pure — no ROM, no checkpoints, no emulator (CI-safe, scripts/probes-pure.sh).
//
// THE CLASS UNDER TEST: an escalation-only VLM consult that must (a) fire
// exactly at the Nth consecutive stuck_dump at an unchanged position, never
// before, (b) refuse call N+1 within a rolling hour and say so, (c) stay
// fully silent when disabled, and (d) never let its own text override RAM —
// enforced structurally here by construction: VisionValve never touches game
// state, and consultVision's caller (agent.ts) writes its result only into
// notepad GUIDANCE, which this probe does not exercise (that wiring is
// asserted by inspection below, since it needs a live Agent+ROM to drive).
import { VisionValve } from "./vision";
import { readFileSync } from "fs";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}

// deterministic clock so the 1h window is exercised without wall-clock sleeps
let clock = 0;
const now = () => clock;

console.log("-- trigger: fires at N, not N-1 --");
{
  const v = new VisionValve(3, 4, now);
  const pos = { map: 3, x: 5, y: 5 };
  ok("dump 1/3: no trigger", v.recordStuck(pos) === false);
  ok("dump 2/3: no trigger", v.recordStuck(pos) === false);
  ok("dump 3/3: TRIGGERS", v.recordStuck(pos) === true);
  ok("dump 4 (still same pos, past N): does not re-trigger the same streak",
     v.recordStuck(pos) === false);
}

console.log("\n-- position change resets the streak --");
{
  const v = new VisionValve(3, 4, now);
  const a = { map: 3, x: 5, y: 5 };
  const b = { map: 3, x: 6, y: 5 };
  ok("a 1/3", v.recordStuck(a) === false);
  ok("a 2/3", v.recordStuck(a) === false);
  ok("move to b: streak resets, no trigger", v.recordStuck(b) === false);
  ok("b 2/3: still no trigger (only 2 consecutive at b)", v.recordStuck(b) === false);
  ok("b 3/3: NOW triggers", v.recordStuck(b) === true);
}

console.log("\n-- re-triggering: a fresh streak at the SAME position after an interruption fires again --");
{
  const v = new VisionValve(3, 4, now);
  const a = { map: 3, x: 5, y: 5 };
  const elsewhere = { map: 3, x: 9, y: 9 };
  ok("first streak triggers at 3", v.recordStuck(a) === false && v.recordStuck(a) === false && v.recordStuck(a) === true);
  v.recordStuck(elsewhere); // interrupt
  ok("back at a, 1/3", v.recordStuck(a) === false);
  ok("back at a, 2/3", v.recordStuck(a) === false);
  ok("back at a, 3/3: triggers again (new streak)", v.recordStuck(a) === true);
}

console.log("\n-- budget: cap refuses call N+1 within the hour, logged by the caller --");
{
  const v = new VisionValve(3, 4, now);
  ok("call 1 allowed", v.tryConsumeBudget() === true);
  ok("call 2 allowed", v.tryConsumeBudget() === true);
  ok("call 3 allowed", v.tryConsumeBudget() === true);
  ok("call 4 allowed (cap=4)", v.tryConsumeBudget() === true);
  ok("call 5 REFUSED — cap reached", v.tryConsumeBudget() === false);
  clock += 30 * 60_000; // +30 min, still inside the window
  ok("30 min later, still refused (window has not rolled)", v.tryConsumeBudget() === false);
  clock += 31 * 60_000; // +61 min from call 1
  ok("61 min after call 1, a slot has rolled off — allowed again", v.tryConsumeBudget() === true);
}

console.log("\n-- env-tunable: stuckN/maxPerHour come from constructor args (config.ts wires env vars in) --");
{
  const v = new VisionValve(1, 1, now);
  ok("stuckN=1: triggers on the very first dump", v.recordStuck({ map: 5, x: 1, y: 1 }) === true);
  const v2 = new VisionValve(3, 0, now);
  ok("maxPerHour=0: valve disabled at the budget layer refuses immediately", v2.tryConsumeBudget() === false);
}

console.log("\n-- disabled (LPP_VISION_ENABLE=0) means zero calls under any condition --");
{
  // agent.ts gates on CFG.visionValve.enabled BEFORE touching the valve at
  // all when disabled — asserted here by source inspection, since exercising
  // it live needs a running Agent+ROM (probe_scope606-class fixture).
  const src = readFileSync(`${__dirname}/agent.ts`, "utf8");
  const m = src.match(/private async maybeConsultVision\([\s\S]*?\n {2}\}\n/);
  ok("maybeConsultVision's FIRST statement gates on CFG.visionValve.enabled",
     !!m && /\{\s*\n\s*if \(!CFG\.visionValve\.enabled\) return;/.test(m[0]),
     m ? m[0].slice(0, 160) : "method not found");
}

console.log("\n-- wiring: vision output lands in notepad GUIDANCE, never overrides RAM --");
{
  const src = readFileSync(`${__dirname}/agent.ts`, "utf8");
  ok("consultVision's result is written via pad.setGuidance (GUIDANCE channel, not notes/RAM)",
     src.includes('this.pad.setGuidance("VISION",'));
  ok("the guidance text is explicitly marked hint-only",
     src.includes("hint only, does not override RAM/grid"));
  const visionSrc = readFileSync(`${__dirname}/vision.ts`, "utf8");
  ok("VisionValve itself touches no emulator/RAM/notepad state (pure trigger+budget only)",
     !/\bemu\.|\bmem\(\)|Notepad|readFileSync/.test(visionSrc.split("export async function consultVision")[0]));
}

console.log("\n-- token accounting: vision calls route through Brain.complete, which already tags think_chunk --");
{
  const brainSrc = readFileSync(`${__dirname}/brain.ts`, "utf8");
  ok("Brain.complete emits think_chunk with {model, tokens} on every call (vision included, no separate wiring needed)",
     brainSrc.includes('this.bus.emit("think_chunk", { model, tokens: usage })'));
  const visionSrc = readFileSync(`${__dirname}/vision.ts`, "utf8");
  ok("consultVision calls brain.complete with CFG.profiles.vision (model=lumen-vision)",
     /brain\.complete\(messages, CFG\.profiles\.vision\)/.test(visionSrc));
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
