Set-StrictMode -Version 2.0

function Test-ContainsWildcard {
    param([string]$Value)
    return [System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Value)
}

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Path must not be empty' }
    if (Test-ContainsWildcard $Path) { throw "Wildcard paths are not allowed: $Path" }
    if ($Path.Contains('$') -or $Path -match '%[^%]+%') { throw "Unresolved variables are not allowed in paths: $Path" }

    $full = [IO.Path]::GetFullPath($Path)
    for ($hop = 0; $hop -lt 32; $hop++) {
        $root = [IO.Path]::GetPathRoot($full)
        $parts = @($full.Substring($root.Length) -split '[\\/]' | Where-Object { $_ })
        $cursor = $root
        $redirected = $false
        for ($index = 0; $index -lt $parts.Count; $index++) {
            $cursor = Join-Path $cursor $parts[$index]
            if (-not (Test-Path -LiteralPath $cursor)) { continue }
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { continue }
            $target = [string]@($item.Target)[0]
            if ([string]::IsNullOrWhiteSpace($target)) { throw "Could not resolve link target: $cursor" }
            if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $cursor) $target }
            $remaining = @()
            if ($index -lt ($parts.Count - 1)) { $remaining = @($parts[($index + 1)..($parts.Count - 1)]) }
            $full = [IO.Path]::GetFullPath($target)
            foreach ($part in $remaining) { $full = Join-Path $full $part }
            $redirected = $true
            break
        }
        if (-not $redirected) { return [IO.Path]::GetFullPath($full) }
    }
    throw "Too many link indirections while resolving path: $Path"
}

function Test-IsWithin {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
    $separator = [IO.Path]::DirectorySeparatorChar
    $prefix = $Root.TrimEnd('\', '/') + $separator
    return $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeRoot {
    param([Parameter(Mandatory = $true)][string]$Root, [string]$Name = 'allowed')

    $resolved = Get-CanonicalPath $Root
    $driveRoot = [IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')
    if ($resolved.TrimEnd('\', '/') -eq $driveRoot) { throw "$Name is a broad root and is not allowed: $resolved" }

    $profile = [Environment]::GetFolderPath('UserProfile')
    if ($profile -and $resolved.TrimEnd('\', '/') -eq $profile.TrimEnd('\', '/')) {
        throw "$Name must not be the user-profile root: $resolved"
    }

    $repoRoot = Get-CanonicalPath (Join-Path $PSScriptRoot '..\..')
    if ($resolved.TrimEnd('\', '/') -eq $repoRoot.TrimEnd('\', '/')) {
        throw "$Name must not be the repository root: $resolved"
    }
    return $resolved
}

function Resolve-SafeTarget {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [string]$CanaryRoot,
        [string]$Purpose = 'target'
    )

    $allowed = Assert-SafeRoot $AllowedRoot 'AllowedRoot'
    $canary = $null
    if ($CanaryRoot) { $canary = Assert-SafeRoot $CanaryRoot 'CanaryRoot' }
    $resolved = Get-CanonicalPath $Path
    if (-not (Test-IsWithin $resolved $allowed) -and (-not $canary -or -not (Test-IsWithin $resolved $canary))) {
        throw "$Purpose escapes the explicit allowed roots: $resolved"
    }
    return $resolved
}

function Assert-EvictionConfirmation {
    param([Parameter(Mandatory = $true)][string]$NodeName, [Parameter(Mandatory = $true)][string]$Confirmation)
    $expected = "EVICT $NodeName"
    if ($Confirmation -cne $expected) { throw "Exact confirmation required: $expected" }
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-JsonAtomic {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $temporary = "$Path.$PID.tmp"
    try {
        $json = $Value | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Read-EvictionManifest {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$NodeName)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Prepared eviction manifest is missing: $Path" }
    $manifest = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.nodeName -cne $NodeName -or -not $manifest.archivePath -or -not $manifest.archiveSha256) {
        throw "Prepared eviction manifest is invalid for node $NodeName"
    }
    return $manifest
}

function Remove-ManifestTargets {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [string]$CanaryRoot,
        [Parameter(Mandatory = $true)][string]$BrainPath
    )
    $brain = Resolve-SafeTarget -Path $BrainPath -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'BrainPath'
    foreach ($entry in @($Manifest.deletionTargets)) {
        $target = Resolve-SafeTarget -Path ([string]$entry) -AllowedRoot $AllowedRoot -CanaryRoot $CanaryRoot -Purpose 'manifest deletion target'
        if ($target -eq $brain -or (Test-IsWithin $target $brain) -or (Test-IsWithin $brain $target)) {
            throw "JarvisNotes deletion is forbidden: $target"
        }
        if (Test-Path -LiteralPath $target) {
            $item = Get-Item -LiteralPath $target -Force
            if ($item.PSIsContainer) { Remove-Item -LiteralPath $target -Recurse -Force }
            else { Remove-Item -LiteralPath $target -Force }
        }
    }
}

Export-ModuleMember -Function Get-CanonicalPath, Resolve-SafeTarget, Assert-EvictionConfirmation, Get-FileSha256, Write-JsonAtomic, Read-EvictionManifest, Remove-ManifestTargets
