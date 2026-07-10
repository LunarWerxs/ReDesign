' Launches RēDesign into the system tray (no console window).
' Normally you start this via the "ReDesign" shortcut in the project root
' (it points here and carries the app icon). You can also double-click this file.

' ── Web UI port ───────────────────────────────────────────────
' RēDesign serves its UI on this port. Change it here (overrides .env).
Const PORT = 5178
' ──────────────────────────────────────────────────────────────

Dim sh, fso, scriptDir, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\misc
root = fso.GetParentFolderName(scriptDir)                     ' project root
sh.CurrentDirectory = root
' 0 = hidden window (no console flash), False = don't wait.
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\ReDesign-Tray.ps1"" -Port " & PORT, 0, False
