// M3 PARTY-SIZE SWEEP (2026-08-10).
//
// Closes the last untested dimension of the trade: party size. Runs a full
// cold-start trade for each size 1..6 on both sides, always offering the LAST
// slot, which is the one immediately before CANCEL in the list — the worst case
// for the cursor walk, because one extra DOWN lands on CANCEL and kills the
// session (wLinkState 50 -> 1).
//
// Size 6 is the full-party edge case: Gen1 removes the offered mon before
// inserting the received one, so a 6-mon party has room, but this is exactly
// where an off-by-one in the party rewrite would show up.
//
//   npx tsx src/link/drive_trade_partysweep.ts
//   SIZES=1,6 npx tsx src/link/drive_trade_partysweep.ts

import { Emulator, loadSnapshotFile } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { writeIdentity } from "./identity";
import { addPartyMonClone, readParty, describeParty, partyCount } from "./party";
import { TradeSession, TradeSide } from "./trade";
import { ckptPath, linkEventsDir, romPath } from "../fixtures";

function side(tag: string): TradeSide {
  const emu = new Emulator(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym"));
  const rom = new Rom(romPath("pokeblue.gb"));
  const ebus = new EventBus(linkEventsDir(), `m3ps-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync);
  return { tag, emu, nav, scr };
}

interface Row { size: number; ok: boolean; note: string; attempts: number; exchanges: number; secs: string; }

async function runSize(size: number, snap: string): Promise<Row> {
  const A = side("A"), B = side("B");
  loadSnapshotFile(A.emu, snap);
  loadSnapshotFile(B.emu, snap);
  A.emu.frames(6); B.emu.frames(6);

  writeIdentity(B.emu.mem(), { playerName: "BOB", playerID: 0x1122, mon1Level: 25, mon1Nick: "BOBMON" });
  // Grow both parties to `size`. Slot nicknames encode side and slot so every
  // mon in the run is uniquely identifiable in the verdict.
  const NAMES = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"];
  while (partyCount(A.emu.mem()) < size) {
    const i = partyCount(A.emu.mem());
    addPartyMonClone(A.emu.mem(), { nick: `A${NAMES[i]}`, level: 10 + i });
  }
  while (partyCount(B.emu.mem()) < size) {
    const i = partyCount(B.emu.mem());
    addPartyMonClone(B.emu.mem(), { nick: `B${NAMES[i]}`, level: 40 + i, otid: 0x1122, ot: "BOB" });
  }

  const last = size - 1;   // worst case: the entry directly above CANCEL
  const t0 = Date.now();
  const session = new TradeSession(A, B, {
    offerSlotA: last, offerSlotB: last, wantSlotA: last, wantSlotB: last,
    log: () => {},   // quiet; the sweep prints its own table
  });
  const r = await session.run();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== party size ${size} (offering slot ${last}, the entry above CANCEL) ===`);
  console.log(`A before:\n        ${describeParty(r.aPartyBefore)}`);
  console.log(`A after :\n        ${describeParty(r.aPartyAfter)}`);
  console.log(`B after :\n        ${describeParty(r.bPartyAfter)}`);
  console.log(`  -> ${r.swapped ? "VERIFIED" : "FAILED"}: ${r.note} (attempts=${r.rendezvousAttempts} ex=${r.exchanges} ${secs}s)`);
  // Party size must be preserved: one out, one in.
  if (r.aPartyAfter.length !== size || r.bPartyAfter.length !== size) {
    console.log(`  !! PARTY SIZE CHANGED: A ${r.aPartyBefore.length}->${r.aPartyAfter.length}, B ${r.bPartyBefore.length}->${r.bPartyAfter.length}`);
  }
  return { size, ok: r.swapped && r.aPartyAfter.length === size && r.bPartyAfter.length === size, note: r.note, attempts: r.rendezvousAttempts, exchanges: r.exchanges, secs };
}

(async () => {
  const snap = process.env.SNAP ?? ckptPath("center-m2b.state.gz");
  const sizes = (process.env.SIZES ?? "1,2,3,4,5,6").split(",").map(Number);
  const rows: Row[] = [];
  for (const s of sizes) rows.push(await runSize(s, snap));

  console.log("\n================ PARTY-SIZE SWEEP ================");
  for (const r of rows) {
    console.log(`  size ${r.size}: ${r.ok ? "PASS" : "FAIL"}  ${r.note}  attempts=${r.attempts} ex=${r.exchanges} ${r.secs}s`);
  }
  const bad = rows.filter(r => !r.ok);
  console.log(bad.length === 0 ? `*** ALL ${rows.length} PARTY SIZES VERIFIED ***` : `--- ${bad.length} FAILED: sizes ${bad.map(b => b.size).join(",")} ---`);
  process.exit(bad.length === 0 ? 0 : 1);
})();
