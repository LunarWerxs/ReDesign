@echo off
rem The one-step launcher for RēDesign.
cd /d "%~dp0"

rem Make sure the root has its clickable tray shortcut (a fresh clone won't).
rem Create-Shortcut.ps1 also deletes a stale "Reimagine.lnk" left over from before the rename.
if not exist "RēDesign.lnk" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "misc\Create-Shortcut.ps1" >nul 2>nul
)

set "PORT=5178"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /I "%%A"=="PORT" set "PORT=%%B"
  )
)

where bun >nul 2>nul
if errorlevel 1 (
  echo.
  echo Bun was not found. Install Bun 1.1.0 or newer:
  echo https://bun.sh
  echo.
  pause
  exit /b 1
)

if not exist "src\web\dist\index.html" (
  echo.
  echo Building the web UI for the first time ^(this can take a minute^)...
  call npm run build
)

echo.
echo Starting RēDesign...
echo UI: http://127.0.0.1:%PORT%/
echo.
echo Leave this window open while you use it. Press Ctrl+C here to stop.
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"
bun run src\index.ts serve
