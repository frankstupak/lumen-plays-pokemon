#!/usr/bin/env bash
# wq#2073 — verify, don't guess: what retry_policy keys does the INSTALLED
# litellm accept, how is the proxy launched, and is the qwen36-local rung the
# fallback dead-ends on actually up? Read-only.
set -uo pipefail

DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/retry_policy_evidence.txt"

redact() {
  sed -E \
    -e 's#(api_key|master_key|salt_key|password|token|secret)([[:space:]"'"'"':=]*)[^,[:space:]"}]+#\1\2<REDACTED>#Ig' \
    -e 's#sk-[A-Za-z0-9_-]+#<REDACTED>#g' \
    -e 's#(csk|gsk|xai|hf|or)-[A-Za-z0-9_-]{8,}#<REDACTED>#g'
}

{
  echo "### litellm version"
  docker exec litellm python -c "import litellm; print(litellm.__version__)" 2>&1 | tail -2

  echo
  echo "### RetryPolicy fields accepted by THIS build"
  docker exec litellm python -c \
    "from litellm.types.router import RetryPolicy; print(sorted(RetryPolicy.model_fields.keys()))" 2>&1 | tail -4

  echo
  echo "### AllowedFailsPolicy fields"
  docker exec litellm python -c \
    "from litellm.types.router import AllowedFailsPolicy; print(sorted(AllowedFailsPolicy.model_fields.keys()))" 2>&1 | tail -4

  echo
  echo "### does RouterConfig/router_settings accept retry_policy?"
  docker exec litellm python -c \
    "import inspect, litellm.router as r; s=inspect.signature(r.Router.__init__); print([p for p in s.parameters if 'polic' in p or 'retr' in p or 'fail' in p])" 2>&1 | tail -4

  echo
  echo "### how the proxy is launched"
  docker inspect litellm --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} image={{.Config.Image}}' 2>&1 | redact
  docker inspect litellm --format 'compose_project={{index .Config.Labels "com.docker.compose.project"}} working_dir={{index .Config.Labels "com.docker.compose.project.working_dir"}} service={{index .Config.Labels "com.docker.compose.service"}}' 2>&1 | redact
  docker inspect litellm --format 'cmd={{.Config.Cmd}}' 2>&1 | redact

  echo
  echo "### is the qwen36-local rung (isis:8095) reachable right now?"
  curl -s -m 6 -o /dev/null -w 'isis_8095_health=%{http_code} t=%{time_total}\n' http://100.100.129.24:8095/health 2>&1

  echo
  echo "### gateway health"
  curl -s -m 6 -o /dev/null -w 'litellm_4000_health_liveliness=%{http_code}\n' http://localhost:4000/health/liveliness 2>&1
} > "$OUT" 2>&1

chmod 0644 "$OUT"
echo "WROTE $OUT"
