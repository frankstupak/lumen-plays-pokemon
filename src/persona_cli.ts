#!/usr/bin/env npx tsx
// wq#1176/wq#1191 — the CROSS-PLATFORM door into the persona store.
//
// The live agent reaches the store by importing PersonaMemory. Everything else
// that ever speaks as Lumen — a Messenger bridge, a Discord bot, a shell script,
// an operator checking what he has claimed — reaches it here, because a process
// boundary should not need a TypeScript import to know who Lumen is.
//
// Every subcommand reads and writes the SAME rows the agent does: lumen_state,
// subject LPP_PERSONA_SUBJECT (default lumen-persona). That store IS the
// cross-platform guarantee; `python3 /home/lumen/minerva/lumen_state.py current
// lumen-persona` shows exactly what this prints, and there is no second copy
// and no sync step to forget to run.
import { PersonaMemory } from "./persona";
import { gatewayExtractor } from "./persona_llm";
import { CFG } from "./config";

const USAGE = `persona — Lumen's canonical self-facts, shared by every platform he speaks on.

USAGE
  npx tsx src/persona_cli.ts <command> [args] [options]

COMMANDS
  recall                 the persona block a prompt should carry (plain text)
  ask "<question>"       facts matching a question, e.g. ask "favourite pokemon"
  list                   every stored fact, ranked (identity first)
  state "<sentence>"     record something Lumen just said, as HIM, on --platform
  stats                  counts only

OPTIONS
  --platform <name>   platform for 'state' (default: ${CFG.persona.platform})
  --budget <chars>    cap for 'recall' (default: ${CFG.persona.recallBudget})
  --no-llm            'state' uses the regex fast path only, no model call
  --json              machine-readable output
  -h, --help

STORE
  lumen_state subject '${CFG.persona.subject}' (LPP_PERSONA_SUBJECT).
  Cross-check: python3 /home/lumen/minerva/lumen_state.py current ${CFG.persona.subject}

EXIT CODES
  0 ok   1 usage/bad args   3 'state' contradicted a fact stated the same day

EXAMPLES
  npx tsx src/persona_cli.ts state "My name is Lumen" --platform messenger
  npx tsx src/persona_cli.ts ask "name" --json
  npx tsx src/persona_cli.ts recall`;

// Only these flags take a value, so a positional can never be eaten by a
// boolean flag standing next to it (`--json "my sentence"` still works).
const VALUE_FLAGS = new Set(["--platform", "--budget"]);

function opt(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    out.push(argv[i]);
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) { console.log(USAGE); return argv.length ? 0 : 1; }
  const json = argv.includes("--json");
  const cmd = argv[0];
  const positional = positionals(argv.slice(1));
  const mem = new PersonaMemory();
  mem.bind();
  if (mem.stats().store !== "lumen_state")
    console.error(`! persona: lumen_state unavailable (${CFG.persona.adapter}); this session is process-local`);

  switch (cmd) {
    case "recall": {
      const budget = Number(opt(argv, "budget") ?? CFG.persona.recallBudget);
      const text = mem.recall(Number.isFinite(budget) && budget > 0 ? budget : CFG.persona.recallBudget);
      console.log(json ? JSON.stringify({ recall: text, stats: mem.stats() }) : (text || "(nothing said yet)"));
      return 0;
    }
    case "ask": {
      const q = positional[0];
      if (!q) { console.error("ask: needs a question, e.g. ask \"favourite pokemon\"\n"); console.error(USAGE); return 1; }
      const hits = mem.search(q);
      if (json) { console.log(JSON.stringify({ query: q, hits })); return 0; }
      if (!hits.length) { console.log(`(nothing canonical about "${q}")`); return 0; }
      for (const f of hits) console.log(`${f.key}: ${f.value}  [${f.platform}, since ${f.validFrom}]`);
      return 0;
    }
    case "list": {
      if (json) { console.log(JSON.stringify(mem.toJSON())); return 0; }
      if (!mem.facts.length) { console.log("(empty)"); return 0; }
      for (const f of mem.facts) {
        const c = f.conflicts.length ? `  !${f.conflicts.length} contradiction(s)` : "";
        console.log(`${f.key}: ${f.value}  [${f.single ? "single" : "set"}, ${f.platform}, since ${f.validFrom}]${c}`);
      }
      return 0;
    }
    case "state": {
      const text = positional[0];
      if (!text) { console.error("state: needs the sentence Lumen said, quoted\n"); console.error(USAGE); return 1; }
      const platform = opt(argv, "platform") ?? CFG.persona.platform;
      if (CFG.persona.llmExtract && !argv.includes("--no-llm")) mem.extractor = gatewayExtractor();
      const events = await mem.observe(text, platform);
      const conflicted = events.some(e => e.outcome === "conflict");
      if (json) console.log(JSON.stringify({ platform, events: events.map(e => ({ outcome: e.outcome, key: e.key, value: e.value, canonical: e.fact.value, validFrom: e.fact.validFrom })) }));
      else if (!events.length) console.log("no self-fact found in that sentence (nothing stored)");
      else for (const e of events) console.log(`${e.outcome}: ${e.key} = ${e.outcome === "conflict" ? `${e.fact.value} (canonical; "${e.value}" rejected)` : e.value}`);
      return conflicted ? 3 : 0;
    }
    case "stats": {
      console.log(json ? JSON.stringify(mem.stats()) : Object.entries(mem.stats()).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v}`).join("\n"));
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(code => process.exit(code));
