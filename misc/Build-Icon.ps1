# Rebuilds misc\Reimagine.ico as a proper MULTI-SIZE icon (16/24/32/48/256) so the
# Windows system tray and Explorer render it crisply. A 256-only .ico shows up blank
# or mushy in the tray, that is the classic "tray icon is broken". Small frames are
# 32bpp DIBs (GDI+ rejects PNG-encoded small frames); the 256 jumbo is PNG-compressed.
#
# Source art is misc\Reimagine-icon.png (a committed 1024x1024 render of the brand icon) so
# this needs NO SVG renderer at runtime. To change the logo: re-render the PNG from the web
# favicon, then re-run this script, e.g.
#     magick -background none src\web\public\icon.svg -resize 1024x1024 misc\Reimagine-icon.png
# The brand vector lives in misc\brand\icon-dark.svg. After regenerating, re-run
# Create-Shortcut.ps1 (Windows caches icons; refreshing the shortcut picks up the new one).
param(
  [string]$Source = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "Reimagine-icon.png"),
  [string]$Out    = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "Reimagine.ico")
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# Load the source artwork at its largest available size. For an .ico we parse the
# directory and pull the biggest frame's raw bytes, Icon.ToBitmap() is broken for
# PNG-compressed frames, so we decode the embedded PNG ourselves.
function Get-SourceBitmap([string]$path) {
  if ($path -notmatch '\.ico$') { return New-Object System.Drawing.Bitmap($path) }
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $count = [BitConverter]::ToUInt16($bytes, 4)
  $best = -1; $bestW = -1
  for ($i = 0; $i -lt $count; $i++) {
    $e = 6 + $i * 16
    $w = $bytes[$e]; if ($w -eq 0) { $w = 256 }
    if ($w -gt $bestW) { $bestW = $w; $best = $e }
  }
  $len = [BitConverter]::ToUInt32($bytes, $best + 8)
  $off = [BitConverter]::ToUInt32($bytes, $best + 12)
  $frame = New-Object byte[] $len
  [Array]::Copy($bytes, $off, $frame, 0, $len)
  if ($frame.Length -gt 8 -and $frame[0] -eq 0x89 -and $frame[1] -eq 0x50) {
    $ms = New-Object System.IO.MemoryStream(, $frame)
    return New-Object System.Drawing.Bitmap($ms)
  }
  $ico = New-Object System.Drawing.Icon($path, $bestW, $bestW)
  return $ico.ToBitmap()
}

# Render the source down to an NxN 32bpp ARGB bitmap with high-quality scaling.
function Resize-Bitmap([System.Drawing.Bitmap]$src, [int]$n) {
  $bmp = New-Object System.Drawing.Bitmap($n, $n, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $n, $n)
  $g.Dispose()
  return $bmp
}

# A frame as { entry = 16-byte ICONDIRENTRY (offset patched later); data = payload }.

# Small (<256) frame: a true 32bpp DIB with full alpha. Layout an .ico expects, 
# BITMAPINFOHEADER with the height DOUBLED (XOR colour rows + AND mask rows), the
# colour pixels bottom-up as BGRA, then an all-zero 1bpp AND mask (transparency comes
# from the alpha channel). Pixels are lifted straight from the bitmap via LockBits.
function Get-DibFrame([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
  $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $buf = New-Object byte[] ($bd.Stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $buf.Length)
  $stride = $bd.Stride
  $bmp.UnlockBits($bd)

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt32]40); $bw.Write([Int32]$w); $bw.Write([Int32]($h * 2))
  $bw.Write([UInt16]1);  $bw.Write([UInt16]32); $bw.Write([UInt32]0)
  $bw.Write([UInt32]0);  $bw.Write([Int32]0);   $bw.Write([Int32]0)
  $bw.Write([UInt32]0);  $bw.Write([UInt32]0)
  for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($buf, $y * $stride, $w * 4) }
  $andRow = [math]::Floor(($w + 31) / 32) * 4
  $zero = New-Object byte[] $andRow
  for ($y = 0; $y -lt $h; $y++) { $bw.Write($zero, 0, $andRow) }
  $bw.Flush()
  $data = $ms.ToArray()

  $entry = New-Object byte[] 16
  $entry[0] = [byte]$w; $entry[1] = [byte]$h     # width / height (16/24/32/48)
  $entry[4] = 1; $entry[6] = 32                  # planes = 1, bit depth = 32
  [Array]::Copy([BitConverter]::GetBytes([UInt32]$data.Length), 0, $entry, 8, 4)
  return @{ entry = $entry; data = $data }
}

# The 256 jumbo frame, PNG-compressed (smaller, and GDI+ decodes PNG at this size).
function Get-PngFrame([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $data = $ms.ToArray()
  $entry = New-Object byte[] 16                  # width = height = 0 => 256
  $entry[4] = 1; $entry[6] = 32                  # planes = 1, bit depth = 32
  [Array]::Copy([BitConverter]::GetBytes([UInt32]$data.Length), 0, $entry, 8, 4)
  return @{ entry = $entry; data = $data }
}

$src = Get-SourceBitmap $Source
$sizes = 16, 24, 32, 48, 256

# A List avoids PowerShell's array-append quirks that can truncate byte payloads.
$frames = New-Object System.Collections.Generic.List[object]
foreach ($s in $sizes) {
  $bmp = Resize-Bitmap $src $s
  if ($s -ge 256) { $frames.Add((Get-PngFrame $bmp)) } else { $frames.Add((Get-DibFrame $bmp)) }
  $bmp.Dispose()
}
$src.Dispose()

# Assemble the .ico: ICONDIR + one ICONDIRENTRY per frame (offset patched) + payloads.
# Every Write uses the explicit (buffer, offset, count) overload so the full payload
# lands in the file.
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)
$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
  [Array]::Copy([BitConverter]::GetBytes([UInt32]$offset), 0, $f.entry, 12, 4)
  $bw.Write($f.entry, 0, 16)
  $offset += $f.data.Length
}
foreach ($f in $frames) { $bw.Write($f.data, 0, $f.data.Length) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($Out, $ms.ToArray())

Write-Host ("Wrote {0} ({1} frames: {2})" -f $Out, $frames.Count, ($sizes -join ', '))
