@echo off
setlocal
title Tarot ClawBot - GitHub Pages + Local API Tunnel
cd /d "%~dp0"
echo Starting the public H5 link with the local ClawBot backend.
echo Keep this computer awake and this window open while people use draw links.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-stack.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo ClawBot startup failed with exit code %EXIT_CODE%.
  echo Check the message above and keep this window open while diagnosing.
  pause
)
endlocal & exit /b %EXIT_CODE%
