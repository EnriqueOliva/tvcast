# tvcast

Paste a link on the phone, it plays on the Fire TV, the remote drives it.

    phone (keyboard)        PC (resolver + proxy)            Fire TV Stick (player)
    paste a link      ->    resolve cineby / yt-dlp    ->    ExoPlayer plays HLS
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

The stick installs our own APKs (unlike the old WhaleTV, which enforced a vendor signature).
It has **no AV1 decoder**: H.264, HEVC, VP8, VP9, MPEG2, MPEG4 only. `lib/cineby.js` rejects
AV1, VP9 and Dolby Vision renditions for that reason.

## The pieces

| File | Job |
| --- | --- |
| `lib/cineby.js` | Resolves cineby links. The valuable part. Do not refactor casually |
| `lib/resolve.js` | yt-dlp for everything else, plus downloads |
| `lib/library.js` | Scans `B:\Media` |
| `lib/tvapi.js` | The whole TV-facing API |
| `lib/hls.js` | Playlist rewriting so segment URLs point at us |
| `lib/proxy.js` | Segment proxy that adds the Referer/Origin/User-Agent the CDN demands |
| `lib/subtitles.js` | Cue parsing, cue JSON, WebVTT, offsets |
| `lib/publications.js` | Content-addressed publication store, persisted |
| `lib/synccheck.js` | Measures subtitle offset against the real audio |
| `firetv/` | The Fire TV app (Java, Media3, no Leanback, no Compose) |

`server.js` is 233 lines and only wires things together.

## Traps that cost real time

- **The CDN 403s without Referer, Origin and User-Agent.** The TV can never be handed an
  upstream URL, which is why every segment is proxied.
- **Segments are disguised as `.jpg`** and arrive with `Content-Type: image/jpeg`. We override it.
- **`#EXT-X-MAP` must survive into the rewritten playlist** or fMP4 fragments are undecodable.
- **cineby VTT uses `MM:SS.mmm`**, not `HH:MM:SS.mmm`.
- **ffmpeg's `-ss` before `-i` does not land where it claims on these playlists.** It silently
  returns a different window. Anything measuring time must fetch exact segments instead.
- **A sleeping stick drops every key event** with "no window focus" while still decoding audio.
  If the remote seems dead, check `dumpsys power` before touching any code.
- **`FLAG_ACTIVITY_NEW_TASK` alone silently drops the intent** when the task already exists, so
  a push would leave the previous item playing. `CLEAR_TOP` is required.
- **`startService` from the background throws on Android 8+.** Use `startForegroundService`.
- **`dumpsys media_session` reports nothing useful** because the app registers no MediaSession.

## Subtitles

Rendered natively by ExoPlayer, never burned. The PC serves cues as JSON; the app drives a
standalone `SubtitleView` from a 100ms ticker that looks cues up by absolute time. That makes an
offset an integer addition, so it applies instantly with no rebuffer, and **seeking cannot
desync**: measured 6 to 19ms after a seek against 26 to 52ms during normal playback.

`lib/synccheck.js` measures the true offset against the audio after a send, stores it per title
and subtitle track, and pushes it to the app live. It is measured once and reused forever. A
manual nudge with the remote is remembered the same way.

**Selection matters more than alignment.** A stream can be the right episode and still be
unalignable: one Yoru rendition ran 3264s against a real 2852s runtime, padded throughout, so no
offset could fix it. `DURATION_TOLERANCE_RATIO` is 0.10 and renditions are narrowed to those
closest to the TMDB runtime before quality is considered.

## Tests

    npm test     # 50 tests, node:test only

`test/tvapi.test.js` drives a **real HTTP server on an ephemeral port against a fake CDN**, so it
covers routing, playlist rewriting, the proxy headers, failure paths and concurrency. Nothing
stubs `child_process.spawn` and nothing replaces a module export.

Mutation-verified: breaking the Referer, leaking the upstream URL into the playlist, and ignoring
the subtitle offset each turn exactly one test red.

**The lesson that produced this suite:** the previous 143 tests passed with ffmpeg, the network
and the TV entirely absent, and one of them asserted a bug was correct behaviour. Validate the
instrument against known-good input before believing any measurement.

## Still to do

- Rewrite `public/index.html` as a keyboard: paste a link, pick subtitles and quality, send.
  No player bar, and no `<select>` elements (Android renders them as bottom sheets, which land in
  the damaged half of the screen).
- The phone WebView wrapper and its signing key were deleted; the phone is a web page now.
