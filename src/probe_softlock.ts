// wq#423 acceptance: soft-lock decision matrix (pure logic, no emulator).
// The force/terminal EXECUTION path (flee/rotate/exit3) is exercised in vivo -
// watch events for kind=battle_softlock; the run's own battles are the test rig.
import { assessBattleLock, LOCK } from "./softlock";

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

// quiet zone
let a = assessBattleLock(1, 0, true);
chk("quiet: fresh battle", a.directive === null && a.force === null && !a.terminal);
a = assessBattleLock(LOCK.ADVISE_TURNS - 1, LOCK.ADVISE_STALL - 1, true);
chk("quiet: just under thresholds", a.directive === null && a.force === null && !a.terminal);

// advisory tier
a = assessBattleLock(10, LOCK.ADVISE_STALL, true);
chk("advise: stall, wild mentions flee", a.directive !== null && a.directive!.includes("STALLED") && a.directive!.includes("flee()") && a.force === null);
a = assessBattleLock(10, LOCK.ADVISE_STALL, false);
chk("advise: stall, trainer no flee", a.directive !== null && !a.directive!.includes("flee()"));
a = assessBattleLock(LOCK.ADVISE_TURNS, 0, true);
chk("advise: turn budget", a.directive !== null && a.directive!.includes("TURN BUDGET") && a.force === null);

// force tier
a = assessBattleLock(20, LOCK.FORCE_STALL, true);
chk("force: stall wild -> flee", a.force === "flee" && !a.terminal);
a = assessBattleLock(20, LOCK.FORCE_STALL, false);
chk("force: stall trainer -> rotate", a.force === "rotate");
a = assessBattleLock(LOCK.FORCE_TURNS, 0, true);
chk("force: turn budget wild -> flee", a.force === "flee");
a = assessBattleLock(LOCK.FORCE_TURNS, 0, false);
chk("force: turn budget trainer -> rotate", a.force === "rotate");
chk("force keeps a directive up", assessBattleLock(20, LOCK.FORCE_STALL, true).directive !== null);

// terminal tier
a = assessBattleLock(LOCK.TERMINAL_TURNS, 0, true);
chk("terminal at turn cap", a.terminal && a.force === "flee");
a = assessBattleLock(LOCK.TERMINAL_TURNS - 1, LOCK.FORCE_STALL, false);
chk("no terminal from stall alone", !a.terminal);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
