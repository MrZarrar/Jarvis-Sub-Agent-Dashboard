# Task 8 report: selective Brain lock evidence

## Status

Added a non-destructive correction to the historical Phase 5 evidence and a new current-scope evidence document. Automated gates and security regressions are recorded from fresh runs. Live Playwright verification is explicitly left pending for the controller.

## Verification

- Server: 924/924 passed, 254 suites.
- Client: 311/311 passed, 34 files.
- Client build: passed, 2,478 modules transformed.
- MCP: 134/134 passed, 29 suites.
- MCP typecheck: passed.
- Targeted security matrix: 141/141 passed, 53 suites.
- Placeholder scan: only intentional TODO parser/demo/test/schema/plan matches.
- `git diff --check`: passed.

The initial MCP run failed because `mcp/node_modules` was absent. Installing the committed lockfile with `npm.cmd --prefix mcp ci --ignore-scripts` restored the required tools. A parallel retry then hit transient Windows `uv_os_get_passwd` `ENOMEM`; the required MCP test command passed serially. Installation reported 9 dependency audit findings; no dependency or lockfile changes were made.

## Scope and concerns

The evidence names `0c1b25e`, the 2026-08-10 scope correction, and the plaintext-not-encryption limitation. No browser checks are claimed, no real PIN/vault/secrets were used, and nothing was pushed. Controller Playwright evidence remains pending.

The minor ledger was triaged: quoted-string true coverage was added; unlocked Vault relationships were already covered; direct `runBriefing()` persistence-wrapper hardening remains deferred.
