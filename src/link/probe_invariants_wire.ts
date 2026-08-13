// wq#482 — M5a INTEGRATION: push a real 415-byte party block through the M5a
// transport over a real localhost socket, then verify ONLY what arrived.
// This closes the loop the ticket asks for: the invariants run on wire-received
// bytes, not on an in-memory array we already trusted.
import { BgbLink } from "./bgblink";
import { SymbolTable } from "../symbols";
import { Emulator, loadSnapshotFile } from "../emulator";
import { offsetsFromSymbols, verifyTradeBlock, BLOCK } from "./invariants";
import { ckptPath, romPath } from "../fixtures";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, note = "") => { c ? (pass++, console.log(`PASS ${n} :: ${note}`)) : (fail++, console.log(`FAIL ${n} :: ${note}`)); };

const sym = new SymbolTable(romPath("pokeblue.sym"));
const O = offsetsFromSymbols(sym);

function realBlock(): number[] {
  const emu = new Emulator(romPath("pokeblue.gb"));
  loadSnapshotFile(emu, ckptPath("center-m2b.state.gz"));
  emu.frames(4);
  const m = emu.mem();
  const rd = (a: number, n: number) => Array.from({ length: n }, (_, i) => m[a + i] & 0xFF);
  return [...rd(sym.addr("wPlayerName"), BLOCK.nameLen), m[sym.addr("wPartyCount")] & 0xFF,
    ...rd(sym.addr("wPartySpecies"), BLOCK.speciesListLen),
    ...rd(sym.addr("wPartyMon1"), BLOCK.maxSlots * BLOCK.structSize),
    ...rd(sym.addr("wPartyMonOT"), BLOCK.maxSlots * BLOCK.nameLen),
    ...rd(sym.addr("wPartyMonNicks"), BLOCK.maxSlots * BLOCK.nameLen)];
}

/** master streams `block`; slave stages nothing; returns bytes the slave got. */
async function shipOverWire(block: number[], port: number, corrupt?: (b: number[]) => void): Promise<number[]> {
  const got: number[] = [];
  const slave = new BgbLink({ onMasterByte: (d) => { got.push(d & 0xFF); return 0x00; } });
  await slave.listen(port, "127.0.0.1");
  const master = new BgbLink({ onSlaveByte: () => {} });
  await master.connect(port, "127.0.0.1");
  for (let i = 0; i < 200 && !(master.ready && slave.ready); i++) await sleep(5);
  const send = block.slice(); if (corrupt) corrupt(send);
  for (const b of send) { master.sendMaster(b); await sleep(0); }
  for (let i = 0; i < 400 && got.length < send.length; i++) await sleep(5);
  master.close(); slave.close();
  return got;
}

(async () => {
  const good = realBlock();

  // GREEN: clean transit — every byte survives and the block still validates.
  const got = await shipOverWire(good, 9241);
  ok("wire delivered all 415 bytes", got.length === BLOCK.total, `got ${got.length}`);
  ok("wire bytes are byte-exact", got.every((b, i) => b === good[i]), "");
  const v = verifyTradeBlock(got, O);
  ok("GREEN: block validates AFTER real-socket transit", v.ok, v.ok ? `checks=${v.checked.join(",")}` : JSON.stringify(v.failures));

  // RED: a peer that corrupts the block on the wire must be caught downstream.
  const bad = await shipOverWire(good, 9242, b => { b[BLOCK.nameLen + 1 + BLOCK.speciesListLen + O.level] = 0xFF; });
  const bv = verifyTradeBlock(bad, O);
  ok("RED: corrupted-in-transit block is REJECTED", !bv.ok && bv.failures.some(f => f.check === "level_range"),
     bv.ok ? "PASSED(!!)" : bv.failures.map(f => f.check).join(","));

  // RED: an unready peer putting $FE on the wire (the patch-list violation).
  const fe = await shipOverWire(good, 9243, b => { b[BLOCK.nameLen + 1 + BLOCK.speciesListLen + 2] = 0xFE; });
  const fv = verifyTradeBlock(fe, O);
  ok("RED: $FE injected in transit is REJECTED", !fv.ok && fv.failures.some(f => f.check === "no_FE"),
     fv.ok ? "PASSED(!!)" : fv.failures.map(f => f.check).join(","));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
