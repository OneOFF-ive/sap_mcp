param()
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $env:TEMP ('SAPMCP Payload Test ' + [Guid]::NewGuid().ToString('N'))
$helper = Join-Path $PSScriptRoot 'installer-control.ps1'
New-Item -ItemType Directory -Path $testRoot | Out-Null
foreach ($scenario in @('complete','preserve-unknown','legacy','unsafe-directory')) {
  $install = Join-Path $testRoot $scenario
  $package = Join-Path $install 'app\node_modules\sample'
  New-Item -ItemType Directory -Path (Join-Path $package '.github'),(Join-Path $package 'empty') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $package '.github\FUNDING.yml') -Value 'owned'
  Set-Content -LiteralPath (Join-Path $package '.package-lock.json') -Value 'owned'
  Set-Content -LiteralPath (Join-Path $package 'index.js') -Value 'owned'
  # Reproduce Windows-hidden entries as well as ordinary dotfiles.
  (Get-Item -LiteralPath (Join-Path $package '.github') -Force).Attributes = [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Hidden
  (Get-Item -LiteralPath (Join-Path $package '.package-lock.json') -Force).Attributes = [IO.FileAttributes]::Hidden
  $files = @(Get-ChildItem -LiteralPath $install -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($install.Length + 1) })
  $directories = @(Get-ChildItem -LiteralPath $install -Recurse -Directory -Force | ForEach-Object { $_.FullName.Substring($install.Length + 1) })
  $manifest = @{schema_version=1;app_id='org.sapmcp.desktop';files=$files;directories=$directories}
  if ($scenario -eq 'legacy') {
    $manifest.Remove('directories')
    # Legacy manifests cannot own empty directories, so omit that fixture.
    [IO.Directory]::Delete((Join-Path $package 'empty'))
  }
  if ($scenario -eq 'unsafe-directory') { $manifest.directories += '..\outside' }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $install 'install-manifest.json') -Encoding UTF8
  if ($scenario -eq 'preserve-unknown') { Set-Content -LiteralPath (Join-Path $package 'user-notes.txt') -Value 'keep' }
  $ErrorActionPreference = 'Continue'
  try {
    $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action RemovePayload -InstallDirectory $install 2>&1
    $result = $LASTEXITCODE
  } finally { $ErrorActionPreference = 'Stop' }
  if ($scenario -eq 'unsafe-directory') {
    if ($result -eq 0 -or !(Test-Path -LiteralPath (Join-Path $package 'index.js'))) { throw 'Unsafe directory was not rejected before deletion.' }
  } else {
    if ($result -ne 0) { throw "Payload cleanup failed: $output" }
    if (Test-Path -LiteralPath (Join-Path $install 'install-manifest.json')) { throw 'Manifest was not removed.' }
    if ($scenario -eq 'preserve-unknown') {
      $remaining = @(Get-ChildItem -LiteralPath $install -Recurse -File -Force)
      if ($remaining.Count -ne 1 -or $remaining[0].Name -ne 'user-notes.txt') { throw 'Unknown file was not preserved or owned files remain.' }
    } elseif (Test-Path -LiteralPath (Join-Path $install 'app')) { throw 'Application directory remains after cleanup.' }
  }
  Write-Host "PASS: $scenario"
}
