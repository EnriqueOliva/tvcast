# tvcast

Watch anything on the Whale TV, driven from the phone.
Nothing is installed on the TV — no ADB, no root, no sideloading, no developer options.

    phone  ──(share link / tap a title)──>  PC  ──(plain HTTP over LAN)──>  TV
                                            │
                                       B:\Media, Downloads

## Three flows, all tested working

1. **Library** — tap a title on the phone, the TV pulls the file from the PC.
2. **Watch now** — share any video link from the phone; the PC resolves it with
   yt-dlp and re-serves it to the TV. Nothing is stored.
3. **Download** — share a link and pick *Download*; yt-dlp saves it to `B:\Media`,
   the library auto-rescans, it appears on the phone seconds later.

Cineby links are resolved by `lib/cineby.js` instead of yt-dlp, which has no
extractor for them. Both *Watch now* and *Download* accept them.

The PC is the only place files live. The phone is a remote and a share target —
it never stores or serves video.

## Verified on this hardware

TV: `Whale TV(F4F1)` — WhaleOS (Zeasn), Android 13 AOSP, model `SMART4KTVPLUS` by SDMC,
`192.168.1.27`, MAC `A8:2C:3E:E9:F4:F1`. The DLNA renderer is `com.zeasn.tv.cast`
(Changhong Platinum stack) and it **binds a different HTTP port on every boot** —
1788 one day, 1245 the next. Never hardcode it; SSDP discovery carries the real one.
Phone: Samsung A36 (`SM-A366E`, Android 16), `192.168.1.30`
PC: `192.168.1.8`

| Capability | Result |
| --- | --- |
| DLNA MediaRenderer, port 1788 | yes (`DMR-1.50`) |
| AirPlay receiver, ports 7000/7001/7100 | present (`AirTunes/220.68`) |
| Play / pause / stop / seek | works |
| **HTTPS source URLs** | **works** — the TV has TLS |
| Plain HTTP source URLs | works |
| MP4 / MKV / AVI · H.264 / H.265 · AAC / AC3 / MP3 | all play |
| Sidecar `.srt` | advertised 6 ways, **the TV never fetches it** — proven, see below |
| `SetVolume` / `GetVolume` | stub — always 0, use the TV remote |

The renderer advertises a legacy `GetProtocolInfo` list (WMV/ASF/MPEG-PS only).
Ignore it — every format above was tested and plays.

## Checking subtitle sync without looking at the TV

    npm run subsync -- https://www.cineby.at/movie/278

Pulls four-minute audio windows from three points in the film, transcribes them
with faster-whisper (the venv at `C:\workshops\sotvox\.venv`), matches spoken lines
to subtitle cues by token overlap, and reports the median timing delta plus drift.
It prints timings and match rates only, never transcript text.

Trust the **text match** figure, not the correlation line — energy correlation is
near useless on a scored film and has produced a 21-second error on a window the
text matcher aligned at 91%. A window needs 6 matches and a 20% match rate before it
counts toward the verdict; anything less prints INCONCLUSIVE. An early version
weighted a 1-of-44 window equally with two good ones and confidently reported drift
that did not exist.

GPU is used when `cublas64_12.dll` is present, otherwise it falls back to CPU int8
at roughly 90 s per window.

Measured for Shawshank on 2026-07-30: **−0.52 s constant, −0.07 s drift across
94 min, 102/116 lines matched.** The provider's subtitle runs about half a second
early against its own audio, and stays there.

## Tests

    npm test          # or: node --test "test/*.test.js"

No dependencies — `node:test` and `node:assert` only. Everything covered is pure,
so the suite needs no TV, no network and no server.

    test/subtitles.test.js   VTT to SRT conversion and the shift arithmetic
    test/timeline.test.js    segment lookup, trimmed playlists, seek offsets
    test/playlist.test.js    media and master playlist parsing
    test/quality.test.js     rendition heights, trailer rejection, languages
    test/playback.test.js    clock times, DIDL metadata, library search

The one to keep green above all others is *the subtitle shift matches the film time
the trimmed playlist begins at*. Seeking with subtitles on is where this project has
broken twice.

## Setup from a fresh clone

Three things are deliberately not in the repository.

    copy config.example.json config.json     # then set libraryRoots and the TV name

`bin/yt-dlp.exe` is a third-party binary — download a Windows build into `bin/`
and it self-updates with `bin\yt-dlp.exe -U`. `ffmpeg` and `ffprobe` must be on
PATH. `android/tvcast.keystore` is the APK signing key and stays local; without it
`android\build.ps1` cannot sign, and a different key cannot update an already
installed app.

## Run

    C:\workshops\tvcast\start.ps1

Phone: **http://192.168.1.8:8787**, or the **TV Cast** app.

## The Android app

`android/` — 16 KB, two activities, no dependencies. Built with the same
aapt2/d8/apksigner chain as the A04 projects.

- **Launcher** — WebView over the phone UI. Menu → *Server address* if the PC IP changes.
- **Share target** — appears in any app's share sheet as *Send to TV*.
  Asks *Watch now* / *Download*. Also handles `tvcast://<url>` links.

Rebuild and reinstall:

    C:\workshops\tvcast\android\build.ps1
    C:\Users\Enrique\platform-tools\adb.exe install -r android\out\tvcast.apk

Editing `public/index.html` needs no rebuild — the WebView reloads it.

## Layout

    config.json        port, library folders, preferred TV name
    state.json         resume positions
    server.js          file server, proxy, REST API, DLNA control
    lib/ssdp.js        renderer discovery
    lib/dlna.js        AVTransport / RenderingControl SOAP
    lib/library.js     folder scanner
    lib/resolve.js     yt-dlp resolution and downloads
    lib/cineby.js      cineby.at / Videasy resolution
    bin/yt-dlp.exe     dedicated copy, self-contained
    public/index.html  phone UI
    android/           the APK
    tvctl.ps1          CLI + ADB helpers

## How "Watch now" picks quality

`lib/resolve.js` prefers a single progressive stream (seekable, cheap). If a
split video+audio pair is at least 360p better — as on YouTube, where progressive
caps at 360p — it switches to remux mode: ffmpeg muxes both into MPEG-TS on the
fly. That gets 1080p, at the cost of no seeking and no duration readout.

Change `QUALITY_GAIN_THRESHOLD` / `MAXIMUM_REMUX_HEIGHT` to retune.

## Cineby

`https://www.cineby.at/movie/27205` and `https://www.cineby.at/tv/1399/1/4` —
season and episode default to 1 when the path omits them. Any mirror on the same
path shape works (`cineby.app`, `cineby.sc`, …).

The chain: TMDB for title / year / imdb id, a seed from the Videasy API, one
encrypted blob per provider, decrypted by `enc-dec.app`. Providers are tried in
order and the first with a usable stream wins; `tvctl why <cineby url>` prints
the per-provider outcome exactly like it does for yt-dlp sites.

Every source is HLS, so playback goes through the ffmpeg remux route. Unlike the
YouTube remux, **cineby streams can seek**: the playlist is parsed at resolve
time into a segment timeline, and `/hls/<session>/video.m3u8` re-serves it
trimmed to start at the current offset. A jump re-points the TV at `/muxed/` and
ffmpeg opens the trimmed playlist — about 3 seconds, against 22 for `-ss` on the
original playlist. The real duration comes from summing `#EXTINF`, which is what
makes the phone's scrubber and the ±30s buttons work at all; the renderer itself
reports `0` for a piped TS.

Two source packagings show up and both are handled:

- **TS media playlist** (Yoru) — segments muxed together, served disguised as
  `.jpg`, hence `-allowed_extensions ALL`.
- **Master playlist with a separate audio group and fMP4 segments** (Breach) —
  the variant matching `cinebyMaximumHeight` is picked, video and audio are
  trimmed independently and fed to ffmpeg as two inputs. `#EXT-X-MAP` is carried
  into the trimmed playlist or the fragments are undecodable. Measured A/V start
  skew after a jump: 21 ms.

Quality is chosen across *all* providers at once rather than first-provider-wins,
then each candidate is fetched and checked: a rendition whose runtime disagrees
with TMDB by more than a third is dropped, as is one that redirects away from a
playlist. Both happen in practice — Breach has served a YouTube trailer labelled
`4K`. Only surviving renditions reach the picker in the phone UI, and the label
shows the variant's true height, not the provider's claim.

At equal height the seekable TS packaging wins, since paired fMP4 costs an extra
playlist fetch per switch.

`config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `cinebyMaximumHeight` | `1080` | Quality ceiling for the automatic pick. The picker still lists everything above it, so 4K is always one tap away. |
| `cinebyDirectHls` | `false` | Hand the `.m3u8` to the TV instead of remuxing. Leave it off: tried, the renderer reports `PLAYING` and never advances a frame. |
| `tmdbApiKey` | `""` | Falls back to a shared public key. |

Two of the four providers were failing server-side at the time of writing, which
is normal and why the fallback list exists. A rendition above the ceiling is used
when nothing below it survives validation, on the grounds that playing is better
than not playing.

New titles are the real limit, not the code. A 2026 release may only exist as a
854x376 rip; no setting invents a better master. The picker is what tells you
which it is.

## Subtitles: the renderer cannot do them

Tested 2026-07-30 over ADB, with a generated 90 s clip plus a matching SRT.

- **Sidecar is dead.** `lib/dlna.js` advertises the subtitle URL six ways — a
  `text/srt` `<res>`, `sec:CaptionInfoEx`, `sec:CaptionInfo`, `pv:subtitleFileUri`,
  `pv:subtitleFileType`, and a `CaptionInfo.sec` HTTP header. The TV played the
  file and **never issued a single request** for the subtitle URL. Not a rendering
  question — it never asked. (The `sec:` extensions are Samsung's, `pv:` is
  PacketVideo; this renderer is neither.)
- **Embedded soft subs look dead too.** An MKV with a `subrip` track flagged
  `default+forced` produced only `Creating an asynchronous MediaCodec adapter for
  track type video` and `... audio` — no text renderer, no subtitle mention anywhere
  in logcat.
- **The player has no UI.** `uiautomator dump` during DLNA playback returns empty
  `FrameLayout`/`LinearLayout` from `com.zeasn.tv.cast` — no controls, and
  `KEYCODE_CAPTIONS` surfaces nothing. There is no way to pick a track even if one
  existed.

So burning into the picture is the only path that works here, and that is what
tvcast now does for cineby streams.

## Subtitles: how the burn works

Pick a language on the phone and ffmpeg draws it into the frames: `-c:v copy`
becomes `h264_nvenc` plus a `subtitles` filter. Measured **11x realtime at 1080p**
on the 4070, so it costs a few seconds of startup and nothing else. Turning
subtitles on, off, or changing language restarts the stream at the current
position, exactly like the quality switcher.

Tracks are gathered from **all four providers**, not only the one supplying the
picture, then deduplicated by language — otherwise availability swings wildly with
whichever rendition happened to win. Labels are normalised, so `eng` and `english`
both become English.

Four things that are easy to get wrong, all settled:

- Cineby subtitle URLs **403 without the Referer / Origin / User-Agent headers**,
  so the PC fetches them and the TV never sees the original URL.
- The VTT files use `MM:SS.mmm`, not `HH:MM:SS.mmm`, and carry no cue numbers.
  A naive converter emits something no player will parse.
- The stream is trimmed to a segment boundary, so subtitles are shifted by
  `seekOffsetSeconds` — regenerated on **every seek**, not only when chosen.
- HLS segments carry their own PTS base (~1.4 s), so the burn runs behind
  `setpts=PTS-STARTPTS` / `asetpts=PTS-STARTPTS`. Without it the text sits about a
  second off.

Because burned text cannot be nudged from the TV, the settings panel carries a
**subtitle delay** control in half-second steps.

**The cast URL must change on every restart.** `buildProxyUrl` carries a
`?g=<generation>` counter bumped by `restartCastAtOffset`. Without it, turning
subtitles on without having seeked produced a URL identical to the one already
playing, the TV never reconnected, and the burn silently never took effect — while
the server happily reported success. The `[mux] session <id> burn=<bool>` log line
exists to catch exactly that: if it does not appear after a change, the TV did not
come back for a new stream.

**Never trust the renderer's `state` after a restart.** It reports `PLAYING` while
sitting at 0 and going nowhere. `restartCastAtOffset` polls `GetPositionInfo` until
the position actually *advances* — 14 s of patience for a plain stream, 35 s when
burning, since NVENC plus a cold CDN fetch is slow to produce first frames. The old
code checked the state flag once and believed it, which is why seeks appeared to do
nothing while reporting success.

Do not retry by resetting the renderer. `startAndVerify` tears the stream down
between attempts, which throws away a burned stream that was seconds from starting
and guarantees the next attempt is just as slow. It is now only the last resort
after patient polling gives up.

Verifying a burn by pulling `/muxed/` yourself proves nothing about what the TV
sees — a fresh HTTP request always gets a fresh ffmpeg with the current settings,
which is precisely the path the TV was not taking.

`screencap` over ADB is useless for verifying any of this — video sits on a hardware
overlay plane and the grab comes back blank. Verify by pulling `/muxed/<session>`
and extracting a frame, and **put `-ss` after `-i`**: input seeking on MPEG-TS snaps
to the nearest keyframe and shows you frames seconds away from the cue you meant.

## Known limits

- The PC must be awake and on the same Wi-Fi.
- Volume: TV remote only.
- Remux mode (`mode=remux`) can't seek — TS has no index.
- DRM services (Netflix, Disney+, Prime) will never work through this. Use the
  TV's own apps; it is Widevine L1 certified.
- Cineby depends on three third-party services staying up and on `enc-dec.app`
  keeping the decrypt endpoint. When it breaks, `tvctl why` names the layer that
  died. If the API host itself goes, `VIDEASY_API_BASE` in `lib/cineby.js` is the
  one line to change — `api.videasy.net` is the usual alternate.
- Cineby subtitles are resolved (50+ languages per title) and parked on the cast
  session as `subtitleTracks`, but are not handed to the TV yet.
- Some hosts break on their own: `archive.org` returns HTTP 500 for the
  BigBuckBunny_124 derivative, from any client. The proxy reports upstream
  failures in the console rather than leaving the TV stalled.
- The PC IP is assumed to be `192.168.1.8`. Set a DHCP reservation on the router,
  or update it in the app menu and `ServerConfig.DEFAULT_BASE_URL`.

## yt-dlp

`bin/yt-dlp.exe` is a dedicated standalone copy (2026.07.04), deliberately not
shared with the venvs in `FreeBestYTDownloader` / `video-downloader` / `unvimeo`.
Update it with:

    C:\workshops\tvcast\bin\yt-dlp.exe -U
