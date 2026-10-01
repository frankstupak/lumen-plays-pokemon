// wq#1053: research-pipeline watchdog. Pure except for one optional ROM check.
import { existsSync } from "fs";
import { Watchdog } from "./watchdog_notify.js";
import { markResearchProgress, researchProgressTracker, startResearchBeat } from "./research_beat.js";
import { checkTarget } from "./research_run.js";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. no systemd watchdog: nothing starts
  const off = startResearchBeat({}, new Watchdog({}), () => false);
  chk("no NOTIFY_SOCKET: beat is off and no timer exists", !off.enabled && off.timer === null);
  const noSec = startResearchBeat({ NOTIFY_SOCKET: "x" }, new Watchdog({ NOTIFY_SOCKET: "x" }), () => false);
  chk("unit without WatchdogSec: beat is off", !noSec.enabled && noSec.timer === null);

  // 2. frame counter marks every 30th call, not every call
  const tr = researchProgressTracker();
  await sleep(40);
  for (let i = 0; i < 29; i++) markResearchProgress();
  chk("29 frames do not touch the clock", !tr.progressedWithin(30));
  markResearchProgress();
  chk("the 30th frame marks progress", tr.progressedWithin(30));

  // 3. beat policy with real timers: WATCHDOG_USEC=100ms -> a beat every 50ms
  const sent: string[] = [];
  const env = { NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "100000", LPP_RESEARCH_STALL_MS: "150" };
  const wd = new Watchdog(env, (_f, a) => { sent.push(a.join(" ")); });
  let frozen = false;
  let unitAsked = "";
  const beat = startResearchBeat(env, wd, (u) => { unitAsked = u; return frozen; });
  chk("enabled with env knobs", beat.enabled && beat.stallAfterMs === 150 && beat.unit === "lumen-lpp-research");
  chk("READY and STATUS announced", sent.includes("READY=1") && sent.some((m) => m.startsWith("STATUS=research beat on")));
  await sleep(120);
  const beatsWhileFresh = sent.filter((m) => m === "WATCHDOG=1").length;
  chk("fresh progress: watchdog beats flow", beatsWhileFresh >= 1, String(beatsWhileFresh));
  await sleep(300); // past the 150ms stall window with no frames
  const n1 = sent.filter((m) => m === "WATCHDOG=1").length;
  await sleep(200);
  const n2 = sent.filter((m) => m === "WATCHDOG=1").length;
  chk("stalled emulator: beats STOP so systemd kills the run", n2 === n1, `${n1} -> ${n2}`);
  frozen = true;
  await sleep(200);
  const n3 = sent.filter((m) => m === "WATCHDOG=1").length;
  chk("holddown on the research unit keeps it alive", n3 > n2 && unitAsked === "lumen-lpp-research", `${n2} -> ${n3} unit=${unitAsked}`);
  frozen = false;
  await sleep(200);
  const n4 = sent.filter((m) => m === "WATCHDOG=1").length;
  chk("holddown released and still no frames: beats stop again", n4 <= n3 + 1, `${n3} -> ${n4}`);
  for (let i = 0; i < 30; i++) markResearchProgress();
  await sleep(120);
  chk("frames resume: beats resume", sent.filter((m) => m === "WATCHDOG=1").length > n4);
  if (beat.timer) clearInterval(beat.timer);

  // 4. the runner only accepts research entry points
  const ok = (p: string) => { try { checkTarget(p); return true; } catch { return false; } };
  chk("allows src/link/drive_trade_e2e.ts", ok("src/link/drive_trade_e2e.ts"));
  chk("allows src/accept_grass1565.ts", ok("src/accept_grass1565.ts"));
  for (const bad of ["src/live_agent.ts", "src/live.ts", "src/stream.ts", "src/link", "src/link/../live_agent.ts",
                     "../../etc/passwd", "/etc/passwd", "src/link/x.js", "src/accept_x.ts/../live_agent.ts", "src/p1_verify.ts"]) {
    chk(`refuses ${bad}`, !ok(bad));
  }

  // 5. the real Emulator feeds the tracker through direct gb.doFrame() calls (needs the ROM)
  const rom = "roms/pokeblue.gb";
  if (existsSync(rom)) {
    const { Emulator } = await import("./emulator.js");
    const emu = new Emulator(rom);
    await sleep(40);
    for (let i = 0; i < 30; i++) (emu as any).gb.doFrame();
    chk("direct gb.doFrame() (link drivers) marks progress", researchProgressTracker().progressedWithin(30));
    chk("doFrame wrapper is non-enumerable (cannot disturb Object.keys probe)", !Object.keys((emu as any).gb).includes("doFrame"));
  } else {
    console.log("SKIP emulator wiring check (no roms/pokeblue.gb here)");
  }

  console.log(`\n${fail === 0 ? "PROBE GREEN" : "PROBE RED"} ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
