// wq#2073: the decommission tombstone — a checked-in file that the live agent
// reads before it does anything else.
//
// WHY THIS IS A FILE IN THE TREE AND NOT A systemctl STATE. LPP was masked on
// 2026-09-13 and was running again on 2026-09-18, because `systemctl mask`
// records a state and not a REASON: wq#1990 found LoadState=masked with nothing
// attached to it, read it as an undocumented leftover blocking an open fire,
// and unmasked it as a documented, argued decision. The guard that failed was
// not the mask — it was that "decommissioned" existed nowhere a sibling agent
// could read. A file in the repo travels with the code, survives every
// systemctl verb and every `install ... /etc/systemd/system`, and can only be
// removed by a reviewable commit. See reports/2073_lpp_resurrection_rca.md.
//
// The path is env-overridable so a probe can exercise the boot path BELOW this
// gate (src/probe_bootguard1664.ts) without deleting the tombstone. That is a
// test seam, not a revival procedure: reviving LPP means deleting the file in a
// PR, which is the whole point of putting it under review.
import { readFileSync } from "fs";
import { join } from "path";

export const DECOMMISSION_FILE =
  process.env.LPP_DECOMMISSION_FILE ?? join(__dirname, "..", "DECOMMISSIONED.md");

export interface DecommissionNotice {
  path: string;
  /** The tombstone's own words, trimmed to what fits in a boot log. Long enough
   *  to reach the revival conditions — a refusal that does not say what would
   *  lift it is the unexplained mask this whole file exists to replace. */
  head: string[];
}

/** The tombstone if this tree is decommissioned, else null.
 *
 *  An unreadable-but-present tombstone still counts (the catch returns a notice
 *  with no head, not null): "I could not read the reason" must never be the
 *  path by which the service boots. */
export function decommissionNotice(lines = 14): DecommissionNotice | null {
  let text: string;
  try {
    text = readFileSync(DECOMMISSION_FILE, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    return { path: DECOMMISSION_FILE, head: [`(unreadable: ${e?.code ?? e})`] };
  }
  const head = text.split("\n").map(l => l.trimEnd())
    .filter(l => l.length > 0 && !l.startsWith("#"))
    .slice(0, lines);
  return { path: DECOMMISSION_FILE, head };
}
