param(
    [string]$ProjectPath = "",
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$ProjectPath = $ProjectPath.Trim().Trim('"')
$ProjectPath = [IO.Path]::GetFullPath($ProjectPath)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ([string]::IsNullOrWhiteSpace($Version)) {
    $PackageJsonPath = Join-Path $ProjectPath "package.json"
    if (-not (Test-Path -LiteralPath $PackageJsonPath)) {
        throw "package.json was not found: $PackageJsonPath"
    }
    $Version = [string](Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json).version
}

if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Invalid application version: $Version"
}

function Repair-KnownCargoPackageVersion {
    param(
        [Parameter(Mandatory = $true)][string]$LockPath,
        [Parameter(Mandatory = $true)][string]$PackageName,
        [Parameter(Mandatory = $true)][string]$CorrectVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedChecksum
    )

    if (-not (Test-Path -LiteralPath $LockPath)) {
        throw "Required Cargo.lock was not found: $LockPath"
    }

    $content = [IO.File]::ReadAllText($LockPath)
    $escapedName = [regex]::Escape($PackageName)
    $escapedChecksum = [regex]::Escape($ExpectedChecksum)
    $pattern = '(?ms)(\[\[package\]\]\r?\nname = "' + $escapedName + '"\r?\nversion = ")([^"]+)' +
        '("\r?\nsource = "registry\+https://github\.com/rust-lang/crates\.io-index"\r?\nchecksum = "' +
        $escapedChecksum + '")'

    $match = [regex]::Match($content, $pattern)
    if ($match.Success -and $match.Groups[2].Value -ne $CorrectVersion) {
        $previousVersion = $match.Groups[2].Value
        $replacement = '${1}' + $CorrectVersion + '${3}'
        $content = [regex]::Replace($content, $pattern, $replacement, 1)
        [IO.File]::WriteAllText($LockPath, $content, $Utf8NoBom)
        Write-Host "Repaired Cargo.lock entry: $PackageName $previousVersion -> $CorrectVersion" -ForegroundColor Yellow
    }

    $verificationPattern = '(?ms)\[\[package\]\]\r?\nname = "' + $escapedName + '"\r?\nversion = "' +
        [regex]::Escape($CorrectVersion) +
        '"\r?\nsource = "registry\+https://github\.com/rust-lang/crates\.io-index"\r?\nchecksum = "' +
        $escapedChecksum + '"'

    if (-not [regex]::IsMatch([IO.File]::ReadAllText($LockPath), $verificationPattern)) {
        throw "Cargo.lock integrity check failed for $PackageName in $LockPath."
    }
}

$MainLock = Join-Path $ProjectPath "src-tauri\Cargo.lock"
$VoiceLock = Join-Path $ProjectPath "voice-app\src-tauri\Cargo.lock"

# These checksums identify the real crates. A previous broad version replacement
# changed dependency version strings while leaving their original checksums.
Repair-KnownCargoPackageVersion `
    -LockPath $MainLock `
    -PackageName "core-foundation-sys" `
    -CorrectVersion "0.8.7" `
    -ExpectedChecksum "773648b94d0e5d620f64f280777445740e61fe701025087ec8b57f45c791888b"

Repair-KnownCargoPackageVersion `
    -LockPath $MainLock `
    -PackageName "rand" `
    -CorrectVersion "0.8.7" `
    -ExpectedChecksum "22f6172bdec972074665ed81ed53b71da00bfc44b65a753cfde883ec4c702a1a"

Repair-KnownCargoPackageVersion `
    -LockPath $VoiceLock `
    -PackageName "core-foundation-sys" `
    -CorrectVersion "0.8.7" `
    -ExpectedChecksum "773648b94d0e5d620f64f280777445740e61fe701025087ec8b57f45c791888b"

# Only the application packages should carry the current MHTalk release version.
$mainText = [IO.File]::ReadAllText($MainLock)
$voiceText = [IO.File]::ReadAllText($VoiceLock)
$EscapedVersion = [regex]::Escape($Version)
if ($mainText -notmatch ('(?ms)\[\[package\]\]\r?\nname = "mhtalk"\r?\nversion = "' + $EscapedVersion + '"')) {
    throw "The mhtalk package version in the main Cargo.lock is not $Version."
}
if ($voiceText -notmatch ('(?ms)\[\[package\]\]\r?\nname = "mhtalk-voice"\r?\nversion = "' + $EscapedVersion + '"')) {
    throw "The mhtalk-voice package version in the voice Cargo.lock is not $Version."
}

Write-Host "Cargo.lock dependency integrity checks passed." -ForegroundColor Green
