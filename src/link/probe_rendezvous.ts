// wq#483 probe — runs the three M5c scenarios as SEPARATE PROCESSES (no shared
// memory between the two sides, exactly like a remote partner) and asserts on
// each side's RESULT line:
//   1. happy path      both sides reach the room
//   2. late join (30s)  the early side waits; both still reach the room
//   3. disconnect       both sides ABORT with a reason, promptly, un-wedged
// Usage: npx tsx src/link/probe_rendezvous.ts
import { spawn } from "child_process";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, note = "") => {
  c ? (pass++, console.log(`PASS ${n} :: ${note}`)) : (fail++, console.log(`FAIL ${n} :: ${note}`));
};

interface SideResult { tag: string; ok: boolean; phase: string; room?: number; yielded: boolean; reason?: string; role: number; map: number; elapsedMs: number; telemetry: any }

function side(env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; res?: SideResult; out: string }> {
  return new Promise(resolve => {
    const p = spawn("npx", ["tsx", "src/link/rdv_side.ts"], {
      cwd: "/home/lumen/pokemon",
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", d => { out += d.toString(); });
    p.stderr.on("data", d => { out += d.toString(); });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    p.on("close", code => {
      clearTimeout(t);
      const m = out.match(/RESULT (\{.*\})/);
      let res: SideResult | undefined;
      try { res = m ? JSON.parse(m[1]) : undefined; } catch {}
      resolve({ code, res, out });
    });
  });
}

const TC = 239;   // $EF Trade Center

(async () => {
  // ---- scenario 1: happy path ----
  console.log("=== 1. happy path (two independent processes) ===");
  const p1a = side({ RDV_ROLE: "listen", RDV_PORT: "9381", RDV_TAG: "A" }, 300000);
  await new Promise(r => setTimeout(r, 3000));
  const p1b = side({ RDV_ROLE: "connect", RDV_PORT: "9381", RDV_TAG: "B" }, 300000);
  const [a1, b1] = await Promise.all([p1a, p1b]);
  ok("happy: side A reached the room", !!a1.res?.ok && a1.res?.map === TC, `phase=${a1.res?.phase} map=${a1.res?.map}`);
  ok("happy: side B reached the room", !!b1.res?.ok && b1.res?.map === TC, `phase=${b1.res?.phase} map=${b1.res?.map}`);
  ok("happy: exactly one side was master (role 2)", [a1.res?.role, b1.res?.role].filter(r => r === 2).length === 1, `roles=${a1.res?.role}/${b1.res?.role}`);
  ok("happy: both agreed on the same room", a1.res?.room === b1.res?.room, `${a1.res?.room}/${b1.res?.room}`);

  // ---- scenario 2: 30s late join ----
  console.log("=== 2. late join: B arrives 30s late ===");
  const p2a = side({ RDV_ROLE: "listen", RDV_PORT: "9382", RDV_TAG: "A" }, 400000);
  const p2b = side({ RDV_ROLE: "connect", RDV_PORT: "9382", RDV_TAG: "B", RDV_DELAY_MS: "30000" }, 400000);
  const [a2, b2] = await Promise.all([p2a, p2b]);
  ok("late join: early side waited, then reached the room", !!a2.res?.ok && a2.res?.map === TC, `elapsed=${a2.res?.elapsedMs}ms`);
  ok("late join: late side reached the room", !!b2.res?.ok && b2.res?.map === TC, `elapsed=${b2.res?.elapsedMs}ms`);
  ok("late join: the early side really did wait >25s", (a2.res?.elapsedMs ?? 0) > 25000, `${a2.res?.elapsedMs}ms`);

  // ---- scenario 3: mid-handshake disconnect ----
  console.log("=== 3. mid-handshake disconnect ===");
  const p3a = side({ RDV_ROLE: "listen", RDV_PORT: "9383", RDV_TAG: "A", RDV_LINGER_MS: "0" }, 200000);
  await new Promise(r => setTimeout(r, 3000));
  const p3b = side({ RDV_ROLE: "connect", RDV_PORT: "9383", RDV_TAG: "B", RDV_DROP_AFTER: "8", RDV_LINGER_MS: "0" }, 200000);
  const [a3, b3] = await Promise.all([p3a, p3b]);
  ok("disconnect: victim ABORTED with a reason (not wedged)", a3.res?.phase === "ABORTED" && !!a3.res?.reason, a3.res?.reason ?? "no result");
  ok("disconnect: dropper ABORTED too", b3.res?.phase === "ABORTED" && !!b3.res?.reason, b3.res?.reason ?? "no result");
  ok("disconnect: both aborted PROMPTLY (<30s, not timeout-bound)",
     (a3.res?.elapsedMs ?? 1e9) < 30000 && (b3.res?.elapsedMs ?? 1e9) < 30000, `A=${a3.res?.elapsedMs}ms B=${b3.res?.elapsedMs}ms`);
  ok("disconnect: cores left in a sane map, not mid-transfer", a3.res?.map !== TC && b3.res?.map !== TC, `maps ${a3.res?.map}/${b3.res?.map}`);
  ok("disconnect: both processes exited (no hung core)", a3.code !== null && b3.code !== null, `exits ${a3.code}/${b3.code}`);

  // ---- scenario 4: WORK IN PROGRESS, NOT PART OF THE GREEN GATE ----------
  // Goal: rendezvous -> 415-byte party exchange -> M5b invariants on the block
  // the peer sent. STATUS 2026-08-13 (wq#483): DOES NOT WORK YET. Measured:
  // both sides rendezvous fine but the block exchange never runs (exchanges=30
  // = the handshake only), so $D887/$D893 still hold uninitialised RAM and the
  // M5b validator correctly rejects it (count=36, level=0, hp>maxHp...) — the
  // validator is behaving right; the driving is not there. Root cause to chase:
  // the in-process 415-byte path needs fine-slicing + peer catch-up
  // (serialbus deferTicks/peerRunner, see lockstep.ts + wq#436); the bridge
  // path has no equivalent, and the seat navigation inside map $EF is
  // unverified. Run explicitly with RDV_PROBE_CONTINUATION=1 while working it.
  if (process.env.RDV_PROBE_CONTINUATION !== "1") {
    console.log("=== 4. continuation: SKIPPED (WIP — set RDV_PROBE_CONTINUATION=1) ===");
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  }
  console.log("=== 4. continuation: party block exchange + M5b invariants (WIP) ===");
  const p4a = side({ RDV_ROLE: "listen", RDV_PORT: "9384", RDV_TAG: "A", RDV_CONTINUE: "block", RDV_LINGER_MS: "45000" }, 600000);
  await new Promise(r => setTimeout(r, 3000));
  const p4b = side({ RDV_ROLE: "connect", RDV_PORT: "9384", RDV_TAG: "B", RDV_CONTINUE: "block", RDV_LINGER_MS: "45000" }, 600000);
  const [a4, b4] = await Promise.all([p4a, p4b]);
  const bc = (o: { out: string }) => { const m = o.out.match(/BLOCKCHECK (\{.*\})/); try { return m ? JSON.parse(m[1]) : undefined; } catch { return undefined; } };
  const ba = bc(a4), bb = bc(b4);
  ok("continuation: both sides rendezvoused", !!a4.res?.ok && !!b4.res?.ok, `${a4.res?.phase}/${b4.res?.phase}`);
  ok("continuation: side A got a block check", !!ba, ba ? `count=${ba.peerCount} slot0=${JSON.stringify(ba.peerSlot0)}` : "none");
  ok("continuation: side B got a block check", !!bb, bb ? `count=${bb.peerCount} slot0=${JSON.stringify(bb.peerSlot0)}` : "none");
  ok("continuation: M5b invariants PASS on A's received block", !!ba?.ok, ba ? JSON.stringify(ba.failures) : "no check");
  ok("continuation: M5b invariants PASS on B's received block", !!bb?.ok, bb ? JSON.stringify(bb.failures) : "no check");
  ok("continuation: bytes actually crossed the bridge", (ba?.exchanges ?? 0) > 100 && (bb?.exchanges ?? 0) > 100, `A=${ba?.exchanges} B=${bb?.exchanges}`);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
