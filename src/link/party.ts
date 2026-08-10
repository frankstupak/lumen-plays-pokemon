// LPP Multiplayer — party construction for link tests (2026-08-10).
//
// M3 was only ever proved with a ONE-MON party on each side, which never
// exercises the list cursor. This builds multi-mon parties from RAM so the
// cursor, the CANCEL sentinel and non-first-slot selection can be tested.
//
// Gen1 party layout (label-exact, roms/pokeblue.sym):
//   $D163 wPartyCount
//   $D164 wPartySpecies   1 byte per slot, $FF terminator
//   $D16B wPartyMons      party_struct, 44 bytes per slot
//   $D273 wPartyMonOT     11 bytes per slot
//   $D2B5 wPartyMonNicks  11 bytes per slot
// Within a party_struct: +0 species, +12 OTID (big-endian), +33 level.
//
// Slots are built by CLONING slot 1 and overriding identity fields only. That
// keeps stats, types, moves and DVs self-consistent with the species — a
// hand-built struct with a mismatched species would render and battle wrongly
// and would tell us nothing about the link.

import { encodeName, NAME_LENGTH } from "./identity";

export const PARTY = {
  count: 0xD163,
  species: 0xD164,
  mons: 0xD16B,
  ot: 0xD273,
  nicks: 0xD2B5,
  structSize: 44,
  maxSlots: 6,
} as const;

const OFF_SPECIES = 0;
const OFF_OTID = 12;
const OFF_LEVEL = 33;

export interface SlotSpec {
  nick: string;
  level?: number;
  otid?: number;   // big-endian
  ot?: string;
  species?: number;
}

const putBytes = (mem: number[], a: number, b: number[]) => { b.forEach((v, i) => { mem[a + i] = v & 0xFF; }); };

export function partyCount(mem: number[]): number { return mem[PARTY.count] & 0xFF; }

/**
 * Append a slot by cloning slot 1 and overriding the given identity fields.
 * Returns the new slot index. Throws if the party is already full.
 */
export function addPartyMonClone(mem: number[], spec: SlotSpec): number {
  const n = partyCount(mem);
  if (n >= PARTY.maxSlots) throw new Error(`party already has ${n} slots`);
  if (n < 1) throw new Error("addPartyMonClone needs an existing slot 1 to clone");

  const src = PARTY.mons;
  const dst = PARTY.mons + PARTY.structSize * n;
  for (let i = 0; i < PARTY.structSize; i++) mem[dst + i] = mem[src + i] & 0xFF;

  if (spec.species !== undefined) mem[dst + OFF_SPECIES] = spec.species & 0xFF;
  if (spec.level !== undefined) mem[dst + OFF_LEVEL] = spec.level & 0xFF;
  if (spec.otid !== undefined) { mem[dst + OFF_OTID] = (spec.otid >> 8) & 0xFF; mem[dst + OFF_OTID + 1] = spec.otid & 0xFF; }

  // OT name: clone slot 1's unless overridden.
  const otSrc = PARTY.ot, otDst = PARTY.ot + NAME_LENGTH * n;
  if (spec.ot !== undefined) putBytes(mem, otDst, encodeName(spec.ot));
  else for (let i = 0; i < NAME_LENGTH; i++) mem[otDst + i] = mem[otSrc + i] & 0xFF;

  putBytes(mem, PARTY.nicks + NAME_LENGTH * n, encodeName(spec.nick));

  // Species list, then re-terminate.
  mem[PARTY.species + n] = (spec.species ?? (mem[src + OFF_SPECIES] & 0xFF)) & 0xFF;
  mem[PARTY.species + n + 1] = 0xFF;
  mem[PARTY.count] = n + 1;
  return n;
}

export interface SlotView { slot: number; species: number; otid: number; level: number; ot: string; nick: string; }

/** Read every occupied slot — used to prove which slot actually moved. */
export function readParty(mem: number[]): SlotView[] {
  const decode = (a: number) => {
    let s = "";
    for (let i = 0; i < NAME_LENGTH; i++) {
      const c = mem[a + i] & 0xFF;
      if (c === 0x50) break;
      s += c >= 0x80 && c <= 0x99 ? String.fromCharCode(65 + c - 0x80) : c === 0x7F ? " " : `<${c.toString(16)}>`;
    }
    return s;
  };
  const out: SlotView[] = [];
  const n = partyCount(mem);
  for (let i = 0; i < n && i < PARTY.maxSlots; i++) {
    const b = PARTY.mons + PARTY.structSize * i;
    out.push({
      slot: i,
      species: mem[b + OFF_SPECIES] & 0xFF,
      otid: ((mem[b + OFF_OTID] & 0xFF) << 8) | (mem[b + OFF_OTID + 1] & 0xFF),
      level: mem[b + OFF_LEVEL] & 0xFF,
      ot: decode(PARTY.ot + NAME_LENGTH * i),
      nick: decode(PARTY.nicks + NAME_LENGTH * i),
    });
  }
  return out;
}

export const slotKey = (s: SlotView) => `sp${s.species}/id$${s.otid.toString(16)}/lv${s.level}/OT:${s.ot}/nick:${s.nick}`;
export const describeParty = (p: SlotView[]) => p.map(s => `[${s.slot}] ${slotKey(s)}`).join("\n        ");
