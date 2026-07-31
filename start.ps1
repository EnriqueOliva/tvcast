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
        $hello = Invoke-RestMethod 'http://127.0.0.1:8787/api/hello' -TimeoutSec 5
        $library = Invoke-RestMethod 'http://127.0.0.1:8787/api/library' -TimeoutSec 20
        $television = Invoke-RestMethod 'http://127.0.0.1:8787/api/tv/status' -TimeoutSec 5
        Write-Output "tvcast up  ->  $($hello.serverBaseUrl)"
        Write-Output "library: $($library.total) videos"
        if ($television.address) {
            Write-Output "fire tv: $($television.address):$($television.port)"
        } else {
            Write-Output "fire tv: not located yet, it registers itself when the app opens"
        }
    } catch {
        Write-Warning "started but not answering yet: $($_.Exception.Message)"
    }
}
