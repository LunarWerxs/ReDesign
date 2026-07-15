# RēDesign system-tray host (Windows). Thin adapter over the shared Tray-Host engine (misc/Tray-Host.ps1). This file owns
# only what's genuinely ReDesign-specific: it builds a $TrayConfig hashtable (see the
# engine's header comment for the full per-key contract), dot-sources the engine, then
# hands off to Invoke-TrayHostSelfTest / Start-TrayHost. Launch it via Tray-Launch.vbs
# (which auto-discovers the sibling *-Tray.ps1 and runs it hidden) so there's no console
# flash; the port comes from this file's own param() default, not the .vbs. Lives in misc/,
# so the project root is one level up.
#
# ReDesign's divergences from the shared engine defaults (see the engine header for the
# full documented list):
#   - ServiceName 'redesign': health check requires body.ok AND body.service=='redesign'.
#   - Shutdown: force-kill only (no HTTP token) — ShutdownTokenEnvVar/ShutdownHeaderPrefix
#     are left unset, so the engine takes the port-sweep branch.
#   - Sentinel: shutdown.request under $rdHome, so a web-UI "Shut Down" / `redesign stop`
#     tears the WHOLE tray down, not just the daemon.
#   - OnStrayDaemon 'warn': a listening port without OUR tray means a headless orphan —
#     refuse to host rather than silently adopting it (the other family members 'attach').
#   - Mutex: hashed per-checkout Local\redesign.tray.<sha16> (computed below) so a second
#     checkout of this repo on the same machine gets its own tray host.
#   - RebuildCommand: a resolver scriptblock — misc\Rebuild.bat first (it skips `npm
#     install` on every rebuild since node_modules is already present), else `npm run
#     build`.
#   - RestartRetries 1 / UsePortFreeWait $true: one extra restart attempt after a failed
#     bind, waiting for the port to actually free first (Windows can hold the socket a
#     moment after a force-kill).
param([int]$Port = 5178, [switch]$SelfTest)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir

# Runtime home (honours REDESIGN_HOME, like the daemon does).
$rdHome = if ($env:REDESIGN_HOME) { $env:REDESIGN_HOME } else { Join-Path $env:USERPROFILE ".redesign" }

# Per-checkout mutex: hash the resolved project root so a second checkout on this machine
# gets its own tray host instead of colliding on a fixed global name.
$rootId = (Resolve-Path -LiteralPath $root).Path.ToLowerInvariant()
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $hash = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($rootId))).Replace('-', '').Substring(0, 16)
} finally {
  $sha.Dispose()
}

# "Rebuild & Restart" command resolver: a standalone misc\Rebuild.bat if present (it skips
# `npm install` on every rebuild since node_modules is already there), else `npm run build`
# when package.json declares a build script, else $null (no rebuild support). Passed to the
# engine as-is (a scriptblock(appRoot, scriptDir) resolver); also reused directly below for
# the first-run bootstrap.
$RebuildResolver = {
  param($appRoot, $appScriptDir)
  $rebuildBat = Join-Path $appScriptDir "Rebuild.bat"
  if (Test-Path $rebuildBat) { return "`"$rebuildBat`"" }
  $packageJson = Join-Path $appRoot "package.json"
  if (Test-Path $packageJson) {
    try {
      $pkg = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
      if ($pkg.scripts -and $pkg.scripts.build) { return "npm run build" }
    } catch { return $null }
  }
  return $null
}

# First run (blocking, once, at cold start): build the web UI if the production bundle is
# missing. The tray icon is already visible by the time the engine runs this, so the app
# doesn't look hung.
$FirstRunBootstrap = {
  param($appRoot)
  if (Test-Path (Join-Path $appRoot 'src\web\dist\index.html')) { return }
  $bc = & $RebuildResolver $appRoot $scriptDir
  if (-not $bc) { return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c cd /d `"$appRoot`" && $bc > `"$(Join-Path $scriptDir 'ReDesign-Rebuild.log')`" 2>&1"
  $psi.WorkingDirectory = $appRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = "Hidden"
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
}

$TrayConfig = @{
  ScriptDir            = $scriptDir
  Root                 = $root
  DisplayName          = "RēDesign"
  ServiceName          = "redesign"
  IconFile             = "ReDesign.ico"
  Port                 = $Port
  InfoFile             = Join-Path $rdHome "runtime.json"
  DaemonLogPath        = Join-Path $rdHome "logs\daemon.log"
  StartCommand         = "bun run src\index.ts serve"
  EntryFile            = "src\index.ts"
  FirstRun             = $FirstRunBootstrap
  RebuildCommand       = $RebuildResolver
  RebuildLogName       = "ReDesign-Rebuild.log"
  # "Rebuild & Restart" only shows when REDESIGN_DEV=1 (public users rebuild via misc\Rebuild.bat).
  IsDevTree            = ($env:REDESIGN_DEV -eq "1")
  SentinelFile         = Join-Path $rdHome "shutdown.request"
  OnStrayDaemon        = "warn"
  SelfTestMarker       = "REDESIGN_TRAY_SELFTEST"
  MenuOpenLabel        = "Open RēDesign"
  MutexName            = "Local\redesign.tray.$hash"
  RestartRetries       = 1
  UsePortFreeWait      = $true
}

. (Join-Path $scriptDir "Tray-Host.ps1")

if ($SelfTest) {
  Invoke-TrayHostSelfTest $TrayConfig
} else {
  Start-TrayHost $TrayConfig
}
