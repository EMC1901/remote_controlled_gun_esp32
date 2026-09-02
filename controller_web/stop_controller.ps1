param([switch]$Silent)

$ErrorActionPreference = 'Stop'
$controllerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $controllerRoot '.controller-pids.json'

function Show-StopMessage {
    param([string]$Message, [bool]$IsError = $false)
    if ($Silent) { return }
    try {
        Add-Type -AssemblyName PresentationFramework
        $icon = if ($IsError) { 'Error' } else { 'Information' }
        [System.Windows.MessageBox]::Show($Message, 'ESP32 Controller', 'OK', $icon) | Out-Null
    } catch {
        Write-Host $Message
    }
}

function Test-ControllerProcess {
    param($Process)
    if ($null -eq $Process -or [string]::IsNullOrWhiteSpace($Process.CommandLine)) {
        return $false
    }
    $belongsToRoot = $Process.CommandLine.IndexOf(
        $controllerRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -ge 0
    $isControllerService =
        $Process.CommandLine.IndexOf('bridge\server.py', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $Process.CommandLine.IndexOf('vinext\dist\cli.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    return $belongsToRoot -and $isControllerService
}

function Stop-ProcessTree {
    param([int]$RootProcessId)
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -RootProcessId $child.ProcessId
    }
    Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

try {
    # Stop changing the position before releasing the Bluetooth COM port. The ESP32 keeps the
    # last target pulse; its watchdog and disconnect handler provide a fallback.
    try {
        Invoke-RestMethod -Method Post `
            -Uri 'http://127.0.0.1:8765/api/command' `
            -ContentType 'application/json' `
            -Body '{"command":"STOP"}' `
            -TimeoutSec 2 | Out-Null
    } catch {}

    $candidateIds = [System.Collections.Generic.HashSet[int]]::new()
    if (Test-Path -LiteralPath $pidFile) {
        try {
            $saved = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
            [void]$candidateIds.Add([int]$saved.backend_pid)
            [void]$candidateIds.Add([int]$saved.frontend_pid)
        } catch {}
    }

    foreach ($process in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if (Test-ControllerProcess -Process $process) {
            [void]$candidateIds.Add([int]$process.ProcessId)
        }
    }

    foreach ($processId in $candidateIds) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        if (Test-ControllerProcess -Process $process) {
            Stop-ProcessTree -RootProcessId $processId
        }
    }

    if (Test-Path -LiteralPath $pidFile) {
        Remove-Item -LiteralPath $pidFile -Force
    }
    Start-Sleep -Milliseconds 500
    Show-StopMessage -Message 'Web services and the Bluetooth bridge are stopped.'
} catch {
    Show-StopMessage -Message $_.Exception.Message -IsError $true
    exit 1
}
