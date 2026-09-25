// wq#1191 — compaction: apply today's persona rules to the rows lumen_state
// ALREADY holds.
//
// The write guards (buildClaim) stop new junk, and quarantine() hides the old
// junk from LPP's own recall block. Neither of those reaches the STORE, and the
// store is the cross-platform contract: a Messenger bridge, a shell script or an
// operator running `lumen_state.py current lumen-persona` reads the rows, not
// LPP's in-process view of them. Live, that is 100 open rows — 36 spellings of
// one self-description, several of them the topic mixer's instructions wearing a
// fact's clothes — written in the days before the guards existed. Every one of
// them is still what the rest of the fleet sees Lumen claim about himself.
//
// So the same judgement runs once against the store. Closing, never deleting: a
// valid_to leaves the row queryable by `history`/`asof`, so the days it was
// canonical stay answerable and a wrong call here is undone by re-ingesting the
// value, not by a restore.
//
// What it will NOT close: anything whose only sin is the recall budget.
// quarantine() drops set members past MAX_SET_MEMBERS because a prompt block is
// 900 chars, and that is a rendering limit, not a claim that the seventh thing
// he likes is untrue. Truth judgements close rows; budget judgements do not.
import { isMetaText } from "./meta_text";
import {
  isRunOn, isSelfDescription, nearDuplicate, normKey, normValue, sameSetMember,
} from "./persona";
import { PersonaRow, decodePredicate } from "./persona_store";

export interface CompactClose {
  predicate: string;
  value: string;
  /** Why it is closing, and — for a fold — which row won. Goes into the row's
   *  close reason verbatim, so the audit trail is readable from lumen_state. */
  reason: string;
}

export interface CompactionPlan {
  scanned: number;
  closes: CompactClose[];
  /** Open rows that survive. scanned - closes.length, named for the reader. */
  kept: number;
}

interface Decoded {
  row: PersonaRow;
  key: string;
  norm: string;
  single: boolean;
}

/** Newest valid-from wins, because that IS the bi-temporal answer to "what does
 *  he believe today"; a tie goes to the shorter value, which is the cleaner
 *  phrasing of the same slot ("San Francisco" over "San Francisco for eleven
 *  years"). Same order quarantine() renders in. */
function singleWinnerFirst(a: Decoded, b: Decoded): number {
  if (a.row.validFrom !== b.row.validFrom) return a.row.validFrom < b.row.validFrom ? 1 : -1;
  return a.row.value.length - b.row.value.length;
}

/** For a set slot the shortest value is the keeper — "a dry, tired streamer"
 *  survives and the five longer paraphrases of it fold in — then the oldest,
 *  since that is the phrasing he has stood by longest. */
function setKeeperFirst(a: Decoded, b: Decoded): number {
  return a.row.value.length - b.row.value.length ||
    (a.row.validFrom < b.row.validFrom ? -1 : a.row.validFrom > b.row.validFrom ? 1 : 0);
}

/**
 * Decide what to close. Pure: no store, no clock, no side effects — the caller
 * runs the plan, prints it, or throws it away.
 */
export function planCompaction(rows: PersonaRow[]): CompactionPlan {
  const closes: CompactClose[] = [];
  const decoded: Decoded[] = [];

  for (const row of rows) {
    const d = decodePredicate(row.predicate);
    const key = normKey(d.key);
    // The write-side gate, read backwards. A row whose value buildClaim would
    // refuse today is a row that only exists because it was written yesterday.
    if (isMetaText(row.value) || isMetaText(key) || (isSelfDescription(key) && isRunOn(row.value))) {
      closes.push({ predicate: row.predicate, value: row.value, reason: "scaffolding, not a self-fact: persona compaction" });
      continue;
    }
    decoded.push({ row, key, norm: normValue(row.value), single: d.single });
  }

  // One question, one slot. Several stored predicates legitimately land on one
  // key after the KEY_SYNONYMS fold ("my former city" and "my previous city" are
  // both "my old city"), and a slot the fleet can read two answers to is the
  // duplication this pass exists to end.
  const singles = new Map<string, Decoded[]>();
  const sets = new Map<string, Decoded[]>();
  for (const d of decoded) {
    const bucket = d.single ? singles : sets;
    const arr = bucket.get(d.key);
    if (arr) arr.push(d); else bucket.set(d.key, [d]);
  }

  for (const arr of singles.values()) {
    if (arr.length < 2) continue;
    arr.sort(singleWinnerFirst);
    const winner = arr[0];
    for (const loser of arr.slice(1))
      closes.push({
        predicate: loser.row.predicate,
        value: loser.row.value,
        reason: `superseded by ${winner.row.predicate}: persona slot fold`,
      });
  }

  // Set members accumulate on purpose, so only an actual restatement folds:
  // nearDuplicate for a normal slot, containment for the copular one (see
  // sameSetMember). "caves" and "caves at night" both survive.
  for (const [key, arr] of sets) {
    if (arr.length < 2) continue;
    arr.sort(setKeeperFirst);
    const kept: Decoded[] = [];
    for (const d of arr) {
      const dupe = kept.find(k => sameSetMember(key, k.norm, d.norm) || nearDuplicate(k.norm, d.norm));
      if (dupe) closes.push({
        predicate: d.row.predicate,
        value: d.row.value,
        reason: `duplicate of ${dupe.row.predicate}: persona set fold`,
      });
      else kept.push(d);
    }
  }

  return { scanned: rows.length, closes, kept: rows.length - closes.length };
}
