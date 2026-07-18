param(
    [string]$ProjectPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Version = "0.9.2"
$ReleaseRepo = "mhlko-tech/MhlkoTalk"
$RecoveryRepo = "mhlko-tech/MHTalk-Recovery"
$ExpectedOrigin = "https://github.com/mhlko-tech/MhlkoTalk.git"
$ExpectedSignalingUrl = "wss://mhlkotalk-signaling.mhlkotalk.workers.dev"
$ArchiveBranch = "archive/main-before-0.9.2"
$ReleaseBranch = "release-0.9.2"

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Split-Path -Parent $PSCommandPath
}

$ProjectPath = [IO.Path]::GetFullPath($ProjectPath.Trim().Trim('"'))
Set-Location $ProjectPath

function Assert-ExitCode([string]$Message) {
    if ($LASTEXITCODE -ne 0) {
        throw $Message
    }
}

function Invoke-GitCapture([string[]]$Arguments) {
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & git.exe @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }

    return [PSCustomObject]@{
        ExitCode = $code
        Output = @($output)
    }
}

Write-Host ""
Write-Host "MHTalk v$Version - one-click GitHub release" -ForegroundColor Cyan
Write-Host "Project: $ProjectPath"
Write-Host "The previous remote main is preserved in $ArchiveBranch." -ForegroundColor DarkGray
Write-Host "You will be asked only for the updater Recovery password during signing." -ForegroundColor Yellow
Write-Host ""

if ($env:OS -ne "Windows_NT") {
    throw "This launcher must run on Windows."
}

foreach ($commandName in @("git.exe", "gh.exe", "node.exe", "npm.cmd", "cargo.exe", "powershell.exe")) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "Required command was not found: $commandName"
    }
}

foreach ($requiredPath in @(
    ".\package.json",
    ".\BUILD_AND_PUBLISH.ps1",
    ".\GITHUB_RELEASE_DESCRIPTION_0.9.2.md",
    ".\CHANGELOG_0.9.2_AR.md",
    ".\.git"
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required project item was not found: $requiredPath"
    }
}

$PackageVersion = [string](Get-Content -LiteralPath ".\package.json" -Raw | ConvertFrom-Json).version
if ($PackageVersion -ne $Version) {
    throw "This package is not MHTalk $Version. Found: $PackageVersion"
}

$CurrentBranch = (& git.exe branch --show-current).Trim()
Assert-ExitCode "Could not read the current Git branch."
if ($CurrentBranch -ne $ReleaseBranch) {
    throw "Expected branch $ReleaseBranch, found $CurrentBranch."
}

$TrackedChanges = @(& git.exe status --porcelain --untracked-files=all)
Assert-ExitCode "Could not read Git status."
if ($TrackedChanges.Count -ne 0) {
    $TrackedChanges | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    throw "The project contains uncommitted changes. Extract a fresh copy of this ZIP and run again."
}

$EnvPath = Join-Path $ProjectPath ".env"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($EnvPath, "VITE_SIGNALING_URL=$ExpectedSignalingUrl`n", $Utf8NoBom)

& git.exe remote set-url origin $ExpectedOrigin
Assert-ExitCode "Could not configure the GitHub origin remote."

& gh.exe auth status
Assert-ExitCode "GitHub CLI is not logged in. Run 'gh auth login' once, then double-click this file again."

$RecoveryCheck = & gh.exe api "repos/$RecoveryRepo/contents/MHTalk-Updater-Recovery.tar.gz.enc" --jq ".sha"
Assert-ExitCode "The encrypted updater-key backup could not be accessed from GitHub."
if ([string]::IsNullOrWhiteSpace(($RecoveryCheck -join "").Trim())) {
    throw "The encrypted updater-key backup returned no SHA."
}

& git.exe fetch origin --prune --tags
Assert-ExitCode "Could not fetch the GitHub repository."

$RemoteMainResult = Invoke-GitCapture -Arguments @("rev-parse", "refs/remotes/origin/main")
if ($RemoteMainResult.ExitCode -ne 0) {
    throw "origin/main was not found."
}
$RemoteMainSha = ($RemoteMainResult.Output -join "").Trim()

$ArchiveResult = Invoke-GitCapture -Arguments @(
    "ls-remote", "--heads", "origin", "refs/heads/$ArchiveBranch"
)
if ($ArchiveResult.ExitCode -ne 0) {
    throw "Could not inspect the remote archive branch."
}

if ([string]::IsNullOrWhiteSpace(($ArchiveResult.Output -join "").Trim())) {
    Write-Host "Preserving the previous GitHub main in $ArchiveBranch..." -ForegroundColor Cyan
    & git.exe push origin "refs/remotes/origin/main:refs/heads/$ArchiveBranch"
    Assert-ExitCode "Could not preserve the previous GitHub main branch."
}
else {
    Write-Host "Previous GitHub main is already preserved in $ArchiveBranch." -ForegroundColor DarkGray
}

Write-Host "Uploading the dedicated $ReleaseBranch branch..." -ForegroundColor Cyan
& git.exe push --force-with-lease origin "HEAD:refs/heads/$ReleaseBranch"
Assert-ExitCode "Could not upload the $ReleaseBranch branch."

Write-Host "Promoting MHTalk $Version to GitHub main..." -ForegroundColor Cyan
& git.exe push "--force-with-lease=refs/heads/main:$RemoteMainSha" origin "HEAD:refs/heads/main"
Assert-ExitCode "Could not promote MHTalk $Version to GitHub main. The archived previous main was not removed."

& git.exe fetch origin --prune
Assert-ExitCode "Could not refresh GitHub refs after uploading."

& git.exe branch --set-upstream-to="origin/$ReleaseBranch" $ReleaseBranch | Out-Null

Write-Host ""
Write-Host "GitHub source upload completed. Starting the signed Windows build and release..." -ForegroundColor Green
Write-Host ""

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $ProjectPath "BUILD_AND_PUBLISH.ps1") `
    -ProjectPath $ProjectPath `
    -Version $Version

Assert-ExitCode "MHTalk $Version build or publishing failed. Read the final error above."

Write-Host ""
Write-Host "SUCCESS - MHTalk v$Version is now the GitHub Latest release." -ForegroundColor Green
