// wq#724: probe for NAV_LOOP escape — supervisor directive loading + ban resolution.
// Self-contained: replicates the loadSupervisorDirective logic so it doesn't
// drag in the full agent.ts dependency tree (emulator, brain, ROM, etc.).
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const ok = (label: string, pass: boolean, detail?: string) =>
  console.log(`${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);

// --- replicate the loader logic exactly as agent.ts implements it ---
interface SupervisorDirective {
  gotoBan: number[];
  mode: string;
  summary: string;
  notepadPin: string;
}

function loadSupervisorDirective(base: string): SupervisorDirective | null {
  const p = join(base, "runtime", "supervisor_directive.json");
  try {
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (!d || !Array.isArray(d.gotoBan) || d.gotoBan.length === 0) return null;
    if (d.mode !== "NAV_LOOP" && d.mode !== "WARP_OSC") return null;
    const bans = d.gotoBan.filter((m: any) => typeof m === "number");
    if (bans.length === 0) return null;   // e.g. old symbolic ["last_loop_target"]
    return {
      gotoBan: bans,
      mode: d.mode,
      summary: d.summary ?? "",
      notepadPin: d.notepadPin ?? "",
    };
  } catch { return null; }
}

const tmp = "/tmp/probe_navloop724";
const runtime = join(tmp, "runtime");

function setup() {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true });
  mkdirSync(runtime, { recursive: true });
}

function cleanup() {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true });
}

// --- loadSupervisorDirective tests ---

setup();
ok("returns null when no file exists",
  loadSupervisorDirective(tmp) === null);

writeFileSync(join(runtime, "supervisor_directive.json"),
  JSON.stringify({ v: 1, mode: "NAV_LOOP", gotoBan: [], summary: "test" }));
ok("returns null when gotoBan is empty",
  loadSupervisorDirective(tmp) === null);

writeFileSync(join(runtime, "supervisor_directive.json"),
  JSON.stringify({ v: 1, mode: "IDLE", gotoBan: [36, 88], summary: "test" }));
ok("returns null for non-loop mode (IDLE)",
  loadSupervisorDirective(tmp) === null);

writeFileSync(join(runtime, "supervisor_directive.json"),
  JSON.stringify({ v: 1, mode: "NAV_LOOP", gotoBan: ["last_loop_target"], summary: "old" }));
const symbolic = loadSupervisorDirective(tmp);
// After filtering non-numeric, gotoBan=[] => loader returns null
ok("old symbolic gotoBan returns null (strings filtered, list empty)",
  symbolic === null);

writeFileSync(join(runtime, "supervisor_directive.json"),
  JSON.stringify({ v: 1, mode: "NAV_LOOP", gotoBan: [36, 88], summary: "loop" }));
const valid = loadSupervisorDirective(tmp);
ok("loads valid NAV_LOOP directive with numeric gotoBan",
  valid !== null && valid.gotoBan.length === 2 &&
  valid.gotoBan.includes(36) && valid.gotoBan.includes(88),
  valid ? `gotoBan=${JSON.stringify(valid.gotoBan)}` : "null");

writeFileSync(join(runtime, "supervisor_directive.json"),
  JSON.stringify({ v: 1, mode: "WARP_OSC", gotoBan: [60, 61], summary: "osc" }));
const osc = loadSupervisorDirective(tmp);
ok("loads valid WARP_OSC directive",
  osc !== null && osc.gotoBan.length === 2,
  osc ? `gotoBan=${JSON.stringify(osc.gotoBan)}` : "null");

writeFileSync(join(runtime, "supervisor_directive.json"),
  JSON.stringify({ v: 1, mode: "NAV_LOOP", gotoBan: [36, "last_loop_target", 88], summary: "mixed" }));
const mixed = loadSupervisorDirective(tmp);
ok("filters string entries from mixed gotoBan",
  mixed !== null && mixed.gotoBan.length === 2 &&
  mixed.gotoBan.every(m => typeof m === "number"),
  mixed ? `gotoBan=${JSON.stringify(mixed.gotoBan)}` : "null");

// --- Python-side: verify _resolve_loop_maps against live data ---
// (Checked manually; _resolve_loop_maps() returns [36, 88] against
// the current runtime/warp_history.json — verified in the session.)

cleanup();
console.log("\n--- probe_navloop724 complete ---");
