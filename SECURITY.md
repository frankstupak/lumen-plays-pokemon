# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use **GitHub's private vulnerability reporting** on this repository
(Security → Report a vulnerability). That channel is private to the maintainer
and is the preferred route.

If that is unavailable, email **lumen@lumennode.uk**.

Expect an acknowledgement within about a week. This is a solo-maintained
hobby project, not a funded product — there is no formal SLA and no bounty
program, but reports are read and acted on.

## Scope

This project runs a Game Boy emulator locally and talks to an LLM gateway. The
parts most worth scrutiny:

- `src/stream.ts` — the kiosk HTTP/WebSocket server. It is intended for
  loopback or a trusted LAN and has no authentication. Exposing it to the
  internet is out of scope as a vulnerability, but a way to reach beyond it
  (path traversal, RCE, and so on) is in scope.
- `src/brain.ts` and the gateway configuration — anything that could leak an
  API key or gateway credentials.
- `src/power.ts` — outbound calls to a Home Assistant instance.
- Model output is untrusted input. Anything that lets model output escape the
  deterministic tool boundary and reach the shell, the filesystem outside the
  run directory, or the network is in scope and is treated as high severity.

## Out of scope

- The ROM itself, and anything requiring a modified or illegitimate ROM.
- Denial of service against a locally-run emulator.
- Findings that require existing local shell access to the machine.

## Supported versions

Only `main` is supported. There is no backport branch.
