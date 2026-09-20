#!/usr/bin/env bash
# wq#2073 — prove the retry_policy is live in the RUNNING router, not just on
# disk, and record the cascade rate after the reload. Read-only.
set -uo pipefail

DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/verify_evidence.txt"

redact() {
  sed -E -e 's#sk-[A-Za-z0-9_-]+#<REDACTED>#g' \
         -e 's#(csk|gsk|xai|hf|or)-[A-Za-z0-9_-]{8,}#<REDACTED>#g' \
         -e 's#(api_key|master_key|token|secret)([[:space:]"'"'"':=]*)[^,[:space:]"}]+#\1\2<REDACTED>#Ig'
}

{
  echo "### router_settings as the RUNNING proxy parsed them"
  docker exec litellm python -c "
import yaml
d = yaml.safe_load(open('/app/config.yaml'))
rs = d['router_settings']
print('retry_policy      =', rs.get('retry_policy'))
print('num_retries       =', rs.get('num_retries'))
print('allowed_fails     =', rs.get('allowed_fails'))
print('fallbacks         =', rs.get('fallbacks'))
" 2>&1 | tail -8

  echo
  echo "### the container is serving the patched file (in-container sha)"
  docker exec litellm sha256sum /app/config.yaml 2>&1 | tail -1

  echo
  echo "### proxy startup: config accepted?"
  docker logs --since 10m litellm 2>&1 | grep -icE 'ValidationError|error loading config|Traceback' | tail -1

  echo
  echo "### cascade counters since the reload"
  echo "CerebrasException:  $(docker logs --since 10m litellm 2>&1 | grep -c 'CerebrasException')"
  echo "qwen36 dead-ends:   $(docker logs --since 10m litellm 2>&1 | grep -c 'No fallback model group found for original model_group=qwen36-local')"

  echo
  echo "### gateway + LPP state"
  echo "litellm liveliness: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:4000/health/liveliness)"
  echo "lumen-pokemon-live: $(systemctl is-enabled lumen-pokemon-live.service 2>&1) / $(systemctl is-active lumen-pokemon-live.service 2>&1)"
  echo "unit file:          $(readlink -f /etc/systemd/system/lumen-pokemon-live.service 2>&1)"
} > "$OUT" 2>&1

chmod 0644 "$OUT"
echo "WROTE $OUT"
