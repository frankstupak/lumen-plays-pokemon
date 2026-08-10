// M2b sandbox probe (wq#434): two LIVE cores on one SerialBus under real ROM
// execution. Runs ONLY in the sandbox (its own dirs; live run untouched).
//
// Goal for this first live-drive step: prove the plumbing end-to-end with real
// GameBoyCores (not the mock from probe_link) —
//   1. two Emulators load the same seed, both attach to one SerialBus,
//   2. run frames in lockstep; the hooks stay installed without breaking exec,
//   3. observe wLinkState on both (expected NONE=0 in overworld — neither ROM is
//      in the Cable Club yet, so no exchange should fire: this establishes the
//      inert baseline before the attendant macro drives them into link mode),
//   4. sanity: if we synthetically stage SB on both and force one to master via a
//      direct SC write, the bus exchanges a real byte between two real cores.
//
// Step 4 is the key new proof over M1: the byte-swap works between two ACTUAL
// serverboy cores, through the real memoryWriter chain, not mocks.

import { Emulator, loadSnapshotFile } from "../emulator";
import { readLinkState } from "./linkstate";
import { SerialBus } from "./serialbus";
import { installSerialHook } from "./hook";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const SEED = "checkpoints/seed-m2b.state.gz";
const SB = 0xFF01, SC = 0xFF02;

const a = new Emulator("roms/pokeblue.gb");
const b = new Emulator("roms/pokeblue.gb");
loadSnapshotFile(a, SEED);
loadSnapshotFile(b, SEED);
a.frames(2); b.frames(2);

const bus = new SerialBus();
const ha = installSerialHook(a.core, bus, 0);
const hb = installSerialHook(b.core, bus, 1);

// baseline: both idle, bus inert while running normal overworld frames
const before = bus.exchanges;
for (let i = 0; i < 60; i++) { a.frames(1); b.frames(1); }
const lsa = readLinkState(a.mem()), lsb = readLinkState(b.mem());
console.log(`  A linkState=0x${lsa.linkState.toString(16)} (${lsa.linkStateLabel})  B linkState=0x${lsb.linkState.toString(16)} (${lsb.linkStateLabel})`);
chk("both cores run 60 frames with hooks installed", true);
chk("bus inert during normal overworld (no spurious exchanges)", bus.exchanges === before, `exchanges=${bus.exchanges - before}`);

// KEY new proof: real-core-to-real-core byte swap through the live memoryWriter chain.
// Stage SB on both via the real SB writer, then force A to master via a real SC write.
const core = (e: Emulator) => e.core;
// ensure SC bit7 clear so SB writes are accepted, then stage
core(a).memory[SC] = 0x00; core(b).memory[SC] = 0x00;
core(a).memoryWriter[SB](core(a), SB, 0x5A);   // A stages 0x5A
core(b).memoryWriter[SB](core(b), SB, 0xC3);   // B stages 0xC3 (follower)
core(b).memoryWriter[SC](core(b), SC, 0x80);   // B arms as follower (external)
core(a).memoryWriter[SC](core(a), SC, 0x81);   // A masters (internal + start) -> exchange
const aRecv = core(a).memory[SB] & 0xFF;
const bRecv = core(b).memory[SB] & 0xFF;
console.log(`  after forced exchange: A.SB=0x${aRecv.toString(16)} B.SB=0x${bRecv.toString(16)} exchanges=${bus.exchanges}`);
chk("real core A received B's staged byte", aRecv === 0xC3, `0x${aRecv.toString(16)}`);
chk("real core B received A's staged byte", bRecv === 0x5A, `0x${bRecv.toString(16)}`);
chk("exactly one exchange from the forced swap", bus.exchanges === before + 1, `${bus.exchanges - before}`);

// cleanup: uninstall, prove cores still run
ha.uninstall(); hb.uninstall();
a.frames(10); b.frames(10);
chk("both cores run after uninstall", true);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
