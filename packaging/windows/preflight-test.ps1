param()
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('SAPMCP Preflight ' + [Guid]::NewGuid().ToString('N'))
$config = Join-Path $root 'config'
$install = Join-Path $root 'application'
New-Item -ItemType Directory -Path $config,$install | Out-Null
$previousConfig = $env:SAP_MCP_CONFIG_DIR
$helper = Join-Path $PSScriptRoot 'installer-control.ps1'
$lock = Join-Path $config 'runtime.lock'
function Expect-Check([int]$Expected, [string]$Name) {
  $before = if (Test-Path -LiteralPath $lock) { (Get-FileHash -LiteralPath $lock).Hash } else { $null }
  $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action Check -InstallDirectory $install
  if ($LASTEXITCODE -ne $Expected) { throw "$Name expected $Expected, got ${LASTEXITCODE}: $output" }
  if ($before -and $before -ne (Get-FileHash -LiteralPath $lock).Hash) { throw "$Name modified the runtime lock." }
  Write-Host "PASS: $Name"
}
try {
  $env:SAP_MCP_CONFIG_DIR = $config
  Expect-Check 0 'Empty configuration'
  # Find a demonstrably absent PID rather than assuming a particular number is unused.
  $unused = 2147483647
  if (Get-CimInstance Win32_Process -Filter "ProcessId=$unused") { throw 'Test PID unexpectedly exists.' }
  @{pid=$unused;started_at='2000-01-01T00:00:00Z';nonce='test'} | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  Expect-Check 0 'Exited owner permits installation without deleting the lock'
  @{pid=$PID;started_at='2000-01-01T00:00:00Z';nonce='test'} | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  Expect-Check 0 'Reused PID with different creation time permits installation'
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  @{pid=$PID;started_at=$owner.CreationDate.ToUniversalTime().ToString('o');nonce='test'} | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  Expect-Check 11 'Matching owner blocks installation'
  Set-Content -LiteralPath "$lock.guard" -Value 'test' -Encoding UTF8
  Expect-Check 12 'Guard blocks installation'
  Remove-Item -LiteralPath "$lock.guard"
  Set-Content -LiteralPath $lock -Value '{invalid' -Encoding UTF8
  Expect-Check 14 'Unreadable lock blocks installation'
  Set-Content -LiteralPath $lock -Value '{"pid":0}' -Encoding UTF8
  Expect-Check 14 'Invalid owner blocks installation'
  Set-Content -LiteralPath (Join-Path $install 'unknown.txt') -Value 'test'
  Expect-Check 13 'Unrecognized nonempty directory blocks installation'
} finally {
  $env:SAP_MCP_CONFIG_DIR = $previousConfig
}
