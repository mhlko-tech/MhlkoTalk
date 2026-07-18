@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

title MHTalk 0.9.2 - One Click GitHub Release

echo.
echo ============================================================
echo        MHTalk 0.9.2 - BUILD, SIGN AND PUBLISH
echo ============================================================
echo.
echo The old GitHub main is preserved automatically.
echo During signing, paste the Recovery password saved in Telegram.
echo Keep this window open until SUCCESS appears.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0MHTalk_0.9.2_Full_Build_And_Publish.ps1" ^
  -ProjectPath "%~dp0."

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
    echo FAILED: MHTalk 0.9.2 was not fully published.
    echo Read the error shown above.
) else (
    echo SUCCESS: MHTalk 0.9.2 was built, signed and published.
)
echo.
pause
exit /b %EXIT_CODE%
