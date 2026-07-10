# Creates / refreshes the "RēDesign" shortcut in the project root. The shortcut
# launches misc\Reimagine.vbs (system tray) and carries the app icon, so the
# root has one nice clickable entry. Re-run this if you move or rename the folder.
#
# Supersedes the older "Reimagine.lnk" (pre-rename) and the plain-ASCII
# "ReDesign.lnk", both are deleted here so the owner isn't left with duplicates.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

# Display name carries the macron (ē = U+0113). Build it from the code point so
# THIS script stays pure-ASCII on disk, a literal "ē" would be mangled by
# Windows PowerShell 5.1 when the .ps1 is read without a UTF-8 BOM. The filename
# is where users actually SEE the name (label under the icon), and NTFS stores
# it as UTF-16, so the macron survives there even though the .lnk Description
# property (below) can't hold it.
$name     = 'R' + [char]0x0113 + 'Design'          # RēDesign
$finalLnk = Join-Path $root ($name + '.lnk')
# WScript.Shell saves the .lnk through an ANSI path, so it can only WRITE to an
# ASCII filename, a Unicode target name is silently transliterated (ē -> e).
# So save to a plain-ASCII temp name, then rename to the real macron name via the
# Unicode filesystem API (Move-Item), which preserves ē.
$tmpLnk = Join-Path $root 'ReDesign.lnk'

foreach ($p in @($finalLnk, $tmpLnk, (Join-Path $root 'Reimagine.lnk'))) {
  if (Test-Path -LiteralPath $p) { try { Remove-Item -LiteralPath $p -Force } catch {} }
}

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($tmpLnk)
# Run the .vbs through wscript explicitly (no console window, no file-association surprises).
$sc.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$sc.Arguments = '"' + (Join-Path $scriptDir "Reimagine.vbs") + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation = (Join-Path $scriptDir "Reimagine.ico") + ",0"
# WScript.Shell's .lnk Description property is ANSI-limited and silently drops the
# macron (ē becomes e), so use the plain-ASCII form here rather than have the two
# disagree. (The filename above carries the macron; the Description can't.)
$sc.Description = "Launch ReDesign (system tray)"
$sc.Save()

# Rename the saved ASCII shortcut to the macron name. Renaming does not touch the
# .lnk's internal TargetPath / IconLocation, so the shortcut keeps working.
Move-Item -LiteralPath $tmpLnk -Destination $finalLnk -Force
Write-Host "Created shortcut: $finalLnk"
