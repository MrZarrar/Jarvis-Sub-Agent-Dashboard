$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EvictionScript = Join-Path $RepoRoot 'scripts\company-node-eviction.ps1'
$EvictionModule = Join-Path $RepoRoot 'scripts\lib\CompanyNodeEviction.psm1'
$CaseRoot = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-eviction-canary-{0}" -f [guid]::NewGuid().ToString('N'))
$EscapeRoot = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-eviction-escape-{0}" -f [guid]::NewGuid().ToString('N'))
$JunctionTargetRoot = Join-Path $RepoRoot (".phase6-junction-target-{0}" -f [guid]::NewGuid().ToString('N'))
$JunctionCanaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-eviction-canary-{0}" -f [guid]::NewGuid().ToString('N'))
Import-Module $EvictionModule -Force

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Invoke-Fails {
    param([scriptblock]$Action, [string]$ExpectedText)
    $failure = $null
    try {
        & $Action | Out-Null
    }
    catch {
        $failure = $_
    }
    if (-not $failure) { throw "Expected failure containing '$ExpectedText', but the action succeeded" }
    if ($failure.Exception.Message -notmatch [regex]::Escape($ExpectedText)) {
        throw "Expected failure containing '$ExpectedText', got: $($failure.Exception.Message)"
    }
}

function New-CanaryDatabase {
    param([string]$Path)
    $code = @'
const Database = require(process.argv[2]);
const db = new Database(process.argv[3]);
db.exec("CREATE TABLE canary (value TEXT NOT NULL)");
db.prepare("INSERT INTO canary (value) VALUES (?)").run("survives");
db.close();
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
    & node -e 'eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())' $encoded (Join-Path $RepoRoot 'server\compat-sqlite.js') $Path
    if ($LASTEXITCODE -ne 0) { throw 'Could not create canary database' }
}

function Assert-DatabaseCanary {
    param([string]$Path)
    $code = @'
const Database = require(process.argv[2]);
const db = new Database(process.argv[3], { readOnly: true });
const row = db.prepare("SELECT value FROM canary").get();
db.close();
if (!row || row.value !== "survives") process.exit(7);
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
    & node -e 'eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())' $encoded (Join-Path $RepoRoot 'server\compat-sqlite.js') $Path
    if ($LASTEXITCODE -ne 0) { throw "Restored database did not contain canary row: $Path" }
}

function New-SyntheticArchiver {
    param([string]$Path)
    $content = @'
param(
    [Parameter(Mandatory = $true, Position = 0)][ValidateSet('create', 'extract')][string]$Operation,
    [Parameter(Mandatory = $true, Position = 1)][string]$ArchivePath,
    [Parameter(Mandatory = $true, Position = 2)][string]$TargetPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ($Operation -eq 'create') {
    [IO.Compression.ZipFile]::CreateFromDirectory($TargetPath, $ArchivePath)
} else {
    [IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $TargetPath)
}
'@
    Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

function New-Case {
    param([string]$Name, [string]$BaseRoot = $CaseRoot)
    $root = Join-Path $BaseRoot $Name
    $allowed = Join-Path $root 'allowed'
    $control = Join-Path $allowed 'control'
    $data = Join-Path $allowed 'data'
    $brain = Join-Path $allowed 'JarvisNotes'
    $recovery = Join-Path $allowed 'recovery'
    $local = Join-Path $allowed 'local'
    $tools = Join-Path $allowed 'tools'
    $unrelated = Join-Path $root 'unrelated\keep.txt'
    @($control, $data, $brain, $recovery, $local, $tools, (Split-Path $unrelated)) | ForEach-Object {
        New-Item -ItemType Directory -Path $_ -Force | Out-Null
    }
    $database = Join-Path $data 'jarvis.db'
    $token = Join-Path $local 'provider.token'
    $config = Join-Path $local 'company.json'
    $archiver = Join-Path $tools 'synthetic-7z.ps1'
    New-CanaryDatabase $database
    Set-Content -LiteralPath (Join-Path $brain 'safe-note.md') -Value 'brain survives'
    Set-Content -LiteralPath $token -Value 'synthetic-token'
    Set-Content -LiteralPath $config -Value '{"synthetic":true}'
    Set-Content -LiteralPath $unrelated -Value 'must survive'
    New-SyntheticArchiver $archiver
    return @{
        Root = $root; Allowed = $allowed; Control = $control; Database = $database
        Brain = $brain; Recovery = $recovery; Token = $token; Config = $config
        Archiver = $archiver; Unrelated = $unrelated
    }
}

New-Item -ItemType Directory -Path $CaseRoot -Force | Out-Null
try {
    $case = New-Case 'restore'
    $password = ConvertTo-SecureString 'canary-password' -AsPlainText -Force
    $common = @{
        NodeName = 'canary-core'
        AllowedRoot = $case.Allowed
        CanaryRoot = $CaseRoot
        ControlDir = $case.Control
        DatabasePath = $case.Database
        BrainPath = $case.Brain
        RecoveryRoot = $case.Recovery
        Confirmation = 'EVICT canary-core'
        DeletionTarget = @($case.Token, $case.Config)
        ArchiverPath = $case.Archiver
        ArchivePassword = $password
    }

    $broadRoot = @{}; foreach ($key in $common.Keys) { $broadRoot[$key] = $common[$key] }
    $broadRoot.AllowedRoot = [IO.Path]::GetPathRoot($case.Allowed)
    $wrongConfirmation = @{}; foreach ($key in $common.Keys) { $wrongConfirmation[$key] = $common[$key] }
    $wrongConfirmation.Confirmation = 'wrong'
    $missingArchiver = @{}; foreach ($key in $common.Keys) { $missingArchiver[$key] = $common[$key] }
    $missingArchiver.ArchiverPath = Join-Path $case.Allowed 'missing-7z.exe'
    $nonDisposableSynthetic = @{}; foreach ($key in $common.Keys) { $nonDisposableSynthetic[$key] = $common[$key] }
    $nonDisposableSynthetic.CanaryRoot = $case.Allowed
    Invoke-Fails { & $EvictionScript -Operation prepare @broadRoot } 'broad root'
    Invoke-Fails { & $EvictionScript -Operation prepare @wrongConfirmation } 'confirmation'
    Invoke-Fails { & $EvictionScript -Operation prepare @missingArchiver } '7-Zip'
    Invoke-Fails { & $EvictionScript -Operation prepare @nonDisposableSynthetic } 'disposable canary'

    New-Item -ItemType Directory -Path $JunctionTargetRoot -Force | Out-Null
    $junctionCase = New-Case 'junction' $JunctionTargetRoot
    New-Item -ItemType Junction -Path $JunctionCanaryRoot -Target $JunctionTargetRoot | Out-Null
    $junctionArgs = @{
        NodeName = 'junction-core'; AllowedRoot = $junctionCase.Allowed; CanaryRoot = $JunctionCanaryRoot
        ControlDir = $junctionCase.Control; DatabasePath = $junctionCase.Database; BrainPath = $junctionCase.Brain
        RecoveryRoot = $junctionCase.Recovery; Confirmation = 'EVICT junction-core'
        DeletionTarget = @($junctionCase.Token); ArchiverPath = $junctionCase.Archiver; ArchivePassword = $password
    }
    Invoke-Fails { & $EvictionScript -Operation prepare @junctionArgs } 'disposable canary'
    New-Item -ItemType Directory -Path $EscapeRoot -Force | Out-Null
    $escapeLink = Join-Path $case.Allowed 'local\escape-link'
    New-Item -ItemType Junction -Path $escapeLink -Target $EscapeRoot | Out-Null
    Invoke-Fails { Resolve-SafeTarget -Path $escapeLink -AllowedRoot $case.Allowed -CanaryRoot $case.Allowed -Purpose 'junction target' } 'escapes'

    $protectedCases = @(
        @{ Name = 'control equal'; Target = $case.Control },
        @{ Name = 'control ancestor'; Target = $case.Allowed },
        @{ Name = 'control descendant'; Target = (Join-Path $case.Control 'child') },
        @{ Name = 'recovery equal'; Target = $case.Recovery },
        @{ Name = 'recovery descendant/archive'; Target = (Join-Path $case.Recovery 'canary-core.recovery.7z') },
        @{ Name = 'database equal'; Target = $case.Database },
        @{ Name = 'database descendant'; Target = (Join-Path $case.Database 'child') },
        @{ Name = 'brain equal'; Target = $case.Brain },
        @{ Name = 'brain descendant'; Target = (Join-Path $case.Brain 'safe-note.md') }
    )
    foreach ($protectedCase in $protectedCases) {
        $protectedArgs = @{}; foreach ($key in $common.Keys) { $protectedArgs[$key] = $common[$key] }
        $protectedArgs.DeletionTarget = @($protectedCase.Target)
        Invoke-Fails { & $EvictionScript -Operation prepare @protectedArgs } 'protected recovery boundary'
    }

    $prepareOutput = (& $EvictionScript -Operation prepare @common | Out-String)
    Assert-True (Test-Path -LiteralPath (Join-Path $case.Control 'EVICTED')) 'prepare creates EVICTED marker'
    Assert-True (Test-Path -LiteralPath (Join-Path $case.Control 'MAINTENANCE')) 'prepare creates maintenance marker'
    Assert-True (Test-Path -LiteralPath (Join-Path $case.Recovery 'canary-core.recovery.7z')) 'prepare creates encrypted recovery archive'
    Assert-True (@(Get-ChildItem -LiteralPath $case.Recovery -Filter '*.sqlite').Count -eq 0) 'prepare leaves no plaintext SQLite recovery beside archive'
    Assert-True ($prepareOutput -notmatch 'canary-password') 'prepare output never reveals archive password'

    $archive = Join-Path $case.Recovery 'canary-core.recovery.7z'
    $archiveBytes = [IO.File]::ReadAllBytes($archive)
    Remove-Item -LiteralPath $archive
    Invoke-Fails { & $EvictionScript -Operation complete @common -ManualBoundaryConfirmed } 'archive is missing'
    Assert-True (Test-Path -LiteralPath $case.Token) 'missing archive prevents manifest cleanup'
    [IO.File]::WriteAllBytes($archive, $archiveBytes)
    [IO.File]::AppendAllText($archive, 'tampered')
    Invoke-Fails { & $EvictionScript -Operation complete @common -ManualBoundaryConfirmed } 'checksum mismatch'
    Assert-True (Test-Path -LiteralPath $case.Token) 'tampered archive prevents manifest cleanup'
    [IO.File]::WriteAllBytes($archive, $archiveBytes)

    $operationManifestPath = Join-Path $case.Control 'eviction-manifest.json'
    $operationManifestJson = Get-Content -Raw -LiteralPath $operationManifestPath
    $operationManifest = $operationManifestJson | ConvertFrom-Json
    $operationManifest.deletionTargets = @($case.Control)
    $operationManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $operationManifestPath -Encoding UTF8
    Invoke-Fails { & $EvictionScript -Operation complete @common -ManualBoundaryConfirmed } 'protected recovery boundary'
    Assert-True (Test-Path -LiteralPath $case.Token) 'tampered deletion manifest cannot cross recovery boundary'
    [IO.File]::WriteAllText($operationManifestPath, $operationManifestJson, (New-Object Text.UTF8Encoding($false)))

    & $EvictionScript -Operation complete @common -ManualBoundaryConfirmed | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $case.Token)) 'complete removes manifest-listed token'
    Assert-True (-not (Test-Path -LiteralPath $case.Config)) 'complete removes manifest-listed config'
    Assert-True (Test-Path -LiteralPath (Join-Path $case.Brain 'safe-note.md')) 'complete never removes brain contents'
    Assert-True (Test-Path -LiteralPath $case.Unrelated) 'complete preserves unrelated sibling'
    Assert-True (Test-Path -LiteralPath (Join-Path $case.Control 'EVICTED')) 'complete leaves eviction marker in place'

    Remove-Item -LiteralPath $case.Database
    Invoke-Fails { & $EvictionScript -Operation restore @common -HealthCheckCommand { $false } } 'health check'
    Assert-True (Test-Path -LiteralPath (Join-Path $case.Control 'EVICTED')) 'failed restore health check keeps eviction marker'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $case.Recovery 'restore-stage-canary-core'))) 'failed restore removes plaintext extraction staging'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $invalidStage = Join-Path $case.Recovery 'invalid-package'
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $invalidStage)
    Set-Content -LiteralPath (Join-Path $invalidStage 'recovery.manifest.json') -Value '{"broken":true}' -Encoding ASCII
    Remove-Item -LiteralPath $archive
    [IO.Compression.ZipFile]::CreateFromDirectory($invalidStage, $archive)
    Remove-Item -LiteralPath $invalidStage -Recurse -Force
    $invalidBytes = [IO.File]::ReadAllBytes($archive)
    $invalidHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $invalidOperationManifest = Get-Content -Raw -LiteralPath $operationManifestPath | ConvertFrom-Json
    $invalidOperationManifest.archiveSha256 = $invalidHash
    $invalidOperationManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $operationManifestPath -Encoding ASCII
    Invoke-Fails { & $EvictionScript -Operation restore @common -HealthCheckCommand { $true } } 'backupDatabase'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $case.Recovery 'restore-stage-canary-core'))) 'packaged-manifest failure removes extraction staging'
    [IO.File]::WriteAllBytes($archive, $archiveBytes)
    [IO.File]::WriteAllText($operationManifestPath, $operationManifestJson, (New-Object Text.UTF8Encoding($false)))
    & $EvictionScript -Operation restore @common -HealthCheckCommand { $true } | Out-Null
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $case.Control 'EVICTED'))) 'successful restore removes eviction marker last'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $case.Recovery 'restore-stage-canary-core'))) 'restore removes plaintext extraction staging'
    Assert-DatabaseCanary $case.Database

    $offboard = New-Case 'offboard'
    $offboardCommon = @{
        NodeName = 'lost-company-node'
        AllowedRoot = $offboard.Allowed
        CanaryRoot = $CaseRoot
        ControlDir = $offboard.Control
        DatabasePath = $offboard.Database
        BrainPath = $offboard.Brain
        RecoveryRoot = $offboard.Recovery
        Confirmation = 'EVICT lost-company-node'
        DeletionTarget = @($offboard.Token)
        ArchiverPath = $offboard.Archiver
        ArchivePassword = $password
    }
    & $EvictionScript -Operation prepare @offboardCommon | Out-Null
    & $EvictionScript -Operation offboard @offboardCommon -ManualBoundaryConfirmed | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $offboard.Token)) 'offboard removes only manifest-listed synthetic credential'
    Assert-True (Test-Path -LiteralPath $offboard.Config) 'offboard preserves unlisted local config'
    Assert-True (Test-Path -LiteralPath $offboard.Unrelated) 'offboard preserves unrelated sibling'
    $report = Join-Path $offboard.Control 'REMOTE-REVOCATION-CHECKLIST.md'
    Assert-True (Test-Path -LiteralPath $report) 'offboard emits remote-revocation checklist'
    Assert-True ((Get-Content -Raw -LiteralPath $report) -match 'does not prove') 'checklist does not claim remote erasure'

    Write-Host 'PASS: company-node eviction canary drill'
}
finally {
    if (Test-Path -LiteralPath $CaseRoot) {
        Remove-Item -LiteralPath $CaseRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $EscapeRoot) {
        Remove-Item -LiteralPath $EscapeRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $JunctionCanaryRoot) {
        [IO.Directory]::Delete($JunctionCanaryRoot)
    }
    if (Test-Path -LiteralPath $JunctionTargetRoot) {
        Remove-Item -LiteralPath $JunctionTargetRoot -Recurse -Force
    }
}
