// wq#1181 (roadmap item 6): fight loss ledger, generalized engagement gates,
// grind governor.
//
// WHY THIS EXISTS
//   FIGHT_LOSS_LOOP has two halves. The in-battle half is item 5 (calc.ts): can
//   I win THIS exchange. This file is the RE-ENTRY half: the agent loses a
//   fight, whites out, respawns at the centre, and walks straight back into the
//   same doorway with the same party — the loop that ran 43 hours at Cerulean
//   Gym. Nothing in the harness remembered the loss, so nothing could refuse
//   the re-entry, and the one place that did refuse it (mistyGymEntryRefusal in
//   guidance.ts) is hand-coded for exactly one gym out of eight.
//
//   The ledger records every trainer fight's outcome keyed by
//   (wCurOpponent, wTrainerNo, map) and turns a LOSS into a time-boxed refusal
//   to re-enter that map, which generalises the Misty gate to every gym and
//   scripted trainer for the rest of the campaign, with no per-gym code.
//
// GATES MUST EXPIRE — this is the wq#517 lesson and the reason this module has
// four independent lifts rather than one. A permanent ban wedges the campaign:
// wq#517's warp guard latched, and the agent could not leave the map it had
// banned itself out of. Here a gate lifts when ANY of these holds:
//   1. levelSum rose by GATE_LEVEL_RISE since the loss (the intended exit),
//   2. GATE_TTL_MS of wall clock passed (the "we were wrong about why" exit),
//   3. a pre-engagement estimate flipped to WINNABLE (the data exit),
//   4. the gate has already refused GATE_MAX_FIRES times (the anti-wedge exit —
//      a gate that keeps firing is not steering, it is stuck, so it gives up).
// A win on the same key clears it outright. There is no code path that produces
// a gate without an expiry.
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/** levelSum points that must accumulate after a loss before re-entry opens.
 *  levelSum (novelty.ts) is the sum over the party, so this is "three levels
 *  anywhere in the party", not three on the lead — a second body is progress
 *  against a fight that beat a solo lead. */
export const GATE_LEVEL_RISE = 3;

/** Wall-clock ceiling on a gate. Six hours is well beyond the levelling loop
 *  the gate is trying to force (Route 24/25 at the live cadence moves levelSum
 *  by 3 in well under an hour) and short enough that a mis-attributed loss
 *  cannot hold the campaign overnight. */
export const GATE_TTL_MS = 6 * 60 * 60 * 1000;

/** Refusals one gate may issue before it lifts itself. Chosen so the brain gets
 *  a real chance to hear the refusal and re-plan (each fire is one turn) while
 *  bounding the damage if the gate is wrong: at worst ten turns are spent
 *  arguing with it, not a night. */
export const GATE_MAX_FIRES = 10;

/** Fight outcomes retained. Bounded like every runtime file here (novelty.ts
 *  KEEP_SAMPLES, oscillation.ts KEEP): a multi-day run cannot grow this file. */
export const KEEP_RECORDS = 200;

/** Turns the "this gate has lifted, stop grinding" line is rendered for after a
 *  gate expires. Bounded so it cannot become wallpaper the brain reads past. */
export const LIFT_RENDERS = 5;

export type Outcome = "win" | "loss";

export interface FightRecord {
  ts: number; turn: number;
  outcome: Outcome;
  opponent: number;       // wCurOpponent (>=200 = trainer class + 200)
  trainerNo: number;      // wTrainerNo
  map: number;
  levelSum: number;       // party levelSum at the time
  badges: number;
}

export interface GateRecord {
  key: string;
  map: number; opponent: number; trainerNo: number;
  lossTs: number;
  lossLevelSum: number;
  losses: number;
  fires: number;
}

/** What the caller knows right now, for deciding whether a gate still holds. */
export interface GateCtx {
  levelSum: number;
  now: number;
  /** Pre-engagement estimate for this fight, when one is available. Item 4's
   *  BaseStats decode is what will let trainers.ts produce this from a decoded
   *  roster; until then the caller passes nothing and lifts 1/2/4 carry the
   *  gate. Only "WINNABLE" lifts — an absent estimate never blocks and never
   *  releases. */
  estimate?: "WINNABLE" | "CLOSE" | "UNWINNABLE" | "UNKNOWN";
}

export interface GateDecision {
  blocked: boolean;
  key: string | null;
  reason: string;
  /** Populated when blocked: what would open it. */
  needLevelSum?: number;
  msLeft?: number;
  firesLeft?: number;
  /** Populated when a gate was found but had expired. */
  lifted?: string;
}

export function fightKey(opponent: number, trainerNo: number, map: number): string {
  return `${opponent}:${trainerNo}:${map}`;
}

interface Store { v: number; records: FightRecord[]; gates: Record<string, GateRecord> }

export function ledgerFile(dir?: string): string {
  return process.env.LPP_FIGHT_LEDGER ?? `${dir ?? `${process.cwd()}/runtime`}/fight_ledger.json`;
}

export function loadLedger(file: string): Store {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Store;
    if (s && Array.isArray(s.records)) {
      return {
        v: 1,
        records: s.records.filter(r => r && typeof r.ts === "number").slice(-KEEP_RECORDS),
        gates: (s.gates && typeof s.gates === "object") ? s.gates : {},
      };
    }
  } catch {}
  return { v: 1, records: [], gates: {} };
}

/** Why a gate is no longer live, or null while it still is. Pure, so the probe
 *  can walk every expiry without touching disk. */
export function gateLift(g: GateRecord, c: GateCtx): string | null {
  if (c.levelSum >= g.lossLevelSum + GATE_LEVEL_RISE)
    return `levelSum rose to ${c.levelSum} (loss was at ${g.lossLevelSum}, needed +${GATE_LEVEL_RISE})`;
  if (c.now - g.lossTs >= GATE_TTL_MS)
    return `gate aged out after ${Math.round((c.now - g.lossTs) / 60000)} min`;
  if (c.estimate === "WINNABLE")
    return "pre-engagement estimate flipped to WINNABLE";
  if (g.fires >= GATE_MAX_FIRES)
    return `gate refused ${g.fires} times without steering the run (anti-wedge cap)`;
  return null;
}

export interface LedgerOpts {
  dir?: string;
  bus?: { emit(kind: any, data: object): void };
}

/**
 * The persisted ledger. One per Agent, constructed with the same
 * <base>/runtime anchor as NoveltyTracker, and fail-soft in the same way: every
 * disk operation is wrapped, because losing a bookkeeping write must never be
 * able to break a turn.
 */
export class FightLedger {
  private store: Store;
  private path: string;
  private lift: { key: string; map: number; reason: string; left: number } | null = null;

  constructor(private opts: LedgerOpts = {}) {
    this.path = ledgerFile(opts.dir);
    this.store = loadLedger(this.path);
  }

  records(): FightRecord[] { return this.store.records.slice(); }
  gates(): GateRecord[] { return Object.values(this.store.gates); }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.store));
    } catch {}
  }

  /** Record one finished fight. A loss opens (or deepens) the gate for its key;
   *  a win closes it — beating the fight is the most direct evidence there is
   *  that the gate's premise no longer holds. */
  record(r: FightRecord): void {
    this.store.records.push(r);
    if (this.store.records.length > KEEP_RECORDS)
      this.store.records = this.store.records.slice(-KEEP_RECORDS);
    const key = fightKey(r.opponent, r.trainerNo, r.map);
    if (r.outcome === "loss") {
      const prev = this.store.gates[key];
      this.store.gates[key] = {
        key, map: r.map, opponent: r.opponent, trainerNo: r.trainerNo,
        lossTs: r.ts, lossLevelSum: r.levelSum,
        losses: (prev?.losses ?? 0) + 1,
        fires: 0,                       // a fresh loss restarts the fire budget
      };
    } else {
      delete this.store.gates[key];
    }
    this.save();
    this.opts.bus?.emit("fight_ledger", {
      event: r.outcome, key, map: r.map, opponent: r.opponent, trainerNo: r.trainerNo,
      levelSum: r.levelSum, turn: r.turn,
      gated: r.outcome === "loss",
    });
  }

  /** Drop an expired gate and say so on the bus. Idempotent. */
  private sweep(g: GateRecord, c: GateCtx): string | null {
    const lift = gateLift(g, c);
    if (!lift) return null;
    delete this.store.gates[g.key];
    this.lift = { key: g.key, map: g.map, reason: lift, left: LIFT_RENDERS };
    this.save();
    this.opts.bus?.emit("fight_ledger", { event: "gate_lifted", key: g.key, map: g.map, reason: lift });
    return lift;
  }

  /** The most recently lifted gate, for the few turns after it lifts.
   *
   *  This is the other half of the grind governor: the moment a gate opens is
   *  the moment grinding stops being justified, and the agent has to be TOLD,
   *  not left to notice. Consuming it decrements a small render budget so the
   *  line does not become wallpaper. */
  recentLift(): { key: string; map: number; reason: string } | null {
    const l = this.lift;
    if (!l) return null;
    if (--l.left <= 0) this.lift = null;
    return { key: l.key, map: l.map, reason: l.reason };
  }

  /** The deepest live gate anywhere, or a not-blocked decision. Used by the
   *  grind governor: "is the harness currently holding the agent back from a
   *  fight" is exactly the condition under which grinding is a justified
   *  state. Sweeps expiries as a side effect, like gateForMap. */
  anyLiveGate(c: GateCtx): GateDecision {
    const live: GateRecord[] = [];
    for (const g of Object.values(this.store.gates)) {
      if (this.sweep(g, c)) continue;
      live.push(g);
    }
    if (!live.length) return { blocked: false, key: null, reason: "no live loss gate" };
    live.sort((a, b) => b.losses - a.losses || b.lossTs - a.lossTs);
    return this.decide(live[0], c);
  }

  /** Is entry into this fight refused right now? */
  gateFor(opponent: number, trainerNo: number, map: number, c: GateCtx): GateDecision {
    const g = this.store.gates[fightKey(opponent, trainerNo, map)];
    if (!g) return { blocked: false, key: null, reason: "no loss on record" };
    return this.decide(g, c);
  }

  /** Is entry into this MAP refused right now? A map gate is the disjunction of
   *  every live fight gate on it, which is what the enter_warp call site needs:
   *  the warp names a destination map, not a trainer. */
  gateForMap(map: number, c: GateCtx): GateDecision {
    const live: GateRecord[] = [];
    let lifted: string | null = null;
    for (const g of Object.values(this.store.gates)) {
      if (g.map !== map) continue;
      const l = this.sweep(g, c);
      if (l) { lifted = l; continue; }
      live.push(g);
    }
    if (!live.length)
      return { blocked: false, key: null, reason: lifted ?? "no live loss gate on this map",
               ...(lifted ? { lifted } : {}) };
    // Deepest gate wins: the fight lost most often is the one to argue about.
    live.sort((a, b) => b.losses - a.losses || b.lossTs - a.lossTs);
    return this.decide(live[0], c);
  }

  private decide(g: GateRecord, c: GateCtx): GateDecision {
    const lift = this.sweep(g, c);
    if (lift) return { blocked: false, key: g.key, reason: lift, lifted: lift };
    return {
      blocked: true, key: g.key,
      reason: `lost here ${g.losses}x, most recently at levelSum ${g.lossLevelSum}`,
      needLevelSum: g.lossLevelSum + GATE_LEVEL_RISE,
      msLeft: Math.max(0, GATE_TTL_MS - (c.now - g.lossTs)),
      firesLeft: Math.max(0, GATE_MAX_FIRES - g.fires),
    };
  }

  /** Count one refusal against the gate's fire budget. Call this ONLY when the
   *  refusal was actually handed to the brain — the budget is what stops a
   *  wrong gate from wedging the run, so it must track real refusals, not
   *  advisory renders. */
  noteFire(key: string): void {
    const g = this.store.gates[key];
    if (!g) return;
    g.fires++;
    this.save();
    this.opts.bus?.emit("fight_ledger", {
      event: "gate_fired", key, map: g.map, fires: g.fires,
      firesLeft: Math.max(0, GATE_MAX_FIRES - g.fires),
    });
  }
}

// ---------------------------------------------------------------- grind governor

/** Turn window the XP rate is measured over. Same units as novelty.ts's dP
 *  window (samples == turns) because it reads the same samples. */
export const GRIND_WINDOW_TURNS = 30;

/** levelSum points the window must produce for grinding to still count as
 *  productive. One is deliberately the floor, not a target: the governor exists
 *  to catch a grind that has stopped paying (wrong route, fleeing everything,
 *  fainting), not to demand a fast one. */
export const GRIND_MIN_LEVEL_GAIN = 1;

export interface GrindSampleLike { seq: number; levelSum: number }

export interface GrindVerdict {
  justified: boolean;
  gain: number;         // levelSum gained across the window
  samples: number;
  reason: string;
}

/**
 * Is grinding still a justified state?
 *
 * Grinding is a JUSTIFIED STATE, not a default. It is allowed only while the
 * next fight is actually gated (or estimated worse than WINNABLE) AND the last
 * GRIND_WINDOW_TURNS turns actually produced levels. When the estimate flips or
 * the XP rate collapses, the answer is no and guidance.ts turns the pressure up
 * (grindPressure). This is what replaces MISTY_MIN_LEVEL=30 as the primary
 * gate: a level number is a proxy, the damage calc and the measured rate are
 * facts.
 *
 * A partial window is justified by construction — a fresh boot has not earned
 * the right to call a grind unproductive, exactly as novelty.ts refuses to call
 * a partial window flat.
 */
export function grindJustified(
  samples: GrindSampleLike[],
  o: { gated: boolean; estimate?: GateCtx["estimate"]; windowTurns?: number }): GrindVerdict {
  const w = Math.max(2, Math.floor(o.windowTurns ?? GRIND_WINDOW_TURNS));
  const win = (samples ?? []).slice(-w);
  const gain = win.length >= 2 ? win[win.length - 1].levelSum - win[0].levelSum : 0;
  if (!o.gated && o.estimate === "WINNABLE")
    return { justified: false, gain, samples: win.length,
             reason: "the next fight estimates WINNABLE - grinding is no longer justified" };
  if (win.length < w)
    return { justified: true, gain, samples: win.length,
             reason: `only ${win.length}/${w} turns sampled - too early to judge the rate` };
  if (gain < GRIND_MIN_LEVEL_GAIN)
    return { justified: false, gain, samples: win.length,
             reason: `levelSum moved ${gain} in ${w} turns - this grind has stopped paying` };
  return { justified: true, gain, samples: win.length,
           reason: `levelSum +${gain} over ${w} turns` };
}
