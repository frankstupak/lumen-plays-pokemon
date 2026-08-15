// wq#620: STRUCTURED MENU/DIALOG VIEW from the BG tilemap — the symbolic
// decode the vision research prescribed (Option A: menus/dialog are font
// tiles; lossless text, zero image tokens).
//
// GROUND TRUTH this module is built on (captured live off a map67 fixture,
// 2026-08-15, recon620 — not recalled): the mart BUY list draws item names on
// even rows starting y=4 with the price RIGHT-ALIGNED on the row below each
// name; the selection arrow (tile 0xED) sits one column left of the name
// column; the visible window holds 4 entries and SCROLLS — wCurrentMenuItem
// pins at 2 while wListScrollOffset grows, so the selected LIST row is
// scroll+cur. And the finding that motivates reading the tilemap at all:
// cf91/wCurItem UPDATES ON SCROLL-HOVER in the mart list (observed cf91=12
// with the arrow displayed on ANTIDOTE=11), contradicting the long-standing
// "hover does NOT update it" note items.ts relied on. The register the old
// verify gated on can disagree with what the player sees; the tilemap cannot
// — it IS what the player sees.
//
// PURE: operates on Screen.textGrid() output + externally-read flags, no
// emulator, no RAM — probe_menu620 replays captured grids offline.

export interface MenuEntry { y: number; label: string; price: number | null }

export interface MenuView {
  open: boolean;                    // a selection arrow is drawn
  arrow: { x: number; y: number } | null;
  selectedLabel: string | null;     // first text cell right of the arrow, its row
  selectedPrice: number | null;     // right-aligned digits on the row below
  entries: MenuEntry[];             // visible entries of the arrow's window
  dialog: string;                   // bottom textbox text (rows 12-17), '' if none
  prompt: boolean;                  // 0xEE: text paused, waiting for A
  yesNo: boolean;                   // a two-option window is up (RAM flag)
}

/** First text cell on a row at/after column x: the run of characters up to a
 *  gap of 2+ spaces. Menus right-align money/prices on the same row, so a
 *  single-space split would glue "BUY           401" into one label. */
function cellAt(row: string, x: number): string {
  const cells = (row ?? "").slice(x).split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  return cells[0] ?? "";
}

/** Rightmost digit-run on a row (price column), or null. */
function priceOn(row: string): number | null {
  const m = (row ?? "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function readMenu(grid: string[], arrow: { x: number; y: number } | null,
                         prompt: boolean, yesNo: boolean): MenuView {
  // Bottom textbox: rows 12-17 (borders at 12/17, text between). Kept even
  // when a menu is also up — dialogs and menus coexist (mart greeting).
  const dialog = grid.slice(13, 17).map(r => (r ?? "").trim()).filter(Boolean).join(" ");
  if (!arrow) {
    return { open: false, arrow: null, selectedLabel: null, selectedPrice: null,
             entries: [], dialog, prompt, yesNo };
  }
  const col = arrow.x + 1;
  const label = cellAt(grid[arrow.y], col) || null;
  // List windows draw entries every 2 rows in the arrow's column band. Walk
  // out from the arrow in both directions while that band holds text; stop at
  // the dialog box (row 12). Row 0 is the MONEY header — never an entry.
  const entries: MenuEntry[] = [];
  const entryAt = (y: number): MenuEntry | null => {
    if (y < 1 || y > 11) return null;
    const l = cellAt(grid[y], col);
    if (!l) return null;
    return { y, label: l, price: priceOn(grid[y + 1] ?? "") };
  };
  let top = arrow.y;
  while (top - 2 >= 1 && entryAt(top - 2)) top -= 2;
  for (let y = top; y <= 11; y += 2) {
    const e = entryAt(y);
    if (!e) break;
    entries.push(e);
  }
  const selectedPrice = priceOn(grid[arrow.y + 1] ?? "");
  return { open: true, arrow, selectedLabel: label, selectedPrice, entries, dialog, prompt, yesNo };
}

/** Case/diacritic-insensitive label match: the tilemap decodes "POKe BALL"
 *  (and, via the shared charmap, "POKé"-style é) while ids carry snake_case
 *  names. Normalizes both sides so the comparison cannot drift with either
 *  spelling convention. */
export function labelMatches(decoded: string, itemName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\u00e9/g, "e")
    .replace(/[^a-z0-9]+/g, " ").trim();
  return norm(decoded) === norm(itemName);
}

/** One brain-facing line for the state block, or null when nothing is open
 *  (wq#488: no dead prose). cur/scroll/maxItem come from RAM; total is the
 *  known stock length when the caller has one (mart), else 0 = unknown. */
export function renderMenuLine(v: MenuView, cur: number, scroll: number, total: number): string | null {
  const parts: string[] = [];
  if (v.open && v.selectedLabel) {
    const pos = total > 0 ? ` [row ${scroll + cur + 1}/${total}]` : "";
    parts.push(`MENU cursor on "${v.selectedLabel}"` +
      (v.selectedPrice !== null ? ` ($${v.selectedPrice})` : "") + pos +
      (v.entries.length > 1
        ? ` — visible: ${v.entries.map(e => e.label + (e.price !== null ? ` $${e.price}` : "")).join(" | ")}`
        : ""));
    if (v.yesNo) parts.push(`YES/NO choice is up — choose(yes) or choose(no)`);
  }
  if (v.dialog) parts.push(`DIALOG: ${v.dialog.slice(0, 140)}${v.prompt ? " [more - press A/talk()]" : ""}`);
  return parts.length ? parts.join("\n") : null;
}
