# Source backups (superseded file snapshots)

Every state-changing edit to this repo takes a timestamped sibling backup first
(`<file>.bak.<YYYYMMDD_HHMMSS>_pre_<ticket>`). wq#490 swept them out of the
working tree into this directory so `src/` and `docs/` show only live source,
while **nothing was deleted** — 69 files preserved.

## Layout

```
backups/src-bak/src/      # snapshots of src/*.ts        (was: src/*.bak.*)
backups/src-bak/docs/     # snapshots of docs/*.md       (was: docs/**/*.bak.*)
backups/misc/             # repo-root + config snapshots (.gitignore, service unit)
```

The filenames are unchanged, so a path referenced in an older ship-log entry as
`src/agent.ts.bak.20260808_235310_pre_wq423` is now at
`backups/src-bak/src/agent.ts.bak.20260808_235310_pre_wq423`. Historical docs
were **not** rewritten — dated log entries record what was true when written.

## Not swept (deliberate)

- `events/retry_ledger.json.bak.*` — kept beside its live ledger; separating a
  runtime backup from the file it restores makes it useless.

## Retention

These are cheap and are the fastest rollback path for a bad ship (restore the
`_pre_<ticket>` sibling, restart under `slock`). Same rule as checkpoints
(`docs/CHECKPOINT-POLICY.md`): **archive, never delete** — deletion is Frank's
call, not an agent's. Contents are gitignored (`*.bak*`); this README is not.
