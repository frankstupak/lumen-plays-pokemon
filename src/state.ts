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
}

const bcd = (bytes: number[]) =>
  bytes.reduce((acc, b) => acc * 100 + ((b >> 4) * 10 + (b & 0xf)), 0);

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
    };
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
