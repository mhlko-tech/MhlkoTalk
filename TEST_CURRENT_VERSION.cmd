@echo off
setlocal EnableExtensions
cd /d "%~dp0"
where npm.cmd >nul 2>nul || goto :missing_node
where cargo.exe >nul 2>nul || goto :missing_rust
where powershell.exe >nul 2>nul || goto :missing_powershell

for /f "usebackq delims=" %%V in (`node.exe -p "require('./package.json').version"`) do set "APP_VERSION=%%V"
if not defined APP_VERSION goto :invalid_version
title MHTalk %APP_VERSION% - Verify and Run Test Build

set "EXIT_CODE=0"
set "npm_config_registry=https://registry.npmjs.org/"
set "npm_config_fetch_retries=5"
set "npm_config_fetch_timeout=300000"

echo [1/9] Stopping old MHTalk processes and cleaning generated files...
taskkill /F /IM mhtalk.exe >nul 2>nul
taskkill /F /IM MHTalkVoice.exe >nul 2>nul
if exist "dist" rmdir /s /q "dist"
if exist "voice-app\dist" rmdir /s /q "voice-app\dist"
if exist "node_modules\.vite" rmdir /s /q "node_modules\.vite"
if exist "voice-app\node_modules\.vite" rmdir /s /q "voice-app\node_modules\.vite"

echo [2/9] Repairing and verifying Cargo.lock dependency versions...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair-cargo-locks.ps1" -ProjectPath "%~dp0."
if errorlevel 1 goto :failed

echo [3/9] Installing locked main dependencies...
call npm.cmd ci --registry=https://registry.npmjs.org/ --fetch-retries=5 --fetch-timeout=300000 --no-fund --no-audit
if errorlevel 1 goto :failed

echo [4/9] Installing locked MHTalkVoice dependencies...
call npm.cmd --prefix voice-app ci --registry=https://registry.npmjs.org/ --fetch-retries=5 --fetch-timeout=300000 --no-fund --no-audit
if errorlevel 1 goto :failed

echo [5/9] Installing locked Worker dependencies...
call npm.cmd --prefix worker ci --registry=https://registry.npmjs.org/ --fetch-retries=5 --fetch-timeout=300000 --no-fund --no-audit
if errorlevel 1 goto :failed

echo [6/9] Running all TypeScript, i18n, RTC, architecture and production checks...
call npm.cmd run verify
if errorlevel 1 goto :failed

echo [7/9] Building the isolated MHTalkVoice sidecar required by the main Tauri application...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-voice-sidecar.ps1" -SkipInstall
if errorlevel 1 goto :failed
if not exist "%~dp0src-tauri\binaries\MHTalkVoice-x86_64-pc-windows-msvc.exe" goto :missing_sidecar

echo [8/9] Checking the Windows Rust backend after the required sidecar exists...
cargo.exe check --manifest-path "%~dp0src-tauri\Cargo.toml"
if errorlevel 1 goto :failed

echo [9/9] Starting MHTalk %APP_VERSION% test build...
call npm.cmd run tauri:dev
set "EXIT_CODE=%ERRORLEVEL%"
goto :done

:missing_node
echo ERROR: Node.js/npm was not found in PATH.
set "EXIT_CODE=2"
goto :done

:missing_rust
echo ERROR: Rust/Cargo was not found in PATH.
set "EXIT_CODE=3"
goto :done

:missing_powershell
echo ERROR: Windows PowerShell was not found.
set "EXIT_CODE=4"
goto :done

:invalid_version
echo ERROR: Could not read the MHTalk version from package.json.
set "EXIT_CODE=6"
goto :done

:missing_sidecar
echo ERROR: MHTalkVoice sidecar was not created at:
echo %~dp0src-tauri\binaries\MHTalkVoice-x86_64-pc-windows-msvc.exe
set "EXIT_CODE=5"
goto :done

:failed
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo MHTalk %APP_VERSION% test preparation failed. Exit code: %EXIT_CODE%

:done
echo.
pause
exit /b %EXIT_CODE%
