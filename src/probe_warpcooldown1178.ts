// wq#1178 acceptance (roadmap item 7): directed warp-edge ledger + time-boxed
// warp cooldown. The live stall this fixes (lpp-pstack: Route 25, 407h /
// 8110 turns, 60% of turns reading `enter_warp: refused - this is the door
// you just arrived through`) never reaches assess() in oscillation.ts at
// all -- the existing zero-step refusal (wq#674/wq#1086) never returns
// "warped", so nothing ever gets recorded as an arrival. This probe proves
// the property the whole ticket hangs on, same shape as probe_ledger1181:
// the cooldown catches the re-entry, generalizes past the zero-step case
// (survives a few steps and a few turns), a DIFFERENT exit is left open,
// and -- per the wq#517 lesson this file already learned once -- the
// cooldown ALWAYS expires.
//
// TEST ISOLATION IS LOAD-BEARING (same lesson as probe_ledger1181). oscillation
// persists to runtime/warp_edges.json under process.cwd(), which in production
// is the LIVE deployment. edgeHistoryFile() resolves the env override at
// CALL time (not construction time -- it's a plain function here, not a
// class), so setting the env var before calling it is enough.
const TAG = `${process.pid}-${Date.now()}`;
process.env.LPP_WARP_EDGE_HISTORY = `/tmp/warpedges1178-${TAG}.json`;

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import {
  WarpEdge, WARP_COOLDOWN_TURNS, recordEdge, warpCooldown,
  edgeHistoryFile, loadEdges, saveEdges,
} from "./oscillation";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

function mkEdge(over: Partial<WarpEdge>): WarpEdge {
  return { fromMap: 36, fromIdx: 0, fromX: 5, fromY: 5,
           toMap: 88, toIdx: 3, toX: 7, toY: 7, turn: 0, ...over };
}

function main() {
  // A. No edges at all: never on cooldown.
  chk("A1 empty ledger never trips cooldown",
      !warpCooldown([], 88, 3, 100).onCooldown);

  // B. The core property: arrive at map88 through door 3 at turn 10, then
  // immediately propose firing door 3 again -- refused.
  {
    const e = mkEdge({ toMap: 88, toIdx: 3, turn: 10 });
    const edges = recordEdge([], e);
    const v = warpCooldown(edges, 88, 3, 11);
    chk("B1 the door just arrived through is on cooldown", v.onCooldown);
    chk("B2 turnsLeft counts down from the full window",
        v.turnsLeft === WARP_COOLDOWN_TURNS - 1, `got ${v.turnsLeft}`);
    chk("B3 via names the edge that caused the cooldown", v.via?.fromMap === 36);
  }

  // C. A DIFFERENT exit on the same map is NOT on cooldown -- "a different
  // exit is chosen" requires the OTHER doors to stay open.
  {
    const e = mkEdge({ toMap: 88, toIdx: 3, turn: 10 });
    const edges = recordEdge([], e);
    chk("C1 a different warp index on the same map is untouched",
        !warpCooldown(edges, 88, 5, 11).onCooldown);
    chk("C2 the same index on a DIFFERENT map is untouched",
        !warpCooldown(edges, 3, 3, 11).onCooldown);
  }

  // D. Cooldowns MUST expire (wq#517 lesson) -- generalizes past the
  // zero-step case: still refused a few turns later, then open once the
  // window has fully elapsed.
  {
    const e = mkEdge({ toMap: 88, toIdx: 3, turn: 10 });
    const edges = recordEdge([], e);
    chk("D1 still on cooldown after a few turns (not just zero-step)",
        warpCooldown(edges, 88, 3, 10 + WARP_COOLDOWN_TURNS - 1).onCooldown);
    chk("D2 cooldown has fully lifted once the window elapses",
        !warpCooldown(edges, 88, 3, 10 + WARP_COOLDOWN_TURNS).onCooldown);
  }

  // E. Two-warp oscillation: A->B recorded, cooldown expires, B->A fires
  // (return trip), and the SAME rule now closes the door back on A without
  // any new logic -- arriving through a door and firing it again is
  // symmetric regardless of which "side" of the loop you are on.
  {
    let edges: WarpEdge[] = [];
    edges = recordEdge(edges, mkEdge({ fromMap: 3, fromIdx: 0, toMap: 88, toIdx: 3, turn: 1 }));
    // cooldown on (88,3) expires by turn 1+WARP_COOLDOWN_TURNS
    const backTurn = 1 + WARP_COOLDOWN_TURNS;
    chk("E1 cooldown lifted before the return trip",
        !warpCooldown(edges, 88, 3, backTurn).onCooldown);
    edges = recordEdge(edges, mkEdge({ fromMap: 88, fromIdx: 3, toMap: 3, toIdx: 0, turn: backTurn }));
    chk("E2 firing the door you just arrived back through (idx0 on map3) is now on cooldown",
        warpCooldown(edges, 3, 0, backTurn + 1).onCooldown);
  }

  // F. recordEdge caps the ring buffer.
  {
    let edges: WarpEdge[] = [];
    for (let i = 0; i < 80; i++) edges = recordEdge(edges, mkEdge({ turn: i, toIdx: i }));
    chk("F1 edge list capped at 64", edges.length === 64, `got ${edges.length}`);
    chk("F2 oldest entries are dropped, newest kept", edges[edges.length - 1].toIdx === 79);
  }

  // G. Persistence: fail-soft round trip through a real file, isolated by
  // the env override above.
  {
    const file = edgeHistoryFile();
    if (existsSync(file)) unlinkSync(file);
    chk("G1 loadEdges on a missing file returns empty, not throw",
        loadEdges(file).length === 0);
    const edges = recordEdge([], mkEdge({ turn: 5 }));
    saveEdges(file, edges);
    const back = loadEdges(file);
    chk("G2 round-trips through disk", back.length === 1 && back[0].toMap === 88);
    writeFileSync(file, "not json{{{");
    chk("G3 a corrupt file fails soft to empty, never throws", loadEdges(file).length === 0);
    unlinkSync(file);
  }

  // H. The wiring must not drift back out of agent.ts, where nothing tests
  // it (same convention as probe_ledger1181's H13-15).
  {
    const agentSrc = readFileSync("src/agent.ts", "utf8");
    chk("H1 enter_warp checks the persisted cooldown before firing",
        /this\.warpOnCooldown\(fromMap, Number\(args\[0\]\)\)/.test(agentSrc));
    chk("H2 a successful enter_warp records the traversal",
        /this\.recordWarpTraversal\(fromMap, Number\(args\[0\]\), w\)/.test(agentSrc));
    chk("H3 the refusal names a concrete alternative exit, not just prose",
        /Try enter_warp\(\$\{alt\.i\}\)/.test(agentSrc));
    chk("H4 the WARPS line is annotated with cooldown state",
        /warpCooldownAnnotation/.test(agentSrc));
  }

  console.log(`\nprobe_warpcooldown1178: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
