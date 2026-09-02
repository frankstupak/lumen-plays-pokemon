// wq#1176 probe — streamer chat. Pure logic: no emulator, no ROM, no network.
// The interesting properties are the two that make it safe to point at an
// audience: it is RATE LIMITED (an emulator running many turns a minute cannot
// produce a wall of text), and it is ONE-WAY (there is no method by which an
// audience message enters the store, and refusals are reported rather than
// silently dropped).
import { StreamChat, MAX_TEXT } from "./chat";
import { existsSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${note}`); }
  else { fail++; console.log(`FAIL ${name} :: ${note}`); }
};

// ---- 1. posting + rate limit (clock injected, no sleeping) ----
let clock = 1_000_000;
const c = new StreamChat({ ring: 5, minIntervalMs: 45_000 });
c.now = () => clock;

const first = c.say("Just beat Brock.");
ok("first line posts", first.ok === true && first.message?.text === "Just beat Brock.", String(first.reason ?? ""));
const second = c.say("Heading to Mt Moon now.");
ok("second line inside the window is refused", second.ok === false, String(second.reason ?? ""));
ok("refusal carries a reason the brain can act on",
   (second.reason ?? "").includes("rate limited"), String(second.reason));
ok("refused lines are counted", c.refused === 1, `refused=${c.refused}`);
clock += 45_000;
ok("line posts once the window passes", c.say("Heading to Mt Moon now.").ok === true, "");
ok("identical consecutive line is refused as a duplicate",
   c.say("Heading to Mt Moon now.").ok === false, "");

// ---- 2. hygiene ----
ok("empty text is refused", c.say("   ").ok === false, "");
clock += 60_000;
const long = c.say("x".repeat(MAX_TEXT + 200));
ok("over-long line is truncated, not dropped", long.ok === true && long.message!.text.length === MAX_TEXT,
   `len=${long.message?.text.length}`);
clock += 60_000;
const multi = c.say("line one\nline two\twith tabs");
ok("newlines/tabs collapse to one display line", multi.ok === true && !/[\n\t]/.test(multi.message!.text),
   String(multi.message?.text));

// ---- 3. ring is bounded, system lines bypass the rate limit ----
for (let i = 0; i < 10; i++) c.system(`milestone ${i}`);
ok("system lines are not rate limited", c.messages.filter(m => m.kind === "system").length > 1, "");
ok("ring stays bounded", c.messages.length <= 5, `messages=${c.messages.length}`);
ok("ring keeps the NEWEST", c.messages[c.messages.length - 1].text === "milestone 9",
   c.messages[c.messages.length - 1].text);
ok("ids are monotonic", c.messages.every((m, i, a) => i === 0 || m.id > a[i - 1].id), "");

// ---- 4. one-way by construction ----
// This is the property the ticket buys: there is no inbound API. Asserted
// structurally so adding one is a deliberate act that trips this probe.
const surface = new Set(Object.getOwnPropertyNames(StreamChat.prototype));
const INBOUND = ["receive", "post", "reply", "fromAudience", "ingest", "onMessage", "listen"];
ok("no inbound method exists on StreamChat", INBOUND.every(n => !surface.has(n)),
   [...surface].join(","));
ok("every stored message is authored by the harness",
   c.messages.every(m => m.kind === "say" || m.kind === "system"), "");

// ---- 5. persistence: the panel is not blank after a restart ----
const dir = mkdtempSync(join(tmpdir(), "lpp-chat-"));
const file = join(dir, "chat.json");
const w = new StreamChat({ ring: 20, minIntervalMs: 0 });
w.bind(file);
w.say("hello stream");
w.system("checkpoint saved");
ok("chat log written", existsSync(file), file);

const r = new StreamChat({ ring: 20, minIntervalMs: 0 });
r.bind(file);
ok("messages restored", r.messages.length === 2, `messages=${r.messages.length}`);
ok("restored kinds survive", r.messages[1].kind === "system", r.messages[1].kind);
ok("ids continue after restore", r.say("after restart").message!.id > w.messages[1].id, "");
ok("recent() returns newest-last", r.recent(2)[1].text === "after restart", r.recent(2).map(m => m.text).join("|"));

// ---- 6. never throws on junk ----
let threw = false;
try {
  const j = new StreamChat();
  j.say(undefined as unknown as string); j.system(null as unknown as string);
  j.bind(join(dir, "nope", "deep", "chat.json"));
} catch { threw = true; }
ok("junk input and a fresh nested path do not throw", !threw, "");

try { unlinkSync(file); } catch {}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
