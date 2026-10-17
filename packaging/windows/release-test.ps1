$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $env:TEMP ('SapLink-release-test-' + [Guid]::NewGuid().ToString('N'))
$scripts = Join-Path $testRoot 'packaging\windows'
New-Item -ItemType Directory -Path $scripts -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release.ps1') -Destination $scripts
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $testRoot 'package.json'), @'
{"name":"saplink-release-test","version":"1.0.0","private":true,"scripts":{"version":"node -e \"require('fs').writeFileSync('hook-ran', 'unexpected')\""}}
'@, $utf8)
[IO.File]::WriteAllText((Join-Path $testRoot 'package-lock.json'), @'
{"name":"saplink-release-test","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"saplink-release-test","version":"1.0.0"}}}
'@, $utf8)
# Use real npm version updates, but replace expensive native builds with a fixture.
[IO.File]::WriteAllText((Join-Path $scripts 'build.ps1'), @'
param([string[]]$Architecture, [switch]$SkipTests)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (Test-Path -LiteralPath (Join-Path $root 'fail-build')) { throw 'Expected build failure' }
@{architecture=@($Architecture);skip_tests=[bool]$SkipTests} | ConvertTo-Json | Set-Content (Join-Path $root 'build-call.json')
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$output = Join-Path $root "outputs\installers\$version"
New-Item -ItemType Directory -Path $output -Force | Out-Null
foreach ($arch in $Architecture) {
  $file = Join-Path $output "SapLink-$version-win-$arch-setup.exe"
  Set-Content -LiteralPath $file -Value 'Test fixture, not an installer'
  $hash = (Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()
  if (Test-Path -LiteralPath (Join-Path $root 'bad-checksum')) { $hash = 'invalid' }
  Set-Content -LiteralPath ($file + '.sha256') -Value ($hash + '  ' + [IO.Path]::GetFileName($file))
}
'@, $utf8)

function Run-Release([string[]]$Options, [bool]$ShouldPass) {
  $ErrorActionPreference = 'Continue'
  try {
    $result = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $scripts 'release.ps1') @Options 2>&1
  } finally { $ErrorActionPreference = 'Stop' }
  if (($LASTEXITCODE -eq 0) -ne $ShouldPass) { throw "Unexpected release exit code: $LASTEXITCODE`n$result" }
}
function Assert-Version([string]$Expected) {
  $versionsJson = & node -e "const fs = require('fs'); const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const l = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); console.log(JSON.stringify([p.version, l.version, l.packages[''].version]));" (Join-Path $testRoot 'package.json') (Join-Path $testRoot 'package-lock.json')
  if ($LASTEXITCODE -ne 0) { throw 'Could not read fixture versions.' }
  $versions = $versionsJson | ConvertFrom-Json
  if ($versions.Count -ne 3 -or @($versions | Where-Object { $_ -ne $Expected }).Count -gt 0) {
    throw 'Version files do not match.'
  }
}

foreach ($invalid in @('v1.2.3','1.2','1.2.3-beta.1','01.2.3','65536.0.0','999999999999999999.0.0','..\outside')) {
  Run-Release @('-Version',$invalid) $false
  Assert-Version '1.0.0'
}
if (Test-Path (Join-Path $testRoot 'build-call.json')) { throw 'Invalid version started a build.' }
Run-Release @('-Version','1.2.3') $true
Assert-Version '1.2.3'
$call = Get-Content (Join-Path $testRoot 'build-call.json') -Raw | ConvertFrom-Json
if (($call.architecture -join ',') -ne 'x64,arm64' -or $call.skip_tests) { throw 'Default build options incorrect.' }
Run-Release @('-Version','1.2.3','-Architecture','x64','-SkipTests') $true
$call = Get-Content (Join-Path $testRoot 'build-call.json') -Raw | ConvertFrom-Json
if (($call.architecture -join ',') -ne 'x64' -or !$call.skip_tests) { throw 'Explicit build options incorrect.' }
if (Test-Path (Join-Path $testRoot 'hook-ran')) { throw 'npm version hook was executed.' }
Set-Content (Join-Path $testRoot 'fail-build') 'fail'
Run-Release @('-Version','1.2.4') $false
Assert-Version '1.2.4'
Remove-Item -LiteralPath (Join-Path $testRoot 'fail-build')
Set-Content (Join-Path $testRoot 'bad-checksum') 'fail'
Run-Release @('-Version','1.2.4') $false
Remove-Item -LiteralPath (Join-Path $testRoot 'bad-checksum')
Run-Release @('-Version','1.2.4') $true
if (!(Test-Path (Join-Path $testRoot 'outputs\installers\1.2.3\SapLink-1.2.3-win-x64-setup.exe'))) { throw 'Previous version output lost.' }
Write-Host "Release script checks passed: validation, version synchronization, build options, same-version rebuild, failure and retry, checksum verification, previous outputs preserved. Fixtures: $testRoot"
