# wq#2073, second half: the cascade that took isis down

The ticket's first half — LPP came back from a mask and ran 19h — is answered in
`2073_lpp_resurrection_rca.md` and fixed by the tombstone gate. This is the
second half: *"the `reasoning_effort=high` in `litellm_config.yaml:159` for
`cerebras-oss-120b` is invalid for that model — fix or remove so failed calls
don't cascade to isis."*

**That line is not what the ticket thinks it is, and removing it would have
broken a working model while leaving the cascade running.** What follows is the
evidence, the actual cause, and the one change that was safe to make from here.

All raw probe output is in `ops/wq2073-cerebras-reasoning-effort/`; the scripts
that produced it are checked in next to it, so every number below is reproducible.

## 1. Line 159 belongs to deepseek, not cerebras

`/home/lumen/agent/litellm_config.yaml` contains exactly **one**
`reasoning_effort` in 409 lines, and it has never been on a Cerebras rung:

| file | line | owner |
|---|---|---|
| `litellm_config.yaml` (today) | 200 | `messenger-re` |
| `.bak.20260920_152128_pre_wq2127` | **159** | `messenger-re` |
| `.bak.20260919_080723_add_mac_rungs` | 147 | `messenger-re` |
| `.bak.20260918_052310_hathor_down` | 147 | `messenger-re` |

(`history_evidence.txt:1-11`. The line number moved because wq#2127 inserted the
Mac `local-worker` rungs above it, which is why the ticket's ":159" was accurate
on 09-20 and is 200 now.)

Line 159 in the backup the ticket was filed against reads (`history_evidence.txt:15`):

```yaml
- model_name: messenger-re
  litellm_params:
    model: deepseek/deepseek-v4-pro
    timeout: 180
    extra_body:
      thinking: {type: enabled}
      reasoning_effort: high      # <- line 159
```

`deepseek-v4-pro` accepts `high`. Meanwhile the actual `cerebras-oss-120b`
deployment carries no `reasoning_effort` at all, in any backup on disk
(`history_evidence.txt:18-25`, `cascade_evidence.txt:9-15`):

```yaml
- model_name: cerebras-oss-120b
  litellm_params:
    model: cerebras/gpt-oss-120b
    api_key: ...
    timeout: 30
```

The misattribution is easy to reconstruct: the LiteLLM error names
`Model Group=cerebras-oss-120b`, a `grep -n reasoning_effort` on the config
returns one hit, and the two get joined. Deleting that hit would have silently
turned off reasoning on the messenger's escalation rung and changed nothing
about isis.

Prior-attempt note on the same ticket reached the same suspicion from the error
text alone (`2073_lpp_resurrection_rca.md:126-137`): the rejection message reads
`Input should be 'none', 'low', 'medium' or 'high'` — **`high` is in the accepted
set**, so the value being rejected was never `high`.

## 2. The value actually being rejected is `disable`, and the caller is Minerva

`minerva_verify.py` sends a judge request with:

```python
JUDGE_MODEL = os.getenv('VERIFY_JUDGE_MODEL', 'cerebras-oss-120b')   # :43
...
'reasoning_effort': 'disable',                                        # :596
```

(cited from the in-tree copy at
`/home/lumen/foreman/ops/wq1997-external-advisory-check/minerva_verify.py`; the
same pair appears in the wq#1528, wq#1529 and wq#1927 copies.)

`disable` is a LiteLLM-level sentinel. It is verified-good on the rungs the
comment at `:592-595` was written for — deepseek passes it through, gemini maps
it to `thinkingBudget=0`. Cerebras is reached over the OpenAI-compatible path,
so the string goes out verbatim, and Cerebras validates it against
`{none, low, medium, high}`. `disable` is not in that set, so **every judge call
that lands on the default rung 400s before the model sees a token.**

`drop_params: true` (line 394) cannot help here: it drops parameters a provider
doesn't *support*, and Cerebras supports `reasoning_effort` fine. It is the
value that is wrong.

## 3. How one 400 became ~13 hops onto isis

From the live traceback (`payload_evidence.txt:43-48`):

```
litellm.BadRequestError: CerebrasException - reasoning_effort: Input should be
  'none', 'low', 'medium' or 'high'. Received Model Group=cerebras-oss-120b
Available Model Group Fallbacks=['qwen36-local']
Error doing the fallback: ... Connection error.
  No fallback model group found for original model_group=qwen36-local
LiteLLM Retried: 3 times
POST /v1/chat/completions HTTP/1.1" 400 Bad Request
```

The router treated a deterministic client-side validation error as a transient
fault. `num_retries: 3` sent the same rejected value out three more times, and
each attempt dragged the `cerebras-oss-120b -> qwen36-local` fallback edge onto
isis with it. Measured over 24h to 2026-09-20 (`cascade_evidence.txt:179-182`):

- **213** `CerebrasException` — the bad calls
- **2,786** `No fallback model group found for original model_group=qwen36-local`
  — the hops they generated, ~13 per bad call

On 2026-09-18/19 that ran alongside a resurrected LPP while isis's llama-server
was *up*, and the two together saturated its 2 decode slots. That is the
mechanism behind the starved supergateway and the dropped MCP sessions.

Worth separating: this is not an LPP bug. LPP's own effort value is
`envEffort()`-clamped and can only ever emit `low|medium|high|undefined`
(`src/config.ts:22-26`). LPP was a *volume* contributor to isis load, not the
source of the invalid parameter — and the cascade is still measurable today,
with LPP masked since 09-19.

## 4. What was changed

**Not** line 159/200 — it is correct and load-bearing.

The amplifier was, in `router_settings` (`apply_evidence.txt`):

```yaml
router_settings:
  retry_policy:
    BadRequestErrorRetries: 0
    AuthenticationErrorRetries: 0
```

A provider's request-validator 400 says the caller sent something the model
cannot accept. Retrying it can never succeed — the identical bad value goes back
out — and every retry pulls the group's fallback edge onto a free local rung
behind it. Retry budgets are for transient faults; these two classes are
deterministic. No fallback edge was touched, so wq#1588's paid→free-only routing
policy is unchanged.

Both keys were confirmed against the *installed* build before being written
rather than taken from documentation — `RetryPolicy` exposes exactly
`{Authentication, BadRequest, ContentPolicyViolation, InternalServer, RateLimit,
Timeout}ErrorRetries`, and `Router.__init__` accepts `retry_policy`
(`retry_policy_evidence.txt:6,12`).

Applied by `ops/wq2073-cerebras-reasoning-effort/apply.sh`, which backs the file
up, patches by line (a YAML round-trip would erase 409 lines of load-bearing
comments), asserts the parse changed *only* `router_settings.retry_policy`,
restarts the container, and restores the backup automatically if the proxy does
not return healthy. It dry-ran against a copy first (`dryrun_evidence.txt`:
insertion-only diff, idempotent on a second run).

Result (`apply_evidence.txt:29-41`, `verify_evidence.txt`, `verify2_evidence.txt`):

- backup at `litellm_config.yaml.bak.20260920_202642_pre_wq2073`
- proxy healthy 50s after restart; `Application startup complete`,
  `Proxy initialized with Config`, 0 config-load errors
- the running container is serving the patched file — in-container
  `sha256(/app/config.yaml)` = `46e8c739…` matches the patched host file
- the running router parsed it:
  `retry_policy = {'BadRequestErrorRetries': 0, 'AuthenticationErrorRetries': 0}`
- `cerebras-oss-120b` still served; `messenger-re`'s `reasoning_effort: high`
  still present and untouched
- real traffic served since: `POST /v1/chat/completions ... 200 OK`

**Honest limit on that last point.** `CerebrasException` count since the reload
is 0, but so is the cerebras traffic in that window — Minerva's judge did not
happen to run. Zero-in-ten-minutes is not proof the cascade is gone; the
verified claim is narrower: *the retry multiplier is installed, parsed, and
live.* The next Minerva verify run is what will show 1 hop where there were 13.

## 5. Left open, with an owner

**The caller's `disable` still needs fixing, on wq#2068.** The gateway change
bounds the blast radius; it does not stop the 400s. The fix is one word in
`minerva_verify.py` — but not a blind swap: `disable` is the *verified-correct*
value for the deepseek and gemini rungs the same function can be pointed at
(`:592-595`), so it needs to be conditioned on the rung, or replaced with `none`
and re-verified against deepseek/gemini passthrough before rollout.

Not done here because `/home/lumen/minerva` is deliberately excluded from worker
read roots (`harness/fleet-exec-policy.yaml:67`, wq#1467: credentials are
mirrored into that tree). That is a boundary worth keeping, not one to route
around with a root unit.

**Two unrelated things this surfaced**, both live in the same 15-minute log
window (`verify2_evidence.txt:12-13`), neither in scope here:

- `Invalid model name passed in model=mistral-small` ×6 — that is
  `VERIFY_JUDGE_MODEL_2`, and `minerva_verify.py:120-125` shows wq#1501 already
  knew this rung was retired. Minerva's second judge has been failing closed.
- `prisma.errors.MissingRequiredValueError` ×4 in the proxy's own DB layer.

**isis is down right now**, independently: `curl` to `100.100.129.24:8095/health`
returns `000` in ~1ms, and the log shows `ConnectionRefusedError [Errno 111]` on
direct `qwen36-local` calls that never went near Cerebras
(`retry_policy_evidence.txt:20`, `verify2_evidence.txt:9-11,26`). Callers are
still asking for that rung. wq#2068 territory.

## 6. LPP is still dead — re-verified

| check | state |
|---|---|
| `lumen-pokemon-live.service` | `masked` / `inactive`, unit → `/dev/null` (Sep 19 08:12) |
| `lpp-restart.service` | `masked` / `inactive` → `/dev/null` |
| `lumen-guardian-lpp.service` | `masked` / `inactive` → `/dev/null` |
| `WantedBy` / `RequiredBy` / `BoundBy` / `TriggeredBy` | all empty — nothing pulls it in |
| lpp/pokemon timers | none active (`lpp-snapshot`, `lpp-watchdog`, `lumen-lpp-{frontier,sentinel,stuck-supervisor}` all disabled) |
| `lumen` crontab | only `harness-preflight` over the tree every 6h; no service start |
| tombstone in the deployed tree | `/home/lumen/pokemon/DECOMMISSIONED.md` present, at 62d76d9 |

(`units_evidence.txt`.) This also closes the open item in ISSUE-LOG #516, which
recorded the tombstone as *not* found in `/home/lumen/pokemon` — it is there now,
and `git log -1 -- DECOMMISSIONED.md` in that checkout resolves to this ticket's
merged commit. #516's "masked, reason unknown" for `lpp-restart.service` and
`lumen-guardian-lpp.service` is likewise answerable: same `/dev/null` symlinks,
same timestamp, same 09-19 re-kill.

One hazard remains and is worth naming rather than fixing: two ExecStart-bearing
copies of the unit sit beside the mask —
`lumen-pokemon-live.service.KILLED-1789805573` and
`lumen-pokemon-live.service.DISABLED-COST-2026-09-13`. systemd ignores them
(wrong suffix), but they are exactly the artifact a future operator renames back,
which is the shape of the mistake wq#1990 already made once. They are harmless
now only because the tombstone gate refuses the boot regardless of who starts the
process — which is the argument for having put the gate in the tree instead of in
a `systemctl` verb.
