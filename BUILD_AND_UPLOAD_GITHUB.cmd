@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

title MHTalk - Build and publish to GitHub

where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Windows PowerShell was not found.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0BUILD_AND_PUBLISH.ps1" (
    echo.
    echo ERROR: BUILD_AND_PUBLISH.ps1 was not found beside this file.
    echo.
    pause
    exit /b 1
)

echo.
echo MHTalk build, signing, and GitHub publishing
echo Project: %~dp0
echo.
echo You may be asked for the updater Recovery password during signing.
echo Do not close this window until SUCCESS appears.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD_AND_PUBLISH.ps1" -ProjectPath "%~dp0."
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%BUILD_EXIT_CODE%"=="0" (
    echo MHTalk build or GitHub publishing failed. Exit code: %BUILD_EXIT_CODE%
    echo Review the error above; no incomplete release will be published.
) else (
    echo SUCCESS: MHTalk was built, signed, uploaded, and published to GitHub.
)
echo.
pause
exit /b %BUILD_EXIT_CODE%
