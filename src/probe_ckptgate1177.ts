// wq#1177 — the checkpoint WRITE gate (LPP plan item 2).
//
// Before this, Agent.maybeCheckpoint refused mid-battle / mid-dialog / mid-text
// and (wq#699) mid-map-load. Two conditions got through:
//   - wJoyIgnore != 0 / script control / mid-step (Sync.busy()): a script owns
//     the player, so the coordinates the sidecar stamps are already stale.
//   - standing ON a warp tile: a real position that is not KEPT — the next step
//     re-fires the warp (wq#1066's Cerulean bounce, 180h frozen).
//
// The gate is pure, so this probe needs no emulator, ROM or corpus.
import { checkpointGate, GateInputs, CKPT_WARP_STARVE_TURNS } from "./checkpoint_gate";

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => {
  c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${l}${d ? ` :: ${d}` : ""}`);
};

console.log("== probe_ckptgate1177 (checkpoint write gate) ==");

/** A quiet, settled, off-warp periodic checkpoint: the case that must write. */
const ok = (over: Partial<GateInputs> = {}): GateInputs => ({
  cls: "auto", inBattle: false, dialogOpen: false, textUp: false,
  engineBusy: false, loadPending: false, onWarp: false, turnsSinceWrite: 10, ...over,
});

// ── A. the settled case still writes ────────────────────────────────────
chk("A1 a settled off-warp state writes", checkpointGate(ok()).write);
chk("A2 a settled milestone writes", checkpointGate(ok({ cls: "milestone" })).write);

// ── B. torn state: refused for EVERY class, with a reason ───────────────
for (const [field, reason] of [
  ["inBattle", "in_battle"], ["dialogOpen", "dialog_open"], ["textUp", "text_up"],
  ["engineBusy", "engine_busy"], ["loadPending", "map_load_pending"],
] as const) {
  for (const cls of ["auto", "milestone"] as const) {
    const v = checkpointGate(ok({ [field]: true, cls } as Partial<GateInputs>));
    chk(`B ${field} refuses a ${cls} checkpoint`, !v.write && v.reason === reason,
        `${v.write} ${v.reason}`);
  }
}

// ── C. the two conditions this ticket adds ──────────────────────────────
chk("C1 wJoyIgnore/script control (engineBusy) is refused — was written before",
    checkpointGate(ok({ engineBusy: true })).reason === "engine_busy");
chk("C2 a warp-tile auto checkpoint is refused — wq#1066's trap at the source",
    checkpointGate(ok({ onWarp: true })).reason === "on_warp_tile");
chk("C3 the map-load reason string is unchanged (event consumers grep it)",
    checkpointGate(ok({ loadPending: true })).reason === "map_load_pending");

// ── D. the warp gate cannot wedge (wq#517's lesson) ─────────────────────
chk("D1 a milestone is never blocked by a warp tile — a badge does not come round again",
    checkpointGate(ok({ onWarp: true, cls: "milestone" })).write);
chk("D2 the warp refusal expires: starvation beats position quality",
    checkpointGate(ok({ onWarp: true, turnsSinceWrite: CKPT_WARP_STARVE_TURNS })).write);
chk("D3 ...but not one turn early",
    !checkpointGate(ok({ onWarp: true, turnsSinceWrite: CKPT_WARP_STARVE_TURNS - 1 })).write);
chk("D4 starvation does NOT open the gate on a torn state",
    !checkpointGate(ok({ loadPending: true, turnsSinceWrite: 10_000 })).write);
chk("D5 the escape is bounded, not permanent", CKPT_WARP_STARVE_TURNS > 0 &&
    CKPT_WARP_STARVE_TURNS <= 100, String(CKPT_WARP_STARVE_TURNS));

// ── E. torn-state reasons outrank the warp reason ───────────────────────
chk("E1 in battle ON a warp tile reports the battle, not the tile",
    checkpointGate(ok({ inBattle: true, onWarp: true })).reason === "in_battle");

console.log(`\nRESULT pass=${pass} fail=${fail} skip=0`);
process.exit(fail ? 1 : 0);
