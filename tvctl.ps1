param(
    [Parameter(Position = 0)][string]$Command = 'status',
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Arguments
)

$ErrorActionPreference = 'Stop'
$BaseUrl = 'http://127.0.0.1:8787'
$AdbPath = 'C:\Users\Enrique\platform-tools\adb.exe'
$TvAddress = '192.168.1.27'

function Invoke-TvCastApi {
    param([string]$Path, [string]$Method = 'GET', $Body = $null)
    if ($Body -ne $null) {
        return Invoke-RestMethod "$BaseUrl$Path" -Method $Method -ContentType 'application/json' -Body ($Body | ConvertTo-Json)
    }
    return Invoke-RestMethod "$BaseUrl$Path" -Method $Method
}

function Show-Status {
    $state = Invoke-TvCastApi '/api/state'
    "TV        : " + (($state.devices | ForEach-Object { "$($_.name) ($($_.address))" }) -join ', ')
    "Library   : $($state.libraryCount) videos"
    "Serving   : http://$($state.serverAddress):8787"
    "Playback  : $($state.playback.state)  $($state.playback.positionSeconds)s / $($state.playback.durationSeconds)s"
    if ($state.playback.title) { "Title     : $($state.playback.title)" }
}

switch ($Command.ToLower()) {
    'status' { Show-Status }

    'scan' {
        $result = Invoke-TvCastApi '/api/scan' 'POST'
        "Scanned: $($result.count) videos"
    }

    'discover' {
        $result = Invoke-TvCastApi '/api/discover' 'POST'
        $result.devices | ForEach-Object { "$($_.name)  $($_.address)" }
    }

    'find' {
        $query = ($Arguments -join ' ')
        $result = Invoke-TvCastApi ('/api/library?q=' + [uri]::EscapeDataString($query))
        $result.items | Select-Object -First 25 | ForEach-Object {
            "{0,-60} {1,8:N1} MB  {2}" -f $_.title, ($_.sizeBytes / 1MB), $_.folder
        }
    }

    'play' {
        $query = ($Arguments -join ' ')
        $result = Invoke-TvCastApi ('/api/library?q=' + [uri]::EscapeDataString($query))
        if ($result.items.Count -eq 0) {
            Write-Warning "No match for '$query'"
        } else {
            $item = $result.items[0]
            Invoke-TvCastApi '/api/play' 'POST' @{ itemId = $item.id; startSeconds = $item.resumeSeconds } | Out-Null
            "Playing on TV: $($item.title)"
        }
    }

    'pause'  { Invoke-TvCastApi '/api/control' 'POST' @{ action = 'pause'  } | Out-Null; 'paused' }
    'resume' { Invoke-TvCastApi '/api/control' 'POST' @{ action = 'resume' } | Out-Null; 'resumed' }
    'stop'   { Invoke-TvCastApi '/api/control' 'POST' @{ action = 'stop'   } | Out-Null; 'stopped' }
    'seek'   { Invoke-TvCastApi '/api/control' 'POST' @{ action = 'seek'; value = [int]$Arguments[0] } | Out-Null; "seeked to $($Arguments[0])s" }

    'why' {
        $target = ($Arguments -join ' ')
        if ($target -eq '') { Write-Warning 'usage: tvctl why <url>'; break }
        Write-Output "Testing $target ..."
        $report = Invoke-TvCastApi '/api/diagnose' 'POST' @{ url = $target }
        foreach ($r in $report.results) {
            if ($r.ok) {
                "  {0,-24} OK   extractor={1} formats={2} best={3}p ({4}s)" -f $r.label, $r.extractor, $r.formatCount, $r.bestHeight, $r.elapsedSeconds
            } else {
                "  {0,-24} FAIL {1} ({2}s)" -f $r.label, $r.reason, $r.elapsedSeconds
                "       {0}" -f $r.detail
            }
        }
        if ($report.winner) {
            ""
            "WORKS WITH: $($report.winner.label)"
            if ($report.winner.label -like 'cookies*') {
                "Set it permanently in config.json -> ytdlpCookiesFromBrowser"
            }
            if ($report.winner.label -like '*impersonate*') {
                "Set it permanently in config.json -> ytdlpImpersonate: chrome"
            }
        } elseif ($report.verdict -eq 'no-extractor') {
            ""
            "yt-dlp has NO EXTRACTOR for this site. This is not anti-bot -"
            "cookies and impersonation cannot help, there is nothing to parse the page."
            "Fallback: get the file and drop it in B:\Media or /sdcard/phoneMedia."
        } else {
            ""
            "Blocked by the site. Fallback: get the file and drop it in B:\Media or /sdcard/phoneMedia."
        }
    }

    'adb-connect' {
        & $AdbPath connect "${TvAddress}:5555"
        & $AdbPath devices -l
    }

    'adb-apps' {
        & $AdbPath -s "${TvAddress}:5555" shell pm list packages -3
        '--- system packages ---'
        & $AdbPath -s "${TvAddress}:5555" shell pm list packages -s
    }

    'adb-install' {
        $apkPath = $Arguments[0]
        if (-not (Test-Path $apkPath)) { throw "APK not found: $apkPath" }
        & $AdbPath -s "${TvAddress}:5555" install -r $apkPath
    }

    'adb-push-install' {
        $apkPath = $Arguments[0]
        if (-not (Test-Path $apkPath)) { throw "APK not found: $apkPath" }
        $remote = '/data/local/tmp/' + (Split-Path $apkPath -Leaf)
        & $AdbPath -s "${TvAddress}:5555" push $apkPath $remote
        & $AdbPath -s "${TvAddress}:5555" shell pm install -r -t $remote
    }

    'adb-disable' {
        $package = $Arguments[0]
        & $AdbPath -s "${TvAddress}:5555" shell pm disable-user --user 0 $package
    }

    'adb-type' {
        $text = ($Arguments -join ' ') -replace ' ', '%s'
        & $AdbPath -s "${TvAddress}:5555" shell input text $text
    }

    default {
        @'
tvctl <command>

  status                     show TV, library and playback state
  scan                       rescan the library folders
  discover                   re-run SSDP discovery
  find <words>               search the library
  play <words>               play the first match on the TV
  pause | resume | stop      transport control
  seek <seconds>             jump to a position

  adb-connect                adb connect to the TV (needs dev options on the TV)
  adb-apps                   list installed packages
  adb-install <apk>          normal install
  adb-push-install <apk>     push to /data/local/tmp then pm install (bypass attempt)
  adb-disable <package>      disable a bloat package
  adb-type <words>           type text into whatever is focused on the TV
'@
    }
}
