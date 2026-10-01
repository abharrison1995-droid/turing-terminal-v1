$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$package = Get-Content (Join-Path $root 'package.json') | ConvertFrom-Json
$version = $package.version
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("turing-terminal-win-" + [guid]::NewGuid())
$app = Join-Path $stage 'app'
$artifact = Join-Path $root "turing-terminal-windows-x64-v$version.zip"

try {
  Push-Location $root
  npm run build
  New-Item -ItemType Directory -Path $app -Force | Out-Null
  Copy-Item package.json, package-lock.json -Destination $app
  Copy-Item dist, dist-server, migrations -Destination $app -Recurse
  Copy-Item (Join-Path $PSScriptRoot 'install-user-startup.ps1') -Destination (Join-Path $app 'install-user-startup.ps1')
  npm ci --omit=dev --prefix $app --no-audit --no-fund
  if (Test-Path $artifact) { Remove-Item $artifact -Force }
  Compress-Archive -Path (Join-Path $app '*') -DestinationPath $artifact -CompressionLevel Optimal
  Write-Output "Created $artifact"
} finally {
  Pop-Location
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}
