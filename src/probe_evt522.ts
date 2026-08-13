// wq#522 acceptance: an event payload can never rewrite the event envelope, and
// the checkpoint event therefore reaches metrics.maxEventCount.
//
// WHY THIS EXISTS SEPARATELY FROM probe_metrics: probe_metrics asserts the
// COUNTER. This asserts the MECHANISM, because the counter was only ever wrong
// due to a field collision that a hand-written fixture happened to avoid. The
// bug survived because the test invented a payload production never sends.
// Usage: npx tsx src/probe_osc522.ts
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "./events";
import { Metrics } from "./metrics";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`);
  ok ? pass++ : fail++;
};

const dir = mkdtempSync(join(tmpdir(), "evt522-"));

// ---------------------------------------------------------- A. envelope wins
console.log("=== A. a payload cannot rewrite the envelope ===");
{
  const bus = new EventBus(dir, "envelope");
  const seen: any[] = [];
  bus.on(e => seen.push(e));

  bus.emit("checkpoint", { file: "x", kind: "periodic", events: 42 } as any);
  chk("A1 a payload `kind` does NOT override the emitted kind",
    seen[0].kind === "checkpoint", `got kind=${seen[0].kind}`);
  chk("A2 the payload's own value is not silently dropped either — it is just not `kind`",
    seen[0].events === 42);

  bus.emit("boot", { t: "1999-01-01T00:00:00.000Z", mode: "x" } as any);
  chk("A3 a payload `t` does not rewrite the timestamp",
    seen[1].t !== "1999-01-01T00:00:00.000Z", `t=${seen[1].t}`);

  // The same guarantee must hold on the JSONL that lands on disk, not only for
  // in-process listeners — every analysis tool reads the file, not the bus.
  const file = readdirSync(dir).map(f => join(dir, f)).find(f => f.includes("envelope"))!;
  const lines = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  chk("A4 the ON-DISK line carries kind=checkpoint", lines[0].kind === "checkpoint",
    `disk kind=${lines[0].kind}`);
  chk("A5 the on-disk line still leads with the timestamp", Object.keys(lines[0])[0] === "t");
}

// ---------------------------------------------------------- B. the real defect
console.log("\n=== B. the production payload reaches maxEventCount ===");
{
  const bus = new EventBus(dir, "metrics");
  const m = new Metrics(bus, "probe522", dir);
  // wq#547/rabbit17b CORRECTION: this fixture used to say `ckptKind: "periodic"`
  // — the POST-FIX field name — so the collision it exists to catch could not
  // occur in it, and B1-B3 scored 3/3 ON THE UNFIXED BUILD. Measured, not
  // argued: with src/{agent,events,probe_metrics}.ts reverted this section
  // returned maxEventCount=25 while the comment claimed it "counted zero".
  // That is the same fault rabbit15 correctly diagnosed and fixed in
  // probe_metrics.ts (whose old fixture OMITTED `kind`), reappearing in the new
  // file written to fix it: omit the field or rename it and the test passes for
  // a reason unrelated to the bug.
  // It now emits the RAW PRE-FIX SHAPE — a sidecar spread carrying its own
  // `kind` — which is exactly what writeCheckpoint used to put on the bus. On a
  // build without the events.ts guard the envelope becomes "periodic",
  // metrics.ts never matches "checkpoint", and B1 reads 0.
  bus.emit("checkpoint", {
    file: "auto-x-t10", kind: "periodic",
    v: 2, map: 61, x: 26, y: 11, badges: 1, events: 25, storyScore: 6,
    maxStoryScore: 6, hpPct: 0.9, ppOk: true, money: 431, ts: Date.now(),
  } as any);
  const s: any = (m as any).m;
  chk("B1 maxEventCount picks up the real sidecar payload", s.maxEventCount === 25,
    `maxEventCount=${s.maxEventCount}`);

  // raw pre-fix shape again, so B2 discriminates too
  bus.emit("checkpoint", { file: "auto-x-t20", kind: "map", events: 31 } as any);
  chk("B2 it tracks the MAXIMUM, not the latest", s.maxEventCount === 31, `=${s.maxEventCount}`);

  bus.emit("checkpoint", { file: "auto-x-t30", ckptKind: "periodic", events: 12 } as any);
  chk("B3 a lower later value does not lower it", s.maxEventCount === 31, `=${s.maxEventCount}`);
}

// ---------------------------------------------------------- C. no regression
console.log("\n=== C. the checkpoint kind distinction is preserved, not deleted ===");
{
  const bus = new EventBus(dir, "kindkept");
  const seen: any[] = [];
  bus.on(e => seen.push(e));
  bus.emit("checkpoint", { file: "f", ckptKind: "milestone", events: 3 } as any);
  chk("C1 periodic/map/milestone still travels, under ckptKind",
    seen[0].ckptKind === "milestone" && seen[0].kind === "checkpoint",
    `ckptKind=${seen[0].ckptKind} kind=${seen[0].kind}`);
}

// ---------------------------------------------------------- D. the wiring
console.log("\n=== D. agent.ts actually emits the de-collided shape ===");
{
  const src = readFileSync(join(__dirname, "agent.ts"), "utf8");
  chk("D1 writeCheckpoint no longer spreads a raw sidecar into the event",
    !/emit\("checkpoint", \{ file: stem, \.\.\.sidecar \}\)/.test(src));
  chk("D2 it destructures the sidecar's kind out first", /kind: ckptKind, \.\.\.sidecarRest/.test(src));
  chk("D3 the on-disk sidecar file is still written with its own `kind` intact",
    /writeFileSync\(path\.replace\(\/\\\.state\\\.gz\$\/, "\.json"\), JSON\.stringify\(sidecar\)\)/.test(src));
  const ev = readFileSync(join(__dirname, "events.ts"), "utf8");
  chk("D4 EventBus pins the envelope AFTER the payload spread",
    /\{ t: "", \.\.\.data, kind \}/.test(ev) && /e\.t = new Date\(\)\.toISOString\(\)/.test(ev));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nprobe_evt522: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
