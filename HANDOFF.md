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
| `public/index.html` | The phone. One file, no build step, no framework |

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

## The phone

`public/index.html`, one file, no build step, no framework. It is a keyboard: paste a link, one
tap, it plays. The Fire TV remote owns playback, so there is **no player bar and no position
polling**, which is what used to make the phone claim "Nothing playing" over a running film.

Two rules it is built around, both from the physical phone:

- **No `<select>` anywhere.** Android renders them as bottom sheets, which land in the damaged
  bottom half of the screen. Subtitle and quality are inline chip rows instead.
- **Everything actionable stays in the top portion.** The compose screen ends around 470px of a
  915px viewport. The lists are a separate top-anchored view, so any row can be scrolled up into
  the reachable half rather than sitting under the fold.

Sending is one tap: it resolves, auto-picks the first subtitle track (cineby already sorts
English first), sends, and *then* shows the chips. Tapping a chip re-sends in place, which is
free because ids are content addressed, so it replaces the row instead of duplicating it.

Nothing reaches `innerHTML`. Every row is built with `createElement` and `textContent`, so a
title containing `&` or `<script>` cannot break the page. There is one in-flight lock: the send
button reads `working`, everything but `back` disables, and every request carries a timeout.

## Foreign language shows: translate the audio, do not hunt for subtitles

For a show whose audio you do not speak and which has no subtitles anywhere (the case that
started this: a Turkish series on its official YouTube channel, no captions at all, not even
auto-generated), the answer is to make the subtitles rather than find them.

`tools/pregenerate-subtitles.cjs <playlist-url> <source-language>` walks a playlist, pulls the
audio, and runs Whisper's **translate** task, which goes straight from foreign speech to timed
English. Output is one `.srt` per video id in `cache/subtitles/`, and `lib/tvapi.js` offers it
automatically as an `English (auto)` track whenever a YouTube link with a matching id is sent.

Measured on the real thing: `large-v3` translates at **14x realtime** on the 4070, so a 2h24m
episode costs about ten minutes, once. The queue skips anything already done, so it is safe to
re-run and safe to kill.

**Sync is exact by construction here**, and this is the point. The cues are derived from the very
audio being played, so there is no offset to measure and no drift to correct. `verifySubtitleSync`
is deliberately skipped for non-cineby publications.

Beware the model choice: `large-v3-turbo` is much faster but was distilled for transcription, and
its translate quality is markedly worse. Use `large-v3` for translation.

## Anything that is not cineby

`lib/resolve.js` returns a **direct stream** for everything else: `streamKind` is `hls`, `file`,
or `split`, and the TV fetches it itself. Nothing is proxied through the PC, because the proxy
only exists for cineby's Referer-checking CDN.

`split` is how 1080p YouTube works: video and audio arrive as separate URLs and `PlayerActivity`
combines them with `MergingMediaSource`. Without it yt-dlp's only combined format is 360p.
`httpHeaders` from the resolver are applied to the player's `DefaultHttpDataSource`, so a stream
that needs a User-Agent still plays without us relaying the bytes.

Direct publications are **deliberately not persisted with their stream URL**. Signed CDN links
expire, so after a restart the publication rehydrates by resolving again, which is what makes a
day-old row still playable.

## Tests

    npm test     # 54 tests, node:test only

`test/tvapi.test.js` drives a **real HTTP server on an ephemeral port against a fake CDN**, so it
covers routing, playlist rewriting, the proxy headers, failure paths and concurrency. Nothing
stubs `child_process.spawn` and nothing replaces a module export. The Fire TV push is tested
against a real socket on port 8788 that records what it was sent.

Mutation-verified: breaking the Referer, leaking the upstream URL into the playlist, ignoring the
subtitle offset, dropping the library push, skipping the replay push, making a delete always
claim success, and hiding the selected rendition each turn exactly one test red.

**The lesson that produced this suite:** the previous 143 tests passed with ffmpeg, the network
and the TV entirely absent, and one of them asserted a bug was correct behaviour. Validate the
instrument against known-good input before believing any measurement.

## Still to do

- The quality label reads `unknown` for some providers, because cineby's rendition has no height
  in its label. Cosmetic, and it is the label rather than the pick that is wrong.
- Publications written before 2026-07-31 have an empty `sourceUrl` and cannot be rehydrated after
  a restart. Current code stores it correctly; delete any such row from the phone if one appears.
