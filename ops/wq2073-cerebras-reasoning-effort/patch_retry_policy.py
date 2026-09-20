#!/usr/bin/env python3
"""wq#2073 — stop a client-side 400 from being amplified onto a free local rung.

A provider's request-validator 400 (`CerebrasException - reasoning_effort: Input
should be 'none', 'low', 'medium' or 'high'`) says the CALLER sent something the
model cannot accept. Retrying it can never succeed: the same bad value goes back
out three more times, and each attempt drags the `cerebras-oss-120b ->
qwen36-local` fallback edge along with it onto isis. That is the amplifier
behind wq#2068's 2,786 dead-end hops in 24h.

`num_retries`/`allowed_fails` budgets exist for transient faults. This pins the
non-transient error classes to zero retries, which the installed build supports
(`RetryPolicy` fields verified in retry_policy_evidence.txt:6, `Router.__init__`
accepts `retry_policy`, line 12).

Line-based insertion on purpose: the config is 409 lines of load-bearing
comments and a yaml round-trip would erase them.
"""
import sys
import yaml

PATH = sys.argv[1]
BLOCK = [
    "  # wq#2073: a 400 from the provider's request validator is a CLIENT bug --\n",
    "  # a bad param value -- not a rung that is down. Retrying it sends the same\n",
    "  # rejected value out num_retries more times, and every attempt drags this\n",
    "  # group's fallback edge onto a free local rung with it. That is how one\n",
    "  # caller's reasoning_effort=disable became 2,786 dead-end hops onto isis\n",
    "  # in 24h (wq#2068 cascade; evidence in the pokemon repo at\n",
    "  # ops/wq2073-cerebras-reasoning-effort/). Retry budgets are for transient\n",
    "  # faults only; these two classes are deterministic.\n",
    "  retry_policy:\n",
    "    BadRequestErrorRetries: 0\n",
    "    AuthenticationErrorRetries: 0\n",
]

with open(PATH) as f:
    lines = f.readlines()

if any(l.startswith("  retry_policy:") for l in lines):
    print("ALREADY_PRESENT")
    sys.exit(0)

try:
    anchor = next(i for i, l in enumerate(lines) if l.rstrip("\n") == "router_settings:")
except StopIteration:
    print("FAIL no router_settings: block")
    sys.exit(1)

patched = lines[: anchor + 1] + BLOCK + lines[anchor + 1 :]

doc = yaml.safe_load("".join(patched))
rp = doc.get("router_settings", {}).get("retry_policy")
if rp != {"BadRequestErrorRetries": 0, "AuthenticationErrorRetries": 0}:
    print(f"FAIL retry_policy did not parse as expected: {rp!r}")
    sys.exit(1)

# The rest of the config must be byte-identical to what was there before.
before = yaml.safe_load("".join(lines))
after = dict(doc)
after["router_settings"] = {k: v for k, v in doc["router_settings"].items() if k != "retry_policy"}
if before != after:
    print("FAIL patch changed something other than router_settings.retry_policy")
    sys.exit(1)

with open(PATH, "w") as f:
    f.writelines(patched)
print(f"PATCHED {PATH} at line {anchor + 2}")
