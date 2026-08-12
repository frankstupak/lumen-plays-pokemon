# AUTO-Turn Rate Lever (wq#472, follow-through on wq#426)

## Knob

`LPP_AUTO_TURN_RATIO` (systemd `Environment=` drop-in, 30-brain-env.conf style)

- **Default: `0` = OFF = current behavior.** The brain is called every turn,
  exactly as before this change. The policy default is Frank's call — see the
  user-lane decision ticket filed with this ship.
- `N > 0`: after every brain-driven turn, the harness may carry up to N
  consecutive turns deterministically ("planned auto", `DET:` prefix in turn
  summaries) before the next brain call. Fractions floor; negatives → 0.
- Sharp edge (same as all LPP_* knobs): an empty-string value wins over the
  default (`LPP_AUTO_TURN_RATIO=` reads as 0 — harmless here, that IS the default).

## When planned auto fires (Agent.plannedAuto — the safety gates)

A planned turn happens ONLY in states where the correct action is not a
judgment call. Everything else falls through to the brain, budget untouched:

| State | Planned action | Falls back to brain when |
|---|---|---|
| TRAINER battle, main menu | strongest damaging move with PP | wild battle (catch decision), HP ≤ 25% (item decision), no usable moves (Struggle), menu not reachable |
| Dialog/sign text open | advance dialog | a cursor choice is up (choices are ALWAYS the brain's) |

Additional invariants:
- `battleLockForce` (wq#423 soft-lock escalation) still runs FIRST every turn.
- Planned turns do NOT count toward brain stall-escalation (`reportProgress`
  is skipped — stallTurns measures the brain, and no brain call happened).
- Budget refills to the ratio only after a real brain turn.
- Every planned turn lands in history (`DET:battle` / `DET:talk` lines), so
  the brain sees exactly what the harness did when it's next called.

## Measurement

`metrics.ts` counts `plannedAutoTurns` (distinct from `autoTurns`, which is
the unwedge/soft-lock FAILURE mode from wq#426) and derives `plannedAutoRate`
in every run summary. Brain-call saving per run = plannedAutoTurns round
trips avoided (~2.3 min/turn on isis-qwen36 as of 2026-08-12).

## Expected effect (estimate, to be measured)

Trainer-battle turns and multi-box dialog account for a large share of turns
in gyms/routes. With ratio=2, a 4-turn trainer fight goes from 4 brain calls
to ~2; a 6-box dialog chain from 6 calls to ~2. Rough estimate: 20-40% fewer
brain calls in battle/dialog-heavy segments, 0% in open-world navigation
(planned auto never moves the player). Wall-clock turn rate rises
proportionally on the qwen36-local rung.

## How to enable

Add to `/etc/systemd/system/lumen-pokemon-live.service.d/30-brain-env.conf`:

    Environment=LPP_AUTO_TURN_RATIO=2

then `sudo systemctl daemon-reload && sudo systemctl restart lumen-pokemon-live`
(under `slock lumen-pokemon-live`). Rollback = remove the line (or set 0) and
restart.
