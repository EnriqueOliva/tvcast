# Proof of concept: play through the TV's own player instead of DLNA

Tested 2026-07-30 against `Whale TV(F4F1)`, WhaleOS / Android 13, over network ADB.

## Why

The DLNA renderer this project casts to has no player UI at all. `uiautomator dump`
during playback returns empty `FrameLayout`/`LinearLayout` from `com.zeasn.tv.cast`,
with no controls, and every remote key is ignored:

    baseline           : PLAYING pos=19
    MEDIA_PLAY_PAUSE   : PLAYING pos=23
    MEDIA_PAUSE        : PLAYING pos=27
    MEDIA_FAST_FORWARD : PLAYING pos=31
    DPAD_RIGHT         : PLAYING pos=35
    MEDIA_PLAY         : PLAYING pos=39

Nothing responds; the position simply keeps climbing. It cannot be fixed on this
box either — `ro.build.type=user`, `ro.debuggable=0`, no `su`, and the renderer is a
system app. There is nothing to patch.

## What works instead

`am start` a real player already installed on the TV, pointed at a tvcast URL:

    com.droidlogic.exoplayer2.demo/com.droidlogic.videoplayer.MoviePlayer

That class lives inside the `com.droidlogic.exoplayer2.demo` package, not
`com.droidlogic.videoplayer` — naming the obvious package fails with
`Activity class ... does not exist`, which is what made this look impossible at
first. The APK also ships `com.google.android.exoplayer2.demo.PlayerActivity`, but
PackageManager will not resolve it.

`npm run poc:player` drives the whole thing and asserts each step:

    PASS  adb connected
    PASS  player launches with our stream
    PASS  player is in the foreground — MoviePlayer resumed
    PASS  the player reports a playback position
    PASS  the remote pause key stops playback — frozen at 10.4s
    PASS  the remote play key resumes playback — 14.0s -> 17.0s
    PASS  the remote forward key moves the position — 17.0s -> 39.0s

Pause, play and forward all work from the remote. It reports position through
`NU-AmNuPlayerDriver ... [getCurrentPosition]` in logcat, which is how the harness
reads playback state without DLNA. The player also logs a `SubtitleManager`, so
native subtitle rendering looks plausible — untested.

## What this would cost

- **ADB must be connected when casting.** Network debugging has to stay on, and the
  connection can drop. That is a new hard dependency the DLNA path does not have.
- **No DLNA transport feedback.** The phone's scrubber and position readout come from
  SOAP polling today. This path has no media session (`dumpsys media_session` lists
  only Bluetooth and Netflix), so position has to be scraped from logcat, which is
  slow and coarse.
- **Seeking to an arbitrary position is unproven.** The forward key jumps a fixed
  amount. Sending the phone's scrubber position would need either a seek intent the
  player accepts or repeated key presses.
- Gallery's `com.android.gallery3d/.app.MovieActivity` resolves and launches, but its
  legacy MediaPlayer rejected the same stream with `error (1, -2147483648)`.

## Files

    lib/adbplayer.js                launch, key sending, position parsing
    test/adbplayer.test.js          pure tests for argument building and log parsing
    tools/poc-external-player.cjs   the live end-to-end check, needs the TV
