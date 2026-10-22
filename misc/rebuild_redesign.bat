@echo off
setlocal
REM Shared build entry point for the root launcher and both tray hosts.
REM A normal Bun install can report "no changes" while a shared-store dependency link is
REM missing (vue-router -> @vue/devtools-api). Force reinstall the LOCKED versions to repair
REM those links and support a first-run checkout, then run the web checks and build.
REM This helper runs hidden behind the tray: return failures without pausing for keyboard input.
cd /d "%~dp0.."
call bun install --cwd src/web --frozen-lockfile --force
if errorlevel 1 (
  echo.
  echo Dependency install FAILED - see the output above.
  exit /b 1
)
call npm run build:web
if errorlevel 1 (
  echo.
  echo Build FAILED - see the output above.
  exit /b 1
)

exit /b 0
