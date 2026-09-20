// wq#1664 acceptance, end to end: the live service REFUSES TO BOOT when the
// rescue brain roles are pinned to the primary model. The env below is the
// 2026-09-10 unit drop-in verbatim (30-brain-env.conf), which is the config that
// produced 337 no-op escalations in a day (M7).
//
// Host-only (scripts/probes-main.sh): it spawns the real entrypoint. That is the
// point — the check has to sit AHEAD of the :8871 bind and the emulator, so a
// bad Environment= line costs a readable log line, not a port fight. If this
// probe ever times out instead of exiting 2, the guard moved down the file.
import { spawnSync } from "child_process";
import { join } from "path";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const GLM = "glm-5.3-flash-zai";
// wq#2073 put a decommission tombstone AHEAD of the config gate, so while LPP
// is decommissioned this entrypoint exits 4 before it ever reads the brain
// config. Point the tombstone at a path that does not exist so this probe keeps
// testing the gate it is named for; probe_decommission2073 owns the other side.
const r = spawnSync("npx", ["tsx", join(__dirname, "live_agent.ts")], {
  env: { ...process.env,
    LPP_DECOMMISSION_FILE: join(__dirname, "..", "DECOMMISSIONED.absent"),
    LPP_BRAIN_PRIMARY: GLM, LPP_BRAIN_ESCALATE: GLM, LPP_BRAIN_ACTRETRY: GLM,
    LPP_BRAIN_FALLBACK_MODELS: "cerebras-oss-120b,qwen36-local" },
  encoding: "utf8", timeout: 30_000,
});

const err = (r.stderr ?? "") + (r.stdout ?? "");
chk("exits instead of running with a no-op escalation", r.status !== null && r.signal === null,
  `status=${r.status} signal=${r.signal}`);
chk("exit 2 (config is unfixable by a restart, unlike the exit-3 continue path)", r.status === 2, String(r.status));
chk("names the escalate role", /FATAL escalate profile model/.test(err));
chk("names the actRetry role", /FATAL actRetry profile model/.test(err));
chk("names the env var to change", err.includes("LPP_BRAIN_ESCALATE"));
chk("prints the ladder it could have used", /fallbackModels=\[cerebras-oss-120b, qwen36-local\]/.test(err), err.split("\n").slice(-3).join(" / "));
chk("dies before the :8871 bind", !/EADDRINUSE|listening/i.test(err), err.slice(0, 200));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
