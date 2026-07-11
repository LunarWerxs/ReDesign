# Creates / refreshes the "RēDesign" shortcut in the project root. THIN ADAPTER over the
# shared LunarWerx shortcut engine (misc/New-TrayShortcut.ps1, kit-synced from
# lunarwerx-ui/src/tray-host/New-TrayShortcut.ps1 - DO NOT EDIT THAT FILE HERE; edit the kit
# copy and run `node sync.mjs`). This file owns only what's genuinely ReDesign-specific: the
# display name, icon, description, and the legacy-.lnk cleanup list. Re-run this if you move
# or rename the folder.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

# Display name carries the macron (ē = U+0113). Built from the code point so THIS script
# stays pure-ASCII on disk - a literal "ē" would be mangled by Windows PowerShell 5.1 when
# the .ps1 is read without a UTF-8 BOM. The engine handles the ASCII-temp-save + Move-Item
# dance needed to get the macron into the final .lnk filename (see its header comment).
$name = 'R' + [char]0x0113 + 'Design'          # RēDesign

New-TrayShortcut `
  -Root $root `
  -ScriptDir $scriptDir `
  -LnkName $name `
  -IconFile "Reimagine.ico" `
  -Description "Launch ReDesign (system tray)" `
  -LegacyLnks @('ReDesign.lnk', 'Reimagine.lnk')
