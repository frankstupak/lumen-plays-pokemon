// wq#547 — the Pokemon Center map ids, DERIVED FROM THE ROM, not remembered.
//
// heal.ts already had the right answer for the emulator-side case: a Gen 1
// Center is identified by its TILESET (POKECENTER_TILESET = 6, read from
// wCurMapTileset), which needs zero per-map configuration and cannot drift.
// Use that whenever a live emulator is in hand.
//
// This table exists for the OTHER case: the blackout detector runs over
// state_read events and over historical event logs, where there is no
// emulator and no tileset field — only {map, money, party}. So the id set has
// to be a literal.
//
// THE CONTRACT THAT KEEPS A LITERAL HONEST is the one SPLIT_MAPS and wq#534's
// POCKET_MAPS already keep: the values are shipped literally, and a probe
// re-derives them from the ROM on every run and FAILS on a one-entry drift.
// probe_blackout547 section A does that — it walks the map header pointers via
// names.ts (MapHeaderPointers 00:01ae + MapHeaderBanks 03:423d, reverse-looked
// up in the pret symbol table) and asserts the /pokecenter/i matches are
// exactly this set. A different ROM build fails loudly instead of silently
// mis-scoring blackouts.
//
// Derived 2026-08-13 from roms/pokeblue.gb + roms/pokeblue.sym: 11 maps.
export const CENTER_MAPS: ReadonlySet<number> = new Set([
  41,   // Viridian Pokecenter
  58,   // Pewter Pokecenter
  64,   // Cerulean Pokecenter
  68,   // Mt Moon Pokecenter
  81,   // Rock Tunnel Pokecenter
  89,   // Vermilion Pokecenter
  133,  // Celadon Pokecenter
  141,  // Lavender Pokecenter
  154,  // Fuchsia Pokecenter
  171,  // Cinnabar Pokecenter
  182,  // Saffron Pokecenter
]);
