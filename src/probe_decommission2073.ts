// wq#2073 acceptance, end to end: while the tree carries a decommission
// tombstone, the live entrypoint REFUSES TO BOOT — no matter who started it.
//
// Host-only (scripts/probes-main.sh): it spawns the real entrypoint, which is
// the only way to prove the gate sits ahead of the :8871 bind and ahead of the
// wq#1664 config gate. If this probe ever times out instead of exiting 4, the
// gate moved down the file and a `systemctl start` can reach the brain again.
//
// BOTH SPAWNS USE THE wq#1664 BAD LADDER (all four roles pinned to the primary)
// ON PURPOSE. It gives the second half a floor to land on: with the tombstone
// absent the boot must fall through to the config gate and exit 2 there, which
// proves the tombstone gate is transparent when it should be — without ever
// letting this probe bind :8871, load the ROM, or call the brain. A probe for
// "LPP stays dead" that resurrects LPP for 60s to prove it is not a probe.
import { spawnSync } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const ENTRY = join(__dirname, "live_agent.ts");
const REAL = join(__dirname, "..", "DECOMMISSIONED.md");
const ABSENT = join(__dirname, "..", "DECOMMISSIONED.absent");
const GLM = "glm-5.3-flash-zai";
const boot = (tombstone: string) => spawnSync("npx", ["tsx", ENTRY], {
  env: { ...process.env, LPP_DECOMMISSION_FILE: tombstone,
    LPP_BRAIN_PRIMARY: GLM, LPP_BRAIN_ESCALATE: GLM, LPP_BRAIN_ACTRETRY: GLM,
    LPP_BRAIN_FALLBACK_MODELS: "cerebras-oss-120b,qwen36-local" },
  encoding: "utf8", timeout: 30_000,
});

chk("the tombstone is checked in (this repo is decommissioned)", existsSync(REAL), REAL);

const r = boot(REAL);
const err = (r.stderr ?? "") + (r.stdout ?? "");
chk("exits instead of playing", r.status !== null && r.signal === null,
  `status=${r.status} signal=${r.signal}`);
chk("exit 4 (policy refusal, not 2=bad config / 3=designed continue)", r.status === 4, String(r.status));
chk("names the tombstone path", err.includes("DECOMMISSIONED.md"));
chk("quotes the tombstone's own reason", /re-approval/i.test(err), err.slice(0, 200));
chk("says how to revive (a PR, not a host edit)", /in a PR/.test(err));
chk("dies before the :8871 bind", !/EADDRINUSE|listening/i.test(err), err.slice(0, 200));
chk("wins over the wq#1664 config gate, which never runs", !/FATAL escalate profile/.test(err));

// Revival path: with no tombstone the gate is transparent and the boot falls
// through to the next gate down. Landing on exit 2 there is the proof, and it
// costs nothing — the config gate is still ahead of the port and the brain.
const rv = boot(ABSENT);
const rverr = (rv.stderr ?? "") + (rv.stdout ?? "");
chk("with no tombstone the gate does not fire", !/\[decommission\]/.test(rverr), rverr.slice(0, 200));
chk("with no tombstone the boot reaches the next gate (exit 2)", rv.status === 2, String(rv.status));
chk("...and that gate is the wq#1664 one", /FATAL escalate profile/.test(rverr));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
