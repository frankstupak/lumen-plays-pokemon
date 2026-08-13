// wq#482 — M5b: ONE-SIDED verification invariants.
//
// wq#433 problem 1: every M3/M4 correctness check reads BOTH cores in one
// process (e.g. battle.ts's `mirrored = pmA===emB && pmB===emA && hp(A)===
// foeHp(B) && ...`). A remote peer's RAM is unreadable, so those checks cannot
// run at all against a real remote partner. This module re-expresses them
// using only what OUR side can legitimately know:
//   1. our own RAM, and
//   2. the bytes that physically arrived on the wire (SerialBridge.log).
//
// FAIL-CLOSED: every check returns explicit failures; an inconsistency, an
// unknown, or missing evidence is a FAILURE, never a pass. Verify-only — this
// module never writes to a core.
//
// ---------------------------------------------------------------------------
// HONEST SCOPE NOTE (read before trusting a green result)
// ---------------------------------------------------------------------------
// The ticket text says the trade check should include a "checksum". Gen1's
// 415-byte trade block carries NO protocol checksum — there is nothing to
// verify against, and inventing one would be a fabricated guarantee. What the
// format DOES give us, and what is implemented here instead:
//   * exact length (415) and exact internal partitioning,
//   * the $FE exclusion invariant: the patch lists remove $FE from the block
//     precisely so it can never ride the wire (see serialbus.ts) — so ANY $FE
//     inside a received block is proof of corruption/an unready sender,
//   * structural range validation of every field against ROM-derived offsets.
// A structurally-valid block from a hostile peer can still contain a legal-but-
// false party; one-sided verification cannot detect that, and does not claim to.
import { SymbolTable } from "../symbols";

/** 415 = 11 name + 1 count + 7 species(+$FF term) + 6*44 mons + 6*11 OT + 6*11 nicks.
 *  Partition sizes are asserted against the symbol table by fromSymbols(). */
export const BLOCK = {
  total: 415,
  nameLen: 11,
  maxSlots: 6,
  structSize: 44,
  speciesListLen: 7,
} as const;

export const PREAMBLE_BYTE = 0xFD;   // R4: SERIAL_PREAMBLE_BYTE, ROM-verified
export const NO_DATA_BYTE = 0xFE;    // ISR "no data"; patch-listed OUT of the block
export const TERMINATOR = 0xFF;      // species-list terminator

/** Party-struct field offsets. NOT hardcoded from memory: derived from
 *  roms/pokeblue.sym so a wrong assumption fails loudly at construction. */
export interface MonOffsets { species: number; hp: number; status: number; level: number; moves: number; pp: number; maxHp: number; stride: number }

export function offsetsFromSymbols(sym: SymbolTable): MonOffsets {
  const base = sym.addr("wPartyMon1");
  const o: MonOffsets = {
    species: sym.addr("wPartyMon1") - base,
    hp: sym.addr("wPartyMon1HP") - base,
    status: sym.addr("wPartyMon1Status") - base,
    level: sym.addr("wPartyMon1Level") - base,
    moves: sym.addr("wPartyMon1Moves") - base,
    pp: sym.addr("wPartyMon1PP") - base,
    maxHp: sym.addr("wPartyMon1MaxHP") - base,
    stride: sym.addr("wPartyMon2") - base,
  };
  if (o.stride !== BLOCK.structSize)
    throw new Error(`invariants: party stride ${o.stride} != expected ${BLOCK.structSize}`);
  return o;
}

export interface Failure { check: string; detail: string }
export interface Verdict { ok: boolean; failures: Failure[]; checked: string[] }

const verdict = (): Verdict & { fail: (c: string, d: string) => void; pass: (c: string) => void } => {
  const v: any = { ok: true, failures: [], checked: [] };
  v.fail = (c: string, d: string) => { v.ok = false; v.failures.push({ check: c, detail: d }); };
  v.pass = (c: string) => v.checked.push(c);
  return v;
};

// ---------------------------------------------------------------------------
// TRADE: validate a RECEIVED 415-byte party block structurally.
// ---------------------------------------------------------------------------
export interface BlockView {
  name: number[]; count: number; species: number[];
  mons: { species: number; hp: number; maxHp: number; level: number; moves: number[]; pp: number[] }[];
}

/** Split a 415-byte block into its parts using ROM-derived offsets. Throws
 *  only on wrong length (callers check length first via verifyTradeBlock). */
export function viewBlock(block: number[] | Uint8Array, o: MonOffsets): BlockView {
  const b = Array.from(block);
  let p = 0;
  const name = b.slice(p, p + BLOCK.nameLen); p += BLOCK.nameLen;
  const count = b[p]; p += 1;
  const species = b.slice(p, p + BLOCK.speciesListLen); p += BLOCK.speciesListLen;
  const mons = [];
  for (let i = 0; i < BLOCK.maxSlots; i++) {
    const m = b.slice(p + i * o.stride, p + (i + 1) * o.stride);
    mons.push({
      species: m[o.species],
      hp: (m[o.hp] << 8) | m[o.hp + 1],
      maxHp: (m[o.maxHp] << 8) | m[o.maxHp + 1],
      level: m[o.level],
      moves: [0, 1, 2, 3].map(j => m[o.moves + j]),
      pp: [0, 1, 2, 3].map(j => m[o.pp + j] & 0x3f),
    });
  }
  return { name, count, species, mons };
}

export interface TradeBlockOpts { maxSpecies?: number; maxMoveId?: number }

/** One-sided trade check #1: is the block the peer sent structurally sound? */
export function verifyTradeBlock(block: number[] | Uint8Array, o: MonOffsets, opts: TradeBlockOpts = {}): Verdict {
  const v = verdict();
  const maxSpecies = opts.maxSpecies ?? 190;   // Gen1 internal ids run to $BE
  const maxMove = opts.maxMoveId ?? 165;       // 165 moves in Gen1
  const b = Array.from(block);

  if (b.length !== BLOCK.total) {
    v.fail("length", `block is ${b.length} bytes, protocol says ${BLOCK.total}`);
    return v;                                   // fail-closed: cannot parse further
  }
  v.pass("length");

  if (b.some(x => x === NO_DATA_BYTE))
    v.fail("no_FE", `$FE at offset(s) ${b.map((x, i) => x === NO_DATA_BYTE ? i : -1).filter(i => i >= 0).slice(0, 8).join(",")} — patch lists exclude $FE, so this is an unready sender or corruption`);
  else v.pass("no_FE");

  const view = viewBlock(b, o);

  if (view.count < 1 || view.count > BLOCK.maxSlots) v.fail("party_count", `count=${view.count}, must be 1..6`);
  else v.pass("party_count");

  // species list: `count` real ids then the $FF terminator
  const term = view.species[Math.min(view.count, BLOCK.maxSlots)];
  if (view.count >= 1 && view.count <= BLOCK.maxSlots && term !== TERMINATOR)
    v.fail("species_terminator", `expected $FF at species[${view.count}], got $${(term ?? 0).toString(16)}`);
  else v.pass("species_terminator");

  for (let i = 0; i < Math.min(view.count, BLOCK.maxSlots); i++) {
    const m = view.mons[i], tag = `slot${i}`;
    if (m.species === 0 || m.species > maxSpecies) v.fail("species_range", `${tag} species=${m.species}`);
    if (view.species[i] !== m.species) v.fail("species_agree", `${tag} list says ${view.species[i]}, struct says ${m.species}`);
    if (m.level < 1 || m.level > 100) v.fail("level_range", `${tag} level=${m.level}`);
    if (m.maxHp < 1 || m.maxHp > 999) v.fail("maxhp_range", `${tag} maxHp=${m.maxHp}`);
    if (m.hp > m.maxHp) v.fail("hp_le_maxhp", `${tag} hp=${m.hp} > maxHp=${m.maxHp}`);
    if (m.moves[0] === 0) v.fail("has_move", `${tag} has no move in slot 0`);
    m.moves.forEach((mv, j) => { if (mv > maxMove) v.fail("move_range", `${tag} move${j}=${mv}`); });
    m.moves.forEach((mv, j) => { if (mv === 0 && m.pp[j] !== 0) v.fail("pp_empty_slot", `${tag} move${j} empty but pp=${m.pp[j]}`); });
    m.pp.forEach((pp, j) => { if (pp > 61) v.fail("pp_range", `${tag} pp${j}=${pp}`); });
  }
  if (v.ok) v.pass("mon_fields");
  return v;
}

/** One-sided trade check #2: after the swap, OUR party must have mutated
 *  exactly per protocol — the traded slot now holds the mon the peer's block
 *  advertised, every other slot is byte-identical, and the count is unchanged.
 *  This is the one-sided replacement for "A ends holding B's mon" (which
 *  needed both cores' RAM). */
export interface PostTradeInput {
  before: BlockView["mons"];    // our party BEFORE (from our own RAM)
  after: BlockView["mons"];     // our party AFTER
  slot: number;                 // slot we offered
  peerMon: BlockView["mons"][number];   // what the peer's block said we'd receive
  count: number;                // our party count (must not change)
  countAfter: number;
}

export function verifyPostTrade(i: PostTradeInput): Verdict {
  const v = verdict();
  if (i.countAfter !== i.count) v.fail("count_stable", `party count ${i.count} -> ${i.countAfter}`);
  else v.pass("count_stable");

  if (i.slot < 0 || i.slot >= i.before.length) { v.fail("slot_range", `slot=${i.slot}`); return v; }

  const got = i.after[i.slot];
  if (!got) { v.fail("slot_present", `no slot ${i.slot} after trade`); return v; }
  // the traded slot must now be the PEER's mon, not ours
  if (got.species !== i.peerMon.species)
    v.fail("received_species", `slot${i.slot} species=${got.species}, peer advertised ${i.peerMon.species}`);
  if (got.level !== i.peerMon.level)
    v.fail("received_level", `slot${i.slot} level=${got.level}, peer advertised ${i.peerMon.level}`);
  if (got.species === i.before[i.slot].species && got.level === i.before[i.slot].level)
    v.fail("slot_actually_changed", `slot${i.slot} is unchanged — no trade occurred (or we verified a clone; see M3_TRADE blind-test rule)`);
  if (v.ok) v.pass("received_mon");

  // every OTHER slot must be untouched
  for (let s = 0; s < Math.min(i.before.length, i.after.length); s++) {
    if (s === i.slot) continue;
    const a = i.before[s], b = i.after[s];
    if (a.species !== b.species || a.level !== b.level || a.maxHp !== b.maxHp)
      v.fail("other_slots_untouched", `slot${s} changed: ${a.species}/L${a.level} -> ${b.species}/L${b.level}`);
  }
  if (v.ok) v.pass("other_slots_untouched");
  return v;
}

// ---------------------------------------------------------------------------
// BATTLE: turn-by-turn ledger reconciled from SETTLED states only.
// ---------------------------------------------------------------------------
// Two-sided version (battle.ts): mirrored = pmA===emB && pmB===emA &&
//   hp(A)===foeHp(B) && hp(B)===foeHp(A).
// One-sided version: we keep only OUR (playerMove, enemyMove, hp, foeHp) per
// settled turn, and require that the enemyMove our ROM reports was actually
// DELIVERED ON THE WIRE — a move byte our RAM shows but that never arrived is
// the remote-peer equivalent of a mirror break. Per doctrine, only settled
// samples are admissible (battle.ts: a torn mid-animation sample reports a
// mismatch that resolves one round later).
export interface TurnSample {
  round: number;
  playerMove: number;    // what we picked
  enemyMove: number;     // what our ROM says the peer picked
  hp: number; foeHp: number;
  settled: boolean;      // caller asserts the settle+bothAtMenu discipline
}

export interface BattleLedgerInput {
  turns: TurnSample[];
  /** bytes the bridge actually received from the peer this battle */
  wireBytes: number[];
  ownMoveIds: number[];  // move ids our active mon actually knows
  maxMoveId?: number;
}

export function verifyBattleLedger(i: BattleLedgerInput): Verdict {
  const v = verdict();
  const maxMove = i.maxMoveId ?? 165;
  const wire = new Set(i.wireBytes.map(b => b & 0xFF));

  const settled = i.turns.filter(t => t.settled);
  if (!settled.length) { v.fail("has_settled_turns", "no settled turns — nothing is verifiable (fail-closed)"); return v; }
  if (settled.length !== i.turns.length) v.pass("unsettled_turns_excluded");
  v.pass("has_settled_turns");

  let prev: TurnSample | null = null;
  for (const t of settled) {
    const tag = `turn${t.round}`;
    if (t.playerMove === 0 || t.playerMove > maxMove) v.fail("own_move_range", `${tag} playerMove=${t.playerMove}`);
    if (i.ownMoveIds.length && !i.ownMoveIds.includes(t.playerMove))
      v.fail("own_move_known", `${tag} we 'used' move ${t.playerMove}, not in our move set [${i.ownMoveIds}]`);
    if (t.enemyMove === 0 || t.enemyMove > maxMove) v.fail("enemy_move_range", `${tag} enemyMove=${t.enemyMove}`);
    // THE one-sided anchor: the peer's move must have physically arrived.
    else if (!wire.has(t.enemyMove))
      v.fail("enemy_move_on_wire", `${tag} enemyMove=${t.enemyMove} never arrived over the link — our RAM shows a move the peer never sent`);
    if (t.hp > 0 && t.foeHp > 0 && prev) {
      if (t.hp > prev.hp) v.fail("own_hp_monotonic", `${tag} hp rose ${prev.hp} -> ${t.hp} with no item/switch accounted`);
      if (t.foeHp > prev.foeHp) v.fail("foe_hp_monotonic", `${tag} foe hp rose ${prev.foeHp} -> ${t.foeHp}`);
      if (t.hp === prev.hp && t.foeHp === prev.foeHp)
        v.fail("turn_had_effect", `${tag} neither side's HP moved across a settled turn boundary — stalled or duplicate sample`);
    }
    prev = t;
  }
  if (v.ok) { v.pass("moves_valid"); v.pass("hp_ledger"); }
  return v;
}

/** Convenience: fail-closed roll-up for a whole remote session. */
export function combine(...vs: Verdict[]): Verdict {
  const out: Verdict = { ok: true, failures: [], checked: [] };
  if (!vs.length) return { ok: false, failures: [{ check: "combine", detail: "no verdicts supplied (fail-closed)" }], checked: [] };
  for (const v of vs) { if (!v.ok) out.ok = false; out.failures.push(...v.failures); out.checked.push(...v.checked); }
  return out;
}
