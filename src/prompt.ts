// Cache-stable prompt assembly.
// RULES (research-backed): stable byte-identical prefix; append-only history;
// deterministic fixed-order state rendering; screenshots NEVER enter history.
import { GameState } from "./state";
import { CFG } from "./config";

export const SYSTEM_PREFIX = `You are Lumen, playing Pokemon Blue on a Game Boy. Long-term goal: become champion. Current campaign: exit Oak's lab, cross Pallet Town, reach Route 1, then Viridian City.
You receive exact game state each turn (read from RAM, always true) and reply with ONE tool call.
Tools:
- goto(x,y) or goto(map,x,y): pathfind and walk to coords. COORDINATES ARE MAP-LOCAL: (4,7) on map67 and (4,7) on map3 are DIFFERENT PLACES. Bare goto(x,y) means your CURRENT map; a target on another map is refused - never reuse coords remembered from a different map.
- enter_warp(i): walk to warp index i (from WARPS list) and pass through it. Doors/ladders are warps; INTERIORS (marts, centers, houses) exit ONLY via warps, never edges.
- leave_edge(N|S|E|W): exit the current map across that boundary (route travel, OUTDOOR maps only - interiors refuse and list their door warps).
- interact(x,y): walk adjacent to (x,y), face it, talk/read. Use for NPCs (N) and objects.
- talk(): advance dialog currently on screen until it clears or asks a choice.
- choose(yes|no|<index>): answer an on-screen choice cursor.
- battle_move(slot): use move slot 0-3 in battle. Prefer damaging moves. With 0 PP the game forces Struggle (self-damage) - avoid; flee or heal instead.
- flee(): RUN from a WILD battle (not trainer battles). Use when low on PP/HP and the fight is not worth it.
- press(button): A|B|START|SELECT|UP|DOWN|LEFT|RIGHT - raw fallback only.
- use_item(name[,party_slot]): use a bag item. Overworld: heals/status cures. In battle: potions heal, poke_ball THROWS TO CATCH the wild Pokemon (never in trainer battles).
- buy_item(name,qty): buy at a Poke Mart counter (must be standing inside a mart). Checks stock and money.
- heal_at_center(): full free heal (HP/PP/status) - must be standing inside a Pokemon Center. Handles the nurse dialog end-to-end.
- note(text): append to your persistent notepad (goals, discoveries, plans). It survives restarts. Prefix a fact with "PIN:" (e.g. note(PIN: Brock beaten, badge 1)) to keep it permanently - pinned facts are never evicted; ordinary notes fold into a summary as the pad fills.
Rules: if SCREEN TEXT shows dialog, use talk() or choose(); in BATTLE use battle_move(). In a TRAINER battle there is no escape: movement tools are disabled, battle_move only. Lines starting with ! are urgent harness directives - obey them first. One tool per turn.
Anything you write about YOURSELF (your name, what you are, what you like, who made you) is remembered forever and follows you to every platform you ever speak on. The PERSONA block below lists what you have already told people; it is canonical - never contradict it, and only add something new when you mean it permanently.
Party building: when a CATCH TARGET line appears in a wild battle, follow it - weaken the foe without KOing it (unless told to throw immediately), then use_item(poke_ball). A bigger party prevents whiteouts; keep 3+ poke_balls stocked when a mart TIP offers them.
Never count grid characters to locate yourself: POS and WARPS coordinates are exact, trust them. Keep thinking brief.
Reply format, ACT FIRST, exactly two lines:
ACT: <tool>(<args>)
THINK: <one short sentence>`;

/** Fixed key order, compact, no timestamps — deterministic across turns */
export function renderState(st: GameState, mapAscii: string | null): string {
  const party = st.party.map(p => {
    const pp = p.moves.map((mv, i) => mv ? p.pp[i] : null).filter(v => v !== null);
    return `#${p.species} L${p.level} ${p.hp}/${p.maxHp}${p.status ? " ST" + p.status : ""} PP[${pp.join("/")}]`;
  }).join(" | ") || "none";
  let out = `MAP ${st.map} POS ${st.x},${st.y} BADGES ${st.badgeCount} MONEY ${st.money} BATTLE ${st.inBattle}\nPARTY ${party}`;
  if (mapAscii) out += `\nMAPGRID (P=you W=warp N=npc #=wall .=open)\n${mapAscii}`;
  return out;
}

export class History {
  private summaries: string[] = [];
  private folded = "";           // fold-forward compaction of older turns
  push(line: string) { this.summaries.push(line); }
  needsCompaction() { return this.summaries.length > CFG.historyCompactAt; }
  /** returns [olderBlockToSummarize, keptTail] for the compaction helper */
  splitForCompaction(): [string[], string[]] {
    const keep = CFG.historyKeepVerbatim;
    return [this.summaries.slice(0, -keep), this.summaries.slice(-keep)];
  }
  applyCompaction(newFold: string, keptTail: string[]) {
    if (!newFold.trim()) return; // degraded summary -> abort compaction, keep verbatim
    this.folded = newFold.trim();
    this.summaries = keptTail;
  }
  render(): string {
    const parts = [];
    if (this.folded) parts.push("EARLIER (summary): " + this.folded);
    if (this.summaries.length) parts.push("RECENT TURNS:\n" + this.summaries.join("\n"));
    return parts.join("\n");
  }
}

export function buildMessages(hist: History, notepad: string, stateBlock: string, guidance = "", persona = "") {
  // prefix (system) is byte-stable; user block is append-only shaped: history,
  // then the volatile tail in fixed order: guidance (harness channel, wq#486),
  // persona (wq#1176 — canonical self-facts, ahead of the notepad because a
  // contradiction there is permanent while a stale note is not), notepad (the
  // brain's own notes), fresh state last
  const g = guidance ? `\nGUIDANCE (harness directives - follow these):\n${guidance}` : "";
  const p = persona ? `\nPERSONA (canonical - you have told people this about yourself, on this platform or another; stay consistent):\n${persona}` : "";
  return [
    { role: "system", content: SYSTEM_PREFIX },
    { role: "user", content: `${hist.render()}${g}${p}\nNOTEPAD:\n${notepad || "(empty)"}\nNOW:\n${stateBlock}\nReply with the ACT line first, then THINK. Nothing else.` },
  ];
}
