$ErrorActionPreference = 'Stop'

$controllerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$vinextCli = Join-Path $controllerRoot 'node_modules\vinext\dist\cli.js'
$sshKey = Join-Path $env:USERPROFILE '.ssh\esp32_gun_cas_m8s_v2'
$tunnelWatchdogScript = Join-Path $controllerRoot 'dog_tunnel_watchdog.ps1'
$pidFile = Join-Path $controllerRoot '.dog-controller-pids.json'
$logDirectory = Join-Path $controllerRoot 'logs'
$localApi = 'http://127.0.0.1:8765'
$localPage = 'http://localhost:3000'

function Show-ControllerError {
    param([string]$Message)
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            $Message,
            'Mechanical Dog Controller - Start failed',
            'OK',
            'Error'
        ) | Out-Null
    } catch {
        Write-Error $Message
    }
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-TunnelProcess {
    param([int]$ProcessId)
    $process = Get-ProcessCommandLine -ProcessId $ProcessId
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)) {
        return $false
    }
    return (
        $process.Name -ieq 'powershell.exe' -and
        $process.CommandLine.IndexOf($controllerRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $process.CommandLine.IndexOf('dog_tunnel_watchdog.ps1', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    )
}

function Test-FrontendProcess {
    param([int]$ProcessId)
    $process = Get-ProcessCommandLine -ProcessId $ProcessId
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)) {
        return $false
    }
    return (
        $process.CommandLine.IndexOf($controllerRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $process.CommandLine.IndexOf('vinext\dist\cli.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    )
}

function Test-ApiReady {
    try {
        $result = Invoke-RestMethod -Uri "$localApi/api/health" -TimeoutSec 2
        return $result.ok -eq $true
    } catch {
        return $false
    }
}

function Test-PageReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $localPage -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$tunnel = $null
$frontend = $null

try {
    if (Test-Path -LiteralPath $pidFile) {
        try {
            $saved = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
            if (
                (Test-TunnelProcess -ProcessId ([int]$saved.tunnel_pid)) -and
                (Test-FrontendProcess -ProcessId ([int]$saved.frontend_pid)) -and
                (Test-ApiReady) -and
                (Test-PageReady)
            ) {
                Start-Process $localPage
                exit 0
            }
        } catch {}
    }

    & (Join-Path $controllerRoot 'stop_dog_controller.ps1') -Silent
    & (Join-Path $controllerRoot 'stop_controller.ps1') -Silent

    if (-not (Test-Path -LiteralPath $sshKey)) {
        throw "SSH key is missing: $sshKey"
    }
    if (-not (Test-Path -LiteralPath $tunnelWatchdogScript)) {
        throw "Tunnel watchdog is missing: $tunnelWatchdogScript"
    }
    if (-not (Test-Path -LiteralPath $vinextCli)) {
        throw 'Web dependencies are missing. Run npm install in controller_web.'
    }

    $powershellCommand = (Get-Command powershell.exe -ErrorAction Stop).Source
    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

    $tunnel = Start-Process -FilePath $powershellCommand `
        -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $tunnelWatchdogScript
        ) `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory 'dog-tunnel.out.log') `
        -RedirectStandardError (Join-Path $logDirectory 'dog-tunnel.error.log') `
        -PassThru

    $apiReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($tunnel.HasExited) {
            $details = Get-Content -Raw -LiteralPath (Join-Path $logDirectory 'dog-tunnel.error.log') -ErrorAction SilentlyContinue
            throw "SSH tunnel watchdog stopped unexpectedly. $details"
        }
        if (Test-ApiReady) {
            $apiReady = $true
            break
        }
        Start-Sleep -Milliseconds 500
        $tunnel.Refresh()
    }
    if (-not $apiReady) {
        throw 'The mechanical-dog bridge did not become ready.'
    }

    $frontend = Start-Process -FilePath $nodeCommand `
        -ArgumentList @($vinextCli, 'dev') `
        -WorkingDirectory $controllerRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory 'dog-frontend.out.log') `
        -RedirectStandardError (Join-Path $logDirectory 'dog-frontend.error.log') `
        -PassThru

    [ordered]@{
        tunnel_pid = $tunnel.Id
        frontend_pid = $frontend.Id
        started_at = (Get-Date).ToString('o')
        controller_root = $controllerRoot
    } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

    $pageReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($frontend.HasExited) {
            $details = Get-Content -Raw -LiteralPath (Join-Path $logDirectory 'dog-frontend.error.log') -ErrorAction SilentlyContinue
            throw "Web page stopped unexpectedly. $details"
        }
        if (Test-PageReady) {
            $pageReady = $true
            break
        }
        Start-Sleep -Milliseconds 500
        $frontend.Refresh()
    }
    if (-not $pageReady) {
        throw 'The control page did not become ready.'
    }

    Start-Process $localPage
} catch {
    if ($null -ne $frontend -and -not $frontend.HasExited) {
        Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $tunnel -and -not $tunnel.HasExited) {
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $pidFile) {
        Remove-Item -LiteralPath $pidFile -Force
    }
    Show-ControllerError -Message $_.Exception.Message
    exit 1
}
