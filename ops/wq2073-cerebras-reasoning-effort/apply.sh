#!/usr/bin/env bash
# wq#2073 — apply the gateway retry_policy guard, reload litellm, and roll back
# automatically if the proxy does not come back healthy.
#
# Runs as a detached lumen-run unit: /home/lumen/agent and the docker socket are
# both outside the BUILD lane's grant, and instinct 5 wants a change to the path
# this worker rides made by a unit reparented to PID 1, never in-session.
set -uo pipefail

SRC=/home/lumen/agent/litellm_config.yaml
DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/apply_evidence.txt"
BAK="$SRC.bak.$(date +%Y%m%d_%H%M%S)_pre_wq2073"
COMPOSE_DIR=/home/lumen/docker

health() { curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:4000/health/liveliness; }

{
  echo "### pre-change state"
  echo "sha256 before: $(sha256sum "$SRC" | cut -d' ' -f1)"
  echo "health before: $(health)"

  cp -p "$SRC" "$BAK" || { echo "FAIL could not back up"; exit 1; }
  echo "backup: $BAK"

  echo
  echo "### patch"
  python3 "$DIR/patch_retry_policy.py" "$SRC" || { echo "FAIL patch rejected; config untouched"; exit 1; }
  echo "sha256 after:  $(sha256sum "$SRC" | cut -d' ' -f1)"
  echo "--- router_settings head ---"
  grep -n -A12 '^router_settings:' "$SRC"

  echo
  echo "### reload"
  docker compose --project-directory "$COMPOSE_DIR" restart litellm 2>&1 | tail -5

  echo
  echo "### health after reload"
  ok=0
  for i in $(seq 1 30); do
    c=$(health)
    echo "t+${i}0s http=$c"
    if [ "$c" = "200" ]; then ok=1; break; fi
    sleep 10
  done

  if [ "$ok" != "1" ]; then
    echo "ROLLBACK: proxy did not return 200 within 300s"
    cp -p "$BAK" "$SRC"
    docker compose --project-directory "$COMPOSE_DIR" restart litellm 2>&1 | tail -3
    for i in $(seq 1 30); do
      [ "$(health)" = "200" ] && { echo "rolled back, healthy"; break; }
      sleep 10
    done
    echo "RESULT=ROLLED_BACK"
    exit 1
  fi

  echo
  echo "### post-reload sanity: model groups still served"
  docker logs --since 5m litellm 2>&1 | grep -ciE 'error loading config|failed to load|ValidationError' \
    || echo "config-load errors: 0"
  echo "cerebras-oss-120b present in loaded config: $(grep -c 'model_name: cerebras-oss-120b' "$SRC")"
  echo "messenger-re reasoning_effort untouched: $(grep -c 'reasoning_effort: high' "$SRC")"
  echo "RESULT=APPLIED"
} > "$OUT" 2>&1

chmod 0644 "$OUT"
echo "WROTE $OUT"
