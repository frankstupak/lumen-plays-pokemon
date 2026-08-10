// LPP Multiplayer M2 groundwork — link-state RAM reader (wq#430).
// Reads the Gen1 link WRAM the harness needs to know connection status, keyed to
// addresses PINNED FROM THE ROM (research/link/R4): wLinkState=$D12B and friends.
// Read-only; no ROM driving here (that's the M2 Cable Club macro).
//
// LINK_STATE_* numeric enum is intentionally NOT hardcoded to guessed values:
// R4 shows the Serial ISR branches on link-state == 2, but the full enum must be
// CONFIRMED IN VIVO (observe $D12B as the live ROM walks the Cable Club) before
// the macro trusts specific values. This module exposes the raw byte + the known
// structural addresses so M2 can do that confirmation.

export const LINK_ADDR = {
  wLinkState: 0xD12B,
  wLinkTimeoutCounter: 0xCC47,
  wSerialExchangeNybbleReceiveData: 0xCC3E,
  wSerialExchangeNybbleSendData: 0xCC42,
  wLinkBattleRandomNumberList: 0xD148,
  wLinkBattleRandomNumberListIndex: 0xCCDE,
  wSerialPlayerDataBlock: 0xD152,
  wSerialEnemyDataBlock: 0xD893,
  wPlayerName: 0xD158,
  wLinkEnemyTrainerName: 0xD887,
  // serial hardware regs (R1), for completeness / assertions
  rSB: 0xFF01,
  rSC: 0xFF02,
} as const;

// Provisional enum labels (values TO BE CONFIRMED IN VIVO per R4). Kept as a map
// from observed byte -> label so M2 can fill it by watching the live ROM, rather
// than asserting a guessed number and silently mislabeling.
export const LINK_STATE_LABEL: Record<number, string> = {
  0x00: "NONE",                 // CONFIRMED in vivo: idle overworld
  0x01: "IN_CABLE_CLUB",        // CONFIRMED in vivo 2026-08-08 (wq#434): observed
                                // on a core that completed the Cable Club handshake
                                // over our SerialBus while its peer showed the
                                // room-selection menu ("Where would you like to go?").
  0x02: "START/NEGOTIATE?",     // ISR branches on 2 (R4); still unconfirmed
};

export interface LinkSnapshot {
  linkState: number;
  linkStateLabel: string;
  timeout: number;
  playerName: number[];       // raw Gen1-charset bytes (0x50-terminated)
  sc: number;
  sb: number;
}

/** mem = a live memory array (Emulator.mem()). Pure read. */
export function readLinkState(mem: number[] | Uint8Array): LinkSnapshot {
  const b = (a: number) => mem[a] & 0xFF;
  const ls = b(LINK_ADDR.wLinkState);
  const name: number[] = [];
  for (let i = 0; i < 11; i++) {
    const c = b(LINK_ADDR.wPlayerName + i);
    if (c === 0x50) break;                 // Gen1 string terminator
    name.push(c);
  }
  return {
    linkState: ls,
    linkStateLabel: LINK_STATE_LABEL[ls] ?? `0x${ls.toString(16)}`,
    timeout: b(LINK_ADDR.wLinkTimeoutCounter),
    playerName: name,
    sc: b(LINK_ADDR.rSC),
    sb: b(LINK_ADDR.rSB),
  };
}

/** True when the game reports it is NOT in any link state (idle overworld). */
export function isLinkIdle(mem: number[] | Uint8Array): boolean {
  return (mem[LINK_ADDR.wLinkState] & 0xFF) === 0x00;
}
