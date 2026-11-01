@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1" %*
if errorlevel 1 (
  echo Uninstall failed. Check the ownership message above.
  pause
  exit /b 1
)
pause
