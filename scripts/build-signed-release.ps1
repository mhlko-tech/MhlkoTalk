param(
    [string]$ProjectRoot = "C:\Dev\MHTalk Remake",
    [string]$Version = "1.2.0"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectPath = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
$passwordPath = Join-Path $projectPath "updater-recovery-password.txt"
$temporaryBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\")
$temporaryRoot = Join-Path $temporaryBase ("MHTalk_Signing_" + [Guid]::NewGuid().ToString("N"))
$encryptedPath = Join-Path $temporaryRoot "MHTalk-Updater-Recovery.tar.gz.enc"
$archivePath = Join-Path $temporaryRoot "MHTalk-Updater-Recovery.tar.gz"
$extractPath = Join-Path $temporaryRoot "recovery"
$expectedPublicKeyHash = "48b5ffef28bb94d06407c8e112ce88eb4b5dca8cecc435d892c1b9a5625f7b3e"
$openSslPath = "C:\Program Files\Git\usr\bin\openssl.exe"
$buildSucceeded = $false

if (-not (Test-Path -LiteralPath $passwordPath)) {
    throw "Updater recovery password file is missing."
}
$recoveryPassword = (Get-Content -LiteralPath $passwordPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($recoveryPassword) -or $recoveryPassword -eq "PASTE_RECOVERY_PASSWORD_HERE") {
    throw "Updater recovery password file is not populated."
}
if (-not (Test-Path -LiteralPath $openSslPath)) {
    throw "OpenSSL was not found."
}

New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
try {
    $encodedBackup = (& gh api "repos/mhlko-tech/MHTalk-Recovery/contents/MHTalk-Updater-Recovery.tar.gz.enc" --jq ".content") -join ""
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($encodedBackup)) {
        throw "Could not download updater recovery archive."
    }
    [IO.File]::WriteAllBytes($encryptedPath, [Convert]::FromBase64String(($encodedBackup -replace "\s", "")))

    & $openSslPath enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 `
        -pass ("file:" + $passwordPath) -in $encryptedPath -out $archivePath
    if ($LASTEXITCODE -ne 0) {
        throw "Updater recovery archive decryption failed."
    }

    & tar.exe -xzf $archivePath -C $extractPath
    if ($LASTEXITCODE -ne 0) {
        throw "Updater recovery archive extraction failed."
    }

    $privateKeyPath = Join-Path $extractPath "mhtalk-updater-private.key"
    $publicKeyPath = Join-Path $extractPath "mhtalk-updater-public.key.pub"
    $privateKeyPasswordPath = Join-Path $extractPath "TAURI_SIGNING_PRIVATE_KEY_PASSWORD.txt"
    foreach ($requiredPath in @($privateKeyPath, $publicKeyPath, $privateKeyPasswordPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath)) {
            throw "Updater recovery archive is incomplete."
        }
    }

    $actualHash = (Get-FileHash -LiteralPath $publicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedPublicKeyHash) {
        throw "Updater public key checksum mismatch."
    }

    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $privateKeyPath -Raw).Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -LiteralPath $privateKeyPasswordPath -Raw).Trim()

    Push-Location $projectPath
    try {
        & npm.cmd run tauri -- build --bundles nsis
        if ($LASTEXITCODE -ne 0) {
            throw "Signed Windows build failed."
        }
    }
    finally {
        Pop-Location
    }

    $installerPath = Join-Path $projectPath "src-tauri\target\release\bundle\nsis\MHTalk_${Version}_x64-setup.exe"
    $signaturePath = "$installerPath.sig"
    if (-not (Test-Path -LiteralPath $installerPath) -or -not (Test-Path -LiteralPath $signaturePath)) {
        throw "Signed installer artifacts are incomplete."
    }

    $resolvedPasswordPath = [IO.Path]::GetFullPath($passwordPath)
    $projectPrefix = $projectPath + "\"
    if (-not $resolvedPasswordPath.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a password outside the project directory."
    }
    Remove-Item -LiteralPath $resolvedPasswordPath -Force
    $buildSucceeded = $true

    [pscustomobject]@{
        Installer = $installerPath
        Size = (Get-Item -LiteralPath $installerPath).Length
        Signature = (Test-Path -LiteralPath $signaturePath)
    }
}
finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $null
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $null
    $recoveryPassword = $null

    $resolvedTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot).TrimEnd("\")
    $temporaryPrefix = $temporaryBase + "\"
    if ($resolvedTemporaryRoot.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedTemporaryRoot)) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
    if (-not $buildSucceeded) {
        Write-Warning "The local recovery password file was kept so the build can be retried."
    }
}
