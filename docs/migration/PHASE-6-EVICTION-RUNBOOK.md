# Phase 6: Company Node Eviction

This runbook prepares a verified local recovery archive, blocks Jarvis startup, removes only explicitly listed company-local files after a manual boundary, and restores the SQLite database after verification. It does not sign out of iCloud, modify Tailscale, revoke credentials, stop processes, alter Scheduled Tasks, or prove disk erasure.

## Start with the disposable drill

Run this before using any real-node values:

```powershell
npm.cmd run phase6:drill
```

The drill creates and removes fixtures only beneath uniquely named Windows temporary directories. Its link-escape regression points a temporary junction at the existing repository without creating, changing, or deleting anything through that link. The synthetic archiver is not encrypted and is accepted only when every supplied path resolves beneath a verifiably disposable temporary root. Supplying `-CanaryRoot` to a real path cannot enable it. A passing drill proves the local path, manifest, marker, and restore gates; it does not exercise external services.

## Real-node prerequisites

1. Stop Jarvis and prevent concurrent database writes manually. The script does not terminate processes or Scheduled Tasks.
2. Choose one explicit company-node root that contains the database, recovery area, and every deletion target. The protected brain may and normally will be outside it. Never use a drive root, user-profile root, repository root, wildcard, or environment-variable expression.
3. Configure `JARVIS_CONTROL_DIR` in the same environment or `.env` used by standalone and desktop Jarvis. `ControlDir` must resolve to that exact directory. If it is omitted from the environment, the workflow requires the guard default `%LOCALAPPDATA%\Jarvis\control`.
4. Identify the exact SQLite database, recovery destination, local credential/config files, and active synced brain path. `BrainPath` is read only for overlap protection and is never a deletion target.
5. Put the recovery destination on storage that will remain available after iCloud sign-out.
6. Install 7-Zip if you intend to evaluate manual secure packaging. Phase 6 does not install it.

7-Zip is absent on the development PC as of 2026-08-13. Install it manually before a real run. The documented CLI password switch places the password in a process argument, so the script never invokes password-bearing archive commands. Encryption and decryption use the 7-Zip GUI as explicit operator boundaries.

## Set reviewed values

Use values reviewed for the specific company node. Do not paste secrets into the command line or save them in this file.

```powershell
$node = 'COMPANY-NODE-NAME'
$allowed = 'C:\ExplicitCompanyJarvisRoot'
$env:JARVIS_CONTROL_DIR = 'C:\ExplicitCompanyJarvisRoot\control'
$control = $env:JARVIS_CONTROL_DIR
$database = 'C:\ExplicitCompanyJarvisRoot\data\jarvis.db'
$brain = "$env:USERPROFILE\JarvisNotes" # or the canonical Obsidian iCloud vault path
$recovery = 'C:\ExplicitCompanyJarvisRoot\recovery'
$deleteOnly = @(
  'C:\ExplicitCompanyJarvisRoot\local\provider.token',
  'C:\ExplicitCompanyJarvisRoot\local\company.json'
)
$common = @{
  NodeName = $node
  AllowedRoot = $allowed
  ControlDir = $control
  DatabasePath = $database
  BrainPath = $brain
  RecoveryRoot = $recovery
  Confirmation = "EVICT $node"
  DeletionTarget = $deleteOnly
}
```

No archive password parameter exists. The workflow will not put a secret on a child-process command line, write it to a manifest, or log it.

## Prepare

```powershell
& .\scripts\company-node-eviction.ps1 -Operation prepare @common
```

`prepare` validates every path, creates a WAL-safe SQLite recovery with `VACUUM INTO`, validates its integrity, and writes the following explicit plaintext handoff directory:

```text
<RecoveryRoot>\<NodeName>.plaintext-package\
  HANDOFF.json
  recovery.manifest.json
  recovery.sqlite
```

At this point there is no operation manifest, no `MAINTENANCE`, no `EVICTED`, and no deletion authorization. The plaintext package remains intentionally available for the GUI step; protect it as sensitive local data.

## Encrypt and seal

1. In the 7-Zip GUI, add the three package files to a new `.7z` archive on trusted personal/removable storage outside and non-overlapping the company root, control/recovery/package paths, database, brain, and every deletion target.
2. Select AES-256 and encrypt file names. Enter the password only in the GUI.
3. Independently extract that archive into a different directory and confirm the three files are present. Keep that decrypted verification directory for restore testing or securely remove it later according to your storage policy.
4. Record the encrypted archive with `seal`:

```powershell
$archive = 'D:\PersonalRecovery\COMPANY-NODE-NAME.encrypted.7z'
& .\scripts\company-node-eviction.ps1 -Operation seal @common `
  -ArchivePath $archive -ArchiveIndependentlyVerified
```

`seal` revalidates the plaintext package, requires the explicit independent-extraction confirmation, binds the handoff deletion list to the freshly supplied canonical deletion list, canonicalises and hashes the encrypted archive, records its path/hash and deletion list, then creates `MAINTENANCE` and `EVICTED`. It never reads, logs, or receives the password. The archive must be outside and non-overlapping every protected or mutable path; it is read only and cannot be a deletion target.

> Manually verify the encrypted archive from independent storage, confirm the iPhone/Mac brain remains available, and sign the company Windows node out of iCloud without choosing any option that deletes the authoritative brain elsewhere.

Do not run `complete` until both archive verification and the iCloud boundary are complete. The workflow does not automatically delete the plaintext handoff or independently decrypted package. They may be on personal storage outside company mutation roots; remove them manually only after deciding which recovery copy to retain.

## Complete local eviction

After the manual iCloud boundary:

```powershell
& .\scripts\company-node-eviction.ps1 -Operation complete @common -ManualBoundaryConfirmed
```

`complete` first requires the sealed encrypted archive to still exist and match its recorded checksum, then removes only the manifest's literal `deletionTargets`. It refuses any target overlapping the control directory, recovery directory/plaintext package, database, brain, encrypted archive, broad targets, or link targets that escape the allowed roots. These protections are reapplied to the stored manifest before deletion. Unlisted files remain. `EVICTED` remains present, so standalone and desktop startup stay blocked.

## Restore

Use the 7-Zip GUI to decrypt the sealed archive into a directory on trusted personal/removable storage outside and non-overlapping every protected or mutable path. The script receives only that directory path, never a password. The original encrypted archive does not need to remain mounted at its recorded path for restore.

First recreate the local company-node root and stop anything that could open the database. Restore refuses to proceed while either `<database>-wal` or `<database>-shm` exists; investigate and quiesce the prior writer rather than discarding sidecars blindly. Supply an offline check that inspects only the restored database/files. It must not start, adopt, or query Jarvis because `EVICTED` still blocks startup during the callback.

```powershell
$offlineCheck = { & node .\scripts\approved-offline-database-check.js }
$decryptedPackage = 'D:\PersonalRecovery\decrypted-COMPANY-NODE-NAME'
& .\scripts\company-node-eviction.ps1 -Operation restore @common `
  -DecryptedPackagePath $decryptedPackage -HealthCheckCommand $offlineCheck
```

Restore canonicalises the operator-decrypted package outside every protected or mutable path, requires the inner manifest identity to match `HANDOFF.json`, copies `recovery.sqlite` to a destination-side temporary file, and validates that exact stable copy's checksum and SQLite integrity before replacing the database. It does not modify the external package. It rejects stale SQLite sidecars and runs the supplied offline check while `EVICTED` still exists. A failed check leaves `EVICTED` in place. On success it removes `MAINTENANCE` and removes `EVICTED` last. Only then may Jarvis be started for an online health check.

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
- Treat both plaintext package directories as sensitive and clean them manually only after recovery retention is decided.
- Never delete or edit the active synced `JarvisNotes` tree through this workflow.
- Never remove `EVICTED` by hand to bypass a failed restore.
- Never add broad directories to `DeletionTarget`; list exact company-local files or narrowly scoped directories.
- Treat archive/checksum, SQLite integrity, manual-boundary, and health-check failures as hard stops.
