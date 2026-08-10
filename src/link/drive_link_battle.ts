// M3 LINK BATTLE end-to-end driver (wq#431, 2026-08-10).
// Two independent serverboy cores fight a real Gen1 Cable Club link battle over
// our SerialBus. Standalone — never inside the live service.
//
//   npx tsx src/link/drive_link_battle.ts
//   SLOT_A=0 SLOT_B=1 ROUNDS=120 npx tsx src/link/drive_link_battle.ts

import { Emulator, loadSnapshotFile } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { writeIdentity } from "./identity";
import { readParty, describeParty } from "./party";
import { LinkBattleSession, BattleSide } from "./battle";

function side(tag: string): BattleSide {
  const emu = new Emulator("roms/pokeblue.gb");
  const sym = new SymbolTable("roms/pokeblue.sym");
  const rom = new Rom("roms/pokeblue.gb");
  const ebus = new EventBus("events", `m3b-${tag}-${Date.now()}`);
  const map = new MapModel(emu, sym, rom);
  const scr = new Screen(emu, sym);
  const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync);
  return { tag, emu, sym, nav, scr };
}

(async () => {
  const snap = process.env.SNAP ?? "checkpoints/center-m2b.state.gz";
  const A = side("A"), B = side("B");
  loadSnapshotFile(A.emu, snap); loadSnapshotFile(B.emu, snap);
  A.emu.frames(6); B.emu.frames(6);

  // Differentiate B before any link traffic. Two clones make every check blind
  // — the lesson that cost several sessions in M3 trade (see trade.ts header).
  // Differentiate by TRAINER and NICKNAME only — deliberately NOT by level.
  // Rewriting mon1Level does not recompute the stat block, so the sending side
  // keeps its old HP while the receiving side recalculates from the level it
  // was sent, and the two views of the same mon disagree by construction. That
  // is an artifact of the test fixture, not a link fault, and it would poison
  // the HP-mirror check. Same level, same DVs, consistent stats both sides.
  writeIdentity(B.emu.mem(), { playerName: "BOB", playerID: 0x1122, mon1Nick: "BOBMON" });
  console.log(`A party:\n        ${describeParty(readParty(A.emu.mem()))}`);
  console.log(`B party:\n        ${describeParty(readParty(B.emu.mem()))}`);

  const session = new LinkBattleSession(A, B, {
    moveSlotA: Number(process.env.SLOT_A ?? 0),
    moveSlotB: Number(process.env.SLOT_B ?? 0),
    maxRounds: Number(process.env.ROUNDS ?? 120),
    fineDiv: Number(process.env.FINE ?? 64),
  });
  const r = await session.run();

  console.log("\n================ LINK BATTLE RESULT ================");
  console.log(`started=${r.started} ended=${r.ended} turns=${r.turns.length} mirrored=${r.mirroredTurns} ` +
              `rngMatch=${r.rngListsMatch} exchanges=${r.exchanges} winner=${r.winner}`);
  for (const t of r.turns) {
    console.log(`  r${t.round}: A move=${t.aPlayerMove} sees foe=${t.aEnemyMove} hp=${t.aHp}/foe=${t.aFoeHp} | ` +
                `B move=${t.bPlayerMove} sees foe=${t.bEnemyMove} hp=${t.bHp}/foe=${t.bFoeHp} | mirror=${t.mirrored}`);
  }
  console.log(r.note);
  const pass = r.started && r.turns.length > 0 && r.mirroredTurns === r.turns.length && r.rngListsMatch;
  console.log(pass ? "*** LINK BATTLE VERIFIED — turn exchange mirrors on both cores ***"
                   : "--- NOT VERIFIED ---");
  process.exit(pass ? 0 : 1);
})();
