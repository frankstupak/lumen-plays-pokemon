#!/usr/bin/env bash
# wq#588 — the RUNNABLE-ON-MAIN probe set.
#
# Contract: every probe here is deterministic, needs no live service, and is
# GREEN on origin/main by construction (fixture-by-property, consistency
# asserts, synthetic anchors — never position-blanket claims over the live
# corpus; see wq#540/#584/#586/#588 for the graveyard of probes that broke
# that rule). Emulator probes need roms/pokeblue.gb and a checkpoints/ dir,
# so this script runs on the Lumen host (npm test / the lpp-probes timer),
# NOT on GitHub CI — scripts/probes-pure.sh is the CI-safe subset.
#
# Excluded on purpose:
#   probe_battle587, probe_catch559, probe_battlebag1663 — real
#     wild-encounter RNG (skip-capable); run them manually around
#     battle/item work.
#   probe_diag — a diagnostic harness, not a test.
set -u
cd "$(dirname "$0")/.."

PROBES=(
  probe_notepad
  probe_notepad584
  probe_claims
  probe_arrival642
  probe_economy
  probe_cerulean
  probe_resume518
  probe_pocket534
  probe_route564
  probe_resume586
  probe_resume628
  probe_reach538
  probe_transit
  probe_steptrace542
  probe_goto583
  probe_warp579
  probe_scope606
  probe_ceiling1090
  probe_menu620
  probe_items607
  probe_bagnames1829
  probe_cerulean638
  probe_vision621
  probe_hidden622
  probe_warploop652
  probe_vision658
  probe_gymdoor674
  probe_mistygate674
  probe_warprace699
  probe_braincfg
  probe_braincfg1664
  probe_bootguard1664
  probe_brain907
  probe_novelty1179
  probe_explore1731
  probe_calc1181
  probe_ledger1181
  probe_grass1565
  probe_sell1835
  probe_pin1840
  probe_route1849
  probe_pocket1870
  probe_guard1877
  probe_resume1177
  probe_checkpoint1177
)

failed=()
for p in "${PROBES[@]}"; do
  echo "==== $p ===="
  if ! timeout 300 npx tsx "src/$p.ts" >"/tmp/lpp-probe-$p.log" 2>&1; then
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
