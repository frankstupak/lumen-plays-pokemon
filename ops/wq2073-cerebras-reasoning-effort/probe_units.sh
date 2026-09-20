#!/usr/bin/env bash
# wq#2073 — the ticket asks what can un-mask or restart LPP. ISSUE-LOG #516 left
# lumen-guardian-lpp.service and lpp-restart.service as "masked, reason unknown".
# Enumerate every unit that could start the agent, and every timer/path/dropin
# pointed at it. Read-only.
set -uo pipefail

DIR=/home/lumen/worktrees/wq2073-a2/ops/wq2073-cerebras-reasoning-effort
OUT="$DIR/units_evidence.txt"

{
  echo "### every systemd unit whose name mentions lpp / pokemon"
  systemctl list-unit-files --no-legend --no-pager 2>/dev/null \
    | grep -iE 'lpp|pokemon' || echo "(none)"

  echo
  echo "### load state of each"
  for u in lumen-pokemon-live.service lumen-guardian-lpp.service lpp-restart.service \
           lpp-probes.service lpp-probes.timer lumen-pokemon-stream.service; do
    printf '%-34s load=%-10s active=%-10s enabled=%s\n' "$u" \
      "$(systemctl show -p LoadState --value "$u" 2>&1)" \
      "$(systemctl show -p ActiveState --value "$u" 2>&1)" \
      "$(systemctl is-enabled "$u" 2>&1)"
  done

  echo
  echo "### anything that Wants/Requires/BindsTo lumen-pokemon-live.service"
  systemctl show -p WantedBy -p RequiredBy -p BoundBy -p TriggeredBy \
    lumen-pokemon-live.service 2>&1

  echo
  echo "### unit files under /etc that reference the pokemon tree in an ExecStart"
  grep -rlE 'ExecStart=.*(pokemon|live_agent)' /etc/systemd/system/ 2>/dev/null | head -20 || echo "(none)"

  echo
  echo "### drop-ins that survive a mask (dir kept even when unit -> /dev/null)"
  ls -d /etc/systemd/system/lumen-pokemon-live.service.d 2>&1
  ls -1 /etc/systemd/system/lumen-pokemon-live.service.d/ 2>&1

  echo
  echo "### timers that could fire anything lpp-shaped"
  systemctl list-timers --all --no-legend --no-pager 2>/dev/null \
    | grep -iE 'lpp|pokemon' || echo "(no lpp/pokemon timers)"

  echo
  echo "### crontab entries mentioning pokemon/lpp (lumen + root)"
  crontab -l 2>/dev/null | grep -iE 'pokemon|lpp' || echo "(lumen crontab: none)"

  echo
  echo "### the mask itself"
  ls -l /etc/systemd/system/lumen-pokemon-live.service 2>&1
  ls -l /etc/systemd/system/lumen-guardian-lpp.service /etc/systemd/system/lpp-restart.service 2>&1

  echo
  echo "### is the tombstone present in the tree the unit runs out of?"
  ls -l /home/lumen/pokemon/DECOMMISSIONED.md 2>&1
  git -C /home/lumen/pokemon log --oneline -1 -- DECOMMISSIONED.md 2>&1
} > "$OUT" 2>&1

chmod 0644 "$OUT"
echo "WROTE $OUT"
