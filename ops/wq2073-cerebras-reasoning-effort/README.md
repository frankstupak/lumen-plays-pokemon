# wq#2073 — the cerebras→isis cascade: probes, fix, evidence

Findings and reasoning live in `reports/2073_cerebras_cascade_finding.md`. This
directory is the reproducible half: the scripts that produced every number in
that report, and their raw output.

Everything here runs as a detached `lumen-run` unit. The gateway config
(`/home/lumen/agent/litellm_config.yaml`) and the docker socket are both outside
a BUILD lane's filesystem grant, and instinct 5 wants a change to the path this
worker rides made by a unit reparented to PID 1, never in-session. The scripts
write their output back into this directory, where the lane can read it.

Every script pipes through a credential mask before writing. One thing the mask
missed — a langfuse *public* key — was redacted by hand afterwards and labelled
as such in `cascade_evidence.txt`.

## Order they were run in

| script | output | what it settles |
|---|---|---|
| `dump_config.sh` | `config_excerpt.txt` | where `reasoning_effort` actually appears in the live config |
| `probe_cascade.sh` | `cascade_evidence.txt` | the cerebras blocks, the fallback edges, and the 24h cascade counts |
| `probe_payload.sh` | `payload_evidence.txt` | the live traceback: retry → fallback → dead end |
| `probe_history.sh` | `history_evidence.txt` | what line 159 held on 09-20, from the backup trail |
| `probe_retry_policy.sh` | `retry_policy_evidence.txt` | which `RetryPolicy` keys the *installed* build accepts |
| `dryrun.sh` | `dryrun_evidence.txt` | the patch against a copy, before the live file |
| `apply.sh` + `patch_retry_policy.py` | `apply_evidence.txt` | the change, the reload, the rollback path |
| `verify.sh` | `verify_evidence.txt` | the running router parsed it; LPP still masked |
| `verify2.sh` | `verify2_evidence.txt` | the post-reload tracebacks named (isis down, not a regression) |
| `probe_units.sh` | `units_evidence.txt` | every unit/timer/cron that could start LPP |

Read-only except `apply.sh`.

## Re-running

```sh
/home/lumen/bin/lumen-run start --name wq2073x -- bash <script>
/home/lumen/bin/lumen-run wait lumen-job-wq2073x-<epoch> 120
```

`apply.sh` is safe to re-run: `patch_retry_policy.py` prints `ALREADY_PRESENT`
and exits 0 if `router_settings.retry_policy` is already there.

## Rolling the gateway change back

```sh
cp /home/lumen/agent/litellm_config.yaml.bak.20260920_202642_pre_wq2073 \
   /home/lumen/agent/litellm_config.yaml
docker compose --project-directory /home/lumen/docker restart litellm
```

`apply.sh` does this itself if the proxy does not return 200 within 300s of the
restart.
