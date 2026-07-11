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
echo Preferred port: %PORT% ^(hops to a free one if that's busy^)
echo.
echo Leave this window open while you use it. Press Ctrl+C here to stop.
echo.

rem The server may hop past %PORT% if something else holds it, so resolve the URL to open from
rem the runtime pointer it writes (~/.redesign/runtime.json), falling back to the preferred port.
rem Factored into misc\Open-Ui.ps1 (rather than an inline one-liner) so it can also honour
rem portableMode (opens a chromeless Edge/Chrome --app= window instead of a normal tab).
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "misc\Open-Ui.ps1" -Port %PORT%
bun run src\index.ts serve
