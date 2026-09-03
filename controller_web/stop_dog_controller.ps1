param([switch]$Silent)

$ErrorActionPreference = 'Stop'
$controllerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $controllerRoot '.dog-controller-pids.json'

function Show-StopMessage {
    param([string]$Message, [bool]$IsError = $false)
    if ($Silent) { return }
    try {
        Add-Type -AssemblyName PresentationFramework
        $icon = if ($IsError) { 'Error' } else { 'Information' }
        [System.Windows.MessageBox]::Show(
            $Message,
            'Mechanical Dog Controller',
            'OK',
            $icon
        ) | Out-Null
    } catch {
        Write-Host $Message
    }
}

function Test-ManagedProcess {
    param($Process, [string]$Kind)
    if ($null -eq $Process -or [string]::IsNullOrWhiteSpace($Process.CommandLine)) {
        return $false
    }
    if ($Kind -eq 'tunnel') {
        return (
            $Process.Name -ieq 'powershell.exe' -and
            $Process.CommandLine.IndexOf($controllerRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $Process.CommandLine.IndexOf('dog_tunnel_watchdog.ps1', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        )
    }
    return (
        $Process.CommandLine.IndexOf($controllerRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $Process.CommandLine.IndexOf('vinext\dist\cli.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    )
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
    try {
        Invoke-RestMethod -Method Post `
            -Uri 'http://127.0.0.1:8765/api/command' `
            -ContentType 'application/json' `
            -Body '{"command":"STOP"}' `
            -TimeoutSec 3 | Out-Null
    } catch {}

    if (Test-Path -LiteralPath $pidFile) {
        try {
            $saved = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
            $targets = @(
                @{ Id = [int]$saved.frontend_pid; Kind = 'frontend' },
                @{ Id = [int]$saved.tunnel_pid; Kind = 'tunnel' }
            )
            foreach ($target in $targets) {
                $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($target.Id)" -ErrorAction SilentlyContinue
                if (Test-ManagedProcess -Process $process -Kind $target.Kind) {
                    Stop-ProcessTree -RootProcessId $target.Id
                }
            }
        } catch {}
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }

    Show-StopMessage -Message 'The web controller and SSH tunnel are stopped.'
} catch {
    Show-StopMessage -Message $_.Exception.Message -IsError $true
    exit 1
}
