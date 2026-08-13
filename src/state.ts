// Decode live WRAM into typed GameState via pret symbols (all offsets symbol-derived)
import { Emulator } from "./emulator";
import { SymbolTable } from "./symbols";

export interface PartyMon {
  species: number; hp: number; maxHp: number; level: number; status: number;
  moves: number[]; pp: number[];   // pp masked to current (bits 6-7 = PP Ups stripped)
}
export interface GameState {
  map: number; x: number; y: number;
  partyCount: number; party: PartyMon[];
  badges: number; badgeCount: number;
  money: number; inBattle: number;
  // wq#503 (kiosk trainer panel). All symbol-derived, all read every turn:
  // mem() is a live zero-copy reference, so these cost a few array indexes.
  pokedexOwned: number; pokedexSeen: number;
  playH: number; playM: number; playS: number;
  storyScore: number;
}

const bcd = (bytes: number[]) =>
  bytes.reduce((acc, b) => acc * 100 + ((b >> 4) * 10 + (b & 0xf)), 0);

/** Set bits over [from, to) — used for the Pokedex owned/seen bitfields,
 *  whose lengths come from their own *End symbols rather than a literal. */
const popcountRange = (m: number[], from: number, to: number) => {
  let n = 0;
  for (let a = from; a < to; a++) { let b = m[a]; while (b) { n += b & 1; b >>= 1; } }
  return n;
};

/** wq#471: STORY-CRITICAL Gen 1 event flags, in campaign order.
 *  idx = bit index into wEventFlags (base 0xd747 per roms/pokeblue.sym);
 *  byte = idx >> 3, bit = idx & 7 (LSB-first, pokered CheckEvent semantics).
 *  Values derived from pret/pokered constants/event_constants.asm (const_def
 *  expansion) and RAM-verified against live checkpoints (see
 *  src/probe_storyscore.ts + reports/471_storyscore.md): every checkpoint with
 *  Boulder Badge has EVENT_BEAT_BROCK set, none without it do.
 *  Each flag is PERMANENT once set, so popcount over this set is monotonic.
 *  Optional-but-permanent flags (town map, nugget, bike, rival fights) are
 *  fine: they can only add points, never remove them. */
export const STORY_FLAGS: { name: string; idx: number }[] = [
  { name: "EVENT_FOLLOWED_OAK_INTO_LAB",          idx: 0x000 },  // byte 0   bit 0
  { name: "EVENT_GOT_STARTER",                    idx: 0x022 },  // byte 4   bit 2
  { name: "EVENT_GOT_OAKS_PARCEL",                idx: 0x039 },  // byte 7   bit 1
  { name: "EVENT_OAK_GOT_PARCEL",                 idx: 0x038 },  // byte 7   bit 0 (parcel delivered)
  { name: "EVENT_GOT_POKEDEX",                    idx: 0x025 },  // byte 4   bit 5
  { name: "EVENT_GOT_TOWN_MAP",                   idx: 0x018 },  // byte 3   bit 0 (optional)
  { name: "EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE",  idx: 0x525 },  // byte 164 bit 5 (optional)
  { name: "EVENT_BEAT_BROCK",                     idx: 0x077 },  // byte 14  bit 7
  { name: "EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD",   idx: 0x579 },  // byte 175 bit 1
  { name: "EVENT_GOT_DOME_FOSSIL",                idx: 0x57e },  // byte 175 bit 6 (one of two)
  { name: "EVENT_GOT_HELIX_FOSSIL",               idx: 0x57f },  // byte 175 bit 7 (one of two)
  { name: "EVENT_GOT_NUGGET",                     idx: 0x540 },  // byte 168 bit 0 (optional, Rte 24)
  { name: "EVENT_BEAT_CERULEAN_RIVAL",            idx: 0x098 },  // byte 19  bit 0
  { name: "EVENT_BEAT_MISTY",                     idx: 0x0bf },  // byte 23  bit 7
  { name: "EVENT_GOT_BICYCLE",                    idx: 0x0c0 },  // byte 24  bit 0 (optional)
  { name: "EVENT_GOT_SS_TICKET",                  idx: 0x55c },  // byte 171 bit 4
  { name: "EVENT_SS_ANNE_LEFT",                   idx: 0x5e2 },  // byte 188 bit 2
  { name: "EVENT_BEAT_LT_SURGE",                  idx: 0x167 },  // byte 44  bit 7
  { name: "EVENT_BEAT_ERIKA",                     idx: 0x1a9 },  // byte 53  bit 1
  { name: "EVENT_BEAT_POKEMON_TOWER_RIVAL",       idx: 0x0f1 },  // byte 30  bit 1
  { name: "EVENT_RESCUED_MR_FUJI",                idx: 0x4cf },  // byte 153 bit 7
  { name: "EVENT_GOT_POKE_FLUTE",                 idx: 0x12a },  // byte 37  bit 2
  { name: "EVENT_BEAT_KOGA",                      idx: 0x259 },  // byte 75  bit 1
  { name: "EVENT_BEAT_SABRINA",                   idx: 0x361 },  // byte 108 bit 1
  { name: "EVENT_BEAT_BLAINE",                    idx: 0x299 },  // byte 83  bit 1
];

export class StateReader {
  private stride: number;
  private off: { hp: number; status: number; level: number; maxHp: number; moves: number; pp: number };
  constructor(private emu: Emulator, private sym: SymbolTable) {
    const base = sym.addr("wPartyMon1");
    this.stride = sym.addr("wPartyMon2") - base;
    this.off = {
      hp: sym.addr("wPartyMon1HP") - base,
      status: sym.addr("wPartyMon1Status") - base,
      level: sym.addr("wPartyMon1Level") - base,
      maxHp: sym.addr("wPartyMon1MaxHP") - base,
      moves: sym.addr("wPartyMon1Moves") - base,
      pp: sym.addr("wPartyMon1PP") - base,
    };
  }

  read(): GameState {
    const m = this.emu.mem();
    const s = this.sym;
    const partyCount = m[s.addr("wPartyCount")];
    const party: PartyMon[] = [];
    const base = s.addr("wPartyMon1");
    for (let i = 0; i < Math.min(partyCount, 6); i++) {
      const p = base + i * this.stride;
      party.push({
        species: m[p],
        hp: (m[p + this.off.hp] << 8) | m[p + this.off.hp + 1],
        status: m[p + this.off.status],
        level: m[p + this.off.level],
        maxHp: (m[p + this.off.maxHp] << 8) | m[p + this.off.maxHp + 1],
        moves: [0, 1, 2, 3].map(j => m[p + this.off.moves + j]),
        pp: [0, 1, 2, 3].map(j => m[p + this.off.pp + j] & 0x3f),
      });
    }
    const badges = m[s.addr("wObtainedBadges")];
    const moneyA = s.addr("wPlayerMoney");
    return {
      map: m[s.addr("wCurMap")],
      x: m[s.addr("wXCoord")],
      y: m[s.addr("wYCoord")],
      partyCount, party, badges,
      badgeCount: badges.toString(2).split("1").length - 1,
      money: bcd([m[moneyA], m[moneyA + 1], m[moneyA + 2]]),
      inBattle: m[s.addr("wIsInBattle")],
      // wq#503: the Pokedex bitfields are bounded by their own End symbols
      // (owned d2f7..d30a, seen d30a..d31d = 19 bytes = 152 bits each), so the
      // loop can never run off the end even on a differently-built ROM.
      pokedexOwned: popcountRange(m, s.addr("wPokedexOwned"), s.addr("wPokedexOwnedEnd")),
      pokedexSeen: popcountRange(m, s.addr("wPokedexSeen"), s.addr("wPokedexSeenEnd")),
      // Play time is three separate single-byte counters; wPlayTimeMaxed sits
      // between hours and minutes, which is how the sym file proves hours is
      // one byte and not a word.
      playH: m[s.addr("wPlayTimeHours")],
      playM: m[s.addr("wPlayTimeMinutes")],
      playS: m[s.addr("wPlayTimeSeconds")],
      storyScore: this.storyScore(),
    };
  }

  /** wq#503: names of the STORY_FLAGS currently set, in campaign order. The
   *  kiosk milestone line is the LAST of these to appear — a milestone is a
   *  RAM flag transition, never a dialog line or a brain claim. */
  storyFlagsSet(): string[] {
    return STORY_FLAGS.filter(f => this.eventFlag(f.idx)).map(f => f.name);
  }

  /** Read one event flag bit from wEventFlags (LSB-first within each byte,
   *  matching pokered's CheckEvent: byte = idx >> 3, bit = idx & 7). */
  eventFlag(idx: number): boolean {
    const m = this.emu.mem();
    const a = this.sym.addr("wEventFlags");
    return ((m[a + (idx >> 3)] >> (idx & 7)) & 1) === 1;
  }

  /** wq#471: story-progress score = popcount over STORY_FLAGS, a curated
   *  subset of STORY-CRITICAL Gen 1 event flags. Every flag in the set is
   *  permanent once set within a playthrough, so the score is strictly
   *  monotonic — unlike eventCount(), which also counts incidental flags
   *  (museum NPCs etc.) and caused the Route 4 -> Pewter resume regression. */
  storyScore(): number {
    let n = 0;
    for (const f of STORY_FLAGS) if (this.eventFlag(f.idx)) n++;
    return n;
  }

  /** Popcount over the 320-byte wEventFlags array (0xd747-0xd886, symbol-
   *  verified vs wGrassRate). Monotonic-ish story-progress signal. */
  eventCount(): number {
    const m = this.emu.mem();
    const a = this.sym.addr("wEventFlags");
    let n = 0;
    for (let i = 0; i < 0x140; i++) {
      let b = m[a + i];
      while (b) { n += b & 1; b >>= 1; }
    }
    return n;
  }
}
