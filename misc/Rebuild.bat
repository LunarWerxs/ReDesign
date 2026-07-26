@echo off
REM Fast web rebuild for ReDesign's tray "Rebuild & Restart".
REM
REM Builds src\web\dist via the root "build:web" script (check:i18n + vite build) WITHOUT the
REM redundant `npm install` that plain `npm run build` runs on EVERY rebuild. node_modules is
REM already present after first-run setup, so the install is pure overhead (and if it ever hiccups
REM the tray reports "Build failed" and does NOT restart -> looks like the app won't start).
REM
REM The tray's Get-BuildCommand auto-prefers this file over `npm run build`, so dropping it in is the
REM whole change. It runs headless (output -> misc\ReDesign-Rebuild.log); the exit code is
REM propagated so a failed build is still reported. Kept pure-ASCII (no macron) so cmd.exe never
REM mangles it. Successful builds exit immediately; failed builds pause so the error stays visible.
cd /d "%~dp0.."
call npm run build:web
if errorlevel 1 (
  echo.
  echo Build FAILED - see the output above.
  pause
  exit /b 1
)

exit /b 0
