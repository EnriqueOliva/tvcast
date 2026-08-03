# capyTV

Paste a link on the phone, it plays on the Fire TV, the remote drives it.

    phone (keyboard)        PC (resolver + proxy)            Fire TV Stick (player)
    paste a link      ->    resolve cineby / generic   ->    ExoPlayer plays HLS
                            rewrite playlist                 native subtitles
                            proxy segments + headers         remote drives transport
                            convert subtitles to cues

There is no ffmpeg in the playback path, no transcoding, no burning, no DLNA, and no GPU work
while you watch.

## Hardware

| Thing | Value |
| --- | --- |
| PC | 192.168.1.8, port 8787, Node v24 |
| Fire TV Stick Lite | `AFTSS`, Fire OS 7.7.1.5, **Android 9 / API 28**, armeabi-v7a, 1080p |
| Stick address | 192.168.1.32, listener on port 8788 |
| Android SDK | `C:\Android\sdk` (platforms 35 and 36), Gradle 8.13 at `C:\Gradle`, JDK 21 |
| Package | `com.enrique.capytv` |

The stick installs our own APKs (unlike the old WhaleTV, which enforced a vendor signature).
It has **no AV1 decoder**: H.264, HEVC, VP8, VP9, MPEG2, MPEG4 only. `lib/cineby.js` rejects
AV1, VP9 and Dolby Vision renditions for that reason.

## The pieces

| File | Job |
| --- | --- |
| `lib/cineby.js` | Resolves cineby links. The valuable part. Do not refactor casually |
| `lib/resolve.js` | Everything else: direct probe, yt-dlp, then the embed scraper |
| `lib/embeds.js` | Scrapes a page for media URLs and iframes, so unknown sites still work |
| `lib/languages.js` | English first, Turkish second, everything else after |
| `lib/library.js` | Scans `B:\Media` |
| `lib/tvapi.js` | The whole TV-facing API |
| `lib/hls.js` | Playlist rewriting so segment URLs point at us |
| `lib/proxy.js` | Segment proxy that adds the Referer/Origin/User-Agent the CDN demands |
| `lib/subtitles.js` | Cue parsing, cue JSON, WebVTT, offsets |
| `lib/publications.js` | Publication store keyed on the source URL, persisted |
| `lib/synccheck.js` | Measures subtitle offset against the real audio |
| `firetv/` | The Fire TV app (Java, Media3, no Leanback, no Compose) |
| `android/` | The **phone** app: a WebView wrapper plus a share-sheet target |
| `public/index.html` | The page the phone app shows. One file, no build step, no framework |

`server.js` only wires things together. `createApplication(overrides)` is the whole app as a
factory, which is what lets the tests drive the real routing without touching live state.

## Autostart

Scheduled Task **`CapyTvServer`** runs `start.ps1` at logon and again every 10 minutes.
`start.ps1` is a no-op when port 8787 is already listening, so the repeat is a free crash
recovery rather than a restart. Reinstall with:

    pwsh -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1

The TV app needs no configuring: on first open it sweeps its own /24 for `/api/hello` answering
`"name":"capytv"` and remembers the PC. If the PC's IP changes, the app forgets the stale address
on the next failed call and sweeps again.

## Structure the user sees

The **main list is every link ever pasted**, not a catalogue of resolved items. Selecting one
always re-resolves, so a signed CDN URL can never be stale. Links carry a `collection`; anything
that is not `main` becomes its own button on the phone and its own tab on the TV. That is how
the Turkish series stays out of the way of ordinary films.

Downloads and the saved-media library live behind one **downloads** button on both. Downloads
land in `B:\Media` (`libraryRoots[0]`).

`tools/seed-links.cjs <playlist-url> [collection]` bulk-loads a series into a collection.
`tools/migrate-collections.cjs <name>` back-fills a collection onto links stored before
collections existed.

## Quality is fixed, deliberately

There is **no quality picker anywhere**. The resolver picks the best rendition at or below
1080p, and only if nothing at all is at or below does it take the smallest oversized one, so a
4K-only source still plays. The payload always carries `maxVideoHeight: 1080` and the player
pins `setMaxVideoSize` plus `setForceHighestSupportedBitrate`.

If playback still fails, `PlayerActivity` walks a ladder of 1080 → 720 → 480 → 360, re-preparing
and seeking back to where it was, rather than showing an error.

## Traps that cost real time

- **The CDN 403s without Referer, Origin and User-Agent.** The TV can never be handed an
  upstream URL, which is why every cineby segment is proxied.
- **Segments are disguised as `.jpg`** and arrive with `Content-Type: image/jpeg`. We override it.
- **`#EXT-X-MAP` must survive into the rewritten playlist** or fMP4 fragments are undecodable.
- **cineby VTT uses `MM:SS.mmm`**, not `HH:MM:SS.mmm`.
- **ffmpeg's `-ss` before `-i` does not land where it claims on these playlists.** It silently
  returns a different window. Anything measuring time must fetch exact segments instead.
- **A sleeping stick drops every key event** with "no window focus" while still decoding audio,
  and `screencap` keeps returning the last composited frame, so a screenshot can look like the
  app is stuck when it is fine. Verify through `logcat`, not pixels.
- **A `ScrollView` takes focus itself when it has no focusable children**, and then swallows
  every d-pad press trying to scroll. On the TV home screen with an empty list that left the
  remote completely dead: no tab was reachable, so ömer and downloads could not be opened at
  all. Both scrollers now set `setFocusable(false)` plus `FOCUS_AFTER_DESCENDANTS`, and the
  empty-list branch focuses the open tab instead of returning early with nothing focused.
  The symptom looks exactly like the stale-screencap trap above, which is how it hid for a day.
- **`FLAG_ACTIVITY_NEW_TASK` alone silently drops the intent** when the task already exists, so
  a push would leave the previous item playing. `CLEAR_TOP` is required.
- **`startService` from the background throws on Android 8+.** Use `startForegroundService`.
- **The source files are CRLF.** Anything matching multi-line anchors must account for that.

## Subtitles

Rendered natively by ExoPlayer, never burned. The PC serves cues as JSON; the app drives a
standalone `SubtitleView` from a 100ms ticker that looks cues up by absolute time. That makes an
offset an integer subtraction, so it applies instantly with no rebuffer, and **seeking cannot
desync**: measured 6 to 19ms after a seek against 26 to 52ms during normal playback.

**A positive offset delays the subtitles**, the same direction VLC uses and the same direction
`shiftCues` applies on the server. The two used to disagree, which was a trap rather than a live
bug because the TV never requests a server-side offset. On the remote, D-pad **up** delays and
**down** advances, in 100ms steps, and the notice spells the direction out in words.

**A subtitle track that cannot be loaded never blocks the film.** The publisher tries the chosen
track, then each remaining track in preference order, then plays with subtitles off.

English is on by default everywhere it exists. `lib/languages.js` folds diacritics and matches on
both the track id and its display name, so `tr`, `Türkçe` and `Turkish [CC]` all classify alike.

For the Turkish series, the generated track **replaces** the list rather than joining it, so
YouTube's machine translations can never appear next to the good ones.

`lib/synccheck.js` measures the true offset against the audio after a cineby send, stores it per
title and subtitle track, and pushes it to the app live.

**Selection matters more than alignment.** A stream can be the right episode and still be
unalignable: one Yoru rendition ran 3264s against a real 2852s runtime, padded throughout, so no
offset could fix it. `DURATION_TOLERANCE_RATIO` is 0.10 and renditions are narrowed to those
closest to the TMDB runtime before quality is considered.

## Resume

Keyed on `contentKey`, which is the kind plus a hash of the source URL, so it is independent of
subtitle choice and survives re-resolving. The TV reports every 10 seconds and on exit; the
report also carries the language and the offset, so all three come back together. Anything under
a minute in is not remembered, and anything within 90 seconds of the end clears the bookmark.

## The phone is a real app, not a browser tab

There are **two** pieces on the phone and it is easy to forget the first one:

1. `android/` builds `com.enrique.capytv`, a native app with its own launcher icon. `MainActivity`
   is a full-screen WebView; `ShareActivity` is a share-sheet target, so you can be in YouTube,
   hit Share, pick capyTV, and choose **play on the tv** or **save on the pc** without opening
   anything.
2. `public/index.html` is the page that WebView shows.

Renaming the page does **not** rename the app. The launcher label comes from `strings.xml`, and
a page-level change can never reach it.

    cd android && gradle assembleDebug
    adb -s <phone> install -r app/build/outputs/apk/debug/app-debug.apk

**This source was lost once.** The original phone app was built outside the repo, `android/` was
left empty, and the only copy was the APK on the phone. It survived only because it could be
pulled back off the device and read with `aapt2 dump badging` / `dump xmltree`. Keep it here.

While it was missing it drifted: it posted shares to `/api/cast-url`, the server later dropped
that route, and sharing a link 404ed silently. `test/useractions.test.js` now pins every route
the phone app calls, so a dropped route fails a test instead of failing in your hand.

Neither app needs configuring. Both sweep their own /24 for `/api/hello` answering
`"name":"capytv"`, cache the address, and re-sweep when it stops answering. The phone also has a
manual address box behind "type the address instead" for the case where the sweep cannot help.

## The page

`public/index.html`, one file, no build step, no framework. It is a keyboard: paste a link, one
tap, it plays. The Fire TV remote owns playback, so there is **no player bar and no position
polling**, which is what used to make the phone claim "Nothing playing" over a running film.
There are **no subtitle controls on the phone at all**; that lives on the TV where you are
looking.

Two rules it is built around, both from the physical phone:

- **No `<select>` anywhere.** Android renders them as bottom sheets, which land in the damaged
  bottom half of the screen.
- **Everything actionable stays in the top portion.** The paste box and send button sit at the
  top; the list scrolls under them and the section buttons pin to the bottom.

Nothing reaches `innerHTML`. Every row is built with `createElement` and `textContent`, so a
title containing `&` or `<script>` cannot break the page. There is one in-flight lock: the send
button reads `working`, everything but `back` disables, and every request carries a timeout.

## Foreign language shows: translate the audio, do not hunt for subtitles

For a show whose audio you do not speak and which has no subtitles anywhere, the answer is to
make the subtitles rather than find them.

`tools/pregenerate-subtitles.cjs <playlist-url> <source-language>` walks a playlist, pulls the
audio, and runs Whisper's **translate** task, which goes straight from foreign speech to timed
English. Output is one `.srt` per video id in `cache/subtitles/`, and `lib/tvapi.js` offers it
automatically as an `English (auto)` track whenever a YouTube link with a matching id is sent.
Local subtitle files are re-read from disk on every request, so regenerating one takes effect
without restarting anything.

Measured on the real thing: `large-v3` translates at **14x realtime** on the 4070, so a 2h24m
episode costs about ten minutes, once. The queue skips anything already done, so it is safe to
re-run and safe to kill. Measured sync on the finished article: **29 to 45ms**.

**Sync is exact by construction here**, and this is the point. The cues are derived from the very
audio being played, so there is no offset to measure and no drift to correct. `verifySubtitleSync`
is deliberately skipped for non-cineby publications.

Beware the model choice: `large-v3-turbo` is much faster but was distilled for transcription, and
its translate quality is markedly worse. Use `large-v3` for translation.

Judge success by the artifact, not the exit code: the process exits non-zero during CUDA teardown
*after* writing a perfectly good file, which once threw away a whole night of work. The queue
counts `-->` markers in the output instead.

## YouTube needs two things, and neither is obvious

**A logged-in cookie source.** Without it YouTube answers "Sign in to confirm you're not a bot",
and it will flag the machine after a burst of unauthenticated requests. `ytdlpCookiesFromBrowser`
is `firefox` because Firefox is the only browser yt-dlp can read reliably on this box: Chrome
locks its cookie database and Edge uses app-bound encryption. **Everything that shells out to
yt-dlp must go through that config**, including `tools/pregenerate-subtitles.cjs`, which once did
not and got this machine blocked.

**A JavaScript runtime.** YouTube requires solving an "n challenge" to reveal real formats, and
without a runtime yt-dlp silently returns only storyboard images, reporting
`Requested format is not available`. yt-dlp enables **only deno by default**, so
`ytdlpExtraArgs` carries `--js-runtimes node` to use the Node that is already installed. The
symptom looks like a format problem and is nothing of the sort; run with `-v` and read the
`JS Challenge Providers` line.

## Anything that is not cineby

`lib/resolve.js` tries three things in order, and stops at the first that yields a stream:

1. **A direct probe** of the pasted URL. HEAD, then a one-byte ranged GET for CDNs that refuse
   HEAD. Catches raw `.m3u8` and `.mp4` links.
2. **yt-dlp**, which covers around 1800 sites.
3. **The embed scraper** (`lib/embeds.js`): fetch the page, pull every media URL out of the HTML
   and its inline JavaScript (escaped slashes and HTML entities included), probe each with the
   page as `Referer`, then follow any iframe one level down and repeat. This is what makes a
   cineby-shaped site we have never seen work without new code.

The result is a **direct stream**: `streamKind` is `hls`, `file`, or `split`, and the TV fetches
it itself. Nothing is proxied through the PC, because the proxy only exists for cineby's
Referer-checking CDN.

`split` is how 1080p YouTube works: video and audio arrive as separate URLs and `PlayerActivity`
combines them with `MergingMediaSource`. Without it yt-dlp's only combined format is 360p.
`httpHeaders` from the resolver are applied to the player's `DefaultHttpDataSource`, so a stream
that needs a User-Agent still plays without us relaying the bytes.

Direct publications are **deliberately not persisted with their stream URL**. Signed CDN links
expire, so after a restart the publication rehydrates by resolving again, which is what makes a
day-old row still playable.

## The remote

The Fire TV remote's **volume and power buttons are infrared, sent by the remote itself**, not
Bluetooth and not Android key events. No app can ever see them: `dispatchKeyEvent` logs every
other key and never once logs `KEYCODE_VOLUME_*`. So if volume stops working, it is never an app
bug.

Both dying together while every other button works is the signature of the remote's IR
configuration or its batteries, because those two are the only IR functions. Try batteries first,
then **Settings → Equipment Control → Manage Equipment → TV**. HDMI-CEC is separate and is
already on (`hdmi_control_enabled=1`, `activeCecState: active`).

The app still handles `KEYCODE_VOLUME_UP/DOWN/MUTE` in case they ever arrive, and the settings
overlay carries volume rows so there is always a reachable control.

**MENU** (also `CAPTIONS`, `SETTINGS`, `INFO`) opens a D-pad navigable panel on the right with
subtitle languages and volume. A hint chip appears top-right whenever the transport controls are
visible. BACK closes the panel; BACK again exits and saves the position.

## Tests

    npm test     # 121 tests, node:test only

| File | Covers |
| --- | --- |
| `test/useractions.test.js` | 46 tests of user actions and sequences |
| `test/resolver.test.js` | 18 tests of the real resolver against a real local site |
| `test/tvapi.test.js` | 39 tests of routing, playlists, the proxy and failure paths |
| `test/subtitles.test.js`, `test/playlist.test.js`, `test/timeline.test.js` | the parsers |

Everything capyTV owns runs for real: real HTTP servers on ephemeral ports, the real routing, the
real publication store, the real subtitle parser, the real link store, real state files, and a
real socket standing in for the Fire TV. `test/resolver.test.js` points the **real resolver** at a
real HTTP server, so the probing, HTML scraping and iframe following genuinely happen over the
wire. The one seam is `resolveMedia`, the single function that reaches the public internet; the
shapes it returns are pinned against the real resolver so the seam cannot drift unnoticed.

### The device tests are the ones that matter

    node tools/device-tests.cjs     # 19 tests, real phone and real fire tv
    node tools/device-tv-tests.cjs  # 22 tests, the fire tv driven by the remote alone

`tools/device-lib.cjs` holds the shared plumbing: the accessibility tree reader, `focusOn`
(walk the focus ring in one direction until the wanted label has it), and `awaitFocus`.

The TV suite covers the journeys the remote actually makes: walking the tabs, entering and
leaving the list, starting an episode or a saved file from the TV itself, play/pause, seeking,
the captions panel, volume, the subtitle offset, and the sequences where those interact.
Navigating it taught two things worth keeping:

- **Rows carry `"title\nurl"`, tabs are a single line.** That is the only reliable way to tell
  where focus is.
- **Sideways presses do nothing inside the list**, because rows are full width. Reaching a tab
  from the list means pressing up first, however deep you are.

**Every test above this line can pass with both apps uninstalled.** They exercise the server,
which is not what anybody uses. This suite drives the actual apps on the actual hardware:

- The phone is driven over the WebView devtools protocol to *find* elements, but every
  interaction is a real `input tap` at real screen coordinates, and text goes in as a real
  input event. It asserts on the live DOM.
- The television is driven by real remote key events and read back through `uiautomator dump`
  and its own logcat.
- Cross-checks never read the thing under test: a tap on the phone is confirmed by what the
  television logged, and what the television shows is confirmed against the server's state.

The label test reads the label out of the **installed apk**, because that is the string under
the launcher icon. Asserting on the web page instead is exactly how the app sat there called
"TV Cast" for a day while the page underneath said capyTV.

Three traps this suite hit, all of which made it lie before they were fixed:

- **Bounds go stale.** The soft keyboard resizes the WebView, so coordinates worked out once at
  connect send later taps into empty space, silently. Bounds are re-read on every tap.
- **Tap then assert is a race.** The tap is delivered asynchronously. `tapUntil` waits for the
  consequence and re-taps if the first one was swallowed.
- **A settle condition satisfied by stale state is worse than none.** Waiting for "the status
  line is not empty" passes instantly on last test's message. Blank it first.

`screencap` on the Fire TV returns the last composited frame when the panel is asleep, so a
screenshot can look frozen while the app is fine. Verify through logcat, never pixels.

    node tools/mutation-check.cjs

Breaks the production code 15 ways and asserts a test dies each time: dropping the English
default, dropping language ordering, un-capping 1080p, forgetting a link's collection, not
restoring the language, letting a broken subtitle kill the send, not falling through to the next
language, minting a publication per subtitle choice, shifting cues the wrong way, ignoring the
height ceiling twice over, never remembering a position, not following iframes, caching a
subtitle file instead of re-reading it, and delivering a queued push twice.

**The lesson that produced this suite:** an earlier 143 tests passed with ffmpeg, the network and
the TV entirely absent, and one of them asserted a bug was correct behaviour. Validate the
instrument against known-good input before believing any measurement.

## Still to do

- The quality label reads `unknown` for some providers, because cineby's rendition has no height
  in its label. Cosmetic, and it is the label rather than the pick that is wrong.
- The embed scraper follows iframes one level only. Two-level embeds would need a real browser.
