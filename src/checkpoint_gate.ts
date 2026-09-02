// Checkpoint WRITE gate (wq#1177, LPP plan item 2).
//
// wq#699 repaired torn checkpoints at READ time (resume.ts settleMapLoad
// re-runs frames until the load the state was caught inside finishes). Gating
// the WRITE is cheaper and closes the class: a state serialized mid-load,
// mid-script, in battle or standing on a warp tile is not a resume target, and
// the ten seconds until the next periodic checkpoint cost nothing.
//
// The gate is a pure function so the policy can be probed without an emulator
// (probe_ckptgate1177); Agent supplies the RAM truth.

/** Torn-state reasons apply to every checkpoint; the warp-tile reason is a
 *  position-QUALITY judgement, so a milestone (badge / full heal — permanent
 *  progress that will not come round again) is allowed through it. */
export type CkptClass = "milestone" | "auto";

export interface GateInputs {
  cls: CkptClass;
  inBattle: boolean;      // wIsInBattle != 0 (battle.ts active())
  dialogOpen: boolean;
  textUp: boolean;        // wStatusFlags5 bit 6
  engineBusy: boolean;    // wJoyIgnore != 0 | script control | mid-step (Sync.busy())
  loadPending: boolean;   // MapModel.loadPending(): header != wCurMap's ROM header
  onWarp: boolean;        // standing ON a warp tile
  /** Turns since the last checkpoint actually landed — feeds the starvation
   *  escape below. */
  turnsSinceWrite: number;
}

/** wq#517's lesson, applied here: a gate that can never open is a wedge. A
 *  warp tile the agent stands on for a long stretch (a doorway it keeps
 *  re-entering is exactly the wq#1066 shape) would otherwise suppress EVERY
 *  checkpoint for the rest of the run, and a run with no checkpoints loses all
 *  of its progress on the next restart. After this many turns with nothing
 *  written, the warp-tile refusal expires; the sidecar still stamps
 *  onWarp=true, so resume.ts's wq#1066 ordering keeps demoting it. */
export const CKPT_WARP_STARVE_TURNS = 30;

export interface GateVerdict { write: boolean; reason?: string }

const WRITE: GateVerdict = { write: true };

export function checkpointGate(g: GateInputs): GateVerdict {
  // Torn state: the RAM does not describe one coherent position, so nothing
  // derived from it (map, coords, onWarp, leg, stateKey) is true.
  if (g.inBattle) return { write: false, reason: "in_battle" };
  if (g.dialogOpen) return { write: false, reason: "dialog_open" };
  if (g.textUp) return { write: false, reason: "text_up" };
  if (g.engineBusy) return { write: false, reason: "engine_busy" };
  if (g.loadPending) return { write: false, reason: "map_load_pending" };
  // Warp tile: the position is real but it is not KEPT — the next step
  // re-fires the warp and the resumed agent is somewhere else, which is the
  // Cerulean bounce wq#1066 traced to warp-tile saves.
  if (g.onWarp && g.cls === "auto" && g.turnsSinceWrite < CKPT_WARP_STARVE_TURNS)
    return { write: false, reason: "on_warp_tile" };
  return WRITE;
}
