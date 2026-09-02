$ErrorActionPreference = 'Stop'

$controllerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $controllerRoot '.venv\Scripts\python.exe'
$requirements = Join-Path $controllerRoot 'bridge\requirements.txt'
$backendScript = Join-Path $controllerRoot 'bridge\server.py'
$vinextCli = Join-Path $controllerRoot 'node_modules\vinext\dist\cli.js'
$configFile = Join-Path $controllerRoot 'controller.config.json'
$pidFile = Join-Path $controllerRoot '.controller-pids.json'
$logDirectory = Join-Path $controllerRoot 'logs'

function Show-ControllerError {
    param([string]$Message)
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($Message, 'ESP32 Controller - Start failed', 'OK', 'Error') | Out-Null
    } catch {
        Write-Error $Message
    }
}

function Get-ManagedProcess {
    param(
        [int]$ProcessId,
        [string]$RequiredText
    )

    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)) {
        return $null
    }
    if ($process.CommandLine.IndexOf($controllerRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $null
    }
    if ($process.CommandLine.IndexOf($RequiredText, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $null
    }
    return $process
}

function Test-PageReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000' -TimeoutSec 1
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

try {
    if (-not (Test-Path -LiteralPath $configFile)) {
        throw 'Missing controller.config.json.'
    }
    $config = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
    $bluetoothPort = [string]$config.bluetooth_port
    if ($bluetoothPort -notmatch '^COM[1-9][0-9]*$') {
        throw 'Invalid bluetooth_port in controller.config.json. Example: COM4.'
    }

    if (Test-Path -LiteralPath $pidFile) {
        try {
            $saved = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
            $savedBackend = Get-ManagedProcess -ProcessId ([int]$saved.backend_pid) -RequiredText 'bridge\server.py'
            $savedFrontend = Get-ManagedProcess -ProcessId ([int]$saved.frontend_pid) -RequiredText 'vinext\dist\cli.js'
            if ($null -ne $savedBackend -and $null -ne $savedFrontend -and (Test-PageReady)) {
                Start-Process 'http://localhost:3000'
                exit 0
            }
        } catch {
            # A stale or partial PID file is handled by the scoped stop script.
        }
        & (Join-Path $controllerRoot 'stop_controller.ps1') -Silent
    }

    if (-not (Test-Path -LiteralPath $venvPython)) {
        py -3 -m venv (Join-Path $controllerRoot '.venv')
        & $venvPython -m pip install --disable-pip-version-check -r $requirements
    }

    if (-not (Test-Path -LiteralPath $vinextCli)) {
        throw 'Web dependencies are missing. Run npm install in controller_web.'
    }

    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $backend = Start-Process -FilePath $venvPython `
        -ArgumentList @($backendScript, '--port', $bluetoothPort) `
        -WorkingDirectory $controllerRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory 'backend.out.log') `
        -RedirectStandardError (Join-Path $logDirectory 'backend.error.log') `
        -PassThru

    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    $frontend = Start-Process -FilePath $nodeCommand `
        -ArgumentList @($vinextCli, 'dev') `
        -WorkingDirectory $controllerRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory 'frontend.out.log') `
        -RedirectStandardError (Join-Path $logDirectory 'frontend.error.log') `
        -PassThru

    [ordered]@{
        backend_pid = $backend.Id
        frontend_pid = $frontend.Id
        started_at = (Get-Date).ToString('o')
        controller_root = $controllerRoot
    } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-PageReady) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if (-not $ready) {
        throw 'The page did not start in 30 seconds. Check controller_web\logs.'
    }

    Start-Process 'http://localhost:3000'
} catch {
    try { & (Join-Path $controllerRoot 'stop_controller.ps1') -Silent } catch {}
    Show-ControllerError -Message $_.Exception.Message
    exit 1
}
