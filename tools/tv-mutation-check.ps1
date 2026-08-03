# Breaks the Fire TV app in one specific way, reinstalls it, runs the tests that ought to
# notice, and restores the source. A device suite that has never been watched go red is only
# marginally more trustworthy than one that cannot fail.
#
# Each mutation names the tests that should catch it, because a full pass takes half an hour
# and running all of it once per mutation would take a working day.

param(
    [string]$Mutation = 'all'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sourceRoot = Join-Path $projectRoot 'firetv\app\src\main\java\com\enrique\capytv'
$gradle = 'C:\Gradle\gradle-8.13\bin\gradle.bat'
$adb = 'C:\Android\Sdk\platform-tools\adb.exe'
$television = '192.168.1.32:5555'
$apk = Join-Path $projectRoot 'firetv\app\build\outputs\apk\debug\app-debug.apk'

$mutations = [ordered]@{
    'focus-trap'      = @{ File = 'HomeActivity.java'
                           From = 'scroller.setFocusable(false);'
                           To   = 'scroller.setFocusable(true);'
                           Only = 'opening the app leaves something focused'
                           Why  = 'the list container steals focus again, the remote goes dead' }
    'server-pill'     = @{ File = 'HomeActivity.java'
                           From = 'setServerPill(readableAddress(baseUrl), Theme.GOOD);'
                           To   = 'setServerPill("connected", Theme.GOOD);'
                           Only = 'the header says which pc'
                           Why  = 'the header stops naming which pc it found' }
    'silent-strip'    = @{ File = 'HomeActivity.java'
                           From = '        activityStrip.setVisibility(View.VISIBLE);'
                           To   = '        activityStrip.setVisibility(View.GONE);'
                           Only = 'the strip reports what the pc is doing'
                           Why  = 'the home screen stops saying what the pc is busy with' }
    'stuck-strip'     = @{ File = 'HomeActivity.java'
                           From = '            activityStrip.setVisibility(View.GONE);
            return;'
                           To   = '            return;'
                           Only = 'the strip goes away again'
                           Why  = 'the activity strip never clears when the pc goes quiet' }
    'no-loading'      = @{ File = 'PlayerActivity.java'
                           From = 'setStageBusy(STAGE_LOADING_VIDEO, "opening the stream");'
                           To   = 'hideStage();'
                           Only = 'the whole screen announces the video'
                           Why  = 'the player stops saying it is loading anything' }
    'stuck-loading'   = @{ File = 'PlayerActivity.java'
                           From = '                showBufferingPill(false);
                hideStage();'
                           To   = '                showBufferingPill(false);'
                           Only = 'the loading screen disappears'
                           Why  = 'the loading screen never gets out of the way of the video' }
    'silent-subs'     = @{ File = 'PlayerActivity.java'
                           From = '        announceMissingSubtitles();'
                           To   = '        hideSubtitlePill();'
                           Only = 'says so rather than staying silent'
                           Why  = 'a stream with no subtitles goes quiet about it again' }
    'quiet-cue-count' = @{ File = 'PlayerActivity.java'
                           From = 'showSubtitlePill(language + SEPARATOR + parsed.size() + " lines", false);'
                           To   = 'hideSubtitlePill();'
                           Only = 'says which track it is loading'
                           Why  = 'the player stops reporting the track it loaded' }
    'paused-seek'     = @{ File = 'PlayerActivity.java'
                           From = '} else if (code == KeyEvent.KEYCODE_DPAD_RIGHT) {'
                           To   = '} else if (playerView.isControllerFullyVisible() == false && code == KeyEvent.KEYCODE_DPAD_RIGHT) {'
                           Only = 'right seeks forward 30s'
                           Why  = 'seeking is gated on the controller again, so it dies while paused' }
    'subtitle-off'    = @{ File = 'PlayerActivity.java'
                           From = '            subtitleController.setCueTrack(CueTrack.empty());'
                           To   = '            subtitleController.setCueTrack(subtitleController.hasCues() ? null : CueTrack.empty());'
                           Only = 'choosing off stops the subtitles'
                           Why  = 'turning subtitles off no longer clears the cues' }
    'offset-reset'    = @{ File = 'PlayerActivity.java'
                           From = '        long updated = subtitleController.getOffsetMilliseconds() + deltaMilliseconds;'
                           To   = '        long updated = deltaMilliseconds;'
                           Only = 'up and down move it'
                           Why  = 'the subtitle offset stops accumulating' }
    'panel-mark'      = @{ File = 'PlayerActivity.java'
                           From = 'row.setText(isSelected ? "•  " + label : "    " + label);'
                           To   = 'row.setText("    " + label);'
                           Only = 'marks the track that is actually on'
                           Why  = 'the panel stops showing which track is chosen' }
}

function Invoke-Build {
    Push-Location (Join-Path $projectRoot 'firetv')
    try {
        & $gradle assembleDebug --console=plain -q 2>&1 | Select-String 'error:|FAILED' | Select-Object -First 3
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Invoke-Mutation {
    param([string]$Name)

    $plan = $mutations[$Name]
    $target = Join-Path $sourceRoot $plan.File
    $original = Get-Content $target -Raw

    if ($original -notlike "*$($plan.From)*") {
        Write-Output "SKIPPED  $Name (anchor not found in $($plan.File))"
        return $false
    }

    Write-Output ""
    Write-Output "=== $Name : $($plan.Why)"
    $caught = $false
    try {
        $original.Replace($plan.From, $plan.To) | Set-Content $target -NoNewline -Encoding UTF8
        if ((Invoke-Build) -ne 0) { throw "the broken build did not compile" }
        & $adb -s $television install -r $apk | Out-Null

        Push-Location $projectRoot
        try {
            $output = & node tools\device-tv-tests.cjs "--only=$($plan.Only)" 2>&1
        } finally {
            Pop-Location
        }
        $summary = $output | Select-String 'tv action tests passed' | Select-Object -First 1
        $failures = $output | Select-String '^FAIL'
        if ($failures) {
            $caught = $true
            Write-Output "CAUGHT   $Name  ($summary)"
            $failures | ForEach-Object { Write-Output "         $_" }
        } elseif ($output | Select-String 'no tv action test matched') {
            Write-Output "SKIPPED  $Name (no test matched '$($plan.Only)')"
        } else {
            Write-Output "SURVIVED $Name  <-- no test noticed  ($summary)"
        }
    } finally {
        $original | Set-Content $target -NoNewline -Encoding UTF8
        Invoke-Build | Out-Null
        & $adb -s $television install -r $apk | Out-Null
        Write-Output "         source restored and the good build reinstalled"
    }
    return $caught
}

$wanted = if ($Mutation -eq 'all') { @($mutations.Keys) } else { @($Mutation) }
foreach ($name in $wanted) {
    if (-not $mutations.Contains($name)) {
        throw "unknown mutation '$name'. Known: $($mutations.Keys -join ', ')"
    }
}

$caughtCount = 0
foreach ($name in $wanted) {
    if (Invoke-Mutation -Name $name) { $caughtCount += 1 }
}

Write-Output ""
Write-Output "$caughtCount/$($wanted.Count) tv mutations caught"
if ($caughtCount -ne $wanted.Count) { exit 1 }
