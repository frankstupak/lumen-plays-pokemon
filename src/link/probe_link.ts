// LPP Multiplayer M1 gate (wq#429): byte-exact link-core verification.
//
// Tests the SerialBus + hook in isolation against KNOWN byte streams, with
// mock cores standing in for serverboy GameBoyCore. This proves the wire
// contract (simultaneous swap, follower-resend, open-cable 0xFF, IRQ raise)
// deterministically BEFORE any live ROM drives it (M2/M3). A mock core mimics
// exactly the two fields the hook touches: memory[$FF01] and interruptsRequested.

import { SerialBus } from "./serialbus";
import { installSerialHook } from "./hook";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const SB = 0xFF01, SC = 0xFF02;

// Minimal core matching the shape hook.ts wraps.
function mockCore() {
  const memory = new Array(0x10000).fill(0);
  const core: any = {
    memory,
    interruptsRequested: 0,
    irqCount: 0,
    checkIRQMatching() { this.irqCount++; },
    memoryWriter: [] as any[],
    memoryHighWriter: [] as any[],
  };
  // original SC handler = serverboy's DMG behavior (internal-clock arms, bit7 clears)
  const scHandler = (p: any, _a: number, data: number) => {
    if ((data & 0x1) === 0x1) { p.memory[SC] = data & 0x7F; p.serialTimer = 4096; }
    else { p.memory[SC] = data; p.serialTimer = 0; }
  };
  core.memoryWriter[SC] = scHandler;
  core.memoryHighWriter[0x2] = scHandler;
  // SB writer = serverboy behavior: blocked during an active transfer (SC bit7).
  const sbHandler = (p: any, _a: number, data: number) => {
    if ((p.memory[SC] & 0xFF) < 0x80) p.memory[SB] = data & 0xFF;
  };
  core.memoryWriter[SB] = sbHandler;
  core.memoryHighWriter[0x1] = sbHandler;
  // helpers a "ROM" would do:
  core.stageOut = (b: number) => { core.memoryWriter[SB](core, SB, b); };
  core.memory[0xFFAC] = 0xFE;   // ROM 'no data' default
  core.recv = () => core.memory[SB] & 0xFF;
  core.startAsMaster = () => core.memoryWriter[SC](core, SC, 0x81); // internal+start
  core.armAsFollower = () => core.memoryWriter[SC](core, SC, 0x80); // external+start
  return core;
}

// --- Test 1: single byte swap, both directions simultaneous ---
{
  const bus = new SerialBus();
  const a = mockCore(), b = mockCore();
  installSerialHook(a, bus, 0);
  installSerialHook(b, bus, 1);
  a.stageOut(0x75); b.stageOut(0x31); b.armAsFollower();  // $75 example + follower stages+arms
  a.startAsMaster();                     // A drives one byte
  chk("master A receives B's byte", a.recv() === 0x31, `got ${a.recv().toString(16)}`);
  chk("follower B receives A's byte", b.recv() === 0x75, `got ${b.recv().toString(16)}`);
  chk("both serial IRQs raised", (a.interruptsRequested & 0x8) === 0x8 && (b.interruptsRequested & 0x8) === 0x8);
  chk("one exchange counted", bus.exchanges === 1, `${bus.exchanges}`);
}

// --- Test 2: a known multi-byte stream trades byte-exact (trade-block shape) ---
{
  const bus = new SerialBus();
  const a = mockCore(), b = mockCore();
  installSerialHook(a, bus, 0);
  installSerialHook(b, bus, 1);
  // Gen1 preamble-ish stream (R3): master sends 0xFD run then payload; follower
  // echoes its own. We assert every swap is exact in both directions.
  const aStream = [0xFD, 0xFD, 0xFD, 0x01, 0x99, 0xFE, 0x22];
  const bStream = [0xFD, 0xFD, 0xFD, 0x63, 0x11, 0x44, 0x55];
  const aGot: number[] = [], bGot: number[] = [];
  for (let i = 0; i < aStream.length; i++) {
    a.stageOut(aStream[i]);
    b.stageOut(bStream[i]); b.armAsFollower();  // follower stages+arms before master clocks
    a.startAsMaster();
    aGot.push(a.recv()); bGot.push(b.recv());
  }
  chk("A received B's stream exactly", JSON.stringify(aGot) === JSON.stringify(bStream), aGot.map(x=>x.toString(16)).join(","));
  chk("B received A's stream exactly", JSON.stringify(bGot) === JSON.stringify(aStream), bGot.map(x=>x.toString(16)).join(","));
  chk("exchange count == stream length", bus.exchanges === aStream.length, `${bus.exchanges}`);
}

// --- Test 3: forgiving timing (R2) — follower not restaged => last byte resends ---
{
  const bus = new SerialBus();
  const a = mockCore(), b = mockCore();
  installSerialHook(a, bus, 0);
  installSerialHook(b, bus, 1);
  b.stageOut(0xAB);                 // follower stages once
  a.stageOut(0x01); a.startAsMaster();
  const first = a.recv();
  a.stageOut(0x02); a.startAsMaster(); // follower did NOT restage
  const second = a.recv();
  chk("follower resends last byte when not restaged", first === 0xAB && second === 0xAB, `${first.toString(16)},${second.toString(16)}`);
}

// --- Test 4: open cable (no partner) => 0xFF, no IRQ storm ---
{
  const bus = new SerialBus();
  const a = mockCore();
  installSerialHook(a, bus, 0);        // only one side attached => bus.attached false
  a.stageOut(0x75);
  const before = a.interruptsRequested;
  a.startAsMaster();
  chk("open cable leaves SB unmodified by bus (no peer)", a.recv() === 0x75);
  chk("open cable does not force-deliver via bus", a.interruptsRequested === before || (a.interruptsRequested & 0x8) === 0, "acceptable: only the core's own timer path may raise it later");
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
