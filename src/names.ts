// wq#503 — human-readable game names for the kiosk trainer-stats panel.
//
// Every name here is derived from the ROM + the pret symbol table at RUNTIME;
// none of it is transcribed by hand. That is the whole point. A hand-typed
// table drifts from the ROM and the tablet then shows a confident lie, which
// is worse than showing nothing.
//
//   map id  -> MapHeaderPointers (00:01ae) + MapHeaderBanks (03:423d). The
//              resulting bank:addr is reverse-looked-up in the symbol table;
//              pokered labels every map header "<Name>_h", so map 59 resolves
//              to MtMoon1F_h -> "Mt Moon 1F".
//   species -> MonsterNames (07:421e), 10 bytes per entry, Gen 1 text
//              encoding, indexed by INTERNAL species id - 1 (NOT the Pokedex
//              number: internal 0xB2 = Charmeleon, dex #5).
//
// Table lengths come from SymbolTable.nextAddr(), never from a literal, so a
// different ROM build fails loudly instead of reading off the end.
//
// 22 map ids resolve to an unlabelled stub header (11, 105-117, 204-206, 231,
// 237-238, 241-244). Those are the genuinely unused Gen 1 slots — several
// share one duplicate header — and wCurMap never holds them in play. mapName()
// returns null for those and the caller renders the raw id, which is a fact
// rather than a guess.
import { Rom } from "./rom";
import { SymbolTable } from "./symbols";

/** Gen 1 string encoding -> ASCII. 0x50 terminates. Unknown bytes decode to
 *  "?" so a misaligned read is visibly wrong instead of quietly plausible. */
export function decodeGen1(bytes: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const t = bytes[i];
    if (t === 0x50) break;
    if (t >= 0x80 && t <= 0x99) s += String.fromCharCode(0x41 + t - 0x80);         // A-Z
    else if (t >= 0xa0 && t <= 0xb9) s += String.fromCharCode(0x61 + t - 0xa0);    // a-z
    else if (t === 0x7f) s += " ";
    // Byte values confirmed by reading MonsterNames directly: NIDORAN ends
    // 8d 88 83 8e 91 80 8d EF (id 3) and ...F5 (id 15), FARFETCH ends 87 E0 83.
    // Without these three, those names decode with a "?" and get filtered out
    // of the table entirely, so the kiosk would show "SPECIES 3" for a Pokemon
    // that is catchable two routes back.
    else if (t === 0xe0) s += "'";
    else if (t === 0xef) s += "\u2642";   // male sign
    else if (t === 0xf5) s += "\u2640";   // female sign
    else if (t === 0xe1) s += "PK";
    else if (t === 0xe2) s += "MN";
    else if (t === 0xe3) s += "-";
    else if (t === 0xe8) s += ".";
    else if (t === 0xf6) s += "0";
    else if (t >= 0xf7 && t <= 0xff) s += String.fromCharCode(0x31 + t - 0xf7);    // 1-9
    else s += "?";
  }
  return s;
}

/** Split a pokered CamelCase label into words without breaking floor labels.
 *  A digit run keeps a trailing capital only when that capital does not start
 *  a new word: "MtMoon1F" -> "Mt Moon 1F", "MtMoonB1F" -> "Mt Moon B1F", but
 *  "Route22Gate" -> "Route 22 Gate" (the G belongs to "Gate"). */
const LABEL_TOKENS = /[A-Z][a-z]+|[A-Z]?\d+(?:[A-Z](?![a-z]))?|[A-Z]+(?![a-z])|[a-z]+/g;

export function prettifyLabel(label: string): string {
  const stem = label.endsWith("_h") ? label.slice(0, -2) : label;
  const parts = stem.match(LABEL_TOKENS);
  return parts && parts.length ? parts.join(" ") : stem;
}

/** wObtainedBadges bit index -> badge name. Order is pokered's badge constant
 *  order (see scripts/CeruleanBadgeHouse.asm, whose badge table is asserted to
 *  be NUM_BADGES long): BOULDER, CASCADE, THUNDER, RAINBOW, SOUL, MARSH,
 *  VOLCANO, EARTH. Bit 0 is additionally RAM-verified on this campaign —
 *  wObtainedBadges = 1 while EVENT_BEAT_BROCK is set, i.e. the Boulder Badge. */
export const BADGE_NAMES = [
  "Boulder", "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth",
];

/** Party status byte -> short label. pokered status bits: 0-2 sleep counter,
 *  3 poison, 4 burn, 5 freeze, 6 paralysis. Bit 7 is unused and renders "?"
 *  rather than being silently dropped. Exported as data so the kiosk page can
 *  apply the SAME table instead of carrying a second copy of the mapping. */
export const STATUS_BITS: [number, string][] = [
  [0x07, "SLP"], [0x08, "PSN"], [0x10, "BRN"], [0x20, "FRZ"], [0x40, "PAR"], [0x80, "?"],
];

export function statusLabel(b: number): string {
  if (!b) return "OK";
  const out = STATUS_BITS.filter(([mask]) => b & mask).map(([, name]) => name);
  return out.length ? out.join("+") : "OK";
}

/** ROM-derived name tables. Built once at boot (a few hundred lookups); after
 *  that every call is a plain object read. */
export class GameNames {
  /** map id -> display name. Sparse: unused Gen 1 slots are absent. */
  readonly maps: Record<number, string> = {};
  /** internal species id -> display name. Sparse only if the ROM is odd. */
  readonly mons: Record<number, string> = {};
  readonly mapCount: number;
  readonly monCount: number;

  constructor(rom: Rom, sym: SymbolTable) {
    const ptrs = sym.sym("MapHeaderPointers");
    const banks = sym.sym("MapHeaderBanks");
    const byPtr = (sym.nextAddr(ptrs.bank, ptrs.addr) - ptrs.addr) / 2;
    const byBank = sym.nextAddr(banks.bank, banks.addr) - banks.addr;
    if (byPtr !== byBank)
      throw new Error(`map table length mismatch: pointers=${byPtr} banks=${byBank}`);
    this.mapCount = byPtr;
    for (let id = 0; id < this.mapCount; id++) {
      const addr = rom.byte(ptrs.bank, ptrs.addr + id * 2)
        | (rom.byte(ptrs.bank, ptrs.addr + id * 2 + 1) << 8);
      const bank = rom.byte(banks.bank, banks.addr + id);
      const label = sym.labelsAt(bank, addr).find(n => n.endsWith("_h"));
      if (label) this.maps[id] = prettifyLabel(label);
    }

    const mn = sym.sym("MonsterNames");
    this.monCount = (sym.nextAddr(mn.bank, mn.addr) - mn.addr) / 10;
    for (let i = 0; i < this.monCount; i++) {
      const name = decodeGen1(rom.bytes(mn.bank, mn.addr + i * 10, 10)).trim();
      if (name && !name.includes("?")) this.mons[i + 1] = name;   // internal id = i + 1
    }
  }

  /** Display name for a map id, or null when the id has no labelled header
   *  (unused Gen 1 slot, or a transient/garbage wCurMap read). */
  mapName(id: number): string | null { return this.maps[id] ?? null; }

  /** Display name for an INTERNAL species id, or null when unknown. */
  monName(species: number): string | null { return this.mons[species] ?? null; }
}
