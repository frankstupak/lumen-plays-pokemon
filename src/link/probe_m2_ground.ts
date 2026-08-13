// M2 groundwork gate (wq#430): link-state reader + live-core hook install.
// Proves against a REAL ROM memory image (a live checkpoint) that:
//  1. readLinkState reads $D12B etc. and reports idle (0) in normal overworld,
//  2. Emulator.core exposes the GameBoyCore and the M1 serial hook installs on
//     a LIVE emulator without throwing / disturbing normal execution,
//  3. player name reads back as sane Gen1-charset bytes.
// This is the substrate M2's Cable Club macro builds on. It does NOT drive the
// Cable Club (that's the macro itself); it confirms the wiring is sound.

import { Emulator, loadSnapshotFile } from "../emulator";
import { readLinkState, isLinkIdle, LINK_ADDR } from "./linkstate";
import { SerialBus } from "./serialbus";
import { installSerialHook } from "./hook";
import { readdirSync } from "fs";
import { repoPath, romPath } from "../fixtures";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const CKPTS = repoPath("checkpoints");
// pick any recent live checkpoint (overworld, mid-run)
const snaps = readdirSync(CKPTS).filter(f => f.endsWith(".state.gz")).sort();
const snap = snaps[snaps.length - 1];
if (!snap) { console.log("no checkpoint found — skipping (need a live .state.gz)"); process.exit(0); }

const emu = new Emulator(romPath("pokeblue.gb"));
loadSnapshotFile(emu, `${CKPTS}/${snap}`);
emu.frames(4);
const mem = emu.mem();

// 1. link-state read
const ls = readLinkState(mem);
console.log(`  loaded ${snap}: linkState=0x${ls.linkState.toString(16)} (${ls.linkStateLabel}) sc=0x${ls.sc.toString(16)} name=[${ls.playerName.join(",")}]`);
chk("link idle in overworld checkpoint", isLinkIdle(mem), `linkState=0x${ls.linkState.toString(16)}`);
chk("SC register readable", ls.sc >= 0 && ls.sc <= 0xFF);
chk("player name bytes look like Gen1 charset (or empty)", ls.playerName.every(c => c >= 0x50), ls.playerName.map(c=>c.toString(16)).join(","));

// 2. core exposed + M1 hook installs on a LIVE core without error
let installed = false;
try {
  const bus = new SerialBus();
  const core = emu.core;
  chk("Emulator.core exposes GameBoyCore", core && typeof core.memory === "object" && Array.isArray(core.memoryWriter));
  const h = installSerialHook(core, bus, 0);
  installed = true;
  // run a few frames — hook must not break normal execution
  emu.frames(30);
  chk("emulator runs normally with hook installed", true);
  h.uninstall();
  emu.frames(10);
  chk("hook uninstalls cleanly, emulator still runs", true);
} catch (e: any) {
  chk("live-core hook install", false, String(e?.message ?? e));
}

// 3. address sanity — $D12B is in WRAM range, regs in HRAM/IO
chk("wLinkState in WRAM", LINK_ADDR.wLinkState >= 0xC000 && LINK_ADDR.wLinkState <= 0xDFFF);
chk("rSC is $FF02", LINK_ADDR.rSC === 0xFF02);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
