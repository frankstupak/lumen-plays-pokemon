#!/usr/bin/env bash
# wq#2073 / wq#2068 — pull the full traceback around a live CerebrasException so
# the REJECTED VALUE and the caller are evidence, not a guess. Read-only.
set -uo pipefail

DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/payload_evidence.txt"
LOG=$(mktemp)

redact() {
  sed -E \
    -e 's#(api_key|master_key|salt_key|password|token|secret|authorization)([[:space:]"'"'"':=]*)[^,[:space:]"}]+#\1\2<REDACTED>#Ig' \
    -e 's#sk-[A-Za-z0-9_-]+#<REDACTED>#g' \
    -e 's#(csk|gsk|xai|hf|or)-[A-Za-z0-9_-]{8,}#<REDACTED>#g' \
    -e 's#Bearer [A-Za-z0-9._-]+#Bearer <REDACTED>#g'
}

docker logs --since 24h litellm > "$LOG" 2>&1

{
  echo "### 45 lines of context around the LAST CerebrasException"
  grep -n 'CerebrasException' "$LOG" | tail -1 | cut -d: -f1 > /tmp/wq2073_ln
  LN=$(cat /tmp/wq2073_ln)
  echo "(log line $LN)"
  sed -n "$((LN-40)),$((LN+5))p" "$LOG" | cut -c1-400 | redact

  echo
  echo "### any line naming the rejected value / optional_params"
  grep -E "optional_params|reasoning_effort['\"]?[:=][^,]{0,40}" "$LOG" | grep -v "Input should be" | tail -12 | cut -c1-400 | redact

  echo
  echo "### which api keys / users hit cerebras-oss-120b (hashed ids only)"
  grep -oE "Received Model Group=cerebras-oss-120b.*" "$LOG" | tail -3 | cut -c1-300 | redact

  echo
  echo "### hourly distribution of CerebrasException (last 24h)"
  grep 'CerebrasException' "$LOG" | grep -oE '^.{0,2}[0-9]{2}:[0-9]{2}:[0-9]{2}' | cut -c1-2 | sort | uniq -c | tail -30

  echo
  echo "### first and last CerebrasException timestamps in window"
  grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}.*CerebrasException' "$LOG" | head -1 | cut -c1-120
  grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}.*CerebrasException' "$LOG" | tail -1 | cut -c1-120
} > "$OUT" 2>&1

rm -f "$LOG"
chmod 0644 "$OUT"
echo "WROTE $OUT"
