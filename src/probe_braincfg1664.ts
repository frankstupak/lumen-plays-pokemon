// wq#1664 acceptance: escalate/actRetry are a SECOND OPINION, not the primary
// model (M7 in foreman/research/LPP_BEHAVIORAL_ANALYSIS.md — escalate on
// stall_12_turns fired 56/352/337x per day into the same model family).
// Pure: no gateway, no ROM, no service.
//
// NOTE: config.ts reads env at import time and the module is cached, so the
// env-dependent half is staged before the dynamic import (same rule as
// probe_braincfg.ts) and every other case goes through the exported pure
// functions, which take their inputs as arguments.
process.env.LPP_BRAIN_PRIMARY = "glm-5.3-flash-zai";           // the 09-10 drop-in's primary
process.env.LPP_BRAIN_FALLBACK_MODELS = "glm-5.3-flash-zai,cerebras-oss-120b,mistral-small";
delete process.env.LPP_BRAIN_ESCALATE;
delete process.env.LPP_BRAIN_ACTRETRY;

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); ok ? pass++ : fail++; };

const prof = (model: string) => ({ model, maxTokensOut: 3200 });
const cfg = (primary: string, escalate: string, actRetry: string, fallbackModels: string[]) =>
  ({ profiles: { primary: prof(primary), escalate: prof(escalate), actRetry: prof(actRetry) },
     brain: { fallbackModels } });

(async () => {
  const { CFG, brainConfigErrors, nextLadderRung } = await import("./config.js");

  // 1. default derivation: the next rung, skipping a fallback list whose first
  //    entry IS primary (the shape that made the ladder a no-op).
  chk("nextLadderRung skips primary", nextLadderRung("a", ["a", "b"]) === "b");
  chk("nextLadderRung takes first differing rung", nextLadderRung("a", ["b", "c"]) === "b");
  chk("nextLadderRung ignores empty entries", nextLadderRung("a", ["", "b"]) === "b");
  chk("nextLadderRung with no alternative returns primary (caught by validation)",
    nextLadderRung("a", ["a"]) === "a");

  // 2. wired into the live defaults: primary pinned to glm => escalate/actRetry
  //    default to the next rung, NOT to glm.
  chk("escalate defaults off primary", CFG.profiles.escalate.model === "cerebras-oss-120b", CFG.profiles.escalate.model);
  chk("actRetry defaults off primary", CFG.profiles.actRetry.model === "cerebras-oss-120b", CFG.profiles.actRetry.model);
  chk("live config with derived defaults validates clean", brainConfigErrors().length === 0,
    brainConfigErrors().join(" | "));

  // 3. validation: the unit-drop-in shape (all roles pinned to one model) fails,
  //    and says which env var to change.
  const all = brainConfigErrors(cfg("glm", "glm", "glm", ["glm"]));
  chk("all-roles-pinned yields one error per role", all.length === 2, String(all.length));
  chk("error names LPP_BRAIN_ESCALATE", all.some(e => e.includes("LPP_BRAIN_ESCALATE")));
  chk("error names LPP_BRAIN_ACTRETRY", all.some(e => e.includes("LPP_BRAIN_ACTRETRY")));
  chk("error says the ladder has no alternative", all[0].includes("nothing to escalate to"), all[0]);

  const one = brainConfigErrors(cfg("glm", "glm", "mistral-small", ["glm", "mistral-small"]));
  chk("only the broken role is reported", one.length === 1 && one[0].startsWith("escalate"), one.join(" | "));
  chk("error offers the usable rungs", one[0].includes("mistral-small"), one[0]);

  chk("distinct roles validate clean",
    brainConfigErrors(cfg("glm", "cerebras-oss-120b", "mistral-small", ["cerebras-oss-120b"])).length === 0);

  // 4. sharp edge from probe_braincfg: an empty Environment= wins over the
  //    default, which would send the rescue roles to a model named "".
  const empty = brainConfigErrors(cfg("glm", "", "", ["cerebras-oss-120b"]));
  chk("empty model is an error, not a silent pass", empty.length === 2, String(empty.length));
  chk("empty-model error names the env var", empty[0].includes("LPP_BRAIN_ESCALATE"), empty[0]);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
