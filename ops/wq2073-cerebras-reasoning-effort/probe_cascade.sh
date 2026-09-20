#!/usr/bin/env bash
# wq#2073 / wq#2068 — capture what actually reaches Cerebras, instead of trusting
# the ticket's "reasoning_effort=high on litellm_config.yaml:159" framing.
# Runs as a detached lumen-run unit because /home/lumen/agent and the docker
# socket are both outside the BUILD lane's filesystem grant. Read-only.
set -uo pipefail

SRC=/home/lumen/agent/litellm_config.yaml
DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/cascade_evidence.txt"

redact() {
  sed -E \
    -e 's#(api_key|master_key|salt_key|password|token|secret|authorization)([[:space:]"'"'"':]*)[^,[:space:]"]+#\1\2<REDACTED>#Ig' \
    -e 's#sk-[A-Za-z0-9_-]+#<REDACTED>#g' \
    -e 's#(csk|gsk|xai|hf|or)-[A-Za-z0-9_-]{8,}#<REDACTED>#g' \
    -e 's#Bearer [A-Za-z0-9._-]+#Bearer <REDACTED>#g'
}

nl_range() { sed -n "$1,$2p" "$SRC" | nl -ba -v "$1" -w5 -s': '; }

{
  echo "### cerebras model blocks (lines 105-135)"
  nl_range 105 135 | redact

  echo
  echo "### routing / fallbacks tail (lines 360-409)"
  nl_range 360 409 | redact

  echo
  echo "### is /home/lumen/agent version controlled?"
  if git -C /home/lumen/agent rev-parse --git-dir >/dev/null 2>&1; then
    echo "REPO yes"
    git -C /home/lumen/agent log --oneline -8 -- litellm_config.yaml 2>&1 | redact
    echo "--- diff of litellm_config.yaml since 2026-09-18 ---"
    git -C /home/lumen/agent log -p --since=2026-09-18 -- litellm_config.yaml 2>&1 \
      | grep -E '^(commit|Date|[-+].*(reasoning_effort|cerebras|model_name))' | head -40 | redact
  else
    echo "REPO no"
    echo "--- mtime / backups next to it ---"
    stat -c '%y %n' "$SRC" 2>&1
    ls -l --time-style=long-iso /home/lumen/agent/ 2>&1 | grep -i 'litellm' | redact
  fi

  echo
  echo "### litellm container"
  CID=$(docker ps --filter name=litellm --format '{{.Names}}' 2>&1 | head -1)
  echo "container=$CID"
  if [ -n "$CID" ] && [ "${CID#*Error}" = "$CID" ] && [ "${CID#*permission}" = "$CID" ]; then
    echo "--- reasoning_effort mentions in last 24h of logs ---"
    docker logs --since 24h "$CID" 2>&1 | grep -i 'reasoning_effort' | tail -15 | redact
    echo "--- count of the 2068 cascade lines in last 24h ---"
    docker logs --since 24h "$CID" 2>&1 | grep -c 'No fallback model group found for original model_group=qwen36-local' 2>&1
    echo "--- CerebrasException lines in last 24h ---"
    docker logs --since 24h "$CID" 2>&1 | grep -c 'CerebrasException' 2>&1
    echo "--- most recent CerebrasException (1 line) ---"
    docker logs --since 24h "$CID" 2>&1 | grep 'CerebrasException' | tail -1 | cut -c1-600 | redact
  fi
} > "$OUT" 2>&1

chmod 0644 "$OUT"
echo "WROTE $OUT"
