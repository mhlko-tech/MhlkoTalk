param(
    [string]$ProjectPath = "",
    [string]$Version = "",
    [string]$ReleaseRepo = "mhlko-tech/MhlkoTalk",
    [string]$RecoveryRepo = "mhlko-tech/MHTalk-Recovery"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ExpectedPublicKeyHash = "48b5ffef28bb94d06407c8e112ce88eb4b5dca8cecc435d892c1b9a5625f7b3e"
$PublicNpmRegistry = "https://registry.npmjs.org/"

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Split-Path -Parent $PSCommandPath
}
$ProjectPath = $ProjectPath.Trim().Trim('"')
$ProjectPath = [IO.Path]::GetFullPath($ProjectPath)

if ([string]::IsNullOrWhiteSpace($Version)) {
    $PackageJsonPath = Join-Path $ProjectPath "package.json"
    if (-not (Test-Path -LiteralPath $PackageJsonPath)) {
        throw "package.json was not found: $PackageJsonPath"
    }
    $Version = [string](Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json).version
}

if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Invalid release version: $Version"
}

$Tag = "v$Version"
$TempRoot = Join-Path $env:TEMP ("MHTalk_Release_" + [Guid]::NewGuid().ToString("N"))
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$OldPrivateKey = $env:TAURI_SIGNING_PRIVATE_KEY
$OldPrivateKeyPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
$OldNpmRegistry = $env:npm_config_registry
$OldNpmFetchRetries = $env:npm_config_fetch_retries
$OldNpmFetchTimeout = $env:npm_config_fetch_timeout
$WorkerEndpoint = "https://mhlkotalk-signaling.mhlkotalk.workers.dev"

function Assert-ExitCode([string]$Message) {
    if ($LASTEXITCODE -ne 0) {
        throw $Message
    }
}

function Repair-NpmLockfiles {
    param([string]$RootPath)

    $lockfiles = @(
        (Join-Path $RootPath "package-lock.json"),
        (Join-Path $RootPath "voice-app\package-lock.json"),
        (Join-Path $RootPath "worker\package-lock.json")
    )

    # Repair lockfiles accidentally generated against a private npm proxy.
    # The expression is intentionally host-agnostic so no environment-specific URL
    # is embedded in a public release package.
    $inaccessibleRegistryPattern = 'https://[^"\s]+/(?:artifactory/api/npm/npm-public|npm-public)/'

    foreach ($lockfile in $lockfiles) {
        if (-not (Test-Path -LiteralPath $lockfile)) {
            throw "Required npm lockfile was not found: $lockfile"
        }

        $content = [IO.File]::ReadAllText($lockfile)
        $repaired = [regex]::Replace($content, $inaccessibleRegistryPattern, $PublicNpmRegistry)

        if ($repaired -match 'artifactory/api/npm|https://[^"\s]+/npm-public/') {
            throw "An inaccessible private npm registry URL remains in $lockfile."
        }

        if ($repaired -ne $content) {
            [IO.File]::WriteAllText($lockfile, $repaired, $Utf8NoBom)
            Write-Host "Repaired inaccessible npm registry URLs in: $lockfile" -ForegroundColor Yellow
        }
    }
}

function Stop-ProjectNodeProcesses {
    param([string]$RootPath)

    try {
        $normalizedRoot = [IO.Path]::GetFullPath($RootPath).TrimEnd('\')
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
            } |
            ForEach-Object {
                Write-Host "Stopping stale project Node process PID $($_.ProcessId)..." -ForegroundColor Yellow
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
    }
    catch {
        Write-Host "Could not inspect stale Node processes; continuing with cleanup." -ForegroundColor DarkYellow
    }
}

function Remove-DirectoryRobust {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Attempts = 6
    )

    $resolvedRoot = [IO.Path]::GetFullPath($ProjectPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $rootPrefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    if ($resolvedPath -eq $resolvedRoot -or -not $resolvedPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to recursively remove a path outside the project workspace: $resolvedPath"
    }

    if (-not (Test-Path -LiteralPath $resolvedPath)) {
        return
    }

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Remove-Item -LiteralPath $resolvedPath -Recurse -Force -ErrorAction Stop
        }
        catch {
            if ($attempt -eq $Attempts) {
                throw
            }
        }

        if (-not (Test-Path -LiteralPath $resolvedPath)) {
            return
        }

        if ($attempt -lt $Attempts) {
            Write-Host "Folder is still locked: $resolvedPath. Retrying cleanup..." -ForegroundColor Yellow
            Start-Sleep -Seconds ($attempt * 2)
        }
    }

    throw "Could not remove locked dependency folder: $resolvedPath. Close VS Code terminals, File Explorer windows opened inside the folder, and antivirus scans, then run the build again."
}

function Test-PublicNpmRegistry {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        & npm.cmd ping `
            --registry=$PublicNpmRegistry `
            --fetch-retries=2 `
            --fetch-timeout=60000 `
            --no-fund `
            --no-audit

        if ($LASTEXITCODE -eq 0) {
            return
        }

        if ($attempt -lt 5) {
            Write-Host "Public npm registry did not respond. Retrying in $($attempt * 5) seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds ($attempt * 5)
        }
    }

    throw "Could not reach the public npm registry at $PublicNpmRegistry. Check the internet connection, VPN, proxy, DNS, or firewall."
}

function Invoke-NpmCleanInstall {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingPath,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    $nodeModulesPath = Join-Path $WorkingPath "node_modules"

    for ($attempt = 1; $attempt -le 4; $attempt++) {
        Remove-DirectoryRobust -Path $nodeModulesPath

        Push-Location $WorkingPath
        try {
            & npm.cmd ci `
                --registry=$PublicNpmRegistry `
                --fetch-retries=5 `
                --fetch-retry-factor=2 `
                --fetch-retry-mintimeout=10000 `
                --fetch-retry-maxtimeout=120000 `
                --fetch-timeout=300000 `
                --no-fund `
                --no-audit
            $installCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }

        if ($installCode -eq 0) {
            return
        }

        if ($attempt -lt 4) {
            Write-Host "$DisplayName dependency installation failed. Verifying npm cache and retrying..." -ForegroundColor Yellow
            & npm.cmd cache verify --no-fund --no-audit | Out-Host
            Start-Sleep -Seconds ($attempt * 5)
        }
    }

    throw "$DisplayName npm dependency installation failed after four attempts."
}

function Find-OpenSsl {
    $command = Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        if ($command.PSObject.Properties.Name -contains "Path" -and $command.Path) {
            return $command.Path
        }
        if ($command.PSObject.Properties.Name -contains "Definition" -and $command.Definition) {
            return $command.Definition
        }
    }

    $candidates = @(
        "C:\Program Files\Git\usr\bin\openssl.exe",
        "C:\Program Files\Git\mingw64\bin\openssl.exe",
        "C:\Program Files (x86)\Git\usr\bin\openssl.exe"
    )

    return ($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

function Invoke-GhCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [int]$Attempts = 4
    )

    $lastOutput = $null

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $oldPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $lastOutput = & gh.exe @Arguments 2>&1
            $code = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $oldPreference
        }

        if ($code -eq 0) {
            return [PSCustomObject]@{
                ExitCode = 0
                Output = @($lastOutput)
            }
        }

        if ($attempt -lt $Attempts) {
            Write-Host "GitHub request failed. Retrying in $($attempt * 3) seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds ($attempt * 3)
        }
    }

    return [PSCustomObject]@{
        ExitCode = $code
        Output = @($lastOutput)
    }
}

function Assert-JsonVersion {
    param(
        [string]$Path,
        [string]$ExpectedVersion
    )

    if (-not (Test-Path $Path)) {
        throw "Required file was not found: $Path"
    }

    $ResolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $NodeJsonReader = @'
const fs = require('node:fs');
const filePath = process.argv[1];
const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));

if (typeof document.version !== 'string' || document.version.length === 0) {
  throw new Error('Missing or invalid top-level version in ' + filePath);
}

process.stdout.write(document.version);
'@

    $OldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $VersionOutput = & node.exe -e $NodeJsonReader $ResolvedPath 2>&1
        $NodeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $OldPreference
    }

    if ($NodeExitCode -ne 0) {
        throw "Could not read JSON version from $Path.`n$($VersionOutput -join [Environment]::NewLine)"
    }

    $ActualVersion = ($VersionOutput -join "").Trim()
    if ($ActualVersion -ne $ExpectedVersion) {
        throw "Version mismatch in $Path. Expected $ExpectedVersion, found $ActualVersion."
    }
}

function Assert-CargoVersion {
    param(
        [string]$Path,
        [string]$ExpectedVersion
    )

    if (-not (Test-Path $Path)) {
        throw "Required file was not found: $Path"
    }

    $content = [IO.File]::ReadAllText($Path)
    $match = [regex]::Match(
        $content,
        '(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"'
    )

    if (-not $match.Success) {
        throw "Could not read [package] version from $Path."
    }

    if ($match.Groups[1].Value -ne $ExpectedVersion) {
        throw "Version mismatch in $Path. Expected $ExpectedVersion, found $($match.Groups[1].Value)."
    }
}

try {
    Write-Host "MHTalk v$Version - complete signed Windows build and GitHub release" -ForegroundColor Cyan
    Write-Host "Project: $ProjectPath"
    Write-Host ""

    if (-not (Test-Path $ProjectPath)) {
        throw "Project folder was not found: $ProjectPath"
    }

    if ($env:OS -ne "Windows_NT") {
        throw "This release script builds Windows NSIS artifacts and must run on Windows."
    }

    foreach ($commandName in @("node.exe", "npm.cmd", "cargo.exe", "gh.exe", "tar.exe")) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "Required command was not found: $commandName"
        }
    }

    $OpenSsl = Find-OpenSsl
    if ([string]::IsNullOrWhiteSpace($OpenSsl) -or -not (Test-Path $OpenSsl)) {
        throw "OpenSSL was not found. Git for Windows normally provides it."
    }

    Set-Location $ProjectPath
    New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

    Write-Host "1/12 Checking version, Cargo lock integrity and updater configuration..." -ForegroundColor Cyan

    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File ".\scripts\repair-cargo-locks.ps1" `
        -ProjectPath $ProjectPath `
        -Version $Version
    Assert-ExitCode "Cargo.lock dependency integrity repair failed."

    $ReleaseNotesPath = Join-Path $ProjectPath "GITHUB_RELEASE_DESCRIPTION_$Version.md"
    if (-not (Test-Path $ReleaseNotesPath)) {
        throw "GitHub release notes were not found: $ReleaseNotesPath"
    }
    $ReleaseNotesContent = [IO.File]::ReadAllText($ReleaseNotesPath).Trim()
    if ([string]::IsNullOrWhiteSpace($ReleaseNotesContent)) {
        throw "GitHub release notes are empty: $ReleaseNotesPath"
    }

    Assert-JsonVersion ".\package.json" $Version
    Assert-JsonVersion ".\package-lock.json" $Version
    Assert-JsonVersion ".\voice-app\package.json" $Version
    Assert-JsonVersion ".\voice-app\package-lock.json" $Version
    Assert-JsonVersion ".\worker\package.json" $Version
    Assert-JsonVersion ".\worker\package-lock.json" $Version
    Assert-CargoVersion ".\src-tauri\Cargo.toml" $Version
    Assert-CargoVersion ".\voice-app\src-tauri\Cargo.toml" $Version

    $TauriConfigPath = ".\src-tauri\tauri.conf.json"
    if (-not (Test-Path $TauriConfigPath)) {
        throw "Tauri configuration was not found."
    }

    $TauriConfig = Get-Content $TauriConfigPath -Raw | ConvertFrom-Json
    if ([string]$TauriConfig.version -ne $Version) {
        throw "tauri.conf.json version is not $Version."
    }

    $VoiceTauriConfig = Get-Content ".\voice-app\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    if ([string]$VoiceTauriConfig.version -ne $Version) {
        throw "voice-app tauri.conf.json version is not $Version."
    }

    $ExpectedEndpoint = "https://github.com/$ReleaseRepo/releases/latest/download/latest.json"
    $UpdaterEndpoint = [string]$TauriConfig.plugins.updater.endpoints[0]
    if ($UpdaterEndpoint -ne $ExpectedEndpoint) {
        throw "Updater endpoint mismatch. Expected: $ExpectedEndpoint"
    }

    if ([string]::IsNullOrWhiteSpace([string]$TauriConfig.plugins.updater.pubkey)) {
        throw "Updater public key is missing from tauri.conf.json."
    }

    if ($TauriConfig.bundle.createUpdaterArtifacts -ne $true) {
        throw 'bundle.createUpdaterArtifacts must be true.'
    }

    $LocalPublicKeyPath = ".\updater-keys\mhtalk-updater.pub"
    if (-not (Test-Path $LocalPublicKeyPath)) {
        throw "Local updater public key was not found: $LocalPublicKeyPath"
    }

    $LocalPublicKeyHash = (Get-FileHash $LocalPublicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($LocalPublicKeyHash -ne $ExpectedPublicKeyHash) {
        throw "Local updater public-key checksum mismatch."
    }

    if (-not (Test-Path ".\.env")) {
        throw ".env was not found. The signaling URL would be missing from the production build."
    }

    $EnvText = [IO.File]::ReadAllText((Resolve-Path ".\.env"))
    if ($EnvText -notmatch '(?m)^VITE_SIGNALING_URL=wss://mhlkotalk-signaling\.mhlkotalk\.workers\.dev\s*$') {
        throw "The expected production signaling URL was not found in .env."
    }

    Write-Host "2/12 Stopping running MHTalk processes and cleaning old build caches..." -ForegroundColor Cyan

    Stop-Process -Name mhtalk, MHTalkVoice -Force -ErrorAction SilentlyContinue
    Stop-ProjectNodeProcesses -RootPath $ProjectPath

    Repair-NpmLockfiles -RootPath $ProjectPath

    $env:npm_config_registry = $PublicNpmRegistry
    $env:npm_config_fetch_retries = "5"
    $env:npm_config_fetch_timeout = "300000"

    foreach ($path in @(
        ".\src-tauri\target",
        ".\voice-app\src-tauri\target",
        ".\node_modules\.vite",
        ".\voice-app\node_modules\.vite",
        ".\dist",
        ".\voice-app\dist"
    )) {
        Remove-DirectoryRobust -Path $path
    }

    Write-Host "3/12 Installing the locked dependencies from the public npm registry..." -ForegroundColor Cyan

    Test-PublicNpmRegistry
    Invoke-NpmCleanInstall -WorkingPath $ProjectPath -DisplayName "Root project"
    Invoke-NpmCleanInstall -WorkingPath (Join-Path $ProjectPath "voice-app") -DisplayName "MHTalkVoice"
    Invoke-NpmCleanInstall -WorkingPath (Join-Path $ProjectPath "worker") -DisplayName "Worker"

    Write-Host "4/12 Running the complete frontend, RTC, language and Worker verification..." -ForegroundColor Cyan

    & npm.cmd run verify
    Assert-ExitCode "Project verification failed."

    Write-Host "5/12 Building the required MHTalkVoice sidecar, then checking the Windows Rust backend..." -ForegroundColor Cyan

    & powershell.exe -ExecutionPolicy Bypass `
        -File ".\scripts\build-voice-sidecar.ps1" `
        -SkipInstall
    Assert-ExitCode "MHTalkVoice sidecar build failed."

    $SidecarPath = ".\src-tauri\binaries\MHTalkVoice-x86_64-pc-windows-msvc.exe"
    if (-not (Test-Path $SidecarPath)) {
        throw "The built MHTalkVoice sidecar was not found."
    }

    if ((Get-Item $SidecarPath).Length -lt 1MB) {
        throw "The built MHTalkVoice sidecar is unexpectedly small."
    }

    & cargo.exe check --locked --manifest-path ".\src-tauri\Cargo.toml"
    Assert-ExitCode "Windows Rust backend check failed."

    Write-Host "6/12 Downloading and decrypting the protected updater signing key..." -ForegroundColor Cyan

    $AuthResult = Invoke-GhCapture -Arguments @("auth", "status")
    if ($AuthResult.ExitCode -ne 0) {
        throw "GitHub CLI is not logged in.`n$($AuthResult.Output -join [Environment]::NewLine)"
    }

    & npm.cmd --prefix worker exec wrangler whoami
    Assert-ExitCode "Wrangler is not authenticated for the Cloudflare Worker deployment."

    $EncryptedBackupPath = Join-Path $TempRoot "MHTalk-Updater-Recovery.tar.gz.enc"
    $RecoveryArchivePath = Join-Path $TempRoot "MHTalk-Updater-Recovery.tar.gz"
    $ExtractFolder = Join-Path $TempRoot "recovery"
    New-Item -ItemType Directory -Path $ExtractFolder -Force | Out-Null

    $DownloadResult = Invoke-GhCapture -Arguments @(
        "api",
        "repos/$RecoveryRepo/contents/MHTalk-Updater-Recovery.tar.gz.enc",
        "--jq",
        ".content"
    )

    if ($DownloadResult.ExitCode -ne 0) {
        throw "Failed to download the encrypted updater-key backup.`n$($DownloadResult.Output -join [Environment]::NewLine)"
    }

    $EncodedBackup = ($DownloadResult.Output -join "") -replace "\s", ""
    [IO.File]::WriteAllBytes(
        $EncryptedBackupPath,
        [Convert]::FromBase64String($EncodedBackup)
    )

    $SecureRecoveryPassword = Read-Host "Paste the Recovery password saved in Telegram" -AsSecureString
    $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureRecoveryPassword)
    try {
        $RecoveryPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    }

    if ([string]::IsNullOrWhiteSpace($RecoveryPassword)) {
        throw "Recovery password is empty."
    }

    $PasswordFile = Join-Path $TempRoot "recovery-password.txt"
    [IO.File]::WriteAllText($PasswordFile, $RecoveryPassword, $Utf8NoBom)

    & $OpenSsl enc `
        -d `
        -aes-256-cbc `
        -pbkdf2 `
        -iter 200000 `
        -md sha256 `
        -pass ("file:" + $PasswordFile) `
        -in $EncryptedBackupPath `
        -out $RecoveryArchivePath

    $DecryptCode = $LASTEXITCODE
    Remove-Item $PasswordFile -Force -ErrorAction SilentlyContinue
    $RecoveryPassword = $null

    if ($DecryptCode -ne 0) {
        throw "Could not decrypt the updater-key backup. Check the Recovery password."
    }

    & tar.exe -xzf $RecoveryArchivePath -C $ExtractFolder
    Assert-ExitCode "Could not extract the updater-key recovery archive."

    $PrivateKeyPath = Join-Path $ExtractFolder "mhtalk-updater-private.key"
    $RecoveredPublicKeyPath = Join-Path $ExtractFolder "mhtalk-updater-public.key.pub"
    $PrivateKeyPasswordPath = Join-Path $ExtractFolder "TAURI_SIGNING_PRIVATE_KEY_PASSWORD.txt"

    foreach ($requiredFile in @(
        $PrivateKeyPath,
        $RecoveredPublicKeyPath,
        $PrivateKeyPasswordPath
    )) {
        if (-not (Test-Path $requiredFile)) {
            throw "A required recovery file is missing: $requiredFile"
        }
    }

    $RecoveredPublicKeyHash = (Get-FileHash $RecoveredPublicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($RecoveredPublicKeyHash -ne $ExpectedPublicKeyHash) {
        throw "Recovered public-key checksum mismatch. Build stopped for safety."
    }

    $PrivateKeyContent = [IO.File]::ReadAllText($PrivateKeyPath).Trim()
    $PrivateKeyPassword = [IO.File]::ReadAllText($PrivateKeyPasswordPath).Trim()

    $env:TAURI_SIGNING_PRIVATE_KEY = $PrivateKeyContent
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $PrivateKeyPassword

    Write-Host "7/12 Building and signing the complete Windows NSIS installer..." -ForegroundColor Cyan

    & npm.cmd run tauri:build -- --bundles nsis
    Assert-ExitCode "The signed MHTalk Windows build failed."

    $NsisFolder = Join-Path $ProjectPath "src-tauri\target\release\bundle\nsis"
    $InstallerName = "MHTalk_${Version}_x64-setup.exe"
    $InstallerPath = Join-Path $NsisFolder $InstallerName
    $SignaturePath = "$InstallerPath.sig"

    if (-not (Test-Path $InstallerPath)) {
        throw "Installer was not found: $InstallerPath"
    }

    if (-not (Test-Path $SignaturePath)) {
        throw "Updater signature was not found: $SignaturePath"
    }

    if ((Get-Item $InstallerPath).Length -lt 1MB) {
        throw "The installer file is unexpectedly small."
    }

    if ((Get-Item $SignaturePath).Length -lt 100) {
        throw "The updater signature file is unexpectedly small."
    }

    Write-Host "8/12 Creating latest.json for automatic updates..." -ForegroundColor Cyan

    $SignatureContent = [IO.File]::ReadAllText($SignaturePath).Trim()
    $InstallerUrl = "https://github.com/$ReleaseRepo/releases/download/$Tag/$InstallerName"
    $LatestJsonPath = Join-Path $NsisFolder "latest.json"

    $LatestObject = [ordered]@{
        version = $Version
        notes = $ReleaseNotesContent
        pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        platforms = [ordered]@{
            "windows-x86_64" = [ordered]@{
                signature = $SignatureContent
                url = $InstallerUrl
            }
        }
    }

    [IO.File]::WriteAllText(
        $LatestJsonPath,
        ($LatestObject | ConvertTo-Json -Depth 20),
        $Utf8NoBom
    )

    $LocalLatest = Get-Content $LatestJsonPath -Raw | ConvertFrom-Json
    if ([string]$LocalLatest.version -ne $Version) {
        throw "The generated latest.json has the wrong version."
    }

    if ([string]$LocalLatest.platforms.'windows-x86_64'.url -ne $InstallerUrl) {
        throw "The generated latest.json has the wrong installer URL."
    }

    Write-Host "9/12 Creating or continuing the GitHub draft release..." -ForegroundColor Cyan

    $ReleaseCheck = Invoke-GhCapture -Arguments @(
        "release", "view", $Tag,
        "--repo", $ReleaseRepo,
        "--json", "isDraft",
        "--jq", ".isDraft"
    )

    $ReleaseExists = ($ReleaseCheck.ExitCode -eq 0)

    if (-not $ReleaseExists) {
        $CreateResult = Invoke-GhCapture -Arguments @(
            "release", "create", $Tag,
            "--repo", $ReleaseRepo,
            "--target", "main",
            "--title", "MHTalk v$Version",
            "--notes-file", $ReleaseNotesPath,
            "--draft"
        )

        if ($CreateResult.ExitCode -ne 0) {
            throw "Failed to create the GitHub draft release.`n$($CreateResult.Output -join [Environment]::NewLine)"
        }
    }
    else {
        $IsDraftText = ($ReleaseCheck.Output -join "").Trim().ToLowerInvariant()
        if ($IsDraftText -ne "true") {
            throw "GitHub Release $Tag already exists and is already published. It was not overwritten."
        }
    }

    Write-Host "10/12 Uploading the installer, signature and latest.json..." -ForegroundColor Cyan

    foreach ($asset in @($InstallerPath, $SignaturePath, $LatestJsonPath)) {
        $UploadResult = Invoke-GhCapture -Arguments @(
            "release", "upload", $Tag,
            $asset,
            "--repo", $ReleaseRepo,
            "--clobber"
        )

        if ($UploadResult.ExitCode -ne 0) {
            throw "Failed to upload $asset.`n$($UploadResult.Output -join [Environment]::NewLine)"
        }
    }

    $AssetsResult = Invoke-GhCapture -Arguments @(
        "release", "view", $Tag,
        "--repo", $ReleaseRepo,
        "--json", "assets",
        "--jq", ".assets[].name"
    )

    if ($AssetsResult.ExitCode -ne 0) {
        throw "Could not verify the uploaded GitHub assets."
    }

    $UploadedNames = @($AssetsResult.Output | ForEach-Object { ([string]$_).Trim() })
    foreach ($requiredAsset in @(
        $InstallerName,
        ([IO.Path]::GetFileName($SignaturePath)),
        "latest.json"
    )) {
        if ($UploadedNames -notcontains $requiredAsset) {
            throw "Missing GitHub Release asset: $requiredAsset"
        }
    }

    Write-Host "11/12 Deploying and verifying the $Version signaling Worker..." -ForegroundColor Cyan

    & npm.cmd --prefix worker run deploy
    Assert-ExitCode "Cloudflare Worker deployment failed. The GitHub release remains a safe draft."

    $WorkerStatus = $null
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            $WorkerStatus = Invoke-RestMethod -Uri $WorkerEndpoint
            if ([string]$WorkerStatus.version -eq $Version) {
                break
            }
        }
        catch {
            if ($attempt -eq 6) {
                throw
            }
        }
        Start-Sleep -Seconds ($attempt * 3)
    }

    if ($null -eq $WorkerStatus -or [string]$WorkerStatus.version -ne $Version) {
        throw "The deployed signaling Worker does not report version $Version. The GitHub release remains a safe draft."
    }

    Write-Host "12/12 Publishing v$Version as the Latest release and verifying the updater..." -ForegroundColor Cyan

    $PublishResult = Invoke-GhCapture -Arguments @(
        "release", "edit", $Tag,
        "--repo", $ReleaseRepo,
        "--title", "MHTalk v$Version",
        "--notes-file", $ReleaseNotesPath,
        "--draft=false",
        "--prerelease=false",
        "--latest"
    )

    if ($PublishResult.ExitCode -ne 0) {
        throw "Failed to publish the GitHub release.`n$($PublishResult.Output -join [Environment]::NewLine)"
    }

    $LatestEndpoint = "https://github.com/$ReleaseRepo/releases/latest/download/latest.json"
    $PublishedJson = $null

    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            $PublishedJson = Invoke-RestMethod -Uri $LatestEndpoint
            if ([string]$PublishedJson.version -eq $Version) {
                break
            }
        }
        catch {
            if ($attempt -eq 6) {
                throw
            }
        }

        Start-Sleep -Seconds ($attempt * 3)
    }

    if ($null -eq $PublishedJson -or [string]$PublishedJson.version -ne $Version) {
        throw "The public latest.json endpoint does not report version $Version."
    }

    if ([string]$PublishedJson.platforms.'windows-x86_64'.url -ne $InstallerUrl) {
        throw "The public latest.json endpoint contains the wrong installer URL."
    }

    $InstallerHash = (Get-FileHash $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()

    Write-Host ""
    Write-Host "SUCCESS - MHTalk v$Version was built, signed and published." -ForegroundColor Green
    Write-Host ""
    Write-Host "Installer:"
    Write-Host $InstallerUrl
    Write-Host ""
    Write-Host "Automatic updater endpoint:"
    Write-Host $LatestEndpoint
    Write-Host ""
    Write-Host "Installer SHA-256:"
    Write-Host $InstallerHash
    Write-Host ""
    Write-Host "Older installed MHTalk clients can now detect and install $Version automatically."
}
finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $OldPrivateKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $OldPrivateKeyPassword
    $env:npm_config_registry = $OldNpmRegistry
    $env:npm_config_fetch_retries = $OldNpmFetchRetries
    $env:npm_config_fetch_timeout = $OldNpmFetchTimeout

    if (Get-Variable PrivateKeyContent -ErrorAction SilentlyContinue) {
        $PrivateKeyContent = $null
    }
    if (Get-Variable PrivateKeyPassword -ErrorAction SilentlyContinue) {
        $PrivateKeyPassword = $null
    }
    if (Get-Variable RecoveryPassword -ErrorAction SilentlyContinue) {
        $RecoveryPassword = $null
    }

    if (Test-Path $TempRoot) {
        Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
