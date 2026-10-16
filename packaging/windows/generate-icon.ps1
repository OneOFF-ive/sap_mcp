param(
  [Parameter(Mandatory=$true)][string]$Output,
  [string]$Source,
  [string]$WebIcon
)
$ErrorActionPreference = 'Stop'
if (!$Source) { $Source = Join-Path $PSScriptRoot 'assets\app-icon.png' }
Add-Type -AssemblyName System.Drawing
$original = [Drawing.Image]::FromFile([IO.Path]::GetFullPath($Source))
$entries = @()
try {
  foreach ($size in @(16,24,32,48,64,128,256)) {
    $bitmap = New-Object Drawing.Bitmap $size,$size,([Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      $attributes = New-Object Drawing.Imaging.ImageAttributes
      try {
        # Mirror edge samples and copy alpha so resizing preserves source transparency.
        $attributes.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($original, [Drawing.Rectangle]::new(0,0,$size,$size), 0,0,$original.Width,$original.Height,[Drawing.GraphicsUnit]::Pixel,$attributes)
      } finally { $graphics.Dispose(); $attributes.Dispose() }
      if ($size -eq 256 -and $WebIcon) { $bitmap.Save([IO.Path]::GetFullPath($WebIcon), [Drawing.Imaging.ImageFormat]::Png) }
      # Uncompressed 32-bit ICO entries work with NSIS, the C# compiler and
      # Windows shell icon extraction, including the 256px desktop image.
      $stream = New-Object IO.MemoryStream
      $writer = New-Object IO.BinaryWriter $stream
      try {
        $stride = [int]([Math]::Ceiling($size / 32.0) * 4)
        $mask = New-Object byte[] ($stride * $size)
        $writer.Write([uint32]40); $writer.Write([int32]$size); $writer.Write([int32]($size * 2))
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]0); $writer.Write([uint32]($size * $size * 4))
        $writer.Write([int32]0); $writer.Write([int32]0); $writer.Write([uint32]0); $writer.Write([uint32]0)
        for ($y = 0; $y -lt $size; $y++) {
          for ($x = 0; $x -lt $size; $x++) {
            $pixel = $bitmap.GetPixel($x, $size - $y - 1)
            $writer.Write([byte]$pixel.B); $writer.Write([byte]$pixel.G); $writer.Write([byte]$pixel.R); $writer.Write([byte]$pixel.A)
            if ($pixel.A -eq 0) {
              $index = $y * $stride + [int][Math]::Floor($x / 8.0)
              $mask[$index] = $mask[$index] -bor (128 -shr ($x % 8))
            }
          }
        }
        $writer.Write([byte[]]$mask)
        $entries += @{ Size=$size; Data=$stream.ToArray() }
      } finally { $writer.Dispose(); $stream.Dispose() }
    } finally { $bitmap.Dispose() }
  }
} finally { $original.Dispose() }
$outputStream = [IO.File]::Create([IO.Path]::GetFullPath($Output))
$outputWriter = New-Object IO.BinaryWriter $outputStream
try {
  $outputWriter.Write([uint16]0); $outputWriter.Write([uint16]1); $outputWriter.Write([uint16]$entries.Count)
  $offset = 6 + 16 * $entries.Count
  foreach ($entry in $entries) {
    $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
    $outputWriter.Write([byte]$dimension); $outputWriter.Write([byte]$dimension)
    $outputWriter.Write([uint16]0); $outputWriter.Write([uint16]1); $outputWriter.Write([uint16]32)
    $outputWriter.Write([uint32]$entry.Data.Length); $outputWriter.Write([uint32]$offset)
    $offset += $entry.Data.Length
  }
  foreach ($entry in $entries) { $outputWriter.Write([byte[]]$entry.Data) }
} finally { $outputWriter.Dispose(); $outputStream.Dispose() }

# Give shell and browser caches a new identity when the artwork changes.
$iconHash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
$iconName = "sapmcp-$iconHash.ico"
Copy-Item -LiteralPath $Output -Destination (Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($Output))) $iconName) -Force
if ($WebIcon) {
  $webPath = [IO.Path]::GetFullPath($WebIcon)
  $webDirectory = Split-Path -Parent $webPath
  $webHash = (Get-FileHash -LiteralPath $webPath -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
  $webName = "app-icon-$webHash.png"
  Copy-Item -LiteralPath $webPath -Destination (Join-Path $webDirectory $webName) -Force
  $indexPath = Join-Path $webDirectory 'index.html'
  if (Test-Path -LiteralPath $indexPath) {
    $html = [IO.File]::ReadAllText($indexPath)
    $html = $html -replace '/app-icon(?:-[0-9a-f]{12})?\.png', "/$webName"
    [IO.File]::WriteAllText($indexPath, $html, [Text.UTF8Encoding]::new($false))
  }
}
