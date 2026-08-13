[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('prepare', 'seal', 'complete', 'restore', 'offboard')][string]$Operation,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$NodeName,
    [Parameter(Mandatory = $true)][string]$AllowedRoot,
    [Parameter(Mandatory = $true)][string]$ControlDir,
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$BrainPath,
    [Parameter(Mandatory = $true)][string]$RecoveryRoot,
    [string]$CanaryRoot,
    [Parameter(Mandatory = $true)][string]$Confirmation,
    [string[]]$DeletionTarget = @(),
    [string]$ArchivePath,
    [switch]$ArchiveIndependentlyVerified,
    [string]$DecryptedPackagePath,
    [switch]$ManualBoundaryConfirmed,
    [scriptblock]$HealthCheckCommand
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'lib\CompanyNodeEviction.psm1') -Force

$control = Resolve-SafeTarget -Path $ControlDir -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'ControlDir'
$database = Resolve-SafeTarget -Path $DatabasePath -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'DatabasePath'
$brain = Get-CanonicalPath $BrainPath
$recovery = Resolve-SafeTarget -Path $RecoveryRoot -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'RecoveryRoot'
$guardControl = Resolve-GuardControlDir
if ($control -cne $guardControl) { throw "ControlDir must equal the guard-resolved control directory: $guardControl" }
Assert-EvictionConfirmation -NodeName $NodeName -Confirmation $Confirmation

$evictedMarker = Join-Path $control 'EVICTED'
$maintenanceMarker = Join-Path $control 'MAINTENANCE'
$operationManifestPath = Join-Path $control 'eviction-manifest.json'
$packagePath = Join-Path $recovery "$NodeName.plaintext-package"
$recoveryHelper = Join-Path $PSScriptRoot 'lib\sqlite-recovery.js'

Write-Host "Operation: $Operation"
Write-Host "Node: $NodeName"
Write-Host "Control: $control"
Write-Host "Database: $database"
Write-Host "Brain (never deleted): $brain"
Write-Host "Recovery: $recovery"

function Invoke-NodeJson {
    param([Parameter(Mandatory = $true)][ValidateSet('create', 'verify')][string]$Action, [string]$ManifestPath)
    if ($Action -eq 'create') {
        $code = 'const h=require(process.argv[2]);const m=h.createRecovery({dbPath:process.argv[3],outputDir:process.argv[4],nodeName:process.argv[5]});process.stdout.write(JSON.stringify(m));'
        $argsForNode = @($recoveryHelper, $database, $recovery, $NodeName)
    } else {
        $code = 'const h=require(process.argv[2]);const m=h.verifyRecovery(process.argv[3]);process.stdout.write(JSON.stringify(m));'
        $argsForNode = @($recoveryHelper, $ManifestPath)
    }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
    $output = & node -e 'eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())' $encoded @argsForNode
    if ($LASTEXITCODE -ne 0) { throw "SQLite recovery $Action failed" }
    return ($output | Out-String | ConvertFrom-Json)
}

function Require-SealedState {
    param([switch]$RequireArchive)
    if (-not (Test-Path -LiteralPath $evictedMarker -PathType Leaf)) { throw "EVICTED marker is missing: $evictedMarker" }
    $prepared = Read-EvictionManifest -Path $operationManifestPath -NodeName $NodeName
    $safeArchive = Get-CanonicalPath ([string]$prepared.archivePath)
    if ($RequireArchive) {
        if (-not (Test-Path -LiteralPath $safeArchive -PathType Leaf)) { throw "Recovery archive is missing: $safeArchive" }
        if ((Get-FileSha256 $safeArchive) -cne ([string]$prepared.archiveSha256).ToLowerInvariant()) { throw "Recovery archive checksum mismatch: $safeArchive" }
    }
    return $prepared
}

function Read-RecoveryPackage {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$StableDatabasePath)
    $package = Get-CanonicalPath $Path
    if (-not (Test-Path -LiteralPath $package -PathType Container)) { throw "Decrypted recovery package is missing: $package" }
    $handoffPath = Join-Path $package 'HANDOFF.json'
    $innerManifestPath = Join-Path $package 'recovery.manifest.json'
    $innerDatabase = Join-Path $package 'recovery.sqlite'
    if (-not (Test-Path -LiteralPath $handoffPath -PathType Leaf) -or -not (Test-Path -LiteralPath $innerManifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $innerDatabase -PathType Leaf)) {
        throw "Decrypted recovery package is incomplete: $package"
    }
    $handoff = Get-Content -Raw -LiteralPath $handoffPath | ConvertFrom-Json
    if ($handoff.schemaVersion -ne 1 -or $handoff.nodeName -cne $NodeName) { throw "Recovery handoff is invalid for node $NodeName" }
    $metadata = Get-Content -Raw -LiteralPath $innerManifestPath | ConvertFrom-Json
    if (-not $metadata.PSObject.Properties['nodeName'] -or
        -not $metadata.PSObject.Properties['createdAt'] -or
        $metadata.nodeName -cne $handoff.nodeName -or
        $metadata.createdAt -cne $handoff.createdAt) {
        throw 'Recovery manifest identity does not match HANDOFF'
    }
    $verificationDatabase = $innerDatabase
    if ($StableDatabasePath) {
        $verificationDatabase = Get-CanonicalPath $StableDatabasePath
        Copy-Item -LiteralPath $innerDatabase -Destination $verificationDatabase -Force
    }
    $metadata.backupDatabase = $verificationDatabase
    $temporaryManifest = Join-Path $control ".verify-$PID.manifest.json"
    try {
        Write-JsonAtomic -Path $temporaryManifest -Value $metadata
        Invoke-NodeJson -Action verify -ManifestPath $temporaryManifest | Out-Null
    }
    finally {
        if (Test-Path -LiteralPath $temporaryManifest) { Remove-Item -LiteralPath $temporaryManifest -Force }
    }
    return @{ PackagePath = $package; DatabasePath = $verificationDatabase; Handoff = $handoff; RecoverySha256 = ([string]$metadata.backupSha256).ToLowerInvariant() }
}

function Test-PathOverlap {
    param([string]$Left, [string]$Right)
    $leftPath = $Left.TrimEnd('\', '/')
    $rightPath = $Right.TrimEnd('\', '/')
    $separator = [IO.Path]::DirectorySeparatorChar
    return $leftPath -eq $rightPath -or
        $leftPath.StartsWith($rightPath + $separator, [StringComparison]::OrdinalIgnoreCase) -or
        $rightPath.StartsWith($leftPath + $separator, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-SafeDeletionTargets {
    param([string[]]$Targets)
    $safeTargets = @()
    $protectedPaths = @($control, $recovery, $packagePath, $database, $brain)
    foreach ($target in $Targets) {
        $canonical = Get-CanonicalPath $target
        if (@($protectedPaths | Where-Object { Test-PathOverlap $canonical $_ }).Count -gt 0) {
            throw "Deletion target crosses a protected recovery boundary: $canonical"
        }
        $safe = Resolve-SafeTarget -Path $canonical -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'deletion target'
        $safeTargets += $safe
    }
    return $safeTargets
}

function Assert-ExternalHandoffPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Purpose)
    $external = Get-CanonicalPath $Path
    $protected = @($AllowedRoot, $control, $recovery, $packagePath, $database, $brain) + @(Resolve-SafeDeletionTargets $DeletionTarget)
    if (@($protected | Where-Object { Test-PathOverlap $external (Get-CanonicalPath $_) }).Count -gt 0) {
        throw "$Purpose must be outside all protected paths: $external"
    }
    return $external
}

function Test-SamePathSet {
    param([string[]]$Left, [string[]]$Right)
    $leftSet = @($Left | ForEach-Object { Get-CanonicalPath $_ } | Sort-Object -Unique)
    $rightSet = @($Right | ForEach-Object { Get-CanonicalPath $_ } | Sort-Object -Unique)
    return ($leftSet.Count -eq $rightSet.Count -and (@(Compare-Object $leftSet $rightSet).Count -eq 0))
}

if ($Operation -eq 'prepare') {
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Database does not exist: $database" }
    if (Test-Path -LiteralPath $evictedMarker) { throw "Node is already EVICTED: $evictedMarker" }
    if (Test-Path -LiteralPath $packagePath) { throw "Plaintext recovery package already exists: $packagePath" }
    $safeDeletionTargets = @(Resolve-SafeDeletionTargets $DeletionTarget)

    New-Item -ItemType Directory -Path $control -Force | Out-Null
    New-Item -ItemType Directory -Path $recovery -Force | Out-Null
    $sqliteManifest = $null
    try {
        $sqliteManifest = Invoke-NodeJson -Action create
        Resolve-SafeTarget -Path $packagePath -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'plaintext package' | Out-Null
        New-Item -ItemType Directory -Path $packagePath | Out-Null
        Copy-Item -LiteralPath $sqliteManifest.backupDatabase -Destination (Join-Path $packagePath 'recovery.sqlite')
        $packagedManifest = [ordered]@{
            schemaVersion = $sqliteManifest.schemaVersion
            nodeName = $sqliteManifest.nodeName
            createdAt = $sqliteManifest.createdAt
            sourceDatabase = $sqliteManifest.sourceDatabase
            backupDatabase = 'recovery.sqlite'
            backupSha256 = $sqliteManifest.backupSha256
            integrityCheck = $sqliteManifest.integrityCheck
        }
        Write-JsonAtomic -Path (Join-Path $packagePath 'recovery.manifest.json') -Value $packagedManifest
        $handoff = [ordered]@{ schemaVersion = 1; nodeName = $NodeName; createdAt = $sqliteManifest.createdAt; packagePath = $packagePath; deletionTargets = $safeDeletionTargets }
        Write-JsonAtomic -Path (Join-Path $packagePath 'HANDOFF.json') -Value $handoff
    } catch {
        if (Test-Path -LiteralPath $packagePath) { Remove-Item -LiteralPath $packagePath -Recurse -Force }
        throw
    } finally {
        if ($sqliteManifest) {
            $rawBackup = Resolve-SafeTarget -Path ([string]$sqliteManifest.backupDatabase) -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'plaintext recovery staging'
            $rawManifest = [IO.Path]::ChangeExtension($rawBackup, '.manifest.json')
            if (Test-Path -LiteralPath $rawBackup) { Remove-Item -LiteralPath $rawBackup -Force }
            if (Test-Path -LiteralPath $rawManifest) { Remove-Item -LiteralPath $rawManifest -Force }
        }
    }

    Write-Host "Verified plaintext handoff prepared at $packagePath. No markers or deletion authorization created. Use the 7-Zip GUI to encrypt it, independently extract and verify it, then run seal."
    exit 0
}

if ($Operation -eq 'seal') {
    if (-not $ArchiveIndependentlyVerified) { throw 'Seal requires explicit independent extraction confirmation via -ArchiveIndependentlyVerified' }
    if ([string]::IsNullOrWhiteSpace($ArchivePath)) { throw 'ArchivePath is required for seal' }
    if (Test-Path -LiteralPath $evictedMarker) { throw "Node is already EVICTED: $evictedMarker" }
    $package = Read-RecoveryPackage $packagePath
    $safeDeletionTargets = @(Resolve-SafeDeletionTargets $DeletionTarget)
    if (-not (Test-SamePathSet @($package.Handoff.deletionTargets) $safeDeletionTargets)) { throw 'HANDOFF deletion targets do not match freshly supplied deletion targets' }
    $sealedArchive = Assert-ExternalHandoffPath -Path $ArchivePath -Purpose 'Encrypted archive'
    if (-not (Test-Path -LiteralPath $sealedArchive -PathType Leaf)) { throw "Encrypted archive is missing: $sealedArchive" }
    if (@($safeDeletionTargets | Where-Object { Test-PathOverlap $_ $sealedArchive }).Count -gt 0) { throw "Encrypted archive overlaps a deletion target: $sealedArchive" }
    $operationManifest = [ordered]@{ schemaVersion = 1; nodeName = $NodeName; createdAt = (Get-Date).ToUniversalTime().ToString('o'); recoverySha256 = $package.RecoverySha256; archivePath = $sealedArchive; archiveSha256 = Get-FileSha256 $sealedArchive; deletionTargets = $safeDeletionTargets }
    Write-JsonAtomic -Path $operationManifestPath -Value $operationManifest
    Set-Content -LiteralPath $maintenanceMarker -Value "$NodeName`n" -Encoding ASCII
    Set-Content -LiteralPath $evictedMarker -Value "$NodeName`n" -Encoding ASCII
    Write-Host 'Encrypted archive recorded and independently verified; EVICTED marker created.'
    exit 0
}

if ($Operation -eq 'complete' -or $Operation -eq 'offboard') {
    if (-not $ManualBoundaryConfirmed) { throw 'Manual boundary confirmation is required before local cleanup' }
    $manifest = Require-SealedState -RequireArchive
    $manifest.deletionTargets = @(Resolve-SafeDeletionTargets @($manifest.deletionTargets))
    $sealedArchive = Get-CanonicalPath ([string]$manifest.archivePath)
    if (@($manifest.deletionTargets | Where-Object { Test-PathOverlap $_ $sealedArchive }).Count -gt 0) { throw "Stored deletion target overlaps encrypted archive: $sealedArchive" }
    Remove-ManifestTargets -Manifest $manifest -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -BrainPath $brain
    if ($Operation -eq 'offboard') {
        $reportPath = Join-Path $control 'REMOTE-REVOCATION-CHECKLIST.md'
        $report = @"
# Remote revocation checklist for $NodeName

- Revoke company-node Tailscale access manually.
- Revoke provider and GitHub sessions manually.
- Remove or rotate company-node credentials manually.
- Confirm the device in each remote admin console.

This local report does not prove remote revocation or SSD erasure.
"@
        Set-Content -LiteralPath $reportPath -Value $report -Encoding UTF8
        Write-Host "Offboard checklist written: $reportPath"
    } else {
        Write-Host 'Manifest-listed local targets removed. EVICTED remains until a validated restore.'
    }
    exit 0
}

if (-not $HealthCheckCommand) { throw 'HealthCheckCommand is required for restore' }
if ([string]::IsNullOrWhiteSpace($DecryptedPackagePath)) { throw 'DecryptedPackagePath is required for restore' }
$manifest = Require-SealedState
$staleSidecars = @(@("$database-wal", "$database-shm") | Where-Object { Test-Path -LiteralPath $_ })
if ($staleSidecars.Count -gt 0) { throw "Restore refused: stale SQLite sidecar exists: $($staleSidecars -join ', ')" }
$decryptedPackage = Assert-ExternalHandoffPath -Path $DecryptedPackagePath -Purpose 'Decrypted package'
$databaseParent = Split-Path -Parent $database
if (-not (Test-Path -LiteralPath $databaseParent -PathType Container)) { New-Item -ItemType Directory -Path $databaseParent -Force | Out-Null }
$temporaryDatabase = "$database.restore-$PID.tmp"
try {
    $decrypted = Read-RecoveryPackage $decryptedPackage -StableDatabasePath $temporaryDatabase
} catch {
    if (Test-Path -LiteralPath $temporaryDatabase) { Remove-Item -LiteralPath $temporaryDatabase -Force }
    throw
}
if ($decrypted.RecoverySha256 -cne ([string]$manifest.recoverySha256).ToLowerInvariant()) {
    if (Test-Path -LiteralPath $temporaryDatabase) { Remove-Item -LiteralPath $temporaryDatabase -Force }
    throw 'Decrypted package does not match the sealed recovery identity'
}
Move-Item -LiteralPath $temporaryDatabase -Destination $database -Force

$global:LASTEXITCODE = 0
$healthResult = @(& $HealthCheckCommand)
$healthExit = $LASTEXITCODE
if ($healthExit -ne 0 -or ($healthResult -contains $false)) {
    throw "Restore health check failed; EVICTED remains at $evictedMarker"
}
if (Test-Path -LiteralPath $maintenanceMarker) { Remove-Item -LiteralPath $maintenanceMarker -Force }
Remove-Item -LiteralPath $evictedMarker -Force
Write-Host 'Restore verified; EVICTED marker removed last.'
