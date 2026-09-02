# Checkpoint & Archive Policy (wq#490)

Codifies what lives under `checkpoints/`, what the `archive-*` directories
mean, and the conditions under which anything may be deleted. **This document
authorises no deletions. wq#490 deleted nothing.**

## The directories

| Path | What it is | Written by |
|---|---|---|
| `checkpoints/*.state.gz` + `.json` sidecar | LIVE resume pool. `auto-*` (rolling, pruned to the newest 40 by `Agent.pruneAuto`), `milestone-*` (badge/heal — **never** auto-pruned), `error-recovery.state.gz` | `Agent.writeCheckpoint` |
| `saves/` | Hand-made named waypoints (`forest-reached`, `oak-lab-intro`, …). Curated, small, never auto-written | humans/agents, deliberately |
| `checkpoints/archive-pre-s2/` | Checkpoints from **before the S2 resume-ranker** (2026-08-07). Their sidecars predate the viability gate, so the old ranker could resume a 5 HP party | historical move |
| `checkpoints/archive-regressed-20260812/` | The Pewter-trap regression set: checkpoints that a resume would rank highly but which sit **behind** the campaign frontier (see wq#471 storyScore, wq#477 recovery) | historical move |

`pickResume` scans `saves/` and `checkpoints/` only — **not** subdirectories —
so archived states are inert by construction. That is the whole mechanism:
archiving is how a checkpoint is removed from consideration without destroying
evidence.

## Why they are kept

1. **Evidence.** wq#471's storyScore ranking and wq#477's regression detector
   were both validated by *simulating the ranker over the archived sidecars*
   (68 sidecars in the wq#471 sim). Deleting the archives destroys the only
   corpus that can prove a future ranker change is not a regression.
2. **They are cheap.** 20 MB (regressed) + 512 KB (pre-s2) against 190 GB free.
   There is no disk pressure justification, and there is unlikely ever to be one.
3. **Recovery of last resort.** If the live pool is ever corrupted, an archived
   state is a worse-but-real resume point.

## When deletion is permitted

All of the following must hold, and the decision is **Frank's**, not an agent's:

- The disk is genuinely under pressure (`/home` below ~10% free) **and** the
  archives are a material share of the shortfall — today they are 0.01%.
- The corpus is no longer referenced by any resume/ranking test
  (`src/probe_storyscore.ts`, `src/probe_recovery.ts` and successors).
- A `restic` snapshot containing the directory is verified present first.

An agent that believes an archive should go writes a ticket proposing it with
the numbers above; it does not delete. **The standing rule for autonomous
agents is: archive, never delete.**

## How to archive (the correct move)

```bash
# from /home/lumen/pokemon — moves only, never rm
mkdir -p checkpoints/archive-<reason>-<YYYYMMDD>
mv checkpoints/<stem>.state.gz checkpoints/<stem>.json \
   checkpoints/archive-<reason>-<YYYYMMDD>/
```

Move the `.json` sidecar **with** its `.state.gz` — a sidecar orphaned from its
state (or vice versa) is what `pickResume`'s viability gate has to defend
against, and it makes the archive useless as a test corpus.

`auto-*` pruning is automatic and is *not* archiving: `pruneAuto` keeps the
newest 40 and unlinks the rest by design (they are seconds apart and
individually worthless). Milestones and named saves are never touched by it.

## When a checkpoint is WRITTEN (wq#1177)

`Agent.maybeCheckpoint` decides a checkpoint is *due* (badge, full heal, map
change, or every 10th turn), then `src/checkpoint_gate.ts` decides whether the
state is fit to serialize. Refusals emit a `checkpoint_skipped` tool_call event
carrying the reason, so a run that stops writing says why.

| Refusal | Applies to | Why |
|---|---|---|
| `in_battle`, `dialog_open`, `text_up` | every checkpoint | transition-frame RAM is not a resume target (the original S2 stability guard) |
| `map_load_pending` | every checkpoint | wq#699: `wCurMap` already names the destination while the header, warp table and coordinates still describe the map being left — every `auto-*-map88` sidecar on disk was written in that window |
| `engine_busy` | every checkpoint | `Sync.busy()`: `wJoyIgnore != 0`, script control, or mid-step — a script owns the player and the position being stamped is already stale |
| `on_warp_tile` | `auto-*` only | wq#1066: a warp tile is a position the next step does not KEEP; resuming onto it re-fires the warp (the Cerulean bounce, 180h frozen) |

The warp refusal is the only one that expires: after
`CKPT_WARP_STARVE_TURNS` (30) turns with nothing written it opens, because a
run that never checkpoints loses everything on the next restart — wq#517's
"a gate that can never open is a wedge". Milestones (badge / full heal) bypass
it outright; permanent progress does not come round again. Either way the
sidecar stamps `onWarp: true` truthfully and `pickResume`'s wq#1066 ordering
keeps demoting it.

Sidecars are **v4** as of wq#1177: `stateKey` (`map@x,y/story/badges/levelSum`,
`stateKeyOf` in `src/resume.ts`) identifies the game state the file holds, so
the resume repeat guard can tell a different *file* from a different
*situation*. v1-v3 sidecars stay readable; their key reads as unknown and the
guard falls back to path identity for them.

## Related

- Backups of superseded source live in `backups/src-bak/` (wq#490 sweep) —
  same principle: keep, do not delete.
- Fleet-wide `restic` dual-repo backups cover this tree independently.
