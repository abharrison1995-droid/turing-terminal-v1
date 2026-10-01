$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path $args[0]).Path
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Turing Terminal'
$launcher = Join-Path $installDirectory 'turing-terminal.exe'
$uninstaller = Join-Path $installDirectory 'uninstall.exe'
$masterLog = Join-Path $env:LOCALAPPDATA 'TuringTerminal\logs\desktop-master.log'
$occupiedPorts = Get-NetTCPConnection -State Listen -LocalPort (4317..4348) -ErrorAction SilentlyContinue
if ($occupiedPorts) { throw 'A local service is already listening on a Turing Terminal smoke-test port (4317-4348).' }

Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDirectory") -Wait
if (-not (Test-Path $launcher)) {
  $candidate = Get-ChildItem -Path $env:LOCALAPPDATA -Filter 'turing-terminal.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($candidate) { $launcher = $candidate.FullName }
}
if (-not (Test-Path $launcher)) { throw "Installed desktop executable was not found under $env:LOCALAPPDATA" }
$installDirectory = Split-Path -Parent $launcher
$uninstaller = Join-Path $installDirectory 'uninstall.exe'

$process = Start-Process -FilePath $launcher -ArgumentList '--background' -PassThru
try {
  $ready = $false
  $masterPort = $null
  $observedPorts = @()
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $candidatePorts = @(Get-NetTCPConnection -State Listen -LocalPort (4317..4348) -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty LocalPort -Unique)
    $observedPorts = @($observedPorts + $candidatePorts | Select-Object -Unique)
    foreach ($port in $candidatePorts) {
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
        if ($health.service -eq 'turing-terminal' -and $health.version -eq '1.0.0-rc1' -and $health.localOnly -eq $true) {
          $ready = $true
          $masterPort = $port
          break
        }
      } catch { }
    }
    if ($ready) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) {
    Write-Output "Installed launcher: $launcher"
    Write-Output "Installed resources: $(Join-Path $installDirectory 'resources')"
    Write-Output "Observed listening smoke-test ports: $($observedPorts -join ', ')"
    Get-NetTCPConnection -State Listen -LocalPort (4317..4348) -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
    if (Test-Path $masterLog) {
      Write-Output "Desktop Master log: $masterLog"
      Get-Content -Path $masterLog
    } else {
      Write-Output "Desktop Master log was not created: $masterLog"
    }
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dist-server*server*index.js*' } | Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
    throw 'Desktop Master did not return a valid local health response.'
  }
  $manifest = Invoke-WebRequest -Uri "http://127.0.0.1:$masterPort/manifest.webmanifest" -TimeoutSec 5
  $manifestContent = [string]$manifest.Content
  $manifestJson = $null
  try { $manifestJson = $manifestContent | ConvertFrom-Json -ErrorAction Stop } catch { }
  if ($manifest.StatusCode -ne 200 -or $manifestJson.name -ne 'Turing Terminal') {
    Write-Output "PWA manifest status: $($manifest.StatusCode)"
    Write-Output "PWA manifest response: $manifestContent"
    throw 'PWA manifest smoke check failed.'
  }
  $frontend = Invoke-WebRequest -Uri "http://127.0.0.1:$masterPort/" -TimeoutSec 5
  if ($frontend.StatusCode -ne 200 -or $frontend.Content -notmatch '/assets/index-') { throw 'Frontend route smoke check failed.' }
} finally {
  function Get-DescendantProcessIds([int] $ParentId) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
      Get-DescendantProcessIds $child.ProcessId
      $child.ProcessId
    }
  }
  @(Get-DescendantProcessIds $process.Id) | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}

if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait }
Write-Output 'Windows NSIS installer smoke check passed (quiet install, Master health, PWA manifest, uninstall).'
