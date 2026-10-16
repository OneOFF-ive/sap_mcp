param(
  [Parameter(Mandatory=$true)][ValidateSet('Check','AddPath','RemovePath','RemovePayload','RefreshIcons')][string]$Action,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [string]$InstallerPath,
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
  foreach ($relative in (@($manifest.files) + @($manifest.directories))) {
    if ($null -eq $relative) { continue }
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or $relative.Contains(':')) { throw 'Unsafe installation manifest path.' }
    $absolute = [IO.Path]::GetFullPath((Join-Path $installRoot $relative))
    if (!$absolute.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path outside installation.' }
  }
  return $manifest
}

function Check-Installation {
  if (Test-Path -LiteralPath $installRoot) {
    $items = @(Get-ChildItem -LiteralPath $installRoot -Force)
    if ($items.Count -and !(Read-Manifest)) {
      Write-Output "目标文件夹包含其他文件，请选择空文件夹或原 SAP MCP 安装目录：$installRoot"
      exit 13
    }
  }
  $executables = @('runtime\node.exe','bin\sapmcp.exe','bin\sapmcp-gui.exe') | ForEach-Object { Join-Path $installRoot $_ }
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='sapmcp.exe' OR Name='sapmcp-gui.exe'" | Where-Object {
    $_.ExecutablePath -and $executables -contains $_.ExecutablePath
  })
  if ($running.Count) {
    Write-Output "安装目录中的程序仍在运行（PID：$($running.ProcessId -join ', ')）。请从托盘退出管理界面；后台服务请运行 sapmcp service stop。前台运行的程序请在其终端按 Ctrl+C。"
    exit 10
  }
  $configDirectory = if ($env:SAP_MCP_CONFIG_DIR) { $env:SAP_MCP_CONFIG_DIR } else { Join-Path $env:APPDATA 'sap-mcp' }
  $lockPath = Join-Path $configDirectory 'runtime.lock'
  $guardPath = "$lockPath.guard"
  if (Test-Path -LiteralPath $guardPath) {
    Write-Output "运行锁正在变更，或上次操作留下了门锁。请稍后重试；若持续出现，请使用 status/doctor 诊断并核实进程后处理：$guardPath"
    exit 12
  }
  if (Test-Path -LiteralPath $lockPath) {
    # Match src/lease.ts: a PID alone cannot identify an owner because Windows reuses PIDs.
    # Read only; the application will reclaim a stale lease under its own guard on startup.
    $record = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $legacy = $record -is [ValueType]
    $ownerId = if ($legacy) { $record } else { $record.pid }
    $parsedId = 0
    if (![int]::TryParse([string]$ownerId, [ref]$parsedId) -or $parsedId -le 0) { throw "运行锁内容无效：$lockPath" }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$parsedId"
    $sameOwner = $false
    if ($owner) {
      if ($legacy) {
        $sameOwner = $owner.CommandLine -match '(sap_mcp[\\/]dist[\\/]cli\.js|\bdist[\\/]cli\.js)(?:["\s]|$)'
      } else {
        $sameOwner = [string]::Equals([string]$record.started_at, $owner.CreationDate.ToUniversalTime().ToString('o'), [StringComparison]::Ordinal)
      }
    }
    if ($sameOwner) {
      Write-Output "SAP MCP 仍在运行（PID：$parsedId）。请从托盘退出管理界面，或运行 sapmcp service stop；前台程序请按 Ctrl+C。运行锁：$lockPath"
      exit 11
    }
    # A new guard means the read may have raced a lease change. Do not act on that snapshot.
    if ((Test-Path -LiteralPath $guardPath) -or !(Test-Path -LiteralPath $lockPath)) { throw '运行状态发生变化，请稍后重试。' }
    $currentRecord = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (($record | ConvertTo-Json -Compress) -ne ($currentRecord | ConvertTo-Json -Compress)) { throw '运行状态发生变化，请稍后重试。' }
    Write-Output "已核实 PID $parsedId 的运行锁失效，允许继续；启动时将安全回收旧锁。"
  }
  exit 0
}

if ($Action -eq 'Check') {
  try { Check-Installation }
  catch {
    Write-Output "无法确认安装目录或运行状态，请运行 sapmcp status --json / sapmcp doctor --json 后重试。详情：$($_.Exception.Message)"
    exit 14
  }
}

if ($Action -eq 'RefreshIcons') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SapMcpShellIcons {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct FileInfo {
    public IntPtr Icon;
    public int Index;
    public uint Attributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string Type;
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  private static extern IntPtr SHGetFileInfo(string path, uint attributes, out FileInfo info, uint size, uint flags);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  private static extern void SHUpdateImage(string path, int iconIndex, uint flags, int imageIndex);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern void SHChangeNotify(uint change, uint flags, string first, string second);
  public static void RefreshExecutable(string path) {
    FileInfo info;
    // These executables each have one icon group at resource index 0.
    if (SHGetFileInfo(path, 0, out info, (uint)Marshal.SizeOf(typeof(FileInfo)), 0x4000) != IntPtr.Zero)
      SHUpdateImage(path, 0, 0, info.Index);
    SHChangeNotify(0x2000, 0x1005, path, null);
  }
}
'@
  foreach ($relative in @('bin\sapmcp.exe','bin\sapmcp-gui.exe','Uninstall.exe')) {
    $path = Join-Path $installRoot $relative
    if (Test-Path -LiteralPath $path -PathType Leaf) { [SapMcpShellIcons]::RefreshExecutable($path) }
  }
  if ($InstallerPath -and (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    [SapMcpShellIcons]::RefreshExecutable([IO.Path]::GetFullPath($InstallerPath))
  }
  [SapMcpShellIcons]::SHChangeNotify(0x08000000, 0, $null, $null)
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
  $directories = @(@($manifest.directories) + @($manifest.files | ForEach-Object {
    $directory = [IO.Path]::GetDirectoryName((Join-Path $installRoot $_))
    while ($directory -and $directory.Length -gt $installRoot.Length) {
      $directory
      $directory = [IO.Path]::GetDirectoryName($directory)
    }
  }) | Where-Object { $_ } | ForEach-Object {
    if ([IO.Path]::IsPathRooted($_)) { $_ } else { Join-Path $installRoot $_ }
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
