[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('prepare', 'complete', 'restore', 'offboard')][string]$Operation,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$NodeName,
    [Parameter(Mandatory = $true)][string]$AllowedRoot,
    [Parameter(Mandatory = $true)][string]$ControlDir,
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$BrainPath,
    [Parameter(Mandatory = $true)][string]$RecoveryRoot,
    [string]$CanaryRoot,
    [Parameter(Mandatory = $true)][string]$Confirmation,
    [string[]]$DeletionTarget = @(),
    [string]$ArchiverPath,
    [Security.SecureString]$ArchivePassword,
    [switch]$ManualBoundaryConfirmed,
    [scriptblock]$HealthCheckCommand
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'lib\CompanyNodeEviction.psm1') -Force

$control = Resolve-SafeTarget -Path $ControlDir -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'ControlDir'
$database = Resolve-SafeTarget -Path $DatabasePath -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'DatabasePath'
$brain = Resolve-SafeTarget -Path $BrainPath -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'BrainPath'
$recovery = Resolve-SafeTarget -Path $RecoveryRoot -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'RecoveryRoot'
Assert-EvictionConfirmation -NodeName $NodeName -Confirmation $Confirmation

$evictedMarker = Join-Path $control 'EVICTED'
$maintenanceMarker = Join-Path $control 'MAINTENANCE'
$operationManifestPath = Join-Path $control 'eviction-manifest.json'
$archivePath = Join-Path $recovery "$NodeName.recovery.7z"
$recoveryHelper = Join-Path $PSScriptRoot 'lib\sqlite-recovery.js'

Write-Host "Operation: $Operation"
Write-Host "Node: $NodeName"
Write-Host "Control: $control"
Write-Host "Database: $database"
Write-Host "Brain (never deleted): $brain"
Write-Host "Recovery: $recovery"

function Find-Archiver {
    if ($ArchiverPath) {
        $candidate = [IO.Path]::GetFullPath($ArchiverPath)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "7-Zip archiver was not found at $candidate. Install 7-Zip, then retry; no recovery was claimed."
        }
        if ([IO.Path]::GetExtension($candidate) -eq '.ps1') {
            if (-not $CanaryRoot) { throw 'Synthetic archivers are restricted to an explicit CanaryRoot' }
            Resolve-SafeTarget -Path $candidate -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'synthetic archiver' | Out-Null
        }
        return $candidate
    }

    $command = Get-Command '7z.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw '7-Zip is required for AES-256 recovery packaging. Install 7-Zip, then retry; no recovery was claimed.'
}

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

function Invoke-Archiver {
    param([Parameter(Mandatory = $true)][ValidateSet('create', 'extract')][string]$Action, [string]$Tool, [string]$Archive, [string]$Target)
    if ([IO.Path]::GetExtension($Tool) -eq '.ps1') {
        & $Tool $Action $Archive $Target
        return
    }
    if (-not $ArchivePassword) { throw 'ArchivePassword is required for real 7-Zip encryption' }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ArchivePassword)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if ($Action -eq 'create') {
            Push-Location $Target
            try { & $Tool a -t7z -mhe=on "-p$plain" $Archive 'recovery.sqlite' 'recovery.manifest.json' | Out-Null }
            finally { Pop-Location }
        } else {
            & $Tool x -y "-p$plain" "-o$Target" $Archive | Out-Null
        }
        if ($LASTEXITCODE -ne 0) { throw "7-Zip $Action failed with exit code $LASTEXITCODE" }
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $plain = $null
    }
}

function Require-PreparedState {
    if (-not (Test-Path -LiteralPath $evictedMarker -PathType Leaf)) { throw "EVICTED marker is missing: $evictedMarker" }
    $prepared = Read-EvictionManifest -Path $operationManifestPath -NodeName $NodeName
    $safeArchive = Resolve-SafeTarget -Path ([string]$prepared.archivePath) -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'manifest recovery archive'
    if ($safeArchive -cne $archivePath) { throw "Prepared manifest names an unexpected recovery archive: $safeArchive" }
    return $prepared
}

if ($Operation -eq 'prepare') {
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Database does not exist: $database" }
    if (Test-Path -LiteralPath $evictedMarker) { throw "Node is already EVICTED: $evictedMarker" }
    if (Test-Path -LiteralPath $archivePath) { throw "Recovery archive already exists: $archivePath" }
    $tool = Find-Archiver
    $safeDeletionTargets = @()
    foreach ($target in $DeletionTarget) {
        $safe = Resolve-SafeTarget -Path $target -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'deletion target'
        if ($safe -eq $brain -or $safe.StartsWith($brain.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $brain.StartsWith($safe.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "JarvisNotes deletion is forbidden: $safe"
        }
        $safeDeletionTargets += $safe
    }

    New-Item -ItemType Directory -Path $control -Force | Out-Null
    New-Item -ItemType Directory -Path $recovery -Force | Out-Null
    $sqliteManifest = Invoke-NodeJson -Action create
    $packageRoot = Join-Path $recovery (".package-{0}-{1}" -f $NodeName, [guid]::NewGuid().ToString('N'))
    Resolve-SafeTarget -Path $packageRoot -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'package staging' | Out-Null
    New-Item -ItemType Directory -Path $packageRoot | Out-Null
    try {
        Copy-Item -LiteralPath $sqliteManifest.backupDatabase -Destination (Join-Path $packageRoot 'recovery.sqlite')
        $packagedManifest = [ordered]@{
            schemaVersion = $sqliteManifest.schemaVersion
            nodeName = $sqliteManifest.nodeName
            createdAt = $sqliteManifest.createdAt
            sourceDatabase = $sqliteManifest.sourceDatabase
            backupDatabase = 'recovery.sqlite'
            backupSha256 = $sqliteManifest.backupSha256
            integrityCheck = $sqliteManifest.integrityCheck
        }
        Write-JsonAtomic -Path (Join-Path $packageRoot 'recovery.manifest.json') -Value $packagedManifest
        Invoke-Archiver -Action create -Tool $tool -Archive $archivePath -Target $packageRoot
    }
    finally {
        if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
    }
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'Archiver did not create a recovery archive' }
    $archiveSha256 = Get-FileSha256 $archivePath
    $rawBackup = Resolve-SafeTarget -Path ([string]$sqliteManifest.backupDatabase) -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'plaintext recovery staging'
    $rawManifest = [IO.Path]::ChangeExtension($rawBackup, '.manifest.json')
    if (Test-Path -LiteralPath $rawBackup) { Remove-Item -LiteralPath $rawBackup -Force }
    if (Test-Path -LiteralPath $rawManifest) { Remove-Item -LiteralPath $rawManifest -Force }

    $operationManifest = [ordered]@{
        schemaVersion = 1
        nodeName = $NodeName
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        archivePath = $archivePath
        archiveSha256 = $archiveSha256
        deletionTargets = $safeDeletionTargets
    }
    Write-JsonAtomic -Path $operationManifestPath -Value $operationManifest
    Set-Content -LiteralPath $maintenanceMarker -Value "$NodeName`n" -Encoding ASCII
    Set-Content -LiteralPath $evictedMarker -Value "$NodeName`n" -Encoding ASCII
    Write-Host 'Prepared recovery verified. STOP: complete the manual iCloud sign-out and independent backup verification before complete.'
    exit 0
}

if ($Operation -eq 'complete' -or $Operation -eq 'offboard') {
    if (-not $ManualBoundaryConfirmed) { throw 'Manual boundary confirmation is required before local cleanup' }
    $manifest = Require-PreparedState
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
$manifest = Require-PreparedState
if (-not (Test-Path -LiteralPath $manifest.archivePath -PathType Leaf)) { throw "Recovery archive is missing: $($manifest.archivePath)" }
if ((Get-FileSha256 $manifest.archivePath) -cne ([string]$manifest.archiveSha256).ToLowerInvariant()) { throw 'Recovery archive checksum mismatch' }
$tool = Find-Archiver
$stage = Join-Path $recovery "restore-stage-$NodeName"
Resolve-SafeTarget -Path $stage -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'restore staging' | Out-Null
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Invoke-Archiver -Action extract -Tool $tool -Archive $manifest.archivePath -Target $stage
$stageDatabase = Join-Path $stage 'recovery.sqlite'
$stageManifest = Join-Path $stage 'recovery.manifest.json'
if (-not (Test-Path -LiteralPath $stageDatabase -PathType Leaf) -or -not (Test-Path -LiteralPath $stageManifest -PathType Leaf)) {
    throw 'Recovery archive is incomplete'
}
$recoveryMetadata = Get-Content -Raw -LiteralPath $stageManifest | ConvertFrom-Json
$recoveryMetadata.backupDatabase = $stageDatabase
Write-JsonAtomic -Path $stageManifest -Value $recoveryMetadata
Invoke-NodeJson -Action verify -ManifestPath $stageManifest | Out-Null

$databaseParent = Split-Path -Parent $database
if (-not (Test-Path -LiteralPath $databaseParent -PathType Container)) { New-Item -ItemType Directory -Path $databaseParent -Force | Out-Null }
$temporaryDatabase = "$database.restore-$PID.tmp"
Copy-Item -LiteralPath $stageDatabase -Destination $temporaryDatabase -Force
Copy-Item -LiteralPath $temporaryDatabase -Destination $database -Force
Remove-Item -LiteralPath $temporaryDatabase -Force
Remove-Item -LiteralPath $stage -Recurse -Force

$global:LASTEXITCODE = 0
$healthResult = @(& $HealthCheckCommand)
$healthExit = $LASTEXITCODE
if ($healthExit -ne 0 -or ($healthResult -contains $false)) {
    throw "Restore health check failed; EVICTED remains at $evictedMarker"
}
if (Test-Path -LiteralPath $maintenanceMarker) { Remove-Item -LiteralPath $maintenanceMarker -Force }
Remove-Item -LiteralPath $evictedMarker -Force
Write-Host 'Restore verified; EVICTED marker removed last.'
