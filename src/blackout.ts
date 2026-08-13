// wq#547 — detect a Gen 1 blackout by its DURABLE CONSEQUENCES, not by catching
// the sub-turn window in which the party is all-fainted.
//
// WHY THE OLD DETECTOR COULD NOT WORK. metrics.ts and retry.ts both counted the
// edge into `party.every(p => p.hp === 0)`. That requires a state_read landing
// INSIDE the all-fainted window, and sampling is one read per turn. Measured
// over every event log on disk: 1285 state_reads carry party data and
// all-fainted appears in ZERO of them. In Red a blackout immediately heals the
// party and warps the player to a Pokemon Center, so the window closes well
// inside one poll interval. The edge is not rare, it is UNOBSERVABLE at this
// rate — which is why six of the seven white-outs on the kiosk had to be typed
// in by hand in August.
//
// THE RULE, AND IT IS NOT THE ONE wq#547 ASKED FOR. The ticket says "require at
// least two co-occurring signatures ... so a Center visit for a normal heal is
// not miscounted as a blackout". Two-of-three does NOT achieve that: a normal
// heal IS at a Center (S2) and DOES restore the party to full (S3), so it
// scores two and fires. The signature that actually separates the two cases is
// money: a Center heal in Gen 1 is free, and a blackout halves the purse.
// So money-halving is MANDATORY and one corroborator is required on top:
//
//     fire  <=>  S1 && (S2 || S3)
//
// S1 alone is not enough either — a mart purchase can coincidentally cost
// exactly half the purse — and the corroborator rules that out.
import { CENTER_MAPS } from "./centers";

export interface PartyMon { hp?: number; maxHp?: number }
export interface StateRead { map?: number; money?: number; party?: PartyMon[] }

export interface BlackoutHit {
  moneyBefore: number; moneyAfter: number;
  map: number; atCenter: boolean; partyRestored: boolean;
}

/** True when every living slot is at full HP and the party is non-empty. */
function allFull(p: PartyMon[] | undefined): boolean {
  if (!Array.isArray(p) || p.length === 0) return false;
  return p.every((m) => typeof m.hp === "number" && typeof m.maxHp === "number"
    && m.maxHp > 0 && m.hp === m.maxHp);
}

/** True when at least one slot is below full (or fainted). */
function anyHurt(p: PartyMon[] | undefined): boolean {
  if (!Array.isArray(p) || p.length === 0) return false;
  return p.some((m) => typeof m.hp === "number" && typeof m.maxHp === "number"
    && m.maxHp > 0 && m.hp < m.maxHp);
}

export class BlackoutDetector {
  private prev: StateRead | null = null;
  readonly hits: BlackoutHit[] = [];

  /** Feed consecutive state_read payloads in order. Returns the hit when this
   *  transition IS a blackout, else null. Caller counts; this decides. */
  observe(e: StateRead): BlackoutHit | null {
    const prev = this.prev;
    this.prev = e;
    if (!prev) return null;
    if (typeof prev.money !== "number" || typeof e.money !== "number") return null;

    // S1 (MANDATORY): the purse was halved, floor-rounded as Red does it.
    if (!(prev.money > 0 && e.money === Math.floor(prev.money / 2))) return null;

    // S2 / S3: corroborators. At least one must hold.
    const atCenter = typeof e.map === "number" && CENTER_MAPS.has(e.map);
    const partyRestored = anyHurt(prev.party) && allFull(e.party);
    if (!atCenter && !partyRestored) return null;

    const hit: BlackoutHit = {
      moneyBefore: prev.money, moneyAfter: e.money,
      map: typeof e.map === "number" ? e.map : -1,
      atCenter, partyRestored,
    };
    this.hits.push(hit);
    return hit;
  }
}
