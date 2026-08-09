// Gen 1 move metadata for the early game. Indexed by internal move ID.
// Enough coverage for Pallet -> Cerulean; extend as the run progresses.
export const MOVES: Record<number, { name: string; type: string; power: number }> = {
  1:  { name: "POUND",         type: "NORMAL",  power: 40 },
  10: { name: "SCRATCH",       type: "NORMAL",  power: 40 },
  33: { name: "TACKLE",        type: "NORMAL",  power: 35 },
  28: { name: "SAND-ATTACK",   type: "NORMAL",  power: 0 },
  31: { name: "FURY ATTACK",   type: "NORMAL",  power: 15 },
  40: { name: "POISON STING",  type: "POISON",  power: 15 },
  43: { name: "LEER",          type: "NORMAL",  power: 0 },
  45: { name: "GROWL",         type: "NORMAL",  power: 0 },
  52: { name: "EMBER",         type: "FIRE",    power: 40 },
  55: { name: "WATER GUN",     type: "WATER",   power: 40 },
  64: { name: "PECK",          type: "FLYING",  power: 35 },
  71: { name: "ABSORB",        type: "GRASS",   power: 20 },
  74: { name: "GROWTH",        type: "NORMAL",  power: 0 },
  77: { name: "POISONPOWDER",  type: "POISON",  power: 0 },
  78: { name: "STUN SPORE",    type: "GRASS",   power: 0 },
  79: { name: "SLEEP POWDER",  type: "GRASS",   power: 0 },
  81: { name: "STRING SHOT",   type: "BUG",     power: 0 },
  91: { name: "DIG",           type: "GROUND",  power: 100 },
  93: { name: "CONFUSION",     type: "PSYCHIC", power: 50 },
  98: { name: "QUICK ATTACK",  type: "NORMAL",  power: 40 },
  99: { name: "RAGE",          type: "NORMAL",  power: 20 },
  106:{ name: "HARDEN",        type: "NORMAL",  power: 0 },
  111:{ name: "DEFENSE CURL",  type: "NORMAL",  power: 0 },
  116:{ name: "FOCUS ENERGY",  type: "NORMAL",  power: 0 },
  117:{ name: "BIDE",          type: "NORMAL",  power: 0 },
};

export function moveLabel(id: number): string {
  const m = MOVES[id];
  return m ? `${m.name}[${m.type}${m.power ? " " + m.power : " status"}]` : `MOVE${id}`;
}
