// M3 MULTI-MON trade test (2026-08-10).
//
// M3 was only ever proved with a ONE-MON party on each side, which never
// exercises the list cursor: with one mon, wMaxMenuItem is 1, the cursor sits
// on slot 0 already and CANCEL is the only other entry. This builds two-mon
// parties and trades a NON-FIRST slot, so DOWN, the cursor read-back and the
// CANCEL boundary all get exercised.
//
// This is the riskiest untested path before M4 hands the link to two agents:
// DOWN on a party list walks toward CANCEL, and selecting CANCEL aborts the
// whole session (wLinkState 50 -> 1, bus goes quiet).
//
//   npx tsx src/link/drive_trade_multimon.ts
//   OFFER_A=1 OFFER_B=1 WANT_A=1 WANT_B=1 npx tsx src/link/drive_trade_multimon.ts

import { Emulator, loadSnapshotFile } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { writeIdentity } from "./identity";
import { addPartyMonClone, readParty, describeParty } from "./party";
import { TradeSession, TradeSide } from "./trade";
import { ckptPath, linkEventsDir, romPath } from "../fixtures";

function side(tag: string): TradeSide {
  const emu = new Emulator(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym"));
  const rom = new Rom(romPath("pokeblue.gb"));
  const ebus = new EventBus(linkEventsDir(), `m3mm-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync);
  return { tag, emu, nav, scr };
}

(async () => {
  const snap = process.env.SNAP ?? ckptPath("center-m2b.state.gz");
  const A = side("A"), B = side("B");
  loadSnapshotFile(A.emu, snap);
  loadSnapshotFile(B.emu, snap);
  A.emu.frames(6); B.emu.frames(6);

  // Side A keeps its own trainer; side B becomes BOB. Then each grows a second
  // slot with a distinct nickname/level/OTID so every slot is identifiable.
  addPartyMonClone(A.emu.mem(), { nick: "ALPHATWO", level: 30 });
  writeIdentity(B.emu.mem(), { playerName: "BOB", playerID: 0x1122, mon1Level: 25, mon1Nick: "BOBMON" });
  addPartyMonClone(B.emu.mem(), { nick: "BOBTWO", level: 35, otid: 0x1122, ot: "BOB" });

  console.log(`A party:\n        ${describeParty(readParty(A.emu.mem()))}`);
  console.log(`B party:\n        ${describeParty(readParty(B.emu.mem()))}`);

  const session = new TradeSession(A, B, {
    fineDiv: Number(process.env.FINE ?? 64),
    offerSlotA: Number(process.env.OFFER_A ?? 1),
    offerSlotB: Number(process.env.OFFER_B ?? 1),
    wantSlotA: Number(process.env.WANT_A ?? 1),
    wantSlotB: Number(process.env.WANT_B ?? 1),
  });
  const r = await session.run();

  console.log("\n================ MULTI-MON TRADE RESULT ================");
  console.log(`A before:\n        ${describeParty(r.aPartyBefore)}`);
  console.log(`A after :\n        ${describeParty(r.aPartyAfter)}`);
  console.log(`B before:\n        ${describeParty(r.bPartyBefore)}`);
  console.log(`B after :\n        ${describeParty(r.bPartyAfter)}`);
  console.log(`exchanges=${r.exchanges} rendezvousAttempts=${r.rendezvousAttempts} blind=${r.blind}`);
  console.log(r.swapped ? `*** MULTI-MON TRADE VERIFIED — ${r.note} ***` : `--- ${r.note} ---`);
  process.exit(r.swapped ? 0 : 1);
})();
