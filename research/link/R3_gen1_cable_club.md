# R3 — Gen 1 Cable Club link protocol (byte level) — from pokered disasm + RE writeups

Sources: pret/pokered engine (link.asm / cable_club), smogon "RBY Link Battle Initial RNG"
(quotes CableClub_DoBattleOrTradeAgain verbatim), nitwhiz "Spoofing a Pokemon Trade",
vaguilar "ACE in Pokemon Red", projectpokemon "Generation 1 Link Protocol" (real
device-over-internet project = prior art we can learn from, not copy).

## Roles
- Two sides negotiate MASTER (internal clock / leader) vs SLAVE (external clock / follower)
  during connection. Master drives every transfer; slave follows. Our bridge assigns these.

## Framing bytes (LOAD-BEARING — bridge must treat these specially)
- **0xFD = SERIAL_PREAMBLE_BYTE** — frames data blocks; sync/no-data filler. Random-number
  seeds are all generated to be < 0xFD so they can't be confused with preamble.
- **0xFE = "no data" / patch-list sentinel** — 0xFE in party data is special; the patch list
  records offsets where a real 0xFE byte occurs so it can be restored after transmission
  (0xFE can't ride the wire directly).
- (nitwhiz observed 0xDF in one block; pokered constant is SERIAL_PREAMBLE_BYTE — reconcile
  exact value against the pinned disasm at build time, do NOT hardcode from memory.)

## Sequence (battle or trade), leader's view
1. Connection + role negotiation (Cable Club attendant triggers link state).
2. Leader writes player-data block preamble (6x preamble) + random-number-list block
   preamble (7x) + generates 10 random numbers (each < preamble) — the SHARED RNG SEED so
   both carts compute identical battle outcomes (BattleRandom reads this list, not the normal
   RNG). This is why link battles are deterministic across both boys.
3. Party/trade blocks exchanged: leader sends 415 bytes = party (Gen1 party data structure,
   Bulbapedia), preceded by an arbitrary run of preamble bytes; follower reads them back.
4. Trade: pick slots, confirm, swap. Battle: link-battle loop with move-select exchanged each
   turn over serial; shared RNG list drives crits/misses identically on both sides.

## Consequence for our design
- Byte-level, TURN-BASED request/response. => **byte-exact lockstep is SUFFICIENT**; we do
  NOT need sub-byte cycle-accurate sync. Bridge exchanges whole SB bytes at each SC-start.
  (This is the single biggest de-risk: no two-free-running-clock race.)
- We do NOT reimplement the Gen1 protocol — the ROM does it. We provide a correct WIRE
  (byte exchange + clock) and let both ROMs run their own link code. Our harness only needs
  to (a) drive the Cable Club attendant to enter link mode (M2 macro), (b) read result from
  RAM as always. The 415-byte party exchange, RNG seed, patch list = all ROM-internal.
- Shared-RNG means a link battle is REPRODUCIBLE from the seed — a gift for testing + replay.

## Open confirmations for build time (pin against disasm, don't trust this doc's byte values)
- Exact SERIAL_PREAMBLE_BYTE value (0xFD vs 0xDF) + counts (6/7/9/10 appear in sources).
- wLinkState / wSerial* WRAM addresses from pokeblue.sym (we have the sym file).
- Master/slave negotiation byte sequence (who sends what first) — from cable_club.asm.
