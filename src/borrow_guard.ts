// wq#488 — no-borrowed-content guard. A sanitizer for the wq#486 Notepad seam
// (pad.sanitizer). Defense-in-depth: the diagnosis (board 2026-08-13T02:44Z)
// found ZERO borrowed content in 44 historical note payloads once wq#486 split
// guidance out of the notepad — but a standing rule ("no borrowing code /
// directives") deserves an enforced guard, not just a structural fix.
//
// Rejects, with in-context feedback to the brain:
//   1. Guidance markers ([[X]] / [[/X]]) — can now ONLY appear in a brain write
//      (guidance lives in its own channel), so their presence is unambiguous.
//   2. Tool-call syntax — the brain must CALL tools via ACT:, never narrate a
//      tool(args) string into memory.
//   3. Fenced code blocks / code-like directives.
//   4. >=15-word verbatim (fuzzy) copies of the current guidance text — the
//      brain parroting the harness's own directives back into its notes.
// Accepts everything else unchanged. Emits a 'rule_violation' event per reject
// (kiosk ticker + sentinel food).
import { EventBus } from "./events";
import { NotepadSanitizer } from "./notepad";

const MARKER = /\[\[\/?[A-Z0-9_]+\]\]/;
const TOOL_CALL = /\b(goto|enter_warp|leave_edge|interact|talk|choose|battle_move|flee|press|use_item|buy_item|sell_item|heal_at_center|note)\s*\([^)]*\)/i;
const FENCE = /```|~~~/;
const CODE_KW = /\b(function|const|let|var|=>|import\s|export\s|for\s*\(|while\s*\()/;

/** normalize to lowercase word tokens for fuzzy overlap */
function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
}

/** longest run of consecutive words from `note` that appears verbatim, in
 *  order, as a contiguous slice of `guidance`. Cheap O(n*m) scan — payloads
 *  are short (<=400 chars) and guidance is a few KB. */
function longestVerbatimRun(note: string, guidance: string): number {
  const a = words(note), b = words(guidance);
  if (!a.length || !b.length) return 0;
  const bJoined = " " + b.join(" ") + " ";
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let len = a.length - i; len > best; len--) {
      const frag = a.slice(i, i + len).join(" ");
      if (bJoined.includes(" " + frag + " ")) { best = len; break; }
    }
  }
  return best;
}

export interface GuardOptions {
  /** returns the CURRENT guidance text to check verbatim copies against */
  guidanceText: () => string;
  /** min consecutive verbatim words from guidance that counts as borrowing */
  verbatimWords?: number;
  bus?: EventBus;
}

export interface GuardResult { ok: boolean; clean?: string; reason?: string }

/** Build a NotepadSanitizer. Pure classification is exposed as classify() for
 *  probes; the returned sanitizer adds the bus emit + the PIN: prefix carve-out
 *  (so the router prefix survives to notepad.ts). */
export function classify(raw: string, guidance: string, verbatimWords = 15): GuardResult {
  // check the CONTENT, not the PIN: router prefix
  const body = raw.replace(/^PIN:\s*/i, "");
  if (MARKER.test(body))
    return { ok: false, reason: "note rejected: contains guidance markers ([[...]]) — those are harness directives, not yours to copy. Write the fact in your own words." };
  if (TOOL_CALL.test(body))
    return { ok: false, reason: "note rejected: contains tool-call syntax — CALL tools on the ACT line, don't write them into notes. Note the goal in plain words instead." };
  if (FENCE.test(body) || CODE_KW.test(body))
    return { ok: false, reason: "note rejected: looks like code — the notepad is for gameplay facts and plans in plain language, not code." };
  const run = longestVerbatimRun(body, guidance);
  if (run >= verbatimWords)
    return { ok: false, reason: `note rejected: this is a ${run}-word verbatim copy of the harness GUIDANCE — that guidance is already shown to you every turn; don't duplicate it. Note only YOUR own observations.` };
  return { ok: true, clean: raw };
}

export function makeBorrowGuard(opts: GuardOptions): NotepadSanitizer {
  const vw = opts.verbatimWords ?? 15;
  return (raw: string): GuardResult => {
    const r = classify(raw, opts.guidanceText(), vw);
    if (!r.ok && opts.bus) {
      // 'rule_violation' -> stream (kiosk ticker) + sentinel food
      (opts.bus as any).emit("rule_violation", { rule: "no_borrowed_content", reason: r.reason, sample: raw.slice(0, 80) });
    }
    return r;
  };
}
