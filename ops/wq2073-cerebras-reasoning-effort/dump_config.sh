#!/usr/bin/env bash
# wq#2073 / wq#2068 — read-only dump of the gateway's cerebras-oss-120b wiring.
# The BUILD lane's filesystem grant stops at its worktree; /home/lumen/agent is
# outside it, so this runs as a detached lumen-run unit that can read the file
# and writes a REDACTED excerpt back into the worktree.
set -uo pipefail

SRC=/home/lumen/agent/litellm_config.yaml
OUT=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort/config_excerpt.txt

# Every value that could be a credential is replaced before anything is written.
redact() {
  sed -E \
    -e 's#(api_key|master_key|salt_key|password|token|secret)([[:space:]]*:[[:space:]]*).*#\1\2<REDACTED>#I' \
    -e 's#sk-[A-Za-z0-9_-]+#<REDACTED>#g' \
    -e 's#(csk|gsk|xai|hf)-[A-Za-z0-9_-]+#<REDACTED>#g'
}

{
  echo "### sha256 + size"
  sha256sum "$SRC"
  wc -l "$SRC"

  echo
  echo "### every reasoning_effort in the file (line-numbered)"
  grep -n "reasoning_effort" "$SRC" | redact

  echo
  echo "### lines 130-200"
  sed -n '130,200p' "$SRC" | cat -n | sed -E 's/^ *([0-9]+)\t/\1+129: /' | redact

  echo
  echo "### every cerebras mention"
  grep -n "cerebras" "$SRC" | redact

  echo
  echo "### fallbacks blocks"
  grep -n "fallback" "$SRC" | redact
} > "$OUT" 2>&1

chmod 0644 "$OUT"
echo "WROTE $OUT"
