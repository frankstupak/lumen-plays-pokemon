// M3 entry point: a complete, verifiable Cable Club trade between two cores.
// Standalone driver — DRIVES emulators, never run inside the live service.
//
//   npx tsx src/link/drive_trade_e2e.ts
//   FINE=64 SNAP=checkpoints/center-m2b.state.gz npx tsx src/link/drive_trade_e2e.ts
//
// Side B is deliberately made a DIFFERENT trainer before any link traffic. That
// is not cosmetic: two cores booted from one snapshot are byte-identical, and a
// trade between clones cannot be distinguished from a failed trade. See the
// header of src/link/identity.ts.

import { Emulator, loadSnapshotFile, saveSnapshotFile } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { writeIdentity, describeMon } from "./identity";
import { TradeSession, TradeSide } from "./trade";

function side(tag: string): TradeSide {
  const emu = new Emulator("roms/pokeblue.gb");
  const sym = new SymbolTable("roms/pokeblue.sym");
  const rom = new Rom("roms/pokeblue.gb");
  const ebus = new EventBus("events", `m3-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync);
  return { tag, emu, nav, scr };
}

(async () => {
  const snap = process.env.SNAP ?? "checkpoints/center-m2b.state.gz";
  const A = side("A"), B = side("B");
  loadSnapshotFile(A.emu, snap);
  loadSnapshotFile(B.emu, snap);
  A.emu.frames(6); B.emu.frames(6);

  // Differentiate B *before* the party block crosses the cable, so the new
  // identity is what the partner actually receives.
  writeIdentity(B.emu.mem(), { playerName: "BOB", playerID: 0x1122, mon1Level: 25, mon1Nick: "BOBMON" });

  const t0 = Date.now();
  const session = new TradeSession(A, B, {
    fineDiv: Number(process.env.FINE ?? 64),
    catchUpCycles: Number(process.env.CUCYCLES ?? 64),
    catchUpMaxSteps: Number(process.env.CUSTEPS ?? 256),
    peerCatchUp: process.env.CATCHUP !== "0",
  });
  const r = await session.run();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n================ TRADE RESULT ================");
  console.log(`A before ${describeMon(r.aBefore.mon1)}`);
  console.log(`A after  ${describeMon(r.aAfter.mon1)}`);
  console.log(`B before ${describeMon(r.bBefore.mon1)}`);
  console.log(`B after  ${describeMon(r.bAfter.mon1)}`);
  console.log(`exchanges=${r.exchanges} rendezvousAttempts=${r.rendezvousAttempts} wallSeconds=${secs} CUSTEPS=${process.env.CUSTEPS ?? 256}`);
  console.log(r.swapped ? `*** TRADE VERIFIED — ${r.note} ***` : `--- ${r.note} ---`);
  if (r.swapped && process.env.SAVE === "1") {
    saveSnapshotFile(A.emu, "checkpoints/m3-traded-A.state.gz");
    saveSnapshotFile(B.emu, "checkpoints/m3-traded-B.state.gz");
    console.log("saved checkpoints/m3-traded-A|B.state.gz");
  }
  process.exit(r.swapped ? 0 : 1);
})();
