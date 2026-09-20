#!/usr/bin/env bash
# wq#2073 — did litellm_config.yaml ever carry the reasoning_effort the ticket
# names at :159, and did pinning it in the cerebras block change anything?
# Answers "was the ticket's premise ever true" from the on-disk backup trail.
set -uo pipefail

AG=/home/lumen/agent
DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/history_evidence.txt"

redact() {
  sed -E \
    -e 's#(api_key|master_key|salt_key|password|token|secret)([[:space:]"'"'"':=]*)[^,[:space:]"}]+#\1\2<REDACTED>#Ig' \
    -e 's#sk-[A-Za-z0-9_-]+#<REDACTED>#g' \
    -e 's#(csk|gsk|xai|hf|or)-[A-Za-z0-9_-]{8,}#<REDACTED>#g'
}

{
  echo "### reasoning_effort across the recent backup trail (file: line: text)"
  for f in "$AG"/litellm_config.yaml \
           "$AG"/litellm_config.yaml.bak.20260920_152128_pre_wq2127 \
           "$AG"/litellm_config.yaml.bak.20260919_080723_add_mac_rungs \
           "$AG"/litellm_config.yaml.bak.20260918_052310_hathor_down \
           "$AG"/litellm_config.yaml.bak.PREAPPLY; do
    [ -f "$f" ] || { echo "MISSING $f"; continue; }
    echo "-- $(basename "$f")"
    grep -n 'reasoning_effort' "$f" | redact || echo "   (none)"
  done

  echo
  echo "### line 159 in each of those files"
  for f in "$AG"/litellm_config.yaml \
           "$AG"/litellm_config.yaml.bak.20260920_152128_pre_wq2127 \
           "$AG"/litellm_config.yaml.bak.20260919_080723_add_mac_rungs; do
    [ -f "$f" ] || continue
    echo "-- $(basename "$f"): $(sed -n '155,162p' "$f" | tr '\n' '|')" | redact
  done

  echo
  echo "### cerebras-oss-120b block in pre_wq2127 backup"
  grep -n -A6 'model_name: cerebras-oss-120b' "$AG"/litellm_config.yaml.bak.20260920_152128_pre_wq2127 | redact

  echo
  echo "### what wq2127 changed (pre_wq2127 -> current), reasoning/cerebras/fallback only"
  diff "$AG"/litellm_config.yaml.bak.20260920_152128_pre_wq2127 "$AG"/litellm_config.yaml \
    | grep -E '^[<>]' | head -40 | redact

  echo
  echo "### retry_policy / allowed_fails present today?"
  grep -n -E 'retry_policy|allowed_fails|num_retries|BadRequest' "$AG"/litellm_config.yaml | redact
} > "$OUT" 2>&1

chmod 0644 "$OUT"
echo "WROTE $OUT"
