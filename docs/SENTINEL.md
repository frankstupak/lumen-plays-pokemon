# LPP Sentinel (wq#489)

Standing, **read-only** monitor for Lumen Plays Pokemon. It watches for
pathologies and alerts; it never touches the game, the service, checkpoints,
or the work queue.

    tools/lpp-sentinel [--dry-run] [--window N] [--events FILE] [--quiet]

Runs every 10 minutes via `lumen-lpp-sentinel.timer` (unit sources kept in
`deploy/`, installed to `/etc/systemd/system/`).

## Checks

| Key | Fires when |
|---|---|
| `loop_position` | 20-turn window entirely inside one map with a position bbox ≤3 tiles |
| `loop_repeat` | ≥5 identical `tool_call` + result pairs in the window |
| `notepad_size` / `notepad_pins` | notes >6000 chars, or pinned region >1500 (eviction stuck) |
| `notepad_guidance_leak` | `[[...]]` guidance markers found inside stored notes — the wq#486 channel separation has regressed |
| `notepad_unreadable` | `runtime/notepad.txt` exists but won't parse (persistence broken) |
| `stall` | storyScore flat across the window AND a step-budget SOFT alarm is active |
| `rule_violation` | wq#488 borrow-guard rejections in the window |
| `turnrate` | newest run <30% of the 24h mean turns/h (needs ≥3 qualifying runs) |

Runs shorter than 5 turns or 5 minutes are ignored for turn-rate, so deploy
restarts don't read as a collapse.

## Alerting

Each alert appends one line to `docs/QUEUE_PROGRESS.md` (append-only — the
board is how parallel agents and the orchestrator see it) and sends ntfy
through the fleet choke point `/home/lumen/bin/ntfy-send` on topic
`lumen-fleet`. **Dedupe: one hour per alert key**, state in
`runtime/sentinel_state.json`. `--dry-run` prints only.

Notepad checks degrade gracefully when `runtime/notepad.txt` is absent (fresh
boot, or a pre-wq#486 binary), so the sentinel never alerts on its own
prerequisites.

## Verification

`tools/verify_489.py` — 14/14. Synthesises pathological logs and asserts every
check fires, that healthy movement / multi-map windows / varied actions do NOT
fire, that dedupe suppresses within the hour and releases after it, and that a
dry run leaves the board untouched.

## Backups

`runtime/` (notepad + sentinel state) and `deploy/` (unit sources) live inside
`/home/lumen/pokemon`, already covered by the standing restic dual-repo job
(local + RAID5 mirror to Thoth). The installed units under
`/etc/systemd/system/` are reproducible from `deploy/` — reinstall with
`sudo cp deploy/lumen-lpp-sentinel.{service,timer} /etc/systemd/system/ &&
sudo systemctl daemon-reload && sudo systemctl enable --now
lumen-lpp-sentinel.timer`.

## Disable

    sudo systemctl disable --now lumen-lpp-sentinel.timer
