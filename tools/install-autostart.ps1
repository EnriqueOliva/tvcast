$ErrorActionPreference = 'Stop'

$taskName = 'CapyTvServer'
$projectDirectory = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$startScript = Join-Path $projectDirectory 'start.ps1'

if (-not (Test-Path $startScript)) {
    throw "cannot find $startScript"
}

$powershellPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $powershellPath) {
    $powershellPath = (Get-Command powershell).Source
}

$successExitCode = 0
$launcherSource = Join-Path $projectDirectory 'bin\runhidden.cs'
$launcherPath = Join-Path $projectDirectory 'bin\runhidden.exe'

if (-not (Test-Path $launcherPath)) {
    if (-not (Test-Path $launcherSource)) {
        throw "cannot find $launcherSource"
    }

    $compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $compilerPath)) {
        throw "cannot find $compilerPath, needed to build $launcherPath"
    }

    & $compilerPath /nologo /target:winexe /optimize+ "/out:$launcherPath" $launcherSource
    if ($LASTEXITCODE -ne $successExitCode) {
        throw "failed to build $launcherPath"
    }
}

$action = New-ScheduledTaskAction -Execute $launcherPath `
    -Argument "`"$powershellPath`" -NoProfile -ExecutionPolicy Bypass -File `"$startScript`"" `
    -WorkingDirectory $projectDirectory

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$heartbeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $taskName `
    -Action $action `
    -Trigger @($logonTrigger, $heartbeatTrigger) `
    -Settings $settings `
    -Principal $principal `
    -Description 'Starts the capyTV server at logon and keeps it alive every 10 minutes. start.ps1 is a no-op when the port is already listening.' | Out-Null

Write-Output "installed scheduled task '$taskName'"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, NextRunTime, LastTaskResult
