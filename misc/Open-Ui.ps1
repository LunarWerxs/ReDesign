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
    Start-Process $browser -ArgumentList ($profileArgs + @("--app=$url"))
    return
  }
}
Start-Process $url
