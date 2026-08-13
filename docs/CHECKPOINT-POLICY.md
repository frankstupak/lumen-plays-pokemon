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

## Related

- Backups of superseded source live in `backups/src-bak/` (wq#490 sweep) —
  same principle: keep, do not delete.
- Fleet-wide `restic` dual-repo backups cover this tree independently.
