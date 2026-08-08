# Creates / refreshes the "RēDesign" shortcut in the project root. Thin adapter over the shared shortcut engine (misc/New-TrayShortcut.ps1). This file owns only what's genuinely ReDesign-specific: the
# display name, icon, description, and the legacy-.lnk cleanup list. Re-run this if you move
# or rename the folder.
param([switch]$Legacy)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

# The shortcut runs the NATIVE tray host (misc\lunarwerx-tray.exe; source vendored beside it in
# misc	ray-host-native\), not wscript + Tray-Launch.vbs + the PowerShell adapter. That chain cost
# ~520ms of script-host startup before the daemon process even existed; this one spawns it at ~25ms.
# Both hosts still ship, so -Legacy rebuilds the shortcut against the old chain if ever needed.
$native = @{ ExeFile = "lunarwerx-tray.exe"; ExeArguments = "ReDesign-Tray.json" }
if ($Legacy) { $native = @{} }


# Display name carries the macron (ē = U+0113). Built from the code point so THIS script
# stays pure-ASCII on disk - a literal "ē" would be mangled by Windows PowerShell 5.1 when
# the .ps1 is read without a UTF-8 BOM. The engine handles the ASCII-temp-save + Move-Item
# dance needed to get the macron into the final .lnk filename (see its header comment).
$name = 'R' + [char]0x0113 + 'Design'          # RēDesign

New-TrayShortcut `
  -Root $root `
  -ScriptDir $scriptDir `
  -LnkName $name `
  -IconFile "ReDesign.ico" `
  -Description "Launch ReDesign (system tray)" `
  -LegacyLnks @('ReDesign.lnk', 'Reimagine.lnk') `
  @native
