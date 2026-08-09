// wq#426 acceptance: brain profile env-override resolution (pure).
// NOTE: static imports are hoisted above env assignments (ESM), so config must
// be loaded via dynamic import AFTER the env is staged.
process.env.LPP_BRAIN_PRIMARY = "test-model-x";
process.env.LPP_BRAIN_EFFORT = "high";
process.env.LPP_BRAIN_ACTRETRY_MAXTOK = "999";
process.env.LPP_BRAIN_ESCALATE_MAXTOK = "-5";   // invalid -> default
process.env.LPP_BRAIN_SUMMARIZE = "";           // sharp edge: empty string is defined -> wins

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

(async () => {
  const { CFG } = await import("./config.js");
  chk("primary model overridden", CFG.profiles.primary.model === "test-model-x", CFG.profiles.primary.model);
  chk("primary effort overridden", CFG.profiles.primary.reasoningEffort === "high", String(CFG.profiles.primary.reasoningEffort));
  chk("primary maxtok default kept", CFG.profiles.primary.maxTokensOut === 3200, String(CFG.profiles.primary.maxTokensOut));
  chk("actRetry maxtok overridden", CFG.profiles.actRetry.maxTokensOut === 999, String(CFG.profiles.actRetry.maxTokensOut));
  chk("actRetry model default", CFG.profiles.actRetry.model === "deepseek-v4-flash", CFG.profiles.actRetry.model);
  chk("invalid number -> default", CFG.profiles.escalate.maxTokensOut === 3200, String(CFG.profiles.escalate.maxTokensOut));
  chk("escalate model default", CFG.profiles.escalate.model === "deepseek-v4-pro", CFG.profiles.escalate.model);
  chk("SHARP EDGE: empty-string env wins over default (never set Environment= to empty)",
    CFG.profiles.summarize.model === "", `'${CFG.profiles.summarize.model}'`);
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
