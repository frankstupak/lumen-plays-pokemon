# wq#511 — M5c-3 party exchange over the bridge — attempt a3: BLOCKED (environment)

**Status: no code written. Not a judgement about the work — the sandbox this
attempt ran in cannot boot a core, so none of the ticket's four deliverables
can be produced or verified. Ticket released, not closed.**

## What is missing

Every deliverable on wq#511 ((1) bridge-side fine-slice/catch-up, (2) verified
seat nav in `$EF`, (3) scenario 4 passing ungated with M5b validator output,
(4) gate removal) requires running two `rdv_side` processes against a real
core. This attempt could not run one.

| need | state in this worktree |
|------|------------------------|
| `roms/pokeblue.gb` | absent — `git ls-files roms` tracks only `pokeblue.sym`, `pokered.sym`; the ROM is gitignored and lives at `/home/lumen/pokemon/roms/` |
| `checkpoints/center-m2b.state.gz` | absent — no `checkpoints/` dir; `rdv_side.ts:50` loads it via `ckptPath()` |
| `node_modules/` | absent — `npm install` was never run here, so `tsx`/`tsc` do not exist |

`src/fixtures.ts:32` pins `REPO = "/home/lumen/pokemon"`, and `romPath()` /
`ckptPath()` resolve against it. That path is outside this session's allowed
directories:

```
$ ls /home/lumen/pokemon/roms/
ls in '/home/lumen/pokemon/roms' was blocked. For security, Claude Code may only
list files in the allowed working directories for this session:
'/home/lumen/worktrees/wq511-a3', '/home/lumen/agents/work-queue'.
```

`LPP_REPO` can retarget the resolver (`src/fixtures.ts:183`), but there is no
ROM or snapshot anywhere inside the allowed roots to retarget it *at*
(`find . -name '*.gb' -o -name '*.state.gz'` → nothing).

Also unavailable, same session: `npx` and `gh` (`npx tsc --version` and
`gh pr list ...` are not on the Bash allowlist / not on PATH), so even a
tsc-only pass and `lumen-pr open` would not have completed.

## What a4 needs

Dispatch with `--add-dir /home/lumen/pokemon` (or stage `roms/pokeblue.gb` +
`checkpoints/center-m2b.state.gz` into the worktree), a populated
`node_modules/`, and `gh` on PATH. Without live ROM access this ticket is
unworkable by construction — do not re-dispatch it into a fixture-less
worktree.

## Technical state carried forward (unchanged from a1, not re-verified here)

Attempt a1 (`origin/fix/wq511-...-a1`, commit `a8c22cc`) already committed the
BLOCK-TRANSFER half — `bridge.enableFollowerCatchUp` plus the `rdv_side`
fine-slice driver — and reported it tsc-clean but never exercised. Its
test-to-failure showed the live wall is UPSTREAM of that code: at the trade
table neither ROM sets `SC=$81`, so serial stays at the 30 handshake exchanges,
`catchUpSteps` is 0, and `$D887`/`$D893` keep uninitialised RAM. See
`reports/511_rdv_continuation_PARTIAL.md` on that branch.

So the open problem is cross-process trade-START coordination, not the
415-byte transfer. `R4_gen1_rom_verified.md:89` pins the trigger —
`wLinkState $02` is set "the moment the two players face each other across the
trade table and press A" — and `trade.ts:242` gets there in-process only
because `step()` presses A on BOTH cores on the same tick with `bus.tick()`
between. That simultaneity is what two OS processes lack. a4 should design and
verify that start handshake first; the a1 catch-up code only starts mattering
once exchanges climb past 30.
