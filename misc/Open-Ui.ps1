# Opens the RēDesign web UI once the daemon started by start.cmd has bound its port. Factored
# out of start.cmd (rather than kept as a hidden-PowerShell one-liner) because honouring
# portableMode needs the same Edge/Chrome resolution as misc/ReDesign-Tray.ps1's Open-AppUi,
# and that logic gets too fragile to cmd-escape inline. Reads the SAME runtime.json path
# expression start.cmd's old one-liner used, falling back to the preferred port.
param([int]$Port = 5178)
$ErrorActionPreference = "SilentlyContinue"
Start-Sleep -Seconds 2

$rdHome = if ($env:REDESIGN_HOME) { $env:REDESIGN_HOME } else { Join-Path $env:USERPROFILE ".redesign" }
$infoFile = Join-Path $rdHome "runtime.json"

$info = $null
if (Test-Path $infoFile) {
  try { $info = Get-Content $infoFile -Raw | ConvertFrom-Json } catch {}
}

$url = if ($info -and $info.url) { $info.url } else { "http://localhost:$Port" }

# Same Chromium candidate order as ReDesign-Tray.ps1's Resolve-ChromiumBrowser: msedge before
# Chrome (preinstalled on every supported Windows), 32-bit Program Files checked first.
function Resolve-ChromiumBrowser {
  $candidates = @()
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
  }
  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"
  }
  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"
  }
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"
  }
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

# PowerShell port of Tray-Host.ps1's placement probe (Get-AppWindowPlacementKey /
# Get-RememberedPlacement, themselves ports of the daemon's server-lib probe — keep all in
# sync), so this open path makes the SAME first-run-or-remembered sizing decision as the
# tray and the daemon's POST /api/portable-window. Chromium keys a saved app-window
# placement under hostname + "_" + path — the port and the query string are both absent
# from the key (Chromium's omissions, not ours; verified Edge 150).
function Get-AppWindowPlacementKey([string]$u) {
  try {
    $uri = [uri]$u
    if (-not $uri.IsAbsoluteUri) { return $null }
    return "$($uri.Host)_$($uri.AbsolutePath)"
  } catch { return $null }
}

# The placement Chromium has saved for $u's window in $profileDir, or $null when nothing
# usable is stored (fresh profile, unreadable/corrupt Preferences, junk rect). Chromium
# writes prefs BY DOTTED PATH, so a placement key containing dots lands as NESTED dicts —
# probe flat first, then walk the key as a dotted path, requiring an object at every hop.
# A rect under 50px a side is junk, not a remembered size (same floor as the tray/daemon
# probes). maximized:true means the rect holds pre-maximize RESTORE bounds, not live size.
function Get-RememberedPlacement([string]$profileDir, [string]$u) {
  $key = Get-AppWindowPlacementKey $u
  if (-not $profileDir -or -not $key) { return $null }
  try {
    $prefsPath = Join-Path $profileDir "Default\Preferences"
    if (-not (Test-Path $prefsPath)) { return $null }
    $prefs = Get-Content $prefsPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $placements = $prefs.browser.app_window_placement
    $node = $placements.$key                     # flat probe first…
    if ($null -eq $node) {                       # …then the dotted-path form
      $node = $placements
      foreach ($seg in $key.Split('.')) {
        if ($node -isnot [System.Management.Automation.PSCustomObject]) { return $null }
        $node = $node.$seg
      }
    }
    if ($node -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    foreach ($edge in @('left', 'top', 'right', 'bottom')) {
      $v = $node.$edge
      if (-not ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal])) { return $null }
    }
    $w = $node.right - $node.left
    $h = $node.bottom - $node.top
    if ($w -lt 50 -or $h -lt 50) { return $null }
    return @{ Width = [int]$w; Height = [int]$h; Maximized = ($node.maximized -eq $true) }
  } catch { return $null }
}

# First-run outer size = the daemon's measured PORTABLE_WINDOW_SIZE (src/http/routes/
# settings.ts); the tray adapter (ReDesign-Tray.ps1's PortableWindowSize) carries the same
# numbers, so all three open paths size a never-seen window identically.
$firstRunSize = @{ Width = 840; Height = 760 }

$portable = $false
if ($info -and $info.portableMode) { $portable = $true }

if ($portable) {
  $browser = Resolve-ChromiumBrowser
  if ($browser) {
    # Dedicated Chromium profile (sibling of runtime.json), same convention as
    # ReDesign-Tray.ps1's Open-AppUi and the daemon's POST /api/portable-window, so
    # every open path shares one profile and the window remembers its geometry.
    $profileDir = Join-Path (Split-Path -Parent $infoFile) "portable-profile"
    $profileArgs = @()
    try {
      if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
      $profileArgs = @("--user-data-dir=`"$profileDir`"", "--no-first-run", "--no-default-browser-check")
    } catch {}
    # First-run sizing: pass --window-size only while the profile remembers NOTHING usable
    # for this URL's placement slot — a placement the user made by resizing (or maximizing)
    # always wins, because --window-size would override it on every launch. Same gate as
    # Tray-Host.ps1's Open-AppUi and the daemon's openPortableWindow.
    $sizeArgs = @()
    if ($null -eq (Get-RememberedPlacement $profileDir $url)) {
      $sizeArgs = @("--window-size=$($firstRunSize.Width),$($firstRunSize.Height)")
    }
    Start-Process $browser -ArgumentList ($profileArgs + $sizeArgs + @("--app=$url"))
    return
  }
}
Start-Process $url
