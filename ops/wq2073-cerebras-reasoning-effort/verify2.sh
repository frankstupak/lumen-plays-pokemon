#!/usr/bin/env bash
# wq#2073 — the 34 Traceback/ValidationError hits in verify_evidence.txt:11 need
# a name before this ticket can close: startup regression, or the pre-existing
# qwen36-local-is-down noise the reload did not cause? Read-only.
set -uo pipefail

DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/verify2_evidence.txt"
LOG=$(mktemp)

redact() {
  sed -E -e 's#sk-[A-Za-z0-9_-]+#<REDACTED>#g' \
         -e 's#(csk|gsk|xai|hf|or)-[A-Za-z0-9_-]{8,}#<REDACTED>#g' \
         -e 's#(api_key|master_key|token|secret)([[:space:]"'"'"':=]*)[^,[:space:]"}]+#\1\2<REDACTED>#Ig'
}

docker logs --since 15m litellm > "$LOG" 2>&1

{
  echo "### did the proxy load the config cleanly? (these strings mean it did NOT)"
  grep -cE "error loading config|Error loading config|Invalid config|worker failed to boot" "$LOG"

  echo
  echo "### distinct exception headlines in the window"
  grep -oE "^[a-zA-Z_.]+(Error|Exception): .{0,90}" "$LOG" | sort | uniq -c | sort -rn | head -12 | redact

  echo
  echo "### litellm startup banner lines after the restart"
  grep -nE "LiteLLM: Proxy initialized|Starting|#{4,}|Uvicorn running|Application startup complete" "$LOG" | tail -8 | redact

  echo
  echo "### are the tracebacks all the qwen36-local connection failure?"
  echo "Connection error lines:   $(grep -c 'Connection error' "$LOG")"
  echo "qwen36-local dead-ends:   $(grep -c 'model_group=qwen36-local' "$LOG")"
  echo "CerebrasException lines:  $(grep -c 'CerebrasException' "$LOG")"

  echo
  echo "### who is still calling qwen36-local (model group of the ORIGINAL request)"
  grep -oE 'Received Model Group=[a-zA-Z0-9_.-]+' "$LOG" | sort | uniq -c | sort -rn | head -8

  echo
  echo "### a served (200) request since the reload, to prove the proxy still works"
  grep -E '"(POST|GET) /v1/' "$LOG" | grep -E ' 200 ' | tail -3 | cut -c1-160 | redact
  echo "200s since reload: $(grep -cE '"(POST|GET) /v1/.*" 200 ' "$LOG")"
} > "$OUT" 2>&1

rm -f "$LOG"
chmod 0644 "$OUT"
echo "WROTE $OUT"
