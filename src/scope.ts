// wq#606: MAP-SCOPED TARGETS + INTERIOR EDGE REFUSAL — the pure half.
//
// THE CLASS THIS KILLS: cross-map coordinate replay. Three occurrences on the
// board before this module existed — wq#564 (east-pocket (5,7) guidance),
// wq#601 (goto(12,7) issued on map15), and the 2026-08-15 mart-door loop
// (goto(4,7) — MART-INTERIOR coords — replayed on the CITY map, no_path,
// walk back inside, repeat for 2h+). Each earlier fix repaired the SITE;
// this module gives the executor a map concept so the CLASS dies: a target
// is a (map,x,y) tuple, bare (x,y) means "the map I am standing on", and a
// target carrying a different map id is REFUSED with a line naming both maps
// instead of silently pathing to the same-numbered tile on the wrong map.
//
// PURE BY DESIGN: no emulator, no RAM, no I/O — probe_scope606 asserts every
// branch offline. agent.ts owns the wiring.

/** A parsed goto target. m === null means "caller's current map" (backcompat
 *  two-arg form). */
export interface GotoTarget { m: number | null; x: number; y: number }

/**
 * Parse the raw goto argument string into a target, tolerantly.
 *
 * Accepted forms (all observed or anticipated brain spellings):
 *   "4,7"            -> { m: null, x: 4, y: 7 }     (current map)
 *   "67,4,7"         -> { m: 67,   x: 4, y: 7 }     (explicit triple)
 *   "map67 4,7"      -> { m: 67,   x: 4, y: 7 }
 *   "4,7 on map67"   -> { m: 67,   x: 4, y: 7 }     (notepad annotation replayed
 *                                                    verbatim — MUST parse so the
 *                                                    cross-map refusal can fire on
 *                                                    it rather than a NaN error)
 *   "map67:4,7"      -> { m: 67,   x: 4, y: 7 }
 * Anything without exactly two coordinate numbers after map extraction is
 * null: the caller answers with a bad-args line that TEACHES the two forms.
 */
export function parseGotoTarget(raw: string): GotoTarget | null {
  let m: number | null = null;
  let rest = raw;
  const mapTok = raw.match(/map\s*[:#]?\s*(\d{1,3})/i);
  if (mapTok) { m = Number(mapTok[1]); rest = raw.replace(mapTok[0], " "); }
  const nums = (rest.match(/\d{1,3}/g) ?? []).map(Number);
  if (m === null && nums.length === 3) return { m: nums[0], x: nums[1], y: nums[2] };
  if (nums.length === 2) return { m, x: nums[0], y: nums[1] };
  return null;
}

/** The one-line cross-map refusal, or null when the target is executable.
 *  Names BOTH maps (ticket deliverable 1) and says what to do instead. */
export function crossMapRefusal(t: GotoTarget, curMap: number,
                                label: (id: number) => string | null): string | null {
  if (t.m === null || t.m === curMap) return null;
  const tn = label(t.m), cn = label(curMap);
  return `target (${t.x},${t.y}) is on map${t.m}${tn ? ` (${tn})` : ""}, you are on ` +
    `map${curMap}${cn ? ` (${cn})` : ""} — coordinates are MAP-LOCAL and do not transfer. ` +
    `Pick a tile on map${curMap} (MAPGRID/WARPS are current), or travel to map${t.m} first.`;
}

/**
 * Annotate bare "(x,y)" coordinate tokens in a brain note with the map the
 * note was written on: "(4,7)" written inside the mart becomes
 * "(4,7 on map67)". Mechanical scoping at WRITE time is what makes stored
 * goals map-scoped without trusting the brain to remember the convention —
 * and if the annotated form is later replayed verbatim into goto(),
 * parseGotoTarget() reads the map id back out and the refusal fires.
 * Already-scoped tokens (a "map" word inside or just before the parens)
 * are left alone.
 */
export function scopeNoteCoords(text: string, map: number): string {
  return text.replace(/\((\d{1,3})\s*,\s*(\d{1,3})\)/g, (full, x, y, off: number) => {
    const before = text.slice(Math.max(0, off - 10), off);
    if (/map\s*[:#]?\s*\d*\s*$/i.test(before)) return full;   // "map67 (4,7)" — scoped
    return `(${x},${y} on map${map})`;
  });
}

// ---------------------------------------------------------------------------
// INTERIOR EDGE REFUSAL (ticket deliverable 2).
//
// Gen 1 stores a map's edge connections as ONE BYTE in the map header copied
// to WRAM: pokered's wCurMapConnections. The byte is the last of the header
// (d370) and carries no label in roms/pokeblue.sym, so MapModel derives its
// address as wCurMapHeaderEnd - 1. Bit layout from pokered
// constants/map_data_constants.asm (EAST_F=0, WEST_F=1, SOUTH_F=2, NORTH_F=3)
// — VERIFIED EMPIRICALLY by probe_scope606 section E against three live
// fixtures: Cerulean map3 = 0x0F (all four), Route 4 map15 = 0x05 (E+S: Route 3 attaches from the SOUTH),
// Cerulean Mart map67 = 0x00 (interior). A map with connections === 0 has no
// adjacent map to walk into: leave_edge THERE is 14 walks into a wall
// (observed live 01:50-03:15Z); the only exits are door warps.
export const CONN = { EAST: 1, WEST: 2, SOUTH: 4, NORTH: 8 } as const;

export function connNames(c: number): string[] {
  const out: string[] = [];
  if (c & CONN.NORTH) out.push("N");
  if (c & CONN.SOUTH) out.push("S");
  if (c & CONN.WEST) out.push("W");
  if (c & CONN.EAST) out.push("E");
  return out;
}

export interface WarpLike { x: number; y: number; destMap: number }

/** Refusal line for leave_edge, or null when the edge exit is plausible.
 *  Decided from the CONNECTION BYTE, never a hardcoded map list (ticket). */
export function edgeRefusal(connections: number, dir: "N" | "S" | "E" | "W",
                            warps: WarpLike[], mapId: number,
                            label: string | null): string | null {
  const name = label ? ` (${label})` : "";
  if (connections === 0) {
    const list = warps.map((w, i) => `${i}:(${w.x},${w.y})->map${w.destMap}`).join(" ");
    return `map${mapId}${name} is an INTERIOR — no edge connections exist; ` +
      `interiors exit via door warps. Warps here: ${list || "(none)"} — use enter_warp(<index>).`;
  }
  const bit = { E: CONN.EAST, W: CONN.WEST, S: CONN.SOUTH, N: CONN.NORTH }[dir];
  if (!(connections & bit))
    return `map${mapId}${name} has no ${dir} connection — this map's walkable edges: ` +
      `${connNames(connections).join(",")}.`;
  return null;
}
