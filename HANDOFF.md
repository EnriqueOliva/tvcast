# tvcast — context handoff

Written 2026-07-31 before a context compaction. Everything here was proven by running it,
not assumed. Read this before touching anything.

**Next task: build the Android TV app** (see the last section).

---

## 1. Environment

| Thing | Value |
| --- | --- |
| Project | `C:\workshops\tvcast` |
| Git remote | `git@github.com:EnriqueOliva/tvcast.git` (SSH works, user EnriqueOliva) |
| Branches | `main` (623fd52 "Initial commit"), `poc/external-player` (56c4628) |
| Server | `node server.js`, port **8787**, autostarted by logon Scheduled Task **`TvCastServer`** running `start.ps1` |
| Logs | `server.log` / `server.err` (start.ps1 redirects; both gitignored) |
| PC LAN address | **192.168.1.8** |
| TV | **192.168.1.27**, `Whale TV(F4F1)`, WhaleOS/Zeasn, Android 13 (SDK 33), model `SMART4KTVPLUS` by SDMC |
| ADB | `C:\Users\Enrique\platform-tools\adb.exe`, TV at `192.168.1.27:5555`, authorised |
| Phone | `SM_A366E` (`RFGYC22020B`) over USB. The user plugs/unplugs it — non-responsive means unplugged, not broken |
| Node | v24.13.0 |
| ffmpeg | 8.0.1 on PATH, plus ffprobe |
| GPU | RTX 4070 + i5-13600K. `h264_nvenc` works: **11x realtime at 1080p** |

**Android build toolchain** (no Gradle): `C:\workshops\rooting\A04\flagsecure\tools\` holds
`aapt2.exe`, `android.jar`, `zipalign.exe`, `d8.jar`, `apksigner.jar`. Driver is
`android\build.ps1`. Signing key `android/tvcast.keystore` is **gitignored** — without it
you cannot sign, and a different key cannot update an already-installed app.

**faster-whisper on GPU only works from `C:\workshops\live-transcript\.venv`** — it ships
`nvidia/cublas/bin/cublas64_12.dll` and `ctranslate2/cudnn64_9.dll`. The sotvox venv lacks
them and silently falls back to CPU. The system CUDA toolkit is **v13**, but CTranslate2
4.7.1 needs cuBLAS **12**, so the toolkit does not help.

---

## 2. The TV — everything established

### The central discovery

DLNA separates roles. tvcast has always been a **control point pushing to a Media Renderer**.
This TV's renderer is a bare video surface: no UI, and it **ignores every remote key**
(tested MEDIA_PLAY_PAUSE, MEDIA_PAUSE, MEDIA_FAST_FORWARD, DPAD_RIGHT, MEDIA_PLAY — position
just kept climbing). `uiautomator dump` during playback returns empty layouts with zero
controls. It cannot be fixed: `ro.build.type=user`, `ro.debuggable=0`, no `su`, and it is a
system app.

**But the TV also has a Digital Media Player.** `com.droidlogic.mediacenter`, labelled
**"Media Center"** in the app list (`/product/app/DLNA/DLNA.apk`), offers `DLNA_DMP`,
`DLNA_DMR` and Settings. The DMP browses UPnP MediaServers and plays through
`com.droidlogic.mediacenter/.dlna.VideoPlayer`, driven by the TV's own remote.

**Proven end to end**: `tools/poc-dms.cjs` advertises a MediaServer, the TV's DMP discovers
it, browses it, lists all 5 library files, and plays one (server saw
`GET /media/<id>.mp4 from 192.168.1.27`, position advancing).

### Packages that matter

| Package / component | What it is |
| --- | --- |
| `com.zeasn.tv.cast` | The DLNA renderer. No UI, ignores remote. **Never `force-stop` it** — it does not rebind its HTTP port and only a TV reboot restores it |
| `com.droidlogic.mediacenter` | "Media Center" — has the DMP. `.dlna.VideoPlayer` is its player |
| `com.droidlogic.exoplayer2.demo` | Contains `com.droidlogic.videoplayer.MoviePlayer` (**responds to remote: pause/play/forward all proven**). Note the class lives in *this* package, not `com.droidlogic.videoplayer` — naming the obvious package gives "Activity class does not exist" |
| `com.android.gallery3d/.app.MovieActivity` | Resolves and launches, but its legacy MediaPlayer rejects our streams (`error (1,-2147483648)`) |
| `com.droidlogic.appinstall` | Built-in APK installer — sideloading is possible **without** ADB, via USB stick |

### Traps

- **The renderer's HTTP port randomises on every boot** (seen 1788, then 1245). Never
  hardcode it; SSDP discovery carries the real one.
- **`screencap` returns a blank frame during video** (hardware overlay plane) but works fine
  for UI screens. Use logcat for playback state, screencap for menus.
- Position is readable from logcat: `NU-AmNuPlayerDriver ... [getCurrentPosition] position : N msec`.
- `dumpsys media_session` lists only Bluetooth and Netflix — these players register none.
- ADB and OEM unlocking are currently **on**. The user wants them off when we are done.

### Multicast gotcha (cost an hour)

This PC has five interfaces (Wi-Fi, AWS VPN, WSL, Hyper-V, VirtualBox). Node joins the
multicast group on whichever Windows picks, which is not the LAN one. SSDP silently never
reaches the TV. Required:

    socket.addMembership('239.255.255.250', '192.168.1.8');
    socket.setMulticastInterface('192.168.1.8');

---

## 3. The cineby pipeline (`lib/cineby.js`)

Providers via `api.speedracelight.com`: `cdn`=Yoru, `m4uhd`=Breach, `vsrc`=Neon, `hdmovie`=Vyse.

1. `GET /seed?mediaId=<tmdbId>` — **`ttlMs` is 30000**, so fetch a fresh seed per provider
2. `GET /<provider>/sources-with-title?title=<DOUBLE-url-encoded>&mediaType&year&tmdbId&imdbId&seasonId&episodeId&enc=2&seed`
3. `POST https://enc-dec.app/api/dec-videasy` with `{text, id, seed}` to decrypt
4. TMDB fallback key `269890f657dddf4635473cf4cf456576`; `config.tmdbApiKey` overrides

### Hard-won details

- **Subtitle and segment URLs 403 without Referer / Origin / User-Agent.** The PC must proxy;
  the TV can never be handed the original URL.
- **VTT files use `MM:SS.mmm`**, not `HH:MM:SS.mmm`, and carry no cue numbers.
- **Segments are disguised as `.jpg`** → ffmpeg needs `-allowed_extensions ALL -extension_picky 0`.
- **Two packagings.** TS media playlist (segments mode), and master playlist with a *separate
  audio group* plus fMP4 (paired mode). Paired needs `#EXT-X-MAP` carried into the trimmed
  playlist or the fragments are undecodable. Measured A/V skew after a jump: 21 ms.
- **HLS carries a PTS base of ~1.4 s**, so burning runs behind `setpts=PTS-STARTPTS` and
  `asetpts=PTS-STARTPTS`.
- **Seeking** = re-serve the playlist trimmed to the target segment at
  `/hls/<session>/<track>.m3u8`. About **0.6 s** versus 22 s for `-ss` on the original.
- **`seekOffsetSeconds` must never be floored.** Flooring made the playlist reopen the
  *previous* segment while subtitles were shifted for the correct one — that was the
  long-hunted desync. `cineby.resolveSeekTarget` returns the exact fractional start.
- **The cast URL must change on every restart** (`?g=<generation>&offset=<n>`) or the TV
  reuses its stream and the change silently never applies.
- **Never trust the renderer's `state`** after a restart — it reports `PLAYING` while frozen
  at 0. Poll `GetPositionInfo` until the position actually advances. 14 s patience normally,
  **35 s when burning**. Do not retry by resetting the renderer; that throws away a stream
  that was about to start.
- Renditions are gathered from **all** providers and validated against the TMDB runtime.
  Breach once served a **YouTube trailer** labelled `4K`.

### Subtitle sync — measured, settled

`npm run subsync -- <url>` (`tools/subsync.cjs` + `tools/transcribe.py`). Pulls audio windows,
transcribes with faster-whisper, matches spoken lines to cues by token overlap.

Shawshank, 5 windows, `small.en` on GPU: **overall −0.10 s, drift −0.00 s across 114 min,
167/171 lines matched.** Verdict IN SYNC. The subtitles are fine.

**Trust the text-match number, not the correlation line** — energy correlation reported
−6.72 s on a window the text matcher aligned at 27/27. A window needs ≥6 matches and ≥20%
match rate or it prints INCONCLUSIVE.

---

## 4. Tests — 119 passing

    npm test        # node --test "test/*.test.js"

`node:test` + `node:assert` only, no dependencies. `server.js` is importable (guarded by
`require.main === module`) and exports `runtime`, `timing`, and the handlers so tests can
stub the DLNA device and intercept `spawn`. Set `server.timing.*` small in tests.

| File | Covers |
| --- | --- |
| `subtitles.test.js` | VTT→SRT conversion, shift arithmetic, link parsing |
| `timeline.test.js` | Segment lookup, trimmed playlists, seek offsets |
| `playlist.test.js` | Media/master parsing, audio groups, fMP4 |
| `quality.test.js` | Heights, trailer rejection, language names |
| `playback.test.js` | Clock times, DIDL metadata, XML escaping, library search |
| `session.test.js` | Cast URL regeneration, ffmpeg argv, playlist alignment |
| `transport.test.js` | Position clamping, pause/resume/eject, subtitle failures |
| `subtitle-flows.test.js` | Subtitle × seek × quality × delay combinations |
| `adbplayer.test.js` | Launch args, key mapping, log parsing |

**The load-bearing test**: *"the subtitle shift matches the film time the trimmed playlist
begins at"*. Fixtures use fractional segment durations on purpose — whole numbers hide the
flooring bug class entirely.

Bugs these tests caught (all real, all fixed): position exceeding duration, a subtitle fetch
failure killing all seeking, a stale burn flag, an unknown subtitle id silently accepted, and
a seek while paused resuming playback.

---

## 5. Current state of the POC branch

`poc/external-player` holds:

- `lib/adbplayer.js` + `tools/poc-external-player.cjs` — `npm run poc:player`, **6/6** against
  the real TV. Proves `com.droidlogic.videoplayer.MoviePlayer` obeys the remote.
- `tools/poc-dms.cjs` — DLNA MediaServer on **port 8790**. Proven: the TV's DMP discovers it,
  browses it, and plays from it. Currently shares only `B:\Media`, started by hand, does not
  survive a reboot. **Not committed yet as of writing** — check `git status`.
- `POC-EXTERNAL-PLAYER.md` — the ADB findings.

---

## 6. What the user decided, and why

The user **rejected** the ADB-launch approach: needing ADB connected for every cast is
unacceptable. They want to **control playback with the TV remote, without the phone**.

Their own proposal: phone enters a link → it opens on the TV → remote takes over. That is
impossible with the TV's built-in apps, because DLNA has no way for a server to tell a DMP to
play something — the DMP is driven only by its own UI. The only push is to the renderer, which
has no UI. But it becomes possible **if the app on the TV is ours**.

### The task: an Android TV app

- **Phone keeps the job it is good at: typing.** Paste/search links there.
- **PC** resolves as it already does and marks something as "now playing".
- **TV app** polls the PC, opens its player full screen, and the **remote drives it**.
- Installed once (ADB or USB via `com.droidlogic.appinstall`), then **no ADB ever again**.

Why it is worth it: a framework player (`VideoView` + `MediaController`) gives a standard
D-pad-driven transport bar, **native subtitle rendering**, and **real HLS seeking**. That would
let us delete burning, the NVENC pass, the trimmed-playlist seeking, and the shift arithmetic
— the entire class of bugs from this week.

Existing `android/` is a WebView wrapper plus a `ShareActivity` share target, built by
`build.ps1`. The TV app extends this codebase; it needs `LEANBACK_LAUNCHER` and something that
keeps it able to receive commands.

**Unproven and worth testing early**: whether the TV's players accept an HLS `m3u8` at all,
and whether sidecar subtitles survive the DIDL-Lite path. Everything demonstrated so far used
plain local MP4s.

---

## 7. Working preferences

- **No comments in code.** Express intent through naming. Preserve existing TODO/FIXME.
- No abbreviated names (`destinationReceipt`, not `destReceipt`). Named constants over literals.
- Prefer `if / else if / else` chains over sequential early returns.
- **Never commit or push unless told.** **Never** add AI attribution or `Co-Authored-By`.
- Only change what was asked; no drive-by refactors.
- Replies: simple, short, plain English.
- The user tests on the real TV and will say when something is wrong. Believe them —
  three separate times the tests were green while the TV was broken, because the tests
  exercised paths the TV never takes.
