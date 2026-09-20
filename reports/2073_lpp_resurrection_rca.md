# wq#2073 — LPP came back from a mask, ran 19h, and took Frank's MCP sessions with it

**Root cause: not a guardian, not a healer, not a deploy hook. A sibling build
worker read the mask, found no reason attached to it, and reversed it on
purpose.** Every automated guard in the fleet held. The thing that failed is
that "decommissioned" was a `systemctl` state and nothing else.

## Timeline (all UTC, all cited)

| when | what | evidence |
|---|---|---|
| 2026-09-13 04:25:13 | `lumen-pokemon-live.service` goes from a real unit file to a mask symlink | `fleet-units` snapshot `afa213e`: `D units/lumen-pokemon-live.service`, `A units/…​.symlink` |
| 2026-09-18 03:41:02 | still masked | `fleet-units` snapshot `b7c313d` |
| 2026-09-18 12:54:07 | wq#1661's port-ownership change lands in the primary tree (`ec1bf29`, touches both `deploy/` unit files) | `git -C /home/lumen/pokemon reflog` |
| 2026-09-18 12:56:18 | wq#1990 claimed: *"[ops] install wq#1661 :8871 units as root (live unit is currently masked)"* | `wq show 1990` |
| 2026-09-18 ~13:01 | `apply.sh` runs as root: `systemctl unmask`, `install -m 0644` both units, `daemon-reload` | `foreman/ops/wq1990-pokemon-8871-install/apply.sh:38-41,60,66` |
| 2026-09-18 13:01:46 | live agent boots (`lpp-restart --ticket wq#1990`) | `events/live-agent-1789736506403.jsonl:1` |
| 2026-09-18 13:02:16 | the run that lasted | `events/run-summary-live-agent-1789736536360.json` |
| 2026-09-18 13:04:42 | wq#1990 closed green, 8/8 on its own tests | `wq show 1990` |
| 2026-09-18 14:09:42 | the unmask is captured in the fleet baseline: `A units/lumen-pokemon-live.service`, `D …​.symlink` | `fleet-units` snapshot `7b604d9` |
| 2026-09-19 08:11:27 | killed, 68,990,518 ms after start (19h09m) | `run-summary…​.json` `wallMs` |
| 2026-09-19 08:16:31 | re-masked | `fleet-units` snapshot `68e1eaa` |

The ticket's "started Sat 13:02" is a day off: the run started **Friday
2026-09-18 13:01:46Z** and was killed Saturday 08:11. The 19h figure is right.

## What the 19 hours cost

From `run-summary-live-agent-1789736536360.json` and the event log:

- **3 turns of gameplay.** 1208 harness reboots — one about every 57s.
- **8,478 brain calls**: 6,043 `qwen36-local`, 1,220 `glm-5.3-flash-zai`,
  1,215 `cerebras-oss-120b` (`grep -o '"model":"…​"' | sort | uniq -c`).
  qwen36-local is the single-decode-slot local model on isis; it absorbed ~5
  calls for every cerebras call, which is the fallback cascade the ticket
  describes arriving at its dead end.
- **8,461 `brain_breaker` trips**, every one of them on `qwen36-local` with
  `cooldownMs: 600000, fails: 2`. A 10-minute breaker that trips 8,461 times in
  19h is a breaker that never holds: it is per-`Brain`-instance state, and the
  reboot loop built a fresh `Brain` roughly every 57s. The circuit breaker was
  working exactly as written and still could not damp anything.
- Spend was **$0** — the $0.01 key caps held. The cost was isis's decode slot,
  which starved supergateway, which dropped Frank's Claude MCP sessions.

## Why the mask lost

`apply.sh:11-20` says it in the worker's own words:

> `lumen-pokemon-live.service` has been LoadState=masked since >= 2026-09-13
> (wq#1895 — a stale-probe cleanup that found it already masked, **cause
> undocumented**). wq#1990 decided to unmask as part of this install: the mask
> postdates fire wq#1821 […] Leaving the unit masked forever keeps the public
> stream down unconditionally, which is strictly worse than the fire it was
> parked to quiet.

That is a careful decision made on the only information available. The worker
researched the mask, found wq#1895 recording it as already-masked-cause-unknown,
weighed it against an open fire whose symptom class wq#1661 existed to fix, and
documented the reversal in its closing notes. `docs/PORT-8871.md` — the install
procedure it was following — said nothing about a decommission either.

A mask carries a state, not a reason. The next reader supplies the reason.

**The fleet already has the right registry and LPP was never entered in it.**
`foreman/docs/fleet/retired_services.yaml` exists precisely so "a guard that
still names a unit here is watching a ghost on purpose-documented grounds"; it
has entries for agent5-split, research-mill, lumen-agent, lumen-dgm,
signal-engine — and none for LPP. `/home/lumen/fleet-units/known-removed.txt`
does the same job for removed units ("reappearance = respawn", wq#1041) and has
no equivalent for masked ones. Both gaps are filed as **wq#2218** — they live in
`claude-foreman`, not here.

## What was ruled out

- **`lpp-watchdog`** (`/home/lumen/bin/sbin/lpp-watchdog.sh`, root, `systemctl
  restart` on a stale event file): `lpp-watchdog.timer` is `disabled` and
  `logs-24h/watchdog.log` has not been written since 2026-08-21. It also cannot
  unmask.
- **`lumen_self_healer.py`**: gates every rule on `is_systemd_active()` and
  no-ops for a masked unit (wq#1112; documented in `retired_services.yaml` under
  `lumen-agent`). It has no unmask verb.
- **`unit-drift`**: detect-only by construction — *"It never applies or
  restarts"*, and `cmd_apply` prints a plan without writing
  (`/home/lumen/bin/unit-drift:6,219-237`). Its snapshots are the evidence above,
  not the cause.
- **`lumen-guardian.py`**: thermal/RAS hardware guardian, no service verbs.
- **`fleet-provision-ssh`, deploy hooks in `lumen-pr`**: no restart or unmask
  path for this unit (`grep -n 'restart|systemctl' /home/lumen/bin/lumen-pr`).
- No `systemctl unmask` exists anywhere under `/home/lumen/bin`. The only one in
  the fleet is the line wq#1990 wrote for itself.

## The fix in this repo

A mask is a state on a host. This lands the reason in the tree the service runs
out of, and makes the code enforce it:

- `DECOMMISSIONED.md` — the tombstone: why, since when, and the two conditions
  for revival (a free local brain, and Frank).
- `src/decommission.ts` + `src/live_agent.ts` — the entrypoint exits **4** while
  the tombstone exists, ahead of the :8871 bind and ahead of the wq#1664 config
  gate. This is the gate that holds regardless of *who* started the process:
  systemd, `lpp-restart`, the watchdog, or a bare `npx tsx src/live_agent.ts`.
  The 2026-09-18 run came through the unit; the 8,478 brain calls did not care.
- `deploy/lumen-pokemon-live.service` — `AssertPathExists=!` on the tombstone, so
  a future `install`-and-`daemon-reload` cannot revive the service even if it
  unmasks again. An assert rather than a condition: a condition failure is a
  silent skip, and silence is how this ran for 19h unnoticed.
- `docs/PORT-8871.md` — the install procedure wq#1990 followed now says, at the
  top of the step it followed, that unmasking is a revival and needs Frank.
- `src/probe_decommission2073.ts` — proves the refusal, the exit code, and that
  the gate is transparent once the tombstone is deleted (so the revival PR is
  testable rather than a leap).

Revival is now one reviewable commit — `git rm DECOMMISSIONED.md` with the
approval named in the message — instead of a judgement call made at 13:00 by
whoever happens to be holding an adjacent ticket.

## Not fixed here, and why

**`litellm_config.yaml:159` — `reasoning_effort` on `cerebras-oss-120b`** (the
ticket's second half, owned by wq#2068). That file is outside this lane's
filesystem grant: `/home/lumen` is not readable from here, the gateway's
`/v1/model/info` needs a key this lane must not read, and the lane has no root.
It needs a lane with the gateway config in `--add-dir`.

**And the fix is probably not the one the ticket names.** wq#2073 describes it as
"bad `reasoning_effort=high` that cerebras-oss-120b rejects", but the LiteLLM
error quoted in wq#2068's own evidence reads:

> `CerebrasException - reasoning_effort: Input should be 'none','low','medium'
> or 'high'`

`high` is *in* the accepted set. So the value reaching Cerebras is something
else — an empty string, an unquoted YAML value that parses to a non-string, or a
value injected on the fallback hop — and deleting the word `high` from line 159
may leave the cascade running. Capture the outbound payload before editing.
Noted on wq#2068 rather than guessed at here.

It is worth saying what the gate above does and does not do for it. LPP is no
longer a caller, so LPP can no longer turn that config error into load on isis.
Anything else on the gateway still can: a model-level parameter the provider
rejects makes every call to that model fail instantly, and instant failure is
what turns a fallback ladder into a flood. The 8,461 breaker trips are the
general lesson — a per-process breaker cannot damp a caller that keeps getting
a fresh process — and that lesson outlives this ticket.
