// wq#1563: probe for the post-K breakout rung's harness seam.
//
// The supervisor's L4 BREAKOUT directive is only worth writing if the harness
// reads it, so this probe drives the real loadSupervisorDirective — imported,
// not replicated. probe_navloop724.ts copied the loader's body into itself,
// which is a copy that can silently drift from the thing it claims to test;
// this one fails when agent.ts changes, which is the point of a probe.
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSupervisorDirective } from "./agent";

let failures = 0;
const ok = (label: string, pass: boolean, detail?: string) => {
  if (!pass) failures++;
  console.log(`${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const base = mkdtempSync(join(tmpdir(), "lpp-breakout-"));
mkdirSync(join(base, "runtime"), { recursive: true });
const write = (d: unknown) =>
  writeFileSync(join(base, "runtime", "supervisor_directive.json"), JSON.stringify(d));

try {
  // The directive lpp_stuck_intervene._breakout_directive actually emits.
  write({
    v: 1, mode: "FIGHT_LOSS_LOOP", location: 3, rung: "breakout", exhausted: true,
    action: "breakout_leave_map", summary: "leave the map",
    notepadPin: "PIN: SUPERVISOR (BREAKOUT, after 3/3): ... leave_edge ... enter_warp ...",
    gotoBan: [], staleMapGotoBan: 35, breakoutTargetMap: 36,
    budgetTurns: 120, issuedAtTurn: 400, expiresAtTurn: 520,
  });
  const d = loadSupervisorDirective(base);
  ok("A1 breakout directive loads", d !== null);
  ok("A2 staleMapGotoBan is read", d?.staleMapGotoBan === 35, `got ${d?.staleMapGotoBan}`);
  ok("A3 it is NOT turned into a warp ban", (d?.gotoBan ?? ["x"]).length === 0,
     `gotoBan=${JSON.stringify(d?.gotoBan)}`);

  // The mode gate on gotoBan must not reach staleMapGotoBan: the rung fires past
  // K on whatever mode was stalled, and FIGHT_LOSS_LOOP is not a ban mode. If
  // this regresses, the breakout is written every tick and honoured never.
  write({ mode: "FIGHT_LOSS_LOOP", gotoBan: [], staleMapGotoBan: 35, notepadPin: "" });
  ok("B1 honoured on a non-ban mode with no pin",
     loadSupervisorDirective(base)?.staleMapGotoBan === 35);

  // The old "nothing actionable" rule still holds for a genuinely empty one.
  write({ mode: "FIGHT_LOSS_LOOP", gotoBan: [], notepadPin: "" });
  ok("B2 an empty directive is still nothing", loadSupervisorDirective(base) === null);

  // The handoff rung carries no ban at all (kill-criterion 4): it must load for
  // its pin, and must impose nothing.
  write({ mode: "FIGHT_LOSS_LOOP", rung: "handoff", action: "handoff_operator",
          gotoBan: [], notepadPin: "PIN: SUPERVISOR (HANDOFF): ..." });
  const h = loadSupervisorDirective(base);
  ok("C1 handoff loads for its pin", !!h?.notepadPin);
  ok("C2 handoff imposes no map-local ban", h?.staleMapGotoBan === null,
     `got ${h?.staleMapGotoBan}`);

  // A malformed field must degrade to "no ban", never to a NaN map id that
  // would refuse goto on every map at once.
  write({ mode: "FIGHT_LOSS_LOOP", gotoBan: [], staleMapGotoBan: "35",
          notepadPin: "p" });
  ok("D1 a non-numeric ban is dropped", loadSupervisorDirective(base)?.staleMapGotoBan === null);
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "probe_breakout1563: PASS" : `probe_breakout1563: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
