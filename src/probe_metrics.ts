// Metrics unit test: synthetic event stream -> assert derived counters + JSON.
import { Metrics } from "./metrics";
import { EventBus } from "./events";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const dir = mkdtempSync(`${tmpdir()}/metrics-`);
const bus = new EventBus(dir, "unit");
const m = new Metrics(bus, "unit", dir);

// synthetic run: boot -> wild battle -> catch fail -> catch success -> heal -> buy -> badge
bus.emit("boot", { mode: "live-agent", resumedFrom: "auto-x-map51.state.gz" } as any);
bus.emit("state_read", { inBattle: 0, map: 51, badgeCount: 0, party: [{ hp: 20 }] } as any);
bus.emit("think_chunk", { turn: 1, tokens: { prompt: 1000, completion: 200, model: "x" } } as any);
bus.emit("state_read", { inBattle: 1, map: 51, badgeCount: 0, party: [{ hp: 20 }] } as any);   // wild battle 1
bus.emit("tool_call", { tool: "catch", args: { ball: "poke_ball", caught: false } } as any);
bus.emit("state_read", { inBattle: 0, map: 51, badgeCount: 0, party: [{ hp: 20 }] } as any);
bus.emit("state_read", { inBattle: 1, map: 51, badgeCount: 0, party: [{ hp: 20 }] } as any);   // wild battle 2
bus.emit("tool_call", { tool: "catch", args: { ball: "poke_ball", caught: true } } as any);
bus.emit("think_chunk", { turn: 5, tokens: { prompt: 2000, completion: 300, model: "x" } } as any);
bus.emit("state_read", { inBattle: 2, map: 54, badgeCount: 0, party: [{ hp: 5 }] } as any);    // trainer battle
// wq#547: the whiteout fixture used to be a single all-fainted state_read.
// That shape PROVED THE ARITHMETIC AND NOTHING ELSE — production never emits
// it, because the all-fainted window closes inside one poll interval and was
// caught in ZERO of the 1381 party-bearing state_reads on disk. The detector
// now counts a blackout from its DURABLE CONSEQUENCES, so the fixture is the
// consequence shape: purse halved, warped to a Center (58 = Pewter), party
// back at full HP. Money must be present on BOTH reads for the transition to
// exist, so the preceding trainer-battle read above carries it too.
bus.emit("state_read", { inBattle: 0, map: 54, badgeCount: 0, money: 400, party: [{ hp: 5, maxHp: 76 }] } as any);
bus.emit("state_read", { inBattle: 0, map: 58, badgeCount: 0, money: 200, party: [{ hp: 76, maxHp: 76 }] } as any);  // BLACKOUT
bus.emit("tool_call", { tool: "heal_at_center", args: { map: 41, ok: true } } as any);
bus.emit("tool_call", { tool: "buy_item", args: { item: "poke_ball", qty: 3, spent: 600 } } as any);
bus.emit("tool_call", { tool: "use_item", args: { item: "potion", used: true } } as any);
// wq#522: this fixture used to be `{ file: "x", events: 42 }` — a payload that
// production NEVER sends. The real writeCheckpoint spreads a sidecar carrying
// its own `kind`, which clobbered the envelope and made maxEventCount read 0
// in every run summary ever written. The test passed throughout because the
// fixture omitted the one field that caused the bug. It now carries the shape
// production actually emits, including a `kind` that must NOT win.
bus.emit("checkpoint", { file: "x", kind: "periodic", events: 42 } as any);
// wq#424 brain/internal split: brain-chosen tools count under toolCalls (junk
// bucketed to _invalid); internal-layer emissions land in autoCalls.
bus.emit("tool_call", { tool: "goto", args: ["10", "5"], src: "brain" } as any);
bus.emit("tool_call", { tool: "goto", args: ["11", "5"], src: "brain" } as any);
bus.emit("tool_call", { tool: "map68", args: [], src: "brain" } as any);         // ACT parse junk
bus.emit("tool_call", { tool: "earlier", args: [], src: "brain" } as any);       // ACT parse junk
bus.emit("tool_call", { tool: "goto", args: { tx: 10, ty: 5 } } as any);         // nav internal
bus.emit("tool_call", { tool: "enterWarp", push: "0", result: "warped" } as any);// nav internal
// wq#426: AUTO-turn + truncation counters
bus.emit("turn_summary", { line: "T6 [map15 11,6] AUTO:enter_warp->255 => enter_warp->255 auto" } as any);
bus.emit("turn_summary", { line: "T7 [map15 12,6] goto(12,6) => arrived" } as any);
bus.emit("think_chunk", { model: "cerebras-oss-120b", truncated: true } as any);
bus.emit("state_read", { inBattle: 0, map: 54, badgeCount: 1, party: [{ hp: 30 }] } as any);   // BADGE -> flush badge1

const s = m.snapshot();
chk("battles counted", s.battlesEntered === 3 && s.battlesWild === 2 && s.battlesTrainer === 1, `entered=${s.battlesEntered} wild=${s.battlesWild} trn=${s.battlesTrainer}`);
chk("tokens summed", s.tokensPrompt === 3000 && s.tokensCompletion === 500, `p=${s.tokensPrompt} c=${s.tokensCompletion}`);
chk("turns tracked", s.turns === 5, `turns=${s.turns}`);
chk("catches", s.catchesAttempted === 2 && s.catchesSucceeded === 1, `att=${s.catchesAttempted} ok=${s.catchesSucceeded}`);
chk("whiteout edge-counted once", s.whiteouts === 1, `wo=${s.whiteouts}`);
chk("heal counted", s.healsAtCenter === 1, `h=${s.healsAtCenter}`);
chk("items bought/used", s.itemsBought === 3 && s.itemsUsed === 1, `b=${s.itemsBought} u=${s.itemsUsed}`);
chk("badge tracked", s.badges === 1, `badges=${s.badges}`);
chk("eventCount max", s.maxEventCount === 42, `ec=${s.maxEventCount}`);
chk("resumedFrom captured", s.resumedFrom === "auto-x-map51.state.gz", s.resumedFrom);
chk("brain tools counted", s.toolCalls["goto"] === 2, `goto=${s.toolCalls["goto"]}`);
chk("junk bucketed to _invalid", s.toolCalls["_invalid"] === 2 && !("map68" in s.toolCalls) && !("earlier" in s.toolCalls), `inv=${s.toolCalls["_invalid"]}`);
chk("internal emits -> autoCalls", s.autoCalls["goto"] === 1 && s.autoCalls["enterWarp"] === 1, `auto goto=${s.autoCalls["goto"]} warp=${s.autoCalls["enterWarp"]}`);
chk("layer emits (no src) not in toolCalls", !("catch" in s.toolCalls) && s.autoCalls["catch"] === 2, `auto catch=${s.autoCalls["catch"]}`);
chk("autoTurns counted", s.autoTurns === 1, `auto=${s.autoTurns}`);
chk("brainTruncations counted", s.brainTruncations === 1, `trunc=${s.brainTruncations}`);
// badge flush wrote the summary JSON
const f = `${dir}/run-summary-unit.json`;
chk("run-summary JSON written on badge", existsSync(f));
if (existsSync(f)) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  chk("derived tokensPerBadge", j.derived.tokensPerBadge === 3500, `tpb=${j.derived.tokensPerBadge}`);
  chk("derived whiteoutsPerBadge", j.derived.whiteoutsPerBadge === 1, `wpb=${j.derived.whiteoutsPerBadge}`);
  chk("derived catchRate", j.derived.catchRate === 0.5, `cr=${j.derived.catchRate}`);
  chk("derived reason=badge1", j.derived.reason === "badge1", j.derived.reason);
}
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
