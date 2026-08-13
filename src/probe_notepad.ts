// wq#486 probe — notepad architecture. No emulator needed; exercises the
// Notepad directly: cap/eviction, pinned survival, guidance isolation,
// persistence round-trip (bind restore), and the wq#488 sanitizer seam.
import { Notepad, PIN_BUDGET, ROLLING_BUDGET } from "./notepad";
import { existsSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// ---- 1. cap + deterministic eviction, pinned survives ----
const p = new Notepad();
p.pin("Brock beaten, badge 1");
p.pin("Charmander L27 knows Ember");
const FIRST = "note-0000 earliest fact that must be evicted first";
p.note(FIRST);
for (let i = 1; i < 200; i++) p.note(`note-${String(i).padStart(4, "0")} filler line to grow the rolling region well past cap`);
const notes = p.renderNotes();
ok("pinned region survives overflow", notes.includes("Brock beaten") && notes.includes("Charmander L27"), `pins=${p.pinned.length}`);
ok("rolling region held under budget", p.rolling.join("\n").length <= ROLLING_BUDGET, `rolling=${p.rolling.join("\n").length}/${ROLLING_BUDGET}`);
ok("oldest note evicted (not present verbatim)", !p.rolling.some(l => l.startsWith("note-0000")), `evictions=${p.evictions}`);
ok("evicted oldest left a summary trace", p.summary.length > 0 && p.summary.includes("note-"), p.summary.slice(0, 60));
ok("newest note retained verbatim", p.rolling.some(l => l.includes("note-0199")), "");
ok("total notes ceiling ~6000", notes.length <= 6000, `chars=${notes.length}`);

// eviction trace on a CONTROLLED fill (few evictions -> oldest digest still in summary)
const pc = new Notepad();
for (let i = 0; i < 60; i++) pc.note(`SEED-${String(i).padStart(3, "0")} ` + "x".repeat(80));
ok("first evicted line's digest is in the summary", pc.summary.includes("SEED-000"), pc.summary.slice(0, 50));

// ---- 2. pin budget: rejected, never silently dropped ----
const p2 = new Notepad();
let rej = "";
for (let i = 0; i < 40; i++) { const r = p2.pin("X".repeat(60) + i); if (r.includes("REJECTED")) { rej = r; break; } }
ok("pin over budget REJECTED (not dropped)", rej.includes("REJECTED"), rej.slice(0, 50));
ok("pinned region stayed within budget", p2.pinned.join("\n").length <= PIN_BUDGET, `${p2.pinned.join("\n").length}/${PIN_BUDGET}`);

// ---- 3. guidance channel is separate and never touched by notes ----
const p3 = new Notepad();
p3.setGuidance("CORRIDOR", "head east to Mt Moon (map59)");
p3.setGuidance("CERULEAN", "buy 4 potions before Misty");
p3.note("my own private note");
p3.note("PIN: rival name is BLUE");
const g = p3.renderGuidance();
ok("guidance renders both sections", g.includes("CORRIDOR") && g.includes("Mt Moon") && g.includes("CERULEAN"), "");
ok("guidance excluded from notes", !p3.renderNotes().includes("Mt Moon") && !p3.renderNotes().includes("Misty"), "");
ok("notes excluded from guidance", !g.includes("private note") && !g.includes("BLUE"), "");
p3.setGuidance("CERULEAN", "");   // clearing a section removes it
ok("clearing a guidance section drops it", !p3.renderGuidance().includes("CERULEAN"), p3.renderGuidance().slice(0, 40));

// ---- 4. persistence round-trip: bind restores across a simulated restart ----
const dir = mkdtempSync(join(tmpdir(), "np-"));
const file = join(dir, "notepad.txt");
const a = new Notepad();
a.bind(file);
a.pin("badge 2 GET");
a.note("talked to Bill, got SS ticket");
a.note("caught ODDISH on route 24");
ok("persist file written", existsSync(file), file);
// new instance = a fresh process after restart
const b = new Notepad();
b.bind(file);
ok("restart restores pinned", b.pinned.some(x => x.includes("badge 2 GET")), `pins=${b.pinned.length}`);
ok("restart restores rolling notes", b.renderNotes().includes("SS ticket") && b.renderNotes().includes("ODDISH"), "");
ok("restoredChars reported", b.restoredChars > 0, `restoredChars=${b.restoredChars}`);
// guidance is NOT persisted (derived state)
b.setGuidance("X", "transient");
const c = new Notepad(); c.bind(file);
ok("guidance not persisted (re-derived each boot)", c.renderGuidance() === "", `"${c.renderGuidance()}"`);

// ---- 5. wq#488 sanitizer seam: reject + clean paths ----
const p5 = new Notepad();
p5.sanitizer = (raw) => raw.includes("[[") ? { ok: false, reason: "rejected: looks like a guidance marker (borrowed content)" }
                      : { ok: true, clean: raw.replace(/BADWORD/g, "***") };
const r1 = p5.note("normal BADWORD note");
ok("sanitizer clean path substitutes", p5.renderNotes().includes("***") && !p5.renderNotes().includes("BADWORD"), r1);
const r2 = p5.note("[[CERULEAN]] leaked marker");
ok("sanitizer reject path blocks write + feeds back", r2.includes("rejected") && !p5.renderNotes().includes("leaked marker"), r2.slice(0, 50));
ok("default (unset) sanitizer = passthrough", (() => { const q = new Notepad(); q.note("plain"); return q.renderNotes().includes("plain"); })(), "");

try { unlinkSync(file); } catch {}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
