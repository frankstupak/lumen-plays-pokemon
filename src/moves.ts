// Gen 1 move metadata for the early game. Indexed by internal move ID.
// Enough coverage for Pallet -> Cerulean; extend as the run progresses.
// wq#587: `lockIn` marks moves that commit one or more MENU-LESS turns —
// the harness drives every battle through the menu, so a locked menu is a
// wedge risk, not a damage upgrade. RAGE is the extreme case: Gen 1 locks
// the user in until the battle ENDS. BIDE stores for 2-3 menu-less turns;
// DIG auto-executes its second turn. The shared picker below treats them
// as last resort.
export const MOVES: Record<number, { name: string; type: string; power: number; lockIn?: boolean }> = {
  1:  { name: "POUND",         type: "NORMAL",  power: 40 },
  10: { name: "SCRATCH",       type: "NORMAL",  power: 40 },
  16: { name: "GUST",          type: "NORMAL",  power: 40 },   // Gen 1: Normal, not Flying
  17: { name: "WING ATTACK",   type: "FLYING",  power: 35 },
  30: { name: "HORN ATTACK",   type: "NORMAL",  power: 65 },
  33: { name: "TACKLE",        type: "NORMAL",  power: 35 },
  28: { name: "SAND-ATTACK",   type: "NORMAL",  power: 0 },
  31: { name: "FURY ATTACK",   type: "NORMAL",  power: 15 },
  40: { name: "POISON STING",  type: "POISON",  power: 15 },
  43: { name: "LEER",          type: "NORMAL",  power: 0 },
  44: { name: "BITE",          type: "NORMAL",  power: 60 },   // Gen 1: Normal, not Dark
  45: { name: "GROWL",         type: "NORMAL",  power: 0 },
  48: { name: "SUPERSONIC",    type: "NORMAL",  power: 0 },
  52: { name: "EMBER",         type: "FIRE",    power: 40 },
  55: { name: "WATER GUN",     type: "WATER",   power: 40 },
  // wq#1181: Misty's Starmie wins the FIGHT_LOSS_LOOP fight with BUBBLEBEAM, and
  // an undecoded foe move makes the winnability verdict low-confidence — which
  // bars it from forcing anything. The foes we keep losing to need entries.
  61: { name: "BUBBLEBEAM",    type: "WATER",   power: 65 },
  64: { name: "PECK",          type: "FLYING",  power: 35 },
  71: { name: "ABSORB",        type: "GRASS",   power: 20 },
  74: { name: "GROWTH",        type: "NORMAL",  power: 0 },
  77: { name: "POISONPOWDER",  type: "POISON",  power: 0 },
  78: { name: "STUN SPORE",    type: "GRASS",   power: 0 },
  79: { name: "SLEEP POWDER",  type: "GRASS",   power: 0 },
  81: { name: "STRING SHOT",   type: "BUG",     power: 0 },
  91: { name: "DIG",           type: "GROUND",  power: 100, lockIn: true },  // turn 2 auto-executes, no menu
  93: { name: "CONFUSION",     type: "PSYCHIC", power: 50 },
  84: { name: "THUNDERSHOCK",  type: "ELECTRIC", power: 40 },
  86: { name: "THUNDER WAVE",  type: "ELECTRIC", power: 0 },
  98: { name: "QUICK ATTACK",  type: "NORMAL",  power: 40 },
  99: { name: "RAGE",          type: "NORMAL",  power: 20,  lockIn: true },  // locks until the battle ENDS
  105:{ name: "RECOVER",       type: "NORMAL",  power: 0 },
  106:{ name: "HARDEN",        type: "NORMAL",  power: 0 },
  111:{ name: "DEFENSE CURL",  type: "NORMAL",  power: 0 },
  116:{ name: "FOCUS ENERGY",  type: "NORMAL",  power: 0 },
  117:{ name: "BIDE",          type: "NORMAL",  power: 0,   lockIn: true },  // 2-3 menu-less storing turns
  129:{ name: "SWIFT",         type: "NORMAL",  power: 60 },
  141:{ name: "LEECH LIFE",    type: "BUG",     power: 20 },
};

/** wq#587: ONE picker for every deterministic fight path (unwedge,
 *  plannedAuto, transit) — previously three identical inline copies, which is
 *  how a policy bug ships thrice. Strongest damaging move with PP, except
 *  lock-in moves lose to ANY non-lock attacker regardless of power: the
 *  harness cannot steer a menu that never comes back. Order of preference:
 *    1. best non-lock move with power > 0 (unknown moves count as power 30)
 *    2. best lock-in attacker (only damage left - RAGE as the last resort
 *       the ticket asks for; still better than a status stall)
 *    3. first non-lock status move (never reached with today's movesets)
 *    4. slot fallback (all-zero PP: Gen 1 auto-Struggles, selection is moot)
 */
export function pickBestMove(moves: number[], pp: number[]): number {
  let atk = -1, atkPow = -1, lock = -1, lockPow = -1, status = -1;
  moves.forEach((mid, i) => {
    if (!mid || (pp[i] & 0x3f) <= 0) return;
    const meta = MOVES[mid];
    const pow = meta?.power ?? 30;       // unknown move: assume mid-power attacker
    if (meta?.lockIn) { if (pow > lockPow) { lockPow = pow; lock = i; } }
    else if (pow > 0) { if (pow > atkPow) { atkPow = pow; atk = i; } }
    else if (status < 0) status = i;
  });
  if (atk >= 0) return atk;
  if (lock >= 0) return lock;
  if (status >= 0) return status;
  const any = moves.findIndex(m => !!m);
  return any >= 0 ? any : 0;
}

/** wq#696: weakest non-lock damaging move — for catch weakening without KO.
 *  Falls back to a status move (0 power, never KOs) then any move, same
 *  priority chain as pickBestMove but ascending power. */
export function pickWeakestMove(moves: number[], pp: number[]): number {
  let atk = -1, atkPow = Infinity, status = -1;
  moves.forEach((mid, i) => {
    if (!mid || (pp[i] & 0x3f) <= 0) return;
    const meta = MOVES[mid];
    if (meta?.lockIn) return;           // never lock in during a catch
    const pow = meta?.power ?? 30;
    if (pow > 0) { if (pow < atkPow) { atkPow = pow; atk = i; } }
    else if (status < 0) status = i;
  });
  if (status >= 0) return status;       // prefer status: zero KO risk
  if (atk >= 0) return atk;
  const any = moves.findIndex(m => !!m);
  return any >= 0 ? any : 0;
}

export function moveLabel(id: number): string {
  const m = MOVES[id];
  return m ? `${m.name}[${m.type}${m.power ? " " + m.power : " status"}]` : `MOVE${id}`;
}
