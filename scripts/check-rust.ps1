$ErrorActionPreference = 'Stop'

$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
$cargoPath = if ($cargoCommand) {
  $cargoCommand.Source
} else {
  Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}

if (!(Test-Path -LiteralPath $cargoPath)) {
  throw 'Rust Cargo is required. Install the stable x86_64-pc-windows-msvc toolchain with rustup.'
}

& $cargoPath check --manifest-path 'src-tauri\Cargo.toml' --locked
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $cargoPath check --manifest-path 'voice-app\src-tauri\Cargo.toml' --locked
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Main and voice Rust checks passed.'
