# LPP Multiplayer — Build Doctrine (set 2026-08-08, Frank-directed)

## Mandate
Build a real Game Boy link-cable multiplayer capability for Lumen Plays Pokemon FROM THE
GROUND UP, orchestrator-vs-orchestrator. Time is NOT a concern; correctness and quality are.
Use documentation + heavy deep research to build it BETTER than a naive SameBoy-callback port,
not faster. GPUs arrive ~next week (hapi-1 trial) -> local models get fast enough that two
full brains battling in real time is viable, not a stunt. Design for that future.

## Key discovery (2026-08-08, verified in-tree — do not re-derive)
serverboy's GB core (node_modules/serverboy/src/gameboy_core/gameboy.js) ALREADY implements
the serial state machine; link data is STUBBED, not absent:
- SC write handler (~L4900 CGB path, mirror in DMG path): splits internal-clock (data&0x1)
  vs external-clock. Internal sets serialTimer (4096 or 128 fast) + serialShiftTimer
  (512 or 16). External-clock path ZEROS the timers "as if nothing is connected" (~L4910).
- Bit-shift spots (L1603, L1773): `memory[0xFF01] = ((memory[0xFF01]<<1)&0xFE)|0x01` —
  shifts in 1-bits (open cable). Author's own comment: "We could shift in actual link data
  here if we were to implement such!!!"
- SB=0xFF01 (data), SC=0xFF02 (control; bit7=start, bit0=clock-source internal/external).
=> A real partner = drive these handlers + the two shift spots + a clock-domain sync between
two independent cores. This is COMPLETING a 90%-present stubbed feature, NOT swapping cores.
Our entire ported harness (StateReader, nav, battle, items via symbol table) stays intact.

## Non-negotiables (carry forward)
- Ground-up, doc-driven. No copied harness/emulator logic; cite sources in code comments.
- Deterministic + verifiable from RAM, same as the single-player harness. No screen-scraping.
- Every timing/protocol claim RESEARCH-BACKED before code (DMG serial has silent-desync traps:
  internal-vs-external clock, 8x internal rate, Gen1 Cable Club handshake byte sequences,
  timeout/abort behavior). Getting these wrong = a hang that looks like a bug elsewhere.
- Two independent brains: reuse the wq#426 BrainProfile config — each side its own model/env.
  This is the whole point (model-vs-model). qwen36-local vs cerebras vs hapi-when-it-lands.
- Test harness first, live second. A byte-exact link unit test (two cores, scripted transfer)
  before ANY agent drives it.

## Phasing (detail each when reached; tickets track)
- M0 RESEARCH (this phase): protocol + Gen1 Cable Club + clock-sync deep research -> reports
  in research/link/. Gate: enough to write the bridge without guessing.
- M1 LINK CORE: complete serverboy's serial stub — SerialLink bus between two Emulator
  instances, lockstep stepping, byte exchange. Unit test: two cores trade a known byte stream.
- M2 CABLE CLUB MACRO: scripted attendant dialog + master/slave handshake (deterministic,
  heal_at_center pattern). Verified by RAM, both sides.
- M3 BATTLE/TRADE over the link: Gen1 link-battle move-select + turn exchange; existing
  battle tools drive it. Trade as a stretch (simpler protocol, good first proof).
- M4 DUAL HARNESS: two Agents, two BrainProfiles, one StreamServer grid (P6 layout).
- M5 NETWORK BRIDGE (stretch): BGB link-over-TCP protocol so a REMOTE orchestrator (someone
  else's agent) can challenge over Tailscale/public endpoint. Spec doc for their side.

## GPU horizon
hapi-1 trial ~next week. When local inference is fast, both brains can be local -> a true
$0 real-time LLM-vs-LLM link battle on Gen1 hardware emulation. Not aware of prior art.
Design M1-M4 so the brain slot is model-agnostic (BrainProfile already is).
