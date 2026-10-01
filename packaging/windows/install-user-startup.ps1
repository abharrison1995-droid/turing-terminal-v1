param(
  [string]$PackageDirectory = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { throw 'Node.js 22 or newer is required. Install Node.js, then rerun this installer.' }
$version = (& $node.Source --version).Trim().TrimStart('v').Split('.')[0]
if ([int]$version -lt 22) { throw "Node.js 22 or newer is required; found $(& $node.Source --version)." }

$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\TuringTerminal'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'TuringTerminal\data'
New-Item -ItemType Directory -Path $installDirectory, $dataDirectory -Force | Out-Null
Get-ChildItem -LiteralPath $PackageDirectory -Force | Where-Object { $_.Name -ne 'install-user-startup.ps1' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $installDirectory -Recurse -Force
}

$serverPath = Join-Path $installDirectory 'dist-server\server\index.js'
if (-not (Test-Path $serverPath)) { throw "The package is missing $serverPath" }
$launcherPath = Join-Path $installDirectory 'run-master.ps1'
$launcher = @'
$ErrorActionPreference = 'Stop'
$env:TT_HOST = '127.0.0.1'
$env:TT_PORT = '4317'
$env:TT_DATA_DIR = '__DATA_DIR__'
Set-Location '__APP_DIR__'
& '__NODE_BIN__' '__SERVER_PATH__'
'@
$launcher = $launcher.Replace('__DATA_DIR__', $dataDirectory.Replace("'", "''"))
$launcher = $launcher.Replace('__APP_DIR__', $installDirectory.Replace("'", "''"))
$launcher = $launcher.Replace('__NODE_BIN__', $node.Source.Replace("'", "''"))
$launcher = $launcher.Replace('__SERVER_PATH__', $serverPath.Replace("'", "''"))
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding UTF8

$taskName = 'Turing Terminal Master'
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$($env:USERDOMAIN)\$($env:USERNAME)" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts the loopback-only Turing Terminal master for the current Windows user.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed the per-user startup task '$taskName' and started the master. UI/API: http://127.0.0.1:4317"
Write-Output "To inspect it, open Task Scheduler and find '$taskName'. Data remains in $dataDirectory."
