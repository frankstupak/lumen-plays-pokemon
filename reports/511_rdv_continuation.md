# wq#511 — M5c-3: the 415-byte party exchange, driven over the bridge

Lane: pokemon (LPP multiplayer)  •  2026-09-20  •  branch `fix/wq511-lpp-mp-m5c-3-rendezvous-continuation-dri-a6`

## TL;DR

wq#483 got two independent processes into the Trade Center and stopped there:
`exchanges=30` is the handshake, `$D887`/`$D893` still held uninitialised RAM,
and M5b correctly rejected the result (count=36, level=0, hp>maxHp). The
validator was right; the driving was missing.

The driving now exists. Two OS processes, no shared memory, one socket: both
ROMs reach `wLinkState=50`, ~700 exchanges cross the bridge, the M5b structural
invariants pass on both received blocks, and every one of the 415 bytes matches
what our own party serialises to — **both directions, zero diffs**. The
`RDV_PROBE_CONTINUATION=1` gate is gone; the scenario runs ungated.

`npx tsx src/link/probe_m5c3.ts` — **16 PASS / 0 FAIL**.

## Why it was not simply a missing call

The in-process 415-byte path (M3, `trade.ts`) leans on fine-slicing and peer
catch-up: `serialbus` `deferTicks`/`peerRunner`, `lockstep.ts` (wq#436). Two
cores in one process can be stepped in turn. Two OS processes cannot — the only
coupling left is the socket, and a socket is not a cable. Three failures follow
from that, and none of them are visible in the wire tape: both sides' transfer
tapes can be byte-identical while the received party is one byte short with its
whole tail shifted. That was the observed failure, roughly one run in three,
always on the passive side (ISSUE-LOG #64, #65).

## Deliverable 1 — the bridge-side equivalent of fine-slice + peer catch-up

Four rules, all local pacing. Nothing new goes on the wire, so a BGB-correct
partner that happens to be slow is indistinguishable from ours.

1. **Yield on a macrotask every step.** Node reads a socket only on a macrotask;
   a core stepping through `await emu.framesAsync(n)` yields microtasks only and
   starves its own link — fatal during the walk to the table, where the Cable
   Club ROM clocks the partner's position every frame. Every slice ends in
   `setImmediate` (check phase, after poll). `Emulator.framePacer`
   (`src/emulator.ts:27`) is the opt-in hook that reaches navigation and dialog
   without every helper learning about the bridge.
2. **At most one byte per executed step, and only when the ROM can take it.**
   Gen1's serial ISR parks the received byte in a one-deep slot
   (`hSerialReceiveData`) for the main loop, so delivering on packet arrival lets
   the next byte overwrite the last and the ROM drops a byte the transport
   thinks it delivered. The gate needs: transfer armed on the external clock, no
   serial IRQ pending, a fresh out-byte staged, and the ROM has READ the previous
   byte out of the slot — the DATA, not the `hSerialReceivedNewData` flag beside
   it, which other link routines clear before they wait and which therefore
   reopens the gate a step early (`BridgeOptions.takenSignal`,
   `src/link/rdv_side.ts:64`).
3. **Leave the peer's transfer open until our core consumed the byte** (BGB
   `DEFER_REPLY`). Our sync2 is the master's backpressure.
4. **Never deliver faster than the cable could** — one byte per 4096 CPU cycles
   (`BridgeOptions.byteTicks`; DMG serial is an 8192 Hz bit clock, 1 KB/s).
   Because our reply paces the master, pacing our own deliveries paces both
   sides, which is what a cable does.

Two bounds keep rule 2 from becoming a hang:

- `holdCycles` is a **deadlock breaker, not a pacing knob** (524288 link ticks
  ≈ 15 frames). An unbounded gate deadlocked the handshake at 17 bytes with the
  master parked in the ROM's serial loop — and it hangs BOTH sides, because the
  peer is holding its transfer open for us. The bound must clear the longest
  legitimate non-consuming pause, which is text: measured forced hand-overs land
  at `$390A` PrintLetterDelay and `$1DD7` TransferBgRows.
- The cycle budget is read **every step** (`rdv_side.linkTicks()`), never once at
  startup. Under fine slicing a step is ~524 cycles, not a frame; a bridge told
  otherwise burns the gate's patience 60x too fast and skews the BGB link
  timestamp (spec rule 5).

## Deliverable 2 — seat navigation inside $EF, verified

Verified directly, not inferred from the exchange completing. `rdv_side` records
where the walk actually left it (`nav.pos()`) and `probe_m5c3` asserts it against
the seat for the resolved role — against the room the rendezvous actually landed
in, since room select can yield to the peer's choice:

```
PASS side A: seated at its own chair inside the room :: want={"map":239,"x":3,"y":4} at={"map":239,"x":3,"y":4}
PASS side B: seated at its own chair inside the room :: want={"map":239,"x":6,"y":4} at={"map":239,"x":6,"y":4}
```

Map 239 = `$EF`, Trade Center. Master takes the left chair (3,4) facing RIGHT,
slave the right chair (6,4) facing LEFT. If the walk ever lands on the wrong
tile, this names the seat instead of leaving a dead handshake to explain.

## Deliverable 3 — scenario 4 ungated, with validator output

`RDV_PROBE_CONTINUATION` no longer appears anywhere in the tree. The block runs
on every `probe_m5c3` invocation.

```
=== M5c-3: rendezvous -> 415-byte party block -> M5b invariants ===
PASS both sides rendezvoused :: IN_ROOM/IN_ROOM
PASS exactly one side was master :: roles=1/2
PASS side A reported a block check :: count=1
PASS side A: seated at its own chair inside the room :: want={"map":239,"x":3,"y":4} at={"map":239,"x":3,"y":4}
PASS side A: the ROM finished the exchange :: linkState=50
PASS side A: M5b invariants PASS on the received block :: []
PASS side A: received block mirrors our own party byte-for-byte :: diffs=0 where=null
PASS side A: peer party is 1..6 mons :: count=1
PASS side A: the block really crossed the wire :: exchanges=701
... (side B identical)
16 PASS / 0 FAIL
```

Measured on the passive side, the one that used to lose bytes:

```
"pacing":{"queuedIn":701,"served":701,"blocked":5138,"forced":6,
          "forcedDuringBlock":1,"collisions":0,"stillQueued":0,
          "gate":{"tooSoon":2307,"notArmed":31,"internal":0,"irq":0,"staged":0,"taken":2800}}
"mirrorAll":{"ok":true,"diffs":0}
```

`forcedDuringBlock=1` with `diffs=0` is the documented case: a force while the
ROM is between transfers costs nothing. Forces are the leading indicator; the
mirror is the gate, because it measures the loss directly.

Peer party as read out of the received block: `{"species":178,"level":20,
"hp":57,"maxHp":57,"moves":[10,45,52,43]}` — a real party, where wq#483 read
count=36, level=0, hp>maxHp.

## Deliverable 4 — which invariants now hold

Passing on **both** received blocks (`verifyTradeBlock`,
`src/link/invariants.ts:209`), checks `["length","no_FE","party_count",
"species_terminator","mon_fields"]`:

- `length` — 415 bytes exactly, the protocol's block size.
- `no_FE` — no `$FE` anywhere; the no-data byte never leaked into stored data.
- `party_count` — 1..6.
- `species_terminator` — `$FF` at `species[count]`.
- `mon_fields` — per mon: species in range and agreeing with the species list,
  level 1..100, maxHp 1..999, hp ≤ maxHp, a move in slot 0, move ids in range,
  no PP on an empty move slot, PP ≤ 61.

Plus the two that only a cross-process run can assert:

- **Mirror, both directions, zero diffs.** Both sides boot the same snapshot, so
  the peer's party IS ours: the 415 bytes received must equal the 415 our own
  party serialises to. This is what catches a single lost byte — a shifted tail
  is still *structurally* plausible, so the structural verdict alone would pass
  it. `diffBlocks` labels each differing byte by section (`mon0+22:134/23`); a
  received byte at offset i equal to ours at i+N is a LOSS of N, not corruption,
  which is how the four-byte loss inside the mon array was found.
- **`mirrorAll` ok** — including never-filled party slots, which an unscoped
  mirror would otherwise cry wolf on between two cores.

And the layout invariant that made the rest legible: the received block is
reassembled from SYMBOLS, `$D887` + the parsed party at **wEnemyPartyCount
`$D89C`** — not `$D893` (`wSerialEnemyDataBlock`, the raw staging buffer, nine
bytes early). Reading the wrong pair is what wq#483 recorded as "the exchange
never ran"; `probe_invariants` now asserts the partitioning
(`src/link/invariants.ts:90`, `readPartyBlock`).

### What does NOT hold yet

Both sides boot the same snapshot, so this proves the BLOCK crossed intact — not
that a trade swapped anything. Two distinct identities and `verifyPostTrade` are
the next milestone (M5d), not this one. Rendezvous can also still land in
STRANDED before the continuation starts (wq#510); the remedy is unchanged and
lives at the orchestrator — relaunch both sides, bump the port. `probe_m5c3`
applies that policy itself and prints the retry count rather than hiding it.

## Evidence

Run on this branch, in this worktree, against `roms/pokeblue.gb`:

| probe | result |
|---|---|
| `npx tsx src/link/probe_m5c3.ts` | **16 PASS / 0 FAIL** |
| `npx tsx src/link/probe_invariants.ts` | 38 PASS / 0 FAIL |
| `npx tsx src/link/probe_bridge.ts` | 13 PASS / 0 FAIL |
| `npx tsx src/link/probe_rendezvous.ts` | 12 PASS / 0 FAIL |
| `npx tsc --noEmit` | clean |

Full protocol writeup, including the contract a non-Lumen partner must honour:
`docs/multiplayer/M5_REMOTE_LINK.md`, "Continuation (M5c-3, wq#511)".

## Notes for the next worker

- A fresh worktree has **no `node_modules`** — `emulator.ts` requires `pngjs`,
  and without it both spawned sides exit 1 with no BLOCKCHECK line, which looks
  exactly like a broken change. Run `npm install` first (ISSUE-LOG #233).
- `probe_m5c3` spawns its sides from **this tree** (`ROOT = resolve(__dirname,
  "..", "..")`), so a worktree tests its own change. It used to hardcode
  `/home/lumen/pokemon` and could not (ISSUE-LOG #65).
- ROM and checkpoints resolve through `repoRoot()` (`src/fixtures.ts:182`), which
  is `/home/lumen/pokemon` unless `LPP_REPO` says otherwise — that is why a
  worktree with no `roms/*.gb` still runs.
- No `.bak` copies were taken: every file touched here is tracked in git, where
  the prior revision is the backup. The `.bak.<stamp>_<reason>` convention covers
  untracked operational files, not source under version control.

## Issues hit this run

Recorded here because a BUILD worker's Write/Edit into `/home/lumen/kb` is
guard.sh-blocked (ISSUE-LOG #473), so these rows could not be appended there.

| symptom | root cause | solution |
|---|---|---|
| `npx tsx src/link/probe_m5c3.ts > /tmp/x.log` and `tail /tmp/x.log` both refused with "the following parts require approval: \<cmd\>" | the refusal names the COMMAND, but the command was fine — `Bash(npx tsx *)` and `Bash(tail *)` are both allow-listed (`harness/worker-settings.json:91,29`). The PATH was the problem: `/tmp` is outside the worktree + `--add-dir` roots. Reads as an allowlist gap and invites a retry that cannot work | redirect into the gitignored `logs-24h/` inside the worktree |
| wq#511 was redispatched (attempt a6) as fresh implementation work, but the implementation already existed, on an unmerged branch, independently verified 14/14 by wq#1278 (ISSUE-LOG #233) | PR#100 was never merged — the wq#1672 F1 fail-open merge gate (`bin/wq _forge_token` reading only `$GITHUB_TOKEN`, which wq#1480 stripped) let the original close pass against an open PR, and the re-adjudication reopened the ticket without pointing the next worker at the branch that held the work | cherry-picked `041ce97` onto current main (clean, no conflicts across ~30 intervening commits), re-verified every probe from scratch in this worktree, and closed the two gaps the original left: seat nav was never asserted, and the ticket's report file was never written. A redispatch whose PR is open and verified wants LANDING, not re-implementation — check `git branch -a --contains` for prior attempts before starting over |
