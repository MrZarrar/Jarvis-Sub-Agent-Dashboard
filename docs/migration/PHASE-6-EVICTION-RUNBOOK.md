# Phase 6: Company Node Eviction

This runbook prepares a verified local recovery archive, blocks Jarvis startup, removes only explicitly listed company-local files after a manual boundary, and restores the SQLite database after verification. It does not sign out of iCloud, modify Tailscale, revoke credentials, stop processes, alter Scheduled Tasks, or prove disk erasure.

## Start with the disposable drill

Run this before using any real-node values:

```powershell
npm.cmd run phase6:drill
```

The drill creates and removes only a uniquely named `jarvis-eviction-canary-<uuid>` directory beneath the Windows temporary directory. Its synthetic archiver is not encrypted and is accepted only when every supplied path resolves beneath that verifiably disposable root. Supplying `-CanaryRoot` to a real path cannot enable it. A passing drill proves the local path, manifest, marker, and restore gates; it does not exercise external services.

## Real-node prerequisites

1. Stop Jarvis and prevent concurrent database writes manually. The script does not terminate processes or Scheduled Tasks.
2. Choose one explicit company-node root that contains every local target. Never use a drive root, user-profile root, repository root, wildcard, environment-variable expression, or active iCloud `JarvisNotes` path.
3. Identify the exact SQLite database, control directory, recovery destination, local credential/config files, and synced brain path.
4. Put the recovery destination on storage that will remain available after iCloud sign-out.
5. Install 7-Zip and ensure `7z.exe` is in `PATH`, or pass its exact path. Phase 6 does not install it.

7-Zip is absent on the development PC as of 2026-08-13. A real `prepare` therefore stops with installation guidance before creating `EVICTED`; it never calls an unencrypted fallback or claims a recovery exists.

## Set reviewed values

Use values reviewed for the specific company node. Do not paste secrets into the command line or save them in this file.

```powershell
$node = 'COMPANY-NODE-NAME'
$allowed = 'C:\ExplicitCompanyJarvisRoot'
$control = 'C:\ExplicitCompanyJarvisRoot\control'
$database = 'C:\ExplicitCompanyJarvisRoot\data\jarvis.db'
$brain = 'C:\ExplicitCompanyJarvisRoot\JarvisNotes'
$recovery = 'C:\ExplicitCompanyJarvisRoot\recovery'
$deleteOnly = @(
  'C:\ExplicitCompanyJarvisRoot\local\provider.token',
  'C:\ExplicitCompanyJarvisRoot\local\company.json'
)
$password = Read-Host 'New recovery archive password' -AsSecureString
$common = @{
  NodeName = $node
  AllowedRoot = $allowed
  ControlDir = $control
  DatabasePath = $database
  BrainPath = $brain
  RecoveryRoot = $recovery
  Confirmation = "EVICT $node"
  DeletionTarget = $deleteOnly
  ArchivePassword = $password
}
```

The password is held only in the current PowerShell process. It is not written to either manifest or printed. Do not provide it as plain command text.

## Prepare

```powershell
& .\scripts\company-node-eviction.ps1 -Operation prepare @common
```

`prepare` validates every path, creates a WAL-safe SQLite recovery with `VACUUM INTO`, validates its integrity, packages it with 7-Zip AES-256 and header encryption, hashes the archive, writes the explicit deletion manifest, then creates `MAINTENANCE` and `EVICTED`. It stops at the following boundary:

> Manually verify the encrypted archive from independent storage, confirm the iPhone/Mac brain remains available, and sign the company Windows node out of iCloud without choosing any option that deletes the authoritative brain elsewhere.

Do not continue until that boundary is independently verified. If `prepare` fails, keep the source database and local files intact and resolve the reported issue.

After `prepare` succeeds, copy the encrypted `.7z` archive to independent storage and verify its checksum there before crossing the manual boundary. The workflow removes its temporary plaintext SQLite recovery after the archive is verified.

## Complete local eviction

After the manual iCloud boundary:

```powershell
& .\scripts\company-node-eviction.ps1 -Operation complete @common -ManualBoundaryConfirmed
```

`complete` first requires the recovery archive to exist and match the checksum recorded by `prepare`, then removes only the manifest's literal `deletionTargets`. It refuses any target overlapping the control directory, recovery directory/archive, database, brain, broad targets, or link targets that escape the allowed roots. These protections are reapplied to the stored manifest before deletion. Unlisted files remain. `EVICTED` remains present, so standalone and desktop startup stay blocked.

## Restore

First recreate the local company-node root and stop anything that could open the database. Supply a real health check that returns success only after the restored Jarvis instance is ready. For example, define a script block that runs the approved local health command and returns `$false` or a non-zero exit code on failure.

```powershell
$health = { & node .\scripts\approved-local-health-check.js }
& .\scripts\company-node-eviction.ps1 -Operation restore @common -HealthCheckCommand $health
```

Restore verifies the archive checksum, extracts it with 7-Zip, verifies the packaged SQLite manifest and integrity, replaces the database from the validated snapshot, and runs the supplied health check. A failed health check leaves `EVICTED` in place. On success it removes `MAINTENANCE` and removes `EVICTED` last.

Provider credentials, GitHub sessions, iCloud authentication, Tailscale enrollment, and Scheduled Tasks must be recreated manually after local validation.

## Permanent offboard or lost node

For a reachable node that was prepared, use:

```powershell
& .\scripts\company-node-eviction.ps1 -Operation offboard @common -ManualBoundaryConfirmed
```

This reuses manifest-only cleanup and writes `REMOTE-REVOCATION-CHECKLIST.md` in the control directory. Complete each remote step in the relevant service console:

- revoke Tailscale access;
- revoke provider and GitHub sessions;
- rotate or delete company-node credentials;
- remove the device from remote administration;
- follow the employer's approved device-return or secure-erasure procedure.

For a lost or unreachable node, local scripts cannot run. Perform the same remote revocations directly and rotate exposed credentials. Neither this source code nor its checklist can prove remote revocation, SSD erasure, iCloud deletion, or physical-device sanitisation.

## Recovery rules

- Preserve the encrypted archive and its password separately.
- Never delete or edit the active synced `JarvisNotes` tree through this workflow.
- Never remove `EVICTED` by hand to bypass a failed restore.
- Never add broad directories to `DeletionTarget`; list exact company-local files or narrowly scoped directories.
- Treat archive/checksum, SQLite integrity, manual-boundary, and health-check failures as hard stops.
