#!/usr/bin/env bash
# wq#588 — the CI-SAFE probe subset: no ROM, no checkpoints, no emulator.
# GitHub runners have neither roms/pokeblue.gb (copyright — only .sym files
# are tracked) nor a checkpoints/ corpus, so CI runs exactly the pure-logic
# probes. The full on-main set is scripts/probes-main.sh on the Lumen host.
set -u
cd "$(dirname "$0")/.."

PROBES=(probe_notepad probe_notepad584 probe_economy probe_vision621 probe_braincfg probe_brain907 probe_novelty1179 probe_calc1181 probe_ledger1181 probe_persona probe_persona_state probe_chat probe_streamer)

failed=()
for p in "${PROBES[@]}"; do
  echo "==== $p ===="
  if ! timeout 120 npx tsx "src/$p.ts" >"/tmp/lpp-probe-$p.log" 2>&1; then
    failed+=("$p")
    echo "FAIL $p — tail:"
    tail -5 "/tmp/lpp-probe-$p.log"
  else
    tail -1 "/tmp/lpp-probe-$p.log"
  fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "PROBES RED: ${failed[*]}"
  exit 1
fi
echo "PROBES GREEN: ${#PROBES[@]}/${#PROBES[@]}"
