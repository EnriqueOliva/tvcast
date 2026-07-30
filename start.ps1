$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDirectory

$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess

if ($existing) {
    Write-Output "tvcast already running (pid $existing)"
} else {
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $projectDirectory -WindowStyle Hidden `
        -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.err'
    Start-Sleep -Seconds 3
    try {
        $state = Invoke-RestMethod 'http://127.0.0.1:8787/api/state' -TimeoutSec 5
        Write-Output "tvcast up  ->  http://$($state.serverAddress):8787"
        Write-Output "library: $($state.libraryCount) videos"
        foreach ($device in $state.devices) { Write-Output "renderer: $($device.name) @ $($device.address)" }
    } catch {
        Write-Warning "started but not answering yet: $($_.Exception.Message)"
    }
}
