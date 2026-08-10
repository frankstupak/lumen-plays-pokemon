// LPP Multiplayer — trainer/party identity accessors (wq#436 follow-up).
//
// WHY THIS EXISTS (measured, 2026-08-09):
// Every link run so far booted BOTH cores from one snapshot, so the two sides
// were byte-identical: same wPlayerName, same wPlayerID, same party, same OT,
// same nickname. A diff over $D163-$D2F7 between the two trade-menu snapshots
// returned ZERO differing bytes. That makes a successful trade and a failed
// trade produce exactly the same RAM, and "OT is still 49699 on both sides"
// -- the signal earlier sessions were chasing -- carries no information at all.
// The trade was in fact already completing; the test was blind.
//
// So: identity is a first-class concept. `readIdentity` gives the comparable
// tuple a trade moves, and `writeIdentity` makes a core a DIFFERENT trainer so
// the swap is observable. Two sides must never be clones again.
//
// Addresses are label-exact from roms/pokeblue.sym (not offset arithmetic into
// the serial block):
//   $D158 wPlayerName      $D359 wPlayerID
//   $D164 wPartySpecies    $D177 wPartyMon1OTID   $D18C wPartyMon1Level
//   $D273 wPartyMon1OT     $D2B5 wPartyMon1Nick
// Receive-side mirrors (what a core was told about its partner):
//   $D887 wLinkEnemyTrainerName  $D8A4 wEnemyMon1Species  $D8B0 wEnemyMon1OTID
//   $D8C5 wEnemyMon1Level        $D9AC wEnemyMon1OT       $D9EE wEnemyMon1Nick

export const ADDR = {
  playerName: 0xD158,
  playerID: 0xD359,
  partySpecies: 0xD164,
  mon1OTID: 0xD177,
  mon1Level: 0xD18C,
  mon1OT: 0xD273,
  mon1Nick: 0xD2B5,
  enemyTrainerName: 0xD887,
  enemyMon1Species: 0xD8A4,
  enemyMon1OTID: 0xD8B0,
  enemyMon1Level: 0xD8C5,
  enemyMon1OT: 0xD9AC,
  enemyMon1Nick: 0xD9EE,
} as const;

/** Gen1 name field width (NAME_LENGTH), terminator included. */
export const NAME_LENGTH = 11;
const TERMINATOR = 0x50;
const SPACE = 0x7F;

/** Gen1 text -> ASCII. Uppercase/lowercase/space only; anything else is shown raw. */
export function decodeName(mem: number[], addr: number, len = NAME_LENGTH): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    const c = mem[addr + i] & 0xFF;
    if (c === TERMINATOR) break;
    if (c >= 0x80 && c <= 0x99) out += String.fromCharCode(65 + c - 0x80);
    else if (c >= 0xA0 && c <= 0xB9) out += String.fromCharCode(97 + c - 0xA0);
    else if (c === SPACE) out += " ";
    else out += `<${c.toString(16)}>`;
  }
  return out;
}

/** ASCII -> Gen1 text, terminated and zero-padded to `len`. Throws on unmappable input. */
export function encodeName(s: string, len = NAME_LENGTH): number[] {
  const out: number[] = [];
  for (const ch of s) {
    if (ch >= "A" && ch <= "Z") out.push(0x80 + ch.charCodeAt(0) - 65);
    else if (ch >= "a" && ch <= "z") out.push(0xA0 + ch.charCodeAt(0) - 97);
    else if (ch === " ") out.push(SPACE);
    else throw new Error(`encodeName: no Gen1 code for ${JSON.stringify(ch)}`);
  }
  if (out.length >= len) throw new Error(`encodeName: "${s}" leaves no room for the terminator in ${len} bytes`);
  out.push(TERMINATOR);
  while (out.length < len) out.push(0x00);
  return out;
}

export interface MonIdentity {
  species: number;
  otid: number;      // big-endian, as the ROM stores it
  level: number;
  ot: string;
  nick: string;
}
export interface Identity {
  playerName: string;
  playerID: number;  // big-endian
  mon1: MonIdentity;
}

const be16 = (mem: number[], a: number) => ((mem[a] & 0xFF) << 8) | (mem[a + 1] & 0xFF);
const putBE16 = (mem: number[], a: number, v: number) => { mem[a] = (v >> 8) & 0xFF; mem[a + 1] = v & 0xFF; };
const putBytes = (mem: number[], a: number, bytes: number[]) => { bytes.forEach((b, i) => { mem[a + i] = b & 0xFF; }); };

/** The identity of THIS core's trainer and its first party slot. */
export function readIdentity(mem: number[]): Identity {
  return {
    playerName: decodeName(mem, ADDR.playerName),
    playerID: be16(mem, ADDR.playerID),
    mon1: {
      species: mem[ADDR.partySpecies] & 0xFF,
      otid: be16(mem, ADDR.mon1OTID),
      level: mem[ADDR.mon1Level] & 0xFF,
      ot: decodeName(mem, ADDR.mon1OT),
      nick: decodeName(mem, ADDR.mon1Nick),
    },
  };
}

/** What this core received about its PARTNER (populated by the 415-byte block). */
export function readEnemyIdentity(mem: number[]): Identity {
  return {
    playerName: decodeName(mem, ADDR.enemyTrainerName),
    playerID: be16(mem, ADDR.enemyMon1OTID), // the enemy's id is only carried per-mon
    mon1: {
      species: mem[ADDR.enemyMon1Species] & 0xFF,
      otid: be16(mem, ADDR.enemyMon1OTID),
      level: mem[ADDR.enemyMon1Level] & 0xFF,
      ot: decodeName(mem, ADDR.enemyMon1OT),
      nick: decodeName(mem, ADDR.enemyMon1Nick),
    },
  };
}

export interface IdentityPatch {
  playerName?: string;
  playerID?: number;   // big-endian value, e.g. 0x1122
  mon1Level?: number;
  mon1OT?: string;
  mon1Nick?: string;
}

/**
 * Make a core a DIFFERENT trainer. Apply BEFORE any link traffic so the change
 * rides across the cable inside the party block; patching afterwards would
 * leave the partner's received copy stale and the pair inconsistent.
 * The mon's OTID always follows the player ID (that is what "originally caught
 * by this trainer" means, and it is the field the trade preserves).
 */
export function writeIdentity(mem: number[], p: IdentityPatch): void {
  if (p.playerName !== undefined) {
    putBytes(mem, ADDR.playerName, encodeName(p.playerName));
    if (p.mon1OT === undefined) putBytes(mem, ADDR.mon1OT, encodeName(p.playerName));
  }
  if (p.playerID !== undefined) {
    putBE16(mem, ADDR.playerID, p.playerID);
    putBE16(mem, ADDR.mon1OTID, p.playerID);
  }
  if (p.mon1Level !== undefined) mem[ADDR.mon1Level] = p.mon1Level & 0xFF;
  if (p.mon1OT !== undefined) putBytes(mem, ADDR.mon1OT, encodeName(p.mon1OT));
  if (p.mon1Nick !== undefined) putBytes(mem, ADDR.mon1Nick, encodeName(p.mon1Nick));
}

/** Stable comparison key for "is this the same mon". */
export function monKey(m: MonIdentity): string {
  return `sp${m.species}/id$${m.otid.toString(16)}/lv${m.level}/OT:${m.ot}/nick:${m.nick}`;
}
export function sameMon(a: MonIdentity, b: MonIdentity): boolean { return monKey(a) === monKey(b); }
export function describeMon(m: MonIdentity): string { return monKey(m); }
