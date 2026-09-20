#!/usr/bin/env bash
# wq#2073 — run patch_retry_policy.py against a COPY of the live config first.
# The live file is only touched once this prints DRYRUN_OK.
set -uo pipefail

SRC=/home/lumen/agent/litellm_config.yaml
DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/dryrun_evidence.txt"
TMP=$(mktemp /tmp/wq2073_dryrun.XXXXXX.yaml)

{
  cp "$SRC" "$TMP"
  echo "### patcher on a copy"
  python3 "$DIR/patch_retry_policy.py" "$TMP"
  rc=$?
  echo "exit=$rc"

  echo
  echo "### diff (copy vs live) — must be exactly the inserted block"
  diff "$SRC" "$TMP"
  echo "diff_exit=$?"

  echo
  echo "### idempotency: second run must be a no-op"
  python3 "$DIR/patch_retry_policy.py" "$TMP"

  [ "$rc" = "0" ] && echo "DRYRUN_OK" || echo "DRYRUN_FAIL"
} > "$OUT" 2>&1

rm -f "$TMP"
chmod 0644 "$OUT"
echo "WROTE $OUT"
