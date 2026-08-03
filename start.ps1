$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDirectory

$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess

if ($existing) {
    Write-Output "capyTV already running (pid $existing)"
} else {
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) {
        $nodePath = 'C:\nvm4w\nodejs\node.exe'
    }
    Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $projectDirectory -WindowStyle Hidden `
        -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.err'
    Start-Sleep -Seconds 3
    try {
        $hello = Invoke-RestMethod 'http://127.0.0.1:8787/api/hello' -TimeoutSec 5
        $saved = Invoke-RestMethod 'http://127.0.0.1:8787/api/library' -TimeoutSec 30
        $television = Invoke-RestMethod 'http://127.0.0.1:8787/api/tv/status' -TimeoutSec 5
        Write-Output "capyTV up  ->  $($hello.serverBaseUrl)"
        Write-Output "saved media: $($saved.total) videos"
        if ($television.address) {
            Write-Output "fire tv: $($television.address):$($television.port)"
        } else {
            Write-Output "fire tv: not located yet, it registers itself when the app opens"
        }
    } catch {
        Write-Warning "started but not answering yet: $($_.Exception.Message)"
    }
}
