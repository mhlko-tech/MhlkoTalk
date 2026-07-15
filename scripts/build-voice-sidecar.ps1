param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$voiceRoot = Join-Path $root "voice-app"
$voiceManifest = Join-Path $voiceRoot "src-tauri\Cargo.toml"
$binaryDir = Join-Path $root "src-tauri\binaries"

if (!(Get-Command rustc -ErrorAction SilentlyContinue)) {
  throw "Rust (rustc/cargo) is required to build MHTalkVoice. Install the Rust MSVC toolchain first."
}
if (!(Test-Path $voiceManifest)) {
  throw "MHTalkVoice Cargo.toml was not found: $voiceManifest"
}

if (!$SkipInstall) {
  & npm.cmd --prefix $voiceRoot install
}

Push-Location $voiceRoot
try {
  & npm.cmd run build
  & npm.cmd run tauri:build
} finally {
  Pop-Location
}

$hostLine = (& rustc -vV | Select-String '^host:').Line
if (!$hostLine) { throw "Could not determine the Rust host target." }
$targetTriple = ($hostLine -replace '^host:\s*', '').Trim()
$extension = if ($targetTriple -match 'windows') { '.exe' } else { '' }

$candidates = @(
  (Join-Path $voiceRoot "src-tauri\target\release\mhtalk-voice$extension"),
  (Join-Path $voiceRoot "src-tauri\target\release\MHTalkVoice$extension")
)
$sourceBinary = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$sourceBinary) {
  throw "MHTalkVoice release binary was not found. Checked: $($candidates -join ', ')"
}

New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null
$destination = Join-Path $binaryDir "MHTalkVoice-$targetTriple$extension"
Copy-Item -Force $sourceBinary $destination

Write-Host "MHTalkVoice sidecar ready:" -ForegroundColor Green
Write-Host $destination
