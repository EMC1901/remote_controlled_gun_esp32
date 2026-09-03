$ErrorActionPreference = 'Continue'

$sshKey = Join-Path $env:USERPROFILE '.ssh\esp32_gun_cas_m8s_v2'
$sshCommand = (Get-Command ssh.exe -ErrorAction Stop).Source

while ($true) {
    & $sshCommand `
        -N `
        -T `
        -i $sshKey `
        -o IdentitiesOnly=yes `
        -o BatchMode=yes `
        -o StrictHostKeyChecking=yes `
        -o ExitOnForwardFailure=yes `
        -o ConnectTimeout=5 `
        -o ServerAliveInterval=10 `
        -o ServerAliveCountMax=2 `
        -L 127.0.0.1:8765:127.0.0.1:18765 `
        cas@10.42.0.1

    Start-Sleep -Seconds 2
}
