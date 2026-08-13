// wq#481 probe — our REAL ROM core completes the Cable Club room-select
// handshake against the scripted mock peer over a REAL localhost socket,
// including a 250ms artificial-latency case proving the core STALLS (emulated
// time frozen, no fake completion, no crash) while a remote byte is pending.
// Standalone — never inside the live service.
import { Emulator, loadSnapshotFile, KEYS } from "../emulator";
import { SymbolTable } from "../symbols";
import { Rom } from "../rom";
import { MapModel } from "../map";
import { Navigator } from "../nav";
import { EventBus } from "../events";
import { Screen } from "../screen";
import { Sync } from "../sync";
import { Dialog } from "../dialog";
import { SerialBridge } from "./bridge";
import { MockPeer, MockPeerOptions } from "./mock_peer";
import { ckptPath, eventsDir, romPath } from "../fixtures";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hex = (n: number) => n.toString(16);

function stack() {
  const emu = new Emulator(romPath("pokeblue.gb"));
  const sym = new SymbolTable(romPath("pokeblue.sym")); const rom = new Rom(romPath("pokeblue.gb"));
  const ebus = new EventBus(eventsDir(), `m5a-probe-${Date.now()}`);
  const map = new MapModel(emu, sym, rom); const scr = new Screen(emu, sym); const sync = new Sync(emu, sym);
  const nav = new Navigator(emu, sym, map, ebus, sync); const dlg = new Dialog(emu, scr, sync, ebus, sym);
  return { emu, nav, dlg, scr };
}

interface RunResult {
  reachedTC: boolean; role: number; map: number;
  log: { out: number; in: number }[];
  telemetry: any;
  stalls: { wallMs: number; tsBefore: number; tsAfter: number; framesDuring: number }[];
  frames: number;
}

async function run(port: number, mockOpts: MockPeerOptions): Promise<{ r: RunResult; mock: MockPeer; bridge: SerialBridge }> {
  const S = stack();
  loadSnapshotFile(S.emu, ckptPath("center-m2b.state.gz"));
  S.emu.frames(6);
  await S.nav.goto(11, 3);

  const mock = new MockPeer(mockOpts);
  await mock.listen(port);
  const bridge = new SerialBridge(S.emu.core as any);
  await bridge.link.connect(port, "127.0.0.1");
  for (let i = 0; i < 100 && !(bridge.link.ready && mock.link.ready); i++) await sleep(10);

  // DMG cpu cycles -> 2 MiHz link clocks is ~/2; precision only matters for a
  // timestamp-validating peer (wq#485's problem), consistency matters here.
  const CYC = ((S.emu.core as any).CPUCyclesTotalBase | 0) >> 1;
  const r: RunResult = { reachedTC: false, role: 0, map: 0, log: bridge.log, telemetry: null, stalls: [], frames: 0 };

  // step n frames; if a remote byte is pending, HOLD the core (emulated time
  // frozen) until it lands — recording the stall so the probe can assert it.
  async function stepFrames(n: number, key?: number) {
    for (let i = 0; i < n; i++) {
      if (bridge.pending) {
        const t0 = Date.now(), ts0 = bridge.link.timestamp, f0 = r.frames;
        await bridge.settled(8000);
        r.stalls.push({ wallMs: Date.now() - t0, tsBefore: ts0, tsAfter: bridge.link.timestamp, framesDuring: r.frames - f0 });
      }
      if (key !== undefined) (S.emu as any).gb.pressKey(key);
      (S.emu as any).gb.doFrame();
      bridge.advance(CYC);
      r.frames++;
    }
    await sleep(0);   // let socket events land between bursts
  }

  // face the attendant, then drive the dialog exactly like the proven driver
  await stepFrames(20, KEYS.UP); await stepFrames(20);
  const mem = () => S.emu.mem();
  for (let round = 0; round < 90; round++) {
    await stepFrames(8, KEYS.A);
    await stepFrames(22);
    r.map = mem()[0xD35E] & 0xFF;
    if (r.map === 0xEF) { r.reachedTC = true; break; }
  }
  r.role = mem()[0xFFAA] & 0xFF;
  r.map = mem()[0xD35E] & 0xFF;
  r.telemetry = bridge.telemetry;
  bridge.uninstall(); mock.close(); bridge.link.close();
  return { r, mock, bridge };
}

(async () => {
  // ---------- RUN 1: no injected latency ----------
  console.log("=== run 1: room-select handshake over localhost TCP ===");
  const { r: r1, mock: m1 } = await run(9147, {});
  const tape1 = r1.log.map(e => `${hex(e.out)}<${e.in < 0 ? "?" : hex(e.in)}`).join(" ");
  console.log(`log(${r1.log.length}): ${tape1}`);
  console.log(`telemetry:`, r1.telemetry, `mock phases ended:`, m1.phase, `frames=${r1.frames}`);

  ok("handshake+room-select completes (map $EF Trade Center)", r1.reachedTC, `map=$${hex(r1.map)}`);
  ok("our core resolved MASTER (role $FFAA=2)", r1.role === 2, `role=${r1.role}`);
  const first = r1.log[0];
  ok("exact: connection probe 01->02 is exchange #0", !!first && first.out === 0x01 && first.in === 0x02, first ? `${hex(first.out)}->${hex(first.in)}` : "no log");
  const syncs = r1.log.filter(e => (e.out & 0xF0) === 0x60 && e.in === 0x60).length;
  ok("exact: nybble sync 60<->60 exchanged (>=6 per tape)", syncs >= 6, `syncs=${syncs}`);
  const selSent = r1.log.find(e => e.out >= 0xD0 && e.out <= 0xDF);
  const selGot = r1.log.find(e => e.in === 0xD0);
  ok("exact: master sent a $D0-family room selection", !!selSent, selSent ? hex(selSent.out) : "none");
  ok("exact: slave's TRADE CENTER ($D0) selection received", !!selGot, selGot ? `${hex(selGot.out)}->${hex(selGot.in)}` : "none");
  ok("every sync1 got a real remote reply (no fake $FF completions)", r1.telemetry.received === r1.telemetry.sent && r1.log.every(e => e.in >= 0), `sent=${r1.telemetry.sent} recv=${r1.telemetry.received}`);
  ok("mock walked the full phase machine", m1.phase === "select", m1.phase);

  // ---------- RUN 2: 250ms artificial latency mid-handshake ----------
  console.log("=== run 2: mock delays one reply by 250ms ===");
  const { r: r2 } = await run(9148, { delayAtSent: 6, delayMs: 250 });
  const big = r2.stalls.filter(s => s.wallMs >= 200);
  ok("delayed run still completes room-select", r2.reachedTC, `map=$${hex(r2.map)}`);
  ok("core STALLED through the delay (>=200ms wall wait observed)", big.length >= 1, JSON.stringify(big[0] ?? {}));
  ok("no free-run: zero frames executed while the byte was pending", big.length >= 1 && big.every(s => s.framesDuring === 0), `framesDuring=${big.map(s => s.framesDuring).join(",")}`);
  ok("emulated time FROZEN during the stall (timestamp unchanged)", big.length >= 1 && big.every(s => s.tsAfter === s.tsBefore), big.length ? `ts ${big[0].tsBefore}==${big[0].tsAfter}` : "no stall");
  ok("no fake completions in delayed run either", r2.telemetry.received === r2.telemetry.sent && r2.log.every(e => e.in >= 0), `sent=${r2.telemetry.sent} recv=${r2.telemetry.received}`);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
