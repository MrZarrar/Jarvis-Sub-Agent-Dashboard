# Phase 6 Company Node Eviction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed company-node eviction, restore, and offboarding workflow that is proven only against disposable canary data.

**Architecture:** A dependency-free startup guard blocks standalone and desktop startup before database access. A Node recovery helper creates and verifies WAL-safe SQLite snapshots and manifests. A PowerShell orchestrator validates explicit roots and confirmations, drives prepare/complete/restore/offboard, and is exercised by one disposable integration drill.

**Tech Stack:** Node.js CommonJS, built-in filesystem/crypto APIs, repository SQLite compatibility layer, PowerShell 5.1-compatible scripts, Node test runner, TypeScript desktop build.

**Spec:** `docs/superpowers/specs/2026-08-13-phase-6-company-node-eviction-design.md`

## Global Constraints

- Automated work may mutate only an explicit disposable canary root.
- Never use a drive root, user-profile root, repository root, wildcard, unresolved variable, or active `JarvisNotes` directory as a recursive target.
- No real iCloud, Tailscale, browser profile, credential, process, or Scheduled Task mutation.
- The marker is created after verified recovery and removed last after restore validation.
- Do not log or persist PINs, archive passwords, session tokens, or provider credentials.
- Missing 7-Zip stops real encrypted preparation with guidance; tests use a synthetic archiver executable.

---

### Task 1: Fail-closed startup marker

**Files:**
- Create: `server/lib/eviction-guard.js`
- Create: `server/__tests__/eviction-guard.test.js`
- Modify: `server/index.js`
- Modify: `desktop/src/server-host.ts`

**Interfaces:**
- Produces: `resolveControlDir(env = process.env): string`, `assertNodeNotEvicted(options?): void`.
- Consumes: `JARVIS_CONTROL_DIR`; production default `%LOCALAPPDATA%/Jarvis/control` on Windows and `~/.jarvis/control` elsewhere.

- [ ] **Step 1: Write failing guard tests**

```js
test("throws before startup when EVICTED exists", () => {
  fs.writeFileSync(path.join(controlDir, "EVICTED"), "company-core\n");
  assert.throws(() => assertNodeNotEvicted({ controlDir }), /EVICTED/);
});

test("allows startup without the marker", () => {
  assert.doesNotThrow(() => assertNodeNotEvicted({ controlDir }));
});
```

- [ ] **Step 2: Run RED**

Run: `node --test server/__tests__/eviction-guard.test.js`
Expected: FAIL because `eviction-guard.js` does not exist.

- [ ] **Step 3: Implement the pure guard and wire startup before imports/adoption**

```js
function assertNodeNotEvicted({ controlDir = resolveControlDir(), fsImpl = fs } = {}) {
  const marker = path.join(controlDir, "EVICTED");
  if (fsImpl.existsSync(marker)) {
    const error = new Error(`Jarvis startup refused: EVICTED marker exists at ${marker}`);
    error.code = "JARVIS_NODE_EVICTED";
    throw error;
  }
}
```

Call it in `server/index.js` immediately after `.env` loading and before Express/router imports. In desktop, resolve the same marker before the preferred-port probe and throw before adopting an existing server.

- [ ] **Step 4: Run GREEN and desktop typecheck/build**

Run: `node --test server/__tests__/eviction-guard.test.js`
Run: `npm.cmd --prefix desktop run build`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```powershell
git add server/lib/eviction-guard.js server/__tests__/eviction-guard.test.js server/index.js desktop/src/server-host.ts
git commit -m "feat: block startup on company eviction marker"
```

### Task 2: Consistent SQLite recovery helper

**Files:**
- Create: `scripts/lib/sqlite-recovery.js`
- Create: `server/__tests__/sqlite-recovery.test.js`

**Interfaces:**
- Produces: `createRecovery({ dbPath, outputDir, nodeName, now? }): RecoveryManifest` and `verifyRecovery(manifestPath): RecoveryManifest`.
- Manifest fields: `schemaVersion`, `nodeName`, `createdAt`, `sourceDatabase`, `backupDatabase`, `backupSha256`, `integrityCheck`.

- [ ] **Step 1: Write failing recovery tests**

```js
test("creates a validated single-file recovery from a WAL database", () => {
  const manifest = createRecovery({ dbPath, outputDir, nodeName: "canary-core" });
  assert.equal(manifest.integrityCheck, "ok");
  assert.equal(sha256(manifest.backupDatabase), manifest.backupSha256);
  assert.deepEqual(readRows(manifest.backupDatabase), [{ value: "survives" }]);
});
```

Add rejection tests for an existing destination and a missing source database.

- [ ] **Step 2: Run RED**

Run: `node --test server/__tests__/sqlite-recovery.test.js`
Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement minimal backup, validation, checksum, and manifest**

Use the same database backend fallback as `scripts/clear-data.js`. Checkpoint WAL, run escaped `VACUUM INTO`, open the backup read-only, require `PRAGMA integrity_check` to return `ok`, then atomically write JSON metadata. Never include environment variables or secrets.

- [ ] **Step 4: Run GREEN**

Run: `node --test server/__tests__/sqlite-recovery.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add scripts/lib/sqlite-recovery.js server/__tests__/sqlite-recovery.test.js
git commit -m "feat: create verified SQLite recovery packages"
```

### Task 3: Canary-only eviction orchestrator and drill

**Files:**
- Create: `scripts/lib/CompanyNodeEviction.psm1`
- Create: `scripts/company-node-eviction.ps1`
- Create: `scripts/__tests__/company-node-eviction-canary.ps1`
- Create: `docs/migration/PHASE-6-EVICTION-RUNBOOK.md`
- Modify: `package.json`

**Interfaces:**
- PowerShell operations: `prepare`, `complete`, `restore`, `offboard`.
- Required parameters: `-Operation`, `-NodeName`, `-AllowedRoot`, `-ControlDir`, `-DatabasePath`, `-BrainPath`, `-RecoveryRoot`.
- Mutating drill additionally requires `-CanaryRoot` and exact `-Confirmation "EVICT <NodeName>"`.
- `complete` requires `-ManualBoundaryConfirmed`; `restore` requires a successful `-HealthCheckCommand` before marker removal.

- [ ] **Step 1: Write the failing disposable drill**

The drill creates sibling `allowed` and `unrelated` directories, a canary database, fake config/token files, a fake JarvisNotes path, and a synthetic 7-Zip command. It asserts:

```powershell
Invoke-Fails { & $script -Operation prepare -AllowedRoot 'C:\' } 'broad root'
Invoke-Fails { & $script -Operation prepare -Confirmation 'wrong' } 'confirmation'
Invoke-Succeeds { & $script -Operation prepare @validCanary }
Assert-Exists "$control\EVICTED"
Assert-Exists $encryptedArchive
Invoke-Succeeds { & $script -Operation complete @validCanary -ManualBoundaryConfirmed }
Assert-NotExists $manifestListedToken
Assert-Exists $unrelatedSibling
Invoke-Succeeds { & $script -Operation restore @validCanary -HealthCheckCommand $healthCheck }
Assert-NotExists "$control\EVICTED"
Assert-DatabaseCanary $restoredDb 'survives'
```

The offboard subcase proves only manifest-listed synthetic credentials disappear and emits a remote-revocation checklist without claiming remote erasure.

- [ ] **Step 2: Run RED**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/__tests__/company-node-eviction-canary.ps1`
Expected: FAIL because the module/orchestrator does not exist.

- [ ] **Step 3: Implement validation and operations**

`Resolve-SafeTarget` resolves full paths and link targets, requires containment under `AllowedRoot` or `CanaryRoot`, rejects roots/wildcards/JarvisNotes deletion, and returns a literal path. `prepare` invokes the Node recovery helper, requires the synthetic or real archiver to exit 0, hashes the archive, writes the explicit deletion manifest, creates maintenance and eviction markers, then stops at the manual boundary. `complete` deletes only manifest entries. `restore` validates/extracts recovery, restores the database, runs the health command, and removes the marker last. `offboard` calls complete semantics and writes the checklist/report.

- [ ] **Step 4: Run GREEN and focused safety matrix**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/__tests__/company-node-eviction-canary.ps1`
Run: `node --test server/__tests__/eviction-guard.test.js server/__tests__/sqlite-recovery.test.js server/__tests__/briefings.test.js`
Run: `npm.cmd --prefix desktop run build`
Run: `npm.cmd run test:mcp && npm.cmd run mcp:typecheck && npm.cmd --prefix mcp audit --audit-level=low`
Run: `git diff --check`
Expected: all exit 0; MCP audit reports 0 vulnerabilities.

- [ ] **Step 5: Write the runbook and commit**

Document the disposable drill, real-node prerequisites, exact manual iCloud boundary, 7-Zip absence behavior, restore sequence, lost-node remote-revocation checklist, and the statement that source code cannot prove SSD erasure.

```powershell
git add scripts/lib/CompanyNodeEviction.psm1 scripts/company-node-eviction.ps1 scripts/__tests__/company-node-eviction-canary.ps1 docs/migration/PHASE-6-EVICTION-RUNBOOK.md package.json
git commit -m "feat: add company node eviction runbook"
```
