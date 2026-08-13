# Phase 6 Company Node Eviction Design

## Purpose

Phase 6 adds tested local runbooks for temporarily evicting Jarvis from a company Windows node, restoring it later, or permanently offboarding it. It does not add a web deletion button and it never operates on the current personal PC during development. All drills use disposable canary directories, databases, tokens, and startup tasks.

## Scope

The first implementation provides:

- a shared production startup guard that refuses to start when an `EVICTED` marker exists;
- PowerShell entry points for `prepare`, `complete`, `restore`, and `offboard`;
- a small Node helper that uses SQLite's backup API and emits a manifest with checksums;
- fail-closed path validation and exact node-name confirmation;
- external 7-Zip AES-256 packaging when 7-Zip is available;
- synthetic drills for prepare, abort, complete, marker blocking, restore, and offboarding.

Real iCloud sign-out, credential revocation, Tailscale changes, Windows Scheduled Task changes, process termination, or deletion require a later explicit real-node invocation and are never part of automated tests.

## Architecture

### PowerShell orchestrator

`scripts/company-node-eviction.ps1` is the human-facing controller. It accepts an explicit operation, node name, control directory, database path, brain path, recovery destination, and a `-CanaryRoot` for drills. It prints all resolved targets before mutation and requires a confirmation phrase containing the node name.

The orchestrator imports a small module containing pure path and confirmation checks. All destructive targets must resolve beneath an explicit allowed company-node root or beneath the disposable canary root. Drive roots, user-profile roots, repository roots, unresolved variables, wildcards, symlinks escaping the allowed root, and active synced brain directories are rejected.

`prepare` pauses dispatch through a local maintenance marker, checkpoints and backs up SQLite, writes recovery metadata, invokes 7-Zip AES-256 without storing the password, verifies the archive checksum, creates `EVICTED`, and reports the manual iCloud boundary. It stops before any local-content deletion.

`complete` requires the prepared manifest, the `EVICTED` marker, a separately supplied confirmation that iCloud sign-out and independent backup verification occurred, and the exact confirmation phrase. It removes only manifest-listed company-local targets.

`restore` stages and validates a recovery archive, restores the database and non-secret settings, leaves credential regeneration and external-service authentication as explicit manual steps, and removes `EVICTED` only after a supplied health-check command succeeds.

`offboard` reuses completed eviction and produces a checklist/report for remote revocations. It does not pretend that local code can prove remote credential revocation or SSD erasure.

### SQLite backup helper

`scripts/lib/sqlite-recovery.js` opens the source database with the repository's existing Node 22 and `better-sqlite3` runtime, checkpoints WAL, uses `db.backup()` to create a consistent copy, validates the copy, and writes SHA-256 metadata. It never copies active database/WAL/SHM files directly.

### Startup guard

`server/lib/eviction-guard.js` resolves the configured control directory and checks for `EVICTED`. Production startup calls it before the database, scheduler, providers, or HTTP listener initialise. Development and tests use explicit temporary control directories; they do not inspect or create a real marker by default.

## External tools

7-Zip is the preferred existing standard tool because it provides AES-256 archives without custom cryptography. The script detects `7z.exe` in `PATH` and common installation locations. If unavailable, prepare stops before creating a supposedly secure recovery archive and prints installation guidance. Phase 6 does not silently install software.

## Security and failure behaviour

- No PIN, archive password, token, session, or provider credential is logged or written to manifests.
- Archive passwords are supplied interactively or through a process-scoped secure parameter; they are never command-history defaults or files.
- Every mutation is idempotent or stops with a clear existing-state message.
- The `EVICTED` marker is created before services are considered safe to stop and is removed last during restore.
- Missing tools, failed checksums, failed database validation, ambiguous paths, incomplete manifests, or failed health checks stop the workflow.
- Cleanup never uses a broad recursive target and never deletes an actively synced `JarvisNotes` tree.

## Verification strategy

Fast verification focuses on catastrophic boundaries rather than exhaustive combinations:

1. Unit tests cover confirmation parsing, allowed-root containment, root/wildcard rejection, symlink escape, manifest-only deletion, and startup refusal.
2. One disposable integration drill creates a canary SQLite database and fake local data, runs prepare, proves abort is recoverable, runs complete, proves the marker blocks startup, restores, and verifies canary/database hashes.
3. One disposable offboarding drill proves old synthetic tokens/config are removed and unrelated sibling files survive.
4. Focused server tests, PowerShell/Pester tests when Pester is available, build/typecheck, and `git diff --check` form the final gate. The full unrelated UI suite is not rerun unless shared client code changes.

## Phase 5 follow-ups

The same branch adds the missing locked-sensitive `runBriefing()` persistence regression. MCP audit findings are assessed separately; only demonstrably non-breaking lockfile updates are eligible, and no forced major upgrade is allowed merely to make the audit count zero.

## Completion boundary

Phase 6 is implementation-complete when all disposable drills pass, production startup is blocked by the marker, recovery artifacts contain no secrets, and the scripts cannot address paths outside their explicit allowed root. Enrolling or evicting a real company PC remains a later user-approved action.
