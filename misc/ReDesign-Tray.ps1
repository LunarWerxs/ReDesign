# RēDesign system-tray host (Windows). Runs the Bun daemon with NO console window
# and shows a tray icon with Open / Rebuild & Restart / Restart / Quit. Launch it
# via Reimagine.vbs (which sets the port) so there's no console flash. This script
# lives in misc/, so the project root is one level up.
#
# Responsiveness: "Rebuild & Restart" and "Restart" run their slow work (npm build,
# kill, port wait, readiness poll) on a BACKGROUND runspace, and a WinForms timer
# marshals the result back to the UI thread. The tray stays responsive the whole
# time instead of freezing (and showing "Not Responding") for the ~10-20s the work
# takes. Server control is stateless, it finds/kills whatever owns the port rather
# than tracking a Process object, so it works identically on the UI thread and in
# the worker runspace, and survives repeated restarts.
param([int]$Port = 5178)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root
$port = $Port
$env:PORT = "$Port"   # RēDesign's loadEnv won't override an already-set var
$url = "http://127.0.0.1:$port"
$script:trayMutex = $null
$script:ownsTrayMutex = $false

function Release-TrayMutex {
  if ($script:ownsTrayMutex -and $script:trayMutex) {
    try { $script:trayMutex.ReleaseMutex() } catch {}
  }
  if ($script:trayMutex) {
    try { $script:trayMutex.Dispose() } catch {}
  }
  $script:trayMutex = $null
  $script:ownsTrayMutex = $false
}

# --- Server control ---------------------------------------------------------------
# Defined once as a scriptblock so the exact same functions run on the UI thread
# (launch, quit) AND inside the background worker runspace (rebuild, restart). All
# of them are stateless: they work off the port, using only core .NET + built-in
# tools, so nothing here depends on WinForms or a shared Process handle.
$ServerControl = {
  # Is anything LISTENING on this port? Pure .NET, no module dependency, so it works
  # in a fresh runspace where Get-NetTCPConnection may not be auto-loaded.
  function Test-PortListening([int]$p) {
    try {
      foreach ($ep in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
        if ($ep.Port -eq $p) { return $true }
      }
    } catch {}
    return $false
  }
  # PIDs of processes LISTENING on the port (via netstat, which is always present).
  # Plain `netstat -ano` (no `-p tcp`) so IPv4 AND IPv6 listeners are both included.
  function Get-PortPids([int]$p) {
    $ids = @()
    try {
      foreach ($line in (& netstat -ano 2>$null)) {
        $t = $line.Trim()
        if ($t -notmatch 'LISTENING') { continue }
        $parts = $t -split '\s+'
        if ($parts.Length -ge 5 -and $parts[1] -match (':' + $p + '$') -and $parts[4] -match '^\d+$') {
          $ids += [int]$parts[4]
        }
      }
    } catch {}
    return ($ids | Select-Object -Unique)
  }
  function Stop-Server([int]$p) {
    foreach ($procId in (Get-PortPids $p)) {
      if ($procId -gt 0) { & taskkill /PID $procId /T /F 2>$null | Out-Null }
    }
  }
  # Wait for the listen socket to actually release after a force-kill (Windows can
  # hold it briefly), so the new instance doesn't lose the port race.
  function Wait-PortFree([int]$p, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
      if (-not (Test-PortListening $p)) { return $true }
      Start-Sleep -Milliseconds 150
    }
    return $false
  }
  function Wait-Ready([int]$p, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
      if (Test-PortListening $p) { return $true }
      Start-Sleep -Milliseconds 200
    }
    return $false
  }
  function Start-Server([string]$appRoot, [int]$p) {
    $env:PORT = "$p"
    # bun on Windows is an npm shim (bun.cmd / bun.ps1) with no bare bun.exe, the Win32
    # CreateProcess used by UseShellExecute=$false does NOT do PATHEXT resolution, so
    # FileName="bun" throws "cannot find the file specified" (silently swallowed here), the
    # server never starts, and the browser opens onto nothing → ERR_CONNECTION_REFUSED. Launch
    # through cmd.exe /c (which DOES resolve bun.cmd), matching the build command above and
    # RepoYeti's tray. PORT rides the inherited environment.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c bun run src\index.ts serve"
    $psi.WorkingDirectory = $appRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = "Hidden"
    return [System.Diagnostics.Process]::Start($psi)
  }
}
. $ServerControl   # make the functions available on the UI thread

# The shortcut is only allowed to open/run RēDesign when this tray host owns the
# per-project mutex. A listening port without the mutex means the server is running
# headless, so the shortcut refuses to continue instead of hiding the problem.
try {
  $rootId = (Resolve-Path -LiteralPath $root).Path.ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($rootId))).Replace('-', '').Substring(0, 16)
  } finally {
    $sha.Dispose()
  }
  $script:trayMutex = New-Object System.Threading.Mutex($false, "Local\redesign.tray.$hash")
  try {
    $script:ownsTrayMutex = $script:trayMutex.WaitOne(0, $false)
  } catch [System.Threading.AbandonedMutexException] {
    $script:ownsTrayMutex = $true
  }
} catch {
  [System.Windows.Forms.MessageBox]::Show("RēDesign could not verify that the tray host is available. It will not start without the tray icon.", "RēDesign") | Out-Null
  Release-TrayMutex
  return
}

if (-not $script:ownsTrayMutex) {
  if (Test-PortListening $port) {
    Start-Process $url
  } else {
    [System.Windows.Forms.MessageBox]::Show("RēDesign is already starting in the tray. Wait a moment, then open it from the tray icon.", "RēDesign") | Out-Null
  }
  if ($script:trayMutex) { try { $script:trayMutex.Dispose() } catch {} }
  $script:trayMutex = $null
  return
}

if (Test-PortListening $port) {
  [System.Windows.Forms.MessageBox]::Show("RēDesign is already serving at $url, but the tray icon is not running. Stop the process using port $port, then run the shortcut again.", "RēDesign") | Out-Null
  Release-TrayMutex
  return
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  [System.Windows.Forms.MessageBox]::Show("Bun was not found on PATH. Install Bun 1.1.0+ from https://bun.sh then try again.", "RēDesign") | Out-Null
  Release-TrayMutex
  return
}

$tray = $null
try {
  $tray = New-Object System.Windows.Forms.NotifyIcon -ErrorAction Stop
  $tray.Text = "RēDesign"
  $iconPath = Join-Path $scriptDir "Reimagine.ico"
  # Pull the tray-sized frame out of the multi-size .ico so it renders crisply (and
  # not blank) in the notification area; fall back to the default frame, then the
  # system icon, if anything goes wrong.
  $tray.Icon = if (Test-Path $iconPath) {
    try { New-Object System.Drawing.Icon($iconPath, [System.Windows.Forms.SystemInformation]::SmallIconSize) }
    catch { try { New-Object System.Drawing.Icon($iconPath) } catch { [System.Drawing.SystemIcons]::Application } }
  } else { [System.Drawing.SystemIcons]::Application }
  $tray.Visible = $true
} catch {
  if ($tray) { try { $tray.Dispose() } catch {} }
  [System.Windows.Forms.MessageBox]::Show("RēDesign could not create the tray icon, so it will not start.", "RēDesign") | Out-Null
  Release-TrayMutex
  return
}

# The build command used by "Rebuild & Restart", a standalone misc\Rebuild.bat if
# present, else `npm run build` when package.json defines a build script, else none.
function Get-BuildCommand {
  $rebuildBat = Join-Path $scriptDir "Rebuild.bat"
  if (Test-Path $rebuildBat) { return "`"$rebuildBat`"" }
  $packageJson = Join-Path $root "package.json"
  if (Test-Path $packageJson) {
    try {
      $pkg = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
      if ($pkg.scripts -and $pkg.scripts.build) { return "npm run build" }
    } catch { return $null }
  }
  return $null
}

# First run: build the web UI if the production bundle is missing (blocking, but this
# only happens once and the tray icon is already visible).
if (-not (Test-Path (Join-Path $root 'src\web\dist\index.html'))) {
  $bc = Get-BuildCommand
  if ($bc) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c cd /d `"$root`" && $bc > `"$(Join-Path $scriptDir 'Reimagine-Rebuild.log')`" 2>&1"
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = "Hidden"
    $p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit()
  }
}
Start-Server $root $port | Out-Null

# --- Background worker ------------------------------------------------------------
# Runs the whole rebuild+restart (or plain restart) sequence off the UI thread and
# returns a result object. Self-contained: it re-defines the server-control helpers
# from the passed-in text so it needs nothing from the parent runspace.
$worker = {
  param($appRoot, $appScriptDir, $appPort, $buildCommand, $doRebuild, $helpersText, $shared)
  $ErrorActionPreference = 'SilentlyContinue'
  . ([scriptblock]::Create($helpersText))
  $result = [pscustomobject]@{ Ok = $true; Skipped = $false; Ready = $false }

  if ($doRebuild) {
    if (-not $buildCommand) {
      $result.Skipped = $true
    } else {
      $logPath = Join-Path $appScriptDir "Reimagine-Rebuild.log"
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = "cmd.exe"
      $psi.Arguments = "/c cd /d `"$appRoot`" && $buildCommand > `"$logPath`" 2>&1"
      $psi.WorkingDirectory = $appRoot
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      $psi.WindowStyle = "Hidden"
      $p = [System.Diagnostics.Process]::Start($psi)
      $shared.buildPid = $p.Id
      # Poll HasExited (interruptible) instead of WaitForExit so a Quit can cancel
      # promptly and reap the build tree instead of the UI blocking on it.
      while (-not $p.HasExited) {
        if ($shared.cancel) { try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch {}; $result.Ok = $false; return $result }
        Start-Sleep -Milliseconds 200
      }
      $shared.buildPid = 0
      if ($p.ExitCode -ne 0) { $result.Ok = $false; return $result }
    }
  }
  if ($shared.cancel) { return $result }

  Stop-Server $appPort
  Wait-PortFree $appPort 6 | Out-Null
  Start-Sleep -Milliseconds 250
  $sp = Start-Server $appRoot $appPort
  if ($sp) { $shared.serverPid = $sp.Id }
  $result.Ready = [bool](Wait-Ready $appPort 12)
  if (-not $result.Ready -and -not $shared.cancel) {
    # Slow/failed to bind: kill the process we started (even if it hasn't listened
    # yet, by tracked PID, not just by port), wait for the port, and retry once.
    if ($shared.serverPid -gt 0) { try { & taskkill /PID $shared.serverPid /T /F 2>$null | Out-Null } catch {} }
    Stop-Server $appPort
    Wait-PortFree $appPort 6 | Out-Null
    Start-Sleep -Milliseconds 400
    $sp = Start-Server $appRoot $appPort
    if ($sp) { $shared.serverPid = $sp.Id }
    $result.Ready = [bool](Wait-Ready $appPort 12)
  }
  return $result
}

$script:busy = $false
$script:ps = $null
$script:psAsync = $null
$script:jobKind = ''
# Shared with the worker runspace (same process heap): the worker records the PIDs it
# spawns so Quit can reap them, and Quit sets `cancel` to stop the worker early.
$script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open RēDesign")
$rebuildItem = New-Object System.Windows.Forms.ToolStripMenuItem("Rebuild && Restart")
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart")
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")

# Ticks on the UI thread (WinForms timer), polls the worker and, once it finishes,
# reports the outcome and re-enables the menu. This is the only place worker results
# touch the UI, so there's no cross-thread control access.
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 300
$pollTimer.Add_Tick({
  if (-not $script:ps -or -not $script:psAsync) { $pollTimer.Stop(); return }
  if (-not $script:psAsync.IsCompleted) { return }
  $pollTimer.Stop()
  $out = $null
  try {
    $res = $script:ps.EndInvoke($script:psAsync)
    if ($res -and $res.Count -gt 0) { $out = $res[$res.Count - 1] }
  } catch {}
  try { $script:ps.Dispose() } catch {}
  $script:ps = $null; $script:psAsync = $null

  if ($out -and -not $out.Ok) {
    $tray.ShowBalloonTip(3500, "RēDesign", "Build failed. See misc\Reimagine-Rebuild.log.", [System.Windows.Forms.ToolTipIcon]::Error)
  } elseif ($out -and $out.Ready) {
    if ($script:jobKind -eq 'rebuild') { Start-Process $url }
  } else {
    $tray.ShowBalloonTip(3500, "RēDesign", "Restarted, but the port did not become ready yet.", [System.Windows.Forms.ToolTipIcon]::Warning)
  }
  $rebuildItem.Enabled = $true
  $restartItem.Enabled = $true
  $script:busy = $false
})

# Kick off the worker without blocking the UI thread.
function Start-Job-Async([bool]$doRebuild) {
  if ($script:busy) { return }
  $script:busy = $true
  $script:jobKind = if ($doRebuild) { 'rebuild' } else { 'restart' }
  $rebuildItem.Enabled = $false
  $restartItem.Enabled = $false

  try {
    $script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
    $buildCommand = if ($doRebuild) { Get-BuildCommand } else { $null }
    $script:ps = [System.Management.Automation.PowerShell]::Create()
    [void]$script:ps.AddScript($worker.ToString())
    [void]$script:ps.AddArgument($root)
    [void]$script:ps.AddArgument($scriptDir)
    [void]$script:ps.AddArgument($port)
    [void]$script:ps.AddArgument($buildCommand)
    [void]$script:ps.AddArgument($doRebuild)
    [void]$script:ps.AddArgument($ServerControl.ToString())
    [void]$script:ps.AddArgument($script:shared)
    $script:psAsync = $script:ps.BeginInvoke()
    $pollTimer.Start()
  } catch {
    # Kicking off the runspace failed, never leave the menu stuck disabled.
    if ($script:ps) { try { $script:ps.Dispose() } catch {} }
    $script:ps = $null; $script:psAsync = $null
    $rebuildItem.Enabled = $true
    $restartItem.Enabled = $true
    $script:busy = $false
    $tray.ShowBalloonTip(3500, "RēDesign", "Couldn't start the background worker. Try again.", [System.Windows.Forms.ToolTipIcon]::Error)
  }
}

$openItem.Add_Click({ Start-Process $url })
$rebuildItem.Add_Click({ Start-Job-Async $true })
$restartItem.Add_Click({ Start-Job-Async $false })
$quitItem.Add_Click({
  $script:shared.cancel = $true
  $pollTimer.Stop()
  # If a job is in flight, reap what the worker spawned (build + a server that may not
  # have bound the port yet) so nothing is orphaned and $script:ps.Stop() doesn't block
  # on the build's WaitForExit. When idle the tracked PIDs are stale (the last job's
  # server is the live one, killed by-port below), skip so we never taskkill a reused PID.
  if ($script:busy) {
    foreach ($k in @('buildPid', 'serverPid')) {
      $procId = $script:shared[$k]
      if ($procId -and $procId -gt 0) { try { & taskkill /PID $procId /T /F 2>$null | Out-Null } catch {} }
    }
  }
  if ($script:ps) { try { $script:ps.Stop(); $script:ps.Dispose() } catch {} }
  Stop-Server $port
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($openItem) | Out-Null
$menu.Items.Add($rebuildItem) | Out-Null
$menu.Items.Add($restartItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($quitItem) | Out-Null
$tray.ContextMenuStrip = $menu
$tray.Add_MouseDoubleClick({ Start-Process $url })

$tray.ShowBalloonTip(2500, "RēDesign", "Running in the tray - right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)
# Wait for the freshly-spawned server to bind before opening the browser, so the first paint
# isn't ERR_CONNECTION_REFUSED (Bun takes ~1s to boot). Falls through after the timeout so a
# genuinely-stuck start still opens the tab (surfacing the browser's own error) rather than hanging.
[void](Wait-Ready $port 15)
Start-Process $url

# Run the WinForms message loop (keeps the tray alive until Quit).
try {
  [System.Windows.Forms.Application]::Run()
} finally {
  Release-TrayMutex
}
