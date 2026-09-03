#!/usr/bin/env npx tsx
// wq#1176 — the CROSS-PLATFORM door into the persona store.
//
// The live agent reaches the store by importing PersonaMemory. Everything else
// that ever speaks as Lumen — a Messenger bridge, a Discord bot, a shell script,
// an operator checking what he has claimed — reaches it here, because a process
// boundary should not need a TypeScript import to know who Lumen is.
//
// Every subcommand reads/writes the SAME file the agent uses (CFG.persona.path,
// LPP_PERSONA_PATH, or --path). That single file IS the cross-platform
// guarantee; there is no second store and no sync step to forget to run.
import { PersonaMemory } from "./persona";
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
  --path <file>       store location (default: ${CFG.persona.path})
  --json              machine-readable output
  -h, --help

EXIT CODES
  0 ok   1 usage/bad args   3 'state' contradicted an existing canonical fact

EXAMPLES
  npx tsx src/persona_cli.ts state "My name is Lumen" --platform messenger
  npx tsx src/persona_cli.ts ask "name" --json
  npx tsx src/persona_cli.ts recall`;

// Only these flags take a value, so a positional can never be eaten by a
// boolean flag standing next to it (`--json "my sentence"` still works).
const VALUE_FLAGS = new Set(["--platform", "--budget", "--path"]);

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

function main(argv: string[]): number {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) { console.log(USAGE); return argv.length ? 0 : 1; }
  const json = argv.includes("--json");
  const cmd = argv[0];
  const positional = positionals(argv.slice(1));
  const mem = new PersonaMemory();
  mem.bind(opt(argv, "path") ?? CFG.persona.path);

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
      for (const f of hits) console.log(`${f.key}: ${f.value}  [${f.platform}, ${f.count}x, since ${f.firstSaid.slice(0, 10)}]`);
      return 0;
    }
    case "list": {
      if (json) { console.log(JSON.stringify(mem.toJSON())); return 0; }
      if (!mem.facts.length) { console.log("(empty)"); return 0; }
      for (const f of mem.facts) {
        const c = f.conflicts.length ? `  !${f.conflicts.length} contradiction(s)` : "";
        console.log(`${f.key}: ${f.value}  [${f.single ? "single" : "set"}, ${f.platform}, ${f.count}x]${c}`);
      }
      return 0;
    }
    case "state": {
      const text = positional[0];
      if (!text) { console.error("state: needs the sentence Lumen said, quoted\n"); console.error(USAGE); return 1; }
      const platform = opt(argv, "platform") ?? CFG.persona.platform;
      const events = mem.observe(text, platform);
      const conflicted = events.some(e => e.outcome === "conflict");
      if (json) console.log(JSON.stringify({ platform, events: events.map(e => ({ outcome: e.outcome, key: e.key, value: e.value, canonical: e.fact.value })) }));
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

process.exit(main(process.argv.slice(2)));
