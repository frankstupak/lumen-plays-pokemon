// wq#482 probe — one-sided invariants, red AND green.
// The VALID trade block is built from a REAL party read out of a real
// checkpoint (not hand-authored), so a green result means the validator
// accepts what the ROM actually produces. Corruptions are then injected into
// that same block, one at a time, and each MUST be caught.
import { Emulator, loadSnapshotFile } from "../emulator";
import { SymbolTable } from "../symbols";
import { offsetsFromSymbols, verifyTradeBlock, verifyPostTrade, verifyBattleLedger,
         viewBlock, combine, BLOCK, MonOffsets, TAIL_LEN,
         partyBlockLayout, readPartyBlock, diffBlocks, sectionOf } from "./invariants";
import { ckptPath, romPath } from "../fixtures";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};
/** a check that MUST be caught by the validator */
const redFails = (name: string, v: { ok: boolean; failures: { check: string }[] }, expect: string) => {
  const hit = !v.ok && v.failures.some(f => f.check === expect);
  ok(name, hit, hit ? `caught '${expect}'` : `expected '${expect}', got ${v.ok ? "PASS(!!)" : v.failures.map(f => f.check).join(",")}`);
};

const sym = new SymbolTable(romPath("pokeblue.sym"));
const O: MonOffsets = offsetsFromSymbols(sym);
ok("offsets derived from pokeblue.sym", O.stride === 44 && O.moves === 8 && O.pp === 29 && O.level === 33,
   `species=${O.species} moves=${O.moves} pp=${O.pp} level=${O.level} stride=${O.stride}`);

/** Build a real 415-byte block out of a live checkpoint's party RAM. */
function realBlock(): number[] {
  const emu = new Emulator(romPath("pokeblue.gb"));
  loadSnapshotFile(emu, ckptPath("center-m2b.state.gz"));
  emu.frames(4);
  return readPartyBlock(emu.mem(), sym, "own");
}

const good = realBlock();
ok("real block is exactly 415 bytes", good.length === BLOCK.total, `${good.length}`);
const gv = verifyTradeBlock(good, O);
ok("GREEN: real ROM party block validates", gv.ok, gv.ok ? `checks=${gv.checked.join(",")}` : JSON.stringify(gv.failures));
const view = viewBlock(good, O);
console.log(`  block: count=${view.count} slot0 species=${view.mons[0].species} L${view.mons[0].level} hp=${view.mons[0].hp}/${view.mons[0].maxHp} moves=[${view.mons[0].moves}]`);

// ---- RED: one corruption at a time, each must be caught ----
const mut = (f: (b: number[]) => void) => { const b = good.slice(); f(b); return verifyTradeBlock(b, O); };
const monBase = BLOCK.nameLen + 1 + BLOCK.speciesListLen;

redFails("RED truncated block", verifyTradeBlock(good.slice(0, 400), O), "length");
redFails("RED $FE on the wire (patch-list violation)", mut(b => { b[monBase + 3] = 0xFE; }), "no_FE");
redFails("RED impossible party count", mut(b => { b[BLOCK.nameLen] = 9; }), "party_count");
redFails("RED missing species terminator", mut(b => { b[BLOCK.nameLen + 1 + view.count] = 0x42; }), "species_terminator");
redFails("RED species 0 in an occupied slot", mut(b => { b[monBase + O.species] = 0; }), "species_range");
redFails("RED species list disagrees with struct", mut(b => { b[BLOCK.nameLen + 1] = 25; }), "species_agree");
redFails("RED level 0", mut(b => { b[monBase + O.level] = 0; }), "level_range");
redFails("RED level 255", mut(b => { b[monBase + O.level] = 255; }), "level_range");
redFails("RED hp > maxHp", mut(b => { b[monBase + O.hp] = 0xFF; b[monBase + O.hp + 1] = 0xFF; }), "hp_le_maxhp");
redFails("RED out-of-range move id", mut(b => { b[monBase + O.moves] = 200; }), "move_range");
redFails("RED PP on an empty move slot", mut(b => { b[monBase + O.moves + 3] = 0; b[monBase + O.pp + 3] = 20; }), "pp_empty_slot");
redFails("RED impossible PP value", mut(b => { b[monBase + O.pp] = 62; }), "pp_range");

// a corruption in an UNOCCUPIED slot must NOT trip the validator (false-positive guard)
const unoccupied = mut(b => { const s5 = monBase + 5 * O.stride; b[s5 + O.level] = 0xFE - 1; b[s5 + O.species] = 0xEE; });
ok("no false positive: junk in unoccupied slots ignored", unoccupied.ok, unoccupied.ok ? "" : JSON.stringify(unoccupied.failures));

// ---- post-trade own-party mutation ----
const mine = viewBlock(good, O).mons;
const peerMon = { species: 25, hp: 40, maxHp: 40, level: 30, moves: [84, 85, 0, 0], pp: [15, 10, 0, 0] };
const afterOk = mine.map((m, i) => i === 0 ? peerMon : m);
ok("GREEN: post-trade slot holds the peer's mon, others untouched",
   verifyPostTrade({ before: mine, after: afterOk, slot: 0, peerMon, count: 6, countAfter: 6 }).ok, "");
redFails("RED post-trade: slot unchanged (no trade happened)",
   verifyPostTrade({ before: mine, after: mine, slot: 0, peerMon, count: 6, countAfter: 6 }), "slot_actually_changed");
redFails("RED post-trade: received wrong species",
   verifyPostTrade({ before: mine, after: mine.map((m, i) => i === 0 ? { ...peerMon, species: 99 } : m), slot: 0, peerMon, count: 6, countAfter: 6 }), "received_species");
redFails("RED post-trade: an untraded slot mutated",
   verifyPostTrade({ before: mine, after: afterOk.map((m, i) => i === 2 ? { ...m, species: 1 } : m), slot: 0, peerMon, count: 6, countAfter: 6 }), "other_slots_untouched");
redFails("RED post-trade: party count changed",
   verifyPostTrade({ before: mine, after: afterOk, slot: 0, peerMon, count: 6, countAfter: 5 }), "count_stable");

// ---- battle ledger (one-sided) ----
// wq#3201: the wire carries the move's LIST INDEX; the id comes from the peer's
// advertised move set. Windows mimic LinkBattleExchangeData: the tagged index
// ($60|i, Serial_ExchangeNybble) repeated, then zero padding.
const OWN = [33, 45, 52, 43];
const FOE = [10, 45, 52, 43];
const win = (idx: number) => [0xFE, 0x60 | idx, 0x60 | idx, 0x60 | idx, 0, 0, 0];
const turns = [
  { round: 1, playerMove: 33, enemyMove: 52, enemyIndex: 2, wire: win(2), hp: 57, foeHp: 51, settled: true },
  { round: 2, playerMove: 45, enemyMove: 43, enemyIndex: 3, wire: win(3), hp: 50, foeHp: 40, settled: true },
];
const L = (t: any[]) => verifyBattleLedger({ turns: t, enemyMoveIds: FOE, ownMoveIds: OWN });
const bl = L(turns);
ok("GREEN: consistent battle ledger passes", bl.ok, bl.ok ? `checks=${bl.checked.join(",")}` : JSON.stringify(bl.failures));

redFails("RED battle: enemy choice our RAM shows but this turn's bytes never carried",
  L([turns[0], { ...turns[1], wire: win(2) }]), "enemy_move_on_wire");
redFails("RED battle: the id was on the wire, but only inside the party block (old vacuous anchor)",
  L([turns[0], { ...turns[1], wire: [0xFE, 43, 43, 0, 0] }]), "enemy_move_on_wire");
redFails("RED battle: an untagged index byte is padding, not a choice",
  L([turns[0], { ...turns[1], wire: [0xFE, 3, 3, 0, 0] }]), "enemy_move_on_wire");
redFails("RED battle: index arrived but maps to a different move than our RAM reports",
  L([turns[0], { ...turns[1], enemyMove: 10 }]), "enemy_move_advertised");
redFails("RED battle: we 'used' a move our mon does not know",
  L([{ ...turns[0], playerMove: 120 }]), "own_move_known");
redFails("RED battle: our HP rose unaccounted",
  L([turns[0], { ...turns[1], hp: 99 }]), "own_hp_monotonic");
redFails("RED battle: foe HP rose unaccounted",
  L([turns[0], { ...turns[1], foeHp: 99 }]), "foe_hp_monotonic");
redFails("RED battle: settled turn where nothing changed (duplicate/stall)",
  L([turns[0], { ...turns[0], round: 2 }]), "turn_had_effect");
redFails("RED battle: no settled turns at all is FAIL-CLOSED, not a pass",
  L([{ ...turns[0], settled: false }]), "has_settled_turns");
redFails("RED combine: zero verdicts is fail-closed", combine(), "combine");
ok("combine rolls up mixed verdicts as failed", !combine(gv, verifyTradeBlock(good.slice(0, 10), O)).ok, "");

// ---- wq#511: WHERE the block lives, and the diff that sees a lost byte ----
const enemy = partyBlockLayout(sym, "enemy");
ok("enemy block tail starts at wEnemyPartyCount, not the staging buffer",
   enemy.tail === sym.addr("wEnemyPartyCount") && enemy.tail !== sym.addr("wSerialEnemyDataBlock"),
   `tail=$${enemy.tail.toString(16)} staging=$${sym.addr("wSerialEnemyDataBlock").toString(16)} (${enemy.tail - sym.addr("wSerialEnemyDataBlock")} bytes apart)`);
ok("enemy and own layouts agree on the 404-byte tail",
   enemy.tailLen === TAIL_LEN && partyBlockLayout(sym, "own").tailLen === TAIL_LEN, `${enemy.tailLen}`);
ok("offset labelling matches the partitioning",
   sectionOf(0, O) === "name+0" && sectionOf(BLOCK.nameLen, O) === "count" &&
   sectionOf(monBase, O) === "mon0+0" && sectionOf(BLOCK.total - 1, O) === "nick5+10",
   `${sectionOf(monBase, O)} .. ${sectionOf(BLOCK.total - 1, O)}`);

ok("GREEN mirror: a block equals itself", diffBlocks(good, good, O, view.count).ok, "");
const oneOff = good.slice(); oneOff[monBase + O.level] ^= 1;
ok("RED mirror: one byte flipped in an OCCUPIED slot is caught",
   !diffBlocks(good, oneOff, O, view.count).ok, JSON.stringify(diffBlocks(good, oneOff, O, view.count).where));
const deadSlot = good.slice(); deadSlot[monBase + 5 * O.stride] ^= 0xFF;
ok("mirror scoped to the party ignores a never-filled slot", diffBlocks(good, deadSlot, O, view.count).ok, "");
ok("...but the unscoped mirror still sees it", !diffBlocks(good, deadSlot, O).ok, "");

// THE wq#511 regression: a block that lost one byte and shifted its tail.
// Structural validation may or may not notice, depending on where the shift
// lands (it caught this one on hp>maxHp, and passed a real one that shifted
// only unused slots). The mirror sees it every time, and says at which byte.
const shifted = [...good.slice(0, 12), ...good.slice(13), 0];
ok("RED mirror: a one-byte-short, tail-shifted block is caught",
   !diffBlocks(good, shifted, O, view.count).ok,
   `structural verdict was ${verifyTradeBlock(shifted, O).ok ? "PASS (which is why the mirror exists)" : "FAIL"}, mirror diffs=${diffBlocks(good, shifted, O, view.count).diffs}`);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
