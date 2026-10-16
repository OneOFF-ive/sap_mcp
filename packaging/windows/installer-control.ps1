param(
  [Parameter(Mandatory=$true)][ValidateSet('Check','AddPath','RemovePath','RemovePayload')][string]$Action,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [switch]$TestMode
)
$ErrorActionPreference = 'Stop'
$installRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if ($installRoot -eq [IO.Path]::GetPathRoot($installRoot).TrimEnd('\') -or $installRoot.Contains(';')) {
  throw 'Choose a dedicated application directory without semicolons.'
}
$productKey = if ($TestMode) { 'Software\SAPMCPInstallerTest' } else { 'Software\SAPMCP' }
$environmentKey = if ($TestMode) { 'Software\SAPMCPInstallerTest\Environment' } else { 'Environment' }
$manifestPath = Join-Path $installRoot 'install-manifest.json'

function Read-Manifest {
  if (!(Test-Path -LiteralPath $manifestPath)) { return $null }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.app_id -ne 'org.sapmcp.desktop' -or $manifest.schema_version -ne 1) { throw 'Unrecognized installation manifest.' }
  foreach ($relative in $manifest.files) {
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or $relative.Contains(':')) { throw 'Unsafe installation manifest path.' }
    $absolute = [IO.Path]::GetFullPath((Join-Path $installRoot $relative))
    if (!$absolute.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path outside installation.' }
  }
  return $manifest
}

if ($Action -eq 'Check') {
  if (Test-Path -LiteralPath $installRoot) {
    $items = @(Get-ChildItem -LiteralPath $installRoot -Force)
    if ($items.Count -and !(Read-Manifest)) { exit 13 }
  }
  $executables = @('runtime\node.exe','bin\sapmcp.exe','bin\sapmcp-gui.exe') | ForEach-Object { Join-Path $installRoot $_ }
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='sapmcp.exe' OR Name='sapmcp-gui.exe'" | Where-Object {
    $_.ExecutablePath -and $executables -contains $_.ExecutablePath
  })
  if ($running.Count) { exit 10 }
  $configDirectory = if ($env:SAP_MCP_CONFIG_DIR) { $env:SAP_MCP_CONFIG_DIR } else { Join-Path $env:APPDATA 'sap-mcp' }
  if (Test-Path -LiteralPath (Join-Path $configDirectory 'runtime.lock.guard')) { exit 12 }
  if (Test-Path -LiteralPath (Join-Path $configDirectory 'runtime.lock')) { exit 11 }
  exit 0
}

if ($Action -eq 'RemovePayload') {
  $manifest = Read-Manifest
  if (!$manifest) { throw 'Installation manifest is required before removing files.' }
  foreach ($relative in $manifest.files) {
    $absolute = [IO.Path]::GetFullPath((Join-Path $installRoot $relative))
    if (Test-Path -LiteralPath $absolute -PathType Leaf) { Remove-Item -LiteralPath $absolute -Force }
  }
  # Delete empty owned directories only. Unknown files and custom data survive uninstall.
  $directories = @($manifest.files | ForEach-Object {
    $directory = [IO.Path]::GetDirectoryName((Join-Path $installRoot $_))
    while ($directory -and $directory.Length -gt $installRoot.Length) {
      $directory
      $directory = [IO.Path]::GetDirectoryName($directory)
    }
  } | Sort-Object -Unique | Sort-Object Length -Descending)
  foreach ($directory in $directories) {
    if ([IO.Directory]::Exists($directory) -and ![IO.Directory]::EnumerateFileSystemEntries($directory).GetEnumerator().MoveNext()) {
      [IO.Directory]::Delete($directory)
    }
  }
  Remove-Item -LiteralPath $manifestPath -Force
  exit 0
}

function Same-Path([string]$Left, [string]$Right) {
  $a = [Environment]::ExpandEnvironmentVariables($Left.Trim().Trim('"')).TrimEnd('\')
  $b = [Environment]::ExpandEnvironmentVariables($Right.Trim().Trim('"')).TrimEnd('\')
  return [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)
}
$binDirectory = Join-Path $installRoot 'bin'
$registry = [Microsoft.Win32.Registry]::CurrentUser
$environment = $registry.CreateSubKey($environmentKey)
$product = $registry.CreateSubKey($productKey)
try {
  $raw = $environment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = if ($null -eq $raw) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $environment.GetValueKind('Path') }
  $parts = if ($null -eq $raw -or $raw -eq '') { @() } else { @(([string]$raw).Split(';')) }
  if ($Action -eq 'AddPath') {
    $found = @($parts | Where-Object { Same-Path $_ $binDirectory }).Count -gt 0
    if (!$found) {
      $environment.SetValue('Path', (($parts + @($binDirectory)) -join ';'), $kind)
      $product.SetValue('PathOwned', $binDirectory)
      $product.SetValue('PathCreated', [int]($null -eq $raw))
    }
  } else {
    $owned = [string]$product.GetValue('PathOwned', '')
    if ($owned -and (Same-Path $owned $binDirectory)) {
      $remaining = @($parts | Where-Object { !(Same-Path $_ $owned) })
      if (!$remaining.Count -and $product.GetValue('PathCreated', 0) -eq 1) { $environment.DeleteValue('Path', $false) }
      else { $environment.SetValue('Path', ($remaining -join ';'), $kind) }
      $product.DeleteValue('PathOwned', $false); $product.DeleteValue('PathCreated', $false)
    }
  }
} finally { $environment.Dispose(); $product.Dispose() }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SapMcpEnvironment {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr target, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$broadcastResult = [UIntPtr]::Zero
[void][SapMcpEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
