// M4 DUEL driver (wq#432) — two brains, two BrainProfiles, one link cable.
//
//   npx tsx src/link/drive_duel.ts
//   LPP_DUEL_A_MODEL=qwen36-local LPP_DUEL_B_MODEL=cerebras-oss-120b \
//     DUEL_PORT=8899 npx tsx src/link/drive_duel.ts
//
// Standalone — never inside the live service. The link mechanics are M3-verified
// and untouched; the brains only ever choose a move slot (see duel.ts).

import { Emulator, loadSnapshotFile } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { moveLabel } from "../moves";
import { writeIdentity } from "./identity";
import { LinkBattleSession, BattleSide, BattleView } from "./battle";
import { DuelBrain, duelProfile } from "./duel";
import { DuelStream } from "./duel_stream";

function side(tag: string): BattleSide {
  const emu = new Emulator("roms/pokeblue.gb");
  const sym = new SymbolTable("roms/pokeblue.sym");
  const rom = new Rom("roms/pokeblue.gb");
  const ebus = new EventBus("events", `duel-${tag}-${Date.now()}`);
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
  // Trainer identity only — never level (see M3_BATTLE.md, fixture note).
  writeIdentity(B.emu.mem(), { playerName: "BOB", playerID: 0x1122, mon1Nick: "BOBMON" });

  const bus = new EventBus("events", `duel-brains-${Date.now()}`);
  const profA = duelProfile("A", "cerebras-oss-120b");
  const profB = duelProfile("B", "deepseek-v4-flash");
  const brainA = new DuelBrain("A", profA, bus, console.log);
  const brainB = new DuelBrain("B", profB, bus, console.log);
  console.log(`A brain = ${profA.model}   B brain = ${profB.model}`);

  const port = Number(process.env.DUEL_PORT ?? 0);
  const stream = port ? new DuelStream(port) : null;
  const hud = (v: BattleView, model: string, tokens: number, move: string) =>
    stream?.send({ kind: "hud", side: v.tag, model, hp: v.myHp, maxHp: v.myMaxHp,
                   turn: v.turn, tokens, move });

  const session = new LinkBattleSession(A, B, {
    maxRounds: Number(process.env.ROUNDS ?? 1600),
    fineDiv: Number(process.env.FINE ?? 64),
    onFrame: stream ? (tag, png) => stream.frame(tag, png) : null,
    pickMove: async (v: BattleView) => {
      const brain = v.tag === "A" ? brainA : brainB;
      const slot = await brain.pick(v);
      const st = brain.stats;
      hud(v, st.model, st.promptTokens + st.completionTokens,
          slot >= 0 ? moveLabel(v.moves[slot]) : "(fallback)");
      stream?.send({ kind: "log", text: `${v.tag} turn ${v.turn}: ${st.model} -> ` +
        (slot >= 0 ? moveLabel(v.moves[slot]) : "fallback slot") });
      return slot;
    },
  });

  const r = await session.run();

  console.log("\n================ DUEL RESULT ================");
  console.log(`started=${r.started} ended=${r.ended} turns=${r.turns.length} mirrored=${r.mirroredTurns} ` +
              `rngMatch=${r.rngListsMatch} exchanges=${r.exchanges} winner=${r.winner}`);
  for (const b of [brainA, brainB]) {
    const s = b.stats;
    console.log(`  ${s.tag} ${s.model}: calls=${s.calls} parsed=${s.parsed} rejected=${s.rejected} ` +
      `picks=[${s.picks.join(",")}] tok=${s.promptTokens}+${s.completionTokens} ` +
      `avg=${s.calls ? Math.round(s.msTotal / s.calls) : 0}ms`);
  }
  for (const t of r.turns) {
    console.log(`  r${t.round}: A ${moveLabel(t.aPlayerMove)} hp ${t.aHp}(foe ${t.aFoeHp}) | ` +
                `B ${moveLabel(t.bPlayerMove)} hp ${t.bHp}(foe ${t.bFoeHp}) | mirror=${t.mirrored}`);
  }
  console.log(r.note);
  // The duel PASSES on link integrity — every turn mirrored, shared RNG list —
  // plus both brains actually having chosen. Who wins is not a pass condition.
  const bothChose = brainA.stats.parsed > 0 && brainB.stats.parsed > 0;
  const pass = r.started && r.turns.length > 0 && r.mirroredTurns === r.turns.length &&
               r.rngListsMatch && bothChose;
  console.log(pass ? `*** DUEL VERIFIED — ${profA.model} vs ${profB.model}, winner ${r.winner} ***`
                   : "--- NOT VERIFIED ---");
  process.exit(pass ? 0 : 1);
})();
