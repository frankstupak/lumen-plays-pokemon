#!/usr/bin/env bash
# wq#1563 — the stuck-supervisor probe subset.
#
# tools/lpp_stuck_*.py and their probes are Python, and the repo had no
# entrypoint that ran them: probes-main.sh and probes-pure.sh are both tsx-only,
# so every tools/test_stuck*.py — 697, 1118, and the 1826/1845/1846/1867 set
# written since — has never been part of any `npm test` surface. Every
# supervisor change since wq#697 was therefore verified by hand or not at all.
# This script is that missing surface, and it runs ALL of them: a probe with no
# runner is a probe that silently rots.
#
# Read-only: each probe imports lpp_stuck_mode/lpp_stuck_intervene and asserts
# against synthetic state, or reads runtime/*.json. None of them writes to
# runtime/ (lpp_stuck_intervene only persists via main(), which no probe calls).
#
# Usage: npm run test:stuck [-- --verbose] [-- <probe> ...]
#   --verbose  stream each probe's full output instead of only its last line.
#              probes-pure.sh buries passing output in /tmp; that is fine in CI
#              but useless in a sandbox that cannot read /tmp, and these probes
#              print the live incident they assert against.
set -u
cd "$(dirname "$0")/.."

verbose=0
selected=()
for a in "$@"; do
  case "$a" in
    --verbose|-v) verbose=1 ;;
    *) selected+=("$a") ;;
  esac
done

PROBES=(test_stuck697 test_stuck1118 test_stuck1563
        test_stuck1826 test_stuck1845 test_stuck1846 test_stuck1867
        test_stuck1660)
[ "${#selected[@]}" -gt 0 ] && PROBES=("${selected[@]}")

failed=()
for p in "${PROBES[@]}"; do
  echo "==== $p ===="
  if [ "$verbose" = 1 ]; then
    if ! timeout 120 python3 "tools/$p.py"; then failed+=("$p"); echo "FAIL $p"; fi
    continue
  fi
  if ! timeout 120 python3 "tools/$p.py" >"/tmp/lpp-stuck-$p.log" 2>&1; then
    failed+=("$p")
    echo "FAIL $p — tail:"
    tail -15 "/tmp/lpp-stuck-$p.log"
  else
    tail -1 "/tmp/lpp-stuck-$p.log"
  fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "STUCK PROBES RED: ${failed[*]}"
  exit 1
fi
echo "STUCK PROBES GREEN: ${#PROBES[@]}/${#PROBES[@]}"
