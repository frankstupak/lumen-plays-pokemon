// wq#488 probe: adversarial notepad writes against the borrowed-content guard.
// Pure logic — no emulator, no socket.
import { classify, makeBorrowGuard } from "./borrow_guard";
import { Notepad } from "./notepad";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// stand-in for the live guidance channel text
const GUIDANCE = [
  "-- CERULEAN --",
  "Buy 4 potions and 3 poke balls at the mart before challenging Misty.",
  "Misty has STARYU L18 and STARMIE L21; bring a level 25 lead or grind on Route 24.",
  "-- CORRIDOR --",
  "Route 4 EAST of Mt Moon continues east to Cerulean City; do not backtrack west.",
].join("\n");

// ---------- rejections ----------
const bad: [string, string][] = [
  ["guidance marker open", "[[CERULEAN]] buy potions"],
  ["guidance marker close", "plan is fine [[/CORRIDOR]]"],
  ["tool syntax goto", "next turn do goto(16,17) then talk"],
  ["tool syntax battle_move", "use battle_move(0) on staryu"],
  ["tool syntax heal_at_center", "heal_at_center() first"],
  ["fenced code", "steps:\n```\nrun it\n```"],
  ["code keywords", "const plan = () => walkEast"],
  ["verbatim guidance copy", "Misty has STARYU L18 and STARMIE L21; bring a level 25 lead or grind on Route 24."],
];
for (const [name, payload] of bad) {
  const r = classify(payload, GUIDANCE);
  ok(`REJECT ${name}`, r.ok === false && !!r.reason, (r.reason ?? "").slice(0, 58));
}

// ---------- acceptances (no false positives) ----------
const good: [string, string][] = [
  ["plain fact", "Mt Moon B1F ladder at (16,17) leads down"],
  ["coords that look like a call", "the gym warp is at (16,17), museum at (14,7)"],
  ["word 'exit' in prose", "took the north exit and reached Cerulean"],
  ["short guidance overlap (<15 words)", "bought 4 potions at the mart"],
  ["own-words paraphrase of guidance", "Misty is strong; I need a higher level lead before trying her"],
  ["PIN routing survives", "PIN: my lead is CHARMELEON L27"],
];
for (const [name, payload] of good) {
  const r = classify(payload, GUIDANCE);
  ok(`ACCEPT ${name}`, r.ok === true && r.clean === payload, (r.reason ?? "ok").slice(0, 50));
}

// PIN: prefix is checked on the BODY, not the prefix
const pinBad = classify("PIN: use goto(3,4) every time", GUIDANCE);
ok("REJECT borrowed content behind a PIN: prefix", pinBad.ok === false, (pinBad.reason ?? "").slice(0, 50));

// ---------- wired through the real Notepad seam ----------
const events: any[] = [];
const bus: any = { emit: (kind: string, e: any) => events.push({ kind, ...e }) };
const pad = new Notepad();
pad.sanitizer = makeBorrowGuard({ guidanceText: () => GUIDANCE, bus });

const rej = pad.note("[[CERULEAN]] copy of the pack");
ok("seam: rejected note returns brain feedback", rej.includes("rejected"), rej.slice(0, 52));
ok("seam: rejected note NOT stored", !pad.renderNotes().includes("CERULEAN"), pad.renderNotes().slice(0, 40) || "(empty)");
ok("seam: rule_violation event emitted", events.length === 1 && events[0].kind === "rule_violation" && events[0].rule === "no_borrowed_content", JSON.stringify(events[0] ?? {}).slice(0, 70));

const acc = pad.note("Route 4 has a rest house halfway east");
ok("seam: clean note still saved", acc === "note saved" && pad.renderNotes().includes("rest house"), acc);

const pinRej = pad.pin("goto(1,2) forever");
ok("seam: pin() sanitized too", pinRej.includes("rejected") && pad.renderNotes().indexOf("goto") < 0, pinRej.slice(0, 44));
const pinOk = pad.pin("Boulder Badge obtained at Pewter");
ok("seam: clean pin still pinned", pinOk.includes("PINNED") && pad.renderNotes().includes("Boulder Badge"), pinOk);
ok("seam: exactly one violation event per rejection (2 total)", events.length === 2, `events=${events.length}`);

// guidance channel itself is never sanitized
pad.setGuidance("CORRIDOR", "[[CORRIDOR]] harness text with goto(1,1) in it");
ok("guidance channel bypasses the guard entirely", pad.renderGuidance().includes("goto(1,1)"), pad.renderGuidance().slice(0, 44));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
