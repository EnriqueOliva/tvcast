const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ssdp = require('./lib/ssdp');
const dlna = require('./lib/dlna');
const library = require('./lib/library');
const resolve = require('./lib/resolve');
const cineby = require('./lib/cineby');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const PUBLIC_DIRECTORY = path.join(__dirname, 'public');
const DEFAULT_PORT = 8787;
const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const RESUME_THRESHOLD_SECONDS = 60;
const NEAR_END_SECONDS = 90;
const CAST_SESSION_LIMIT = 20;
const DOWNLOAD_JOB_LIMIT = 20;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function loadJsonFile(filePath, fallbackValue) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        void error;
        return fallbackValue;
    }
}

function saveJsonFile(filePath, value) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    } catch (error) {
        void error;
    }
}

const configuration = loadJsonFile(CONFIG_PATH, { port: DEFAULT_PORT, libraryRoots: [], preferredDeviceName: '' });
const persistedState = loadJsonFile(STATE_PATH, { resumePositions: {}, lastDeviceId: '' });

const runtime = {
    devices: [],
    selectedDeviceId: persistedState.lastDeviceId || '',
    libraryItems: [],
    currentItemId: '',
    currentCastSessionId: '',
    serverAddress: '127.0.0.1',
    lastError: '',
    castSessions: new Map(),
    downloadJobs: new Map(),
    nextSequence: 1
};

function getAllLibraryItems() {
    return runtime.libraryItems;
}

function nextIdentifier(prefix) {
    runtime.nextSequence += 1;
    return `${prefix}${runtime.nextSequence.toString(36)}`;
}

function trimMap(targetMap, limit) {
    while (targetMap.size > limit) {
        const oldestKey = targetMap.keys().next().value;
        targetMap.delete(oldestKey);
    }
}

function getSelectedDevice() {
    return runtime.devices.find((device) => device.id === runtime.selectedDeviceId) || null;
}

function getLibraryItem(itemIdentifier) {
    return getAllLibraryItems().find((item) => item.id === itemIdentifier) || null;
}

async function refreshDevices() {
    const responses = await ssdp.discoverRenderers({});
    const profiles = [];
    for (const response of responses) {
        try {
            const profile = await dlna.fetchDeviceProfile(response.location);
            if (profile.avTransportUrl !== '' && profiles.some((existing) => existing.id === profile.id) === false) {
                profiles.push(profile);
            }
        } catch (error) {
            void error;
        }
    }
    runtime.devices = profiles;
    if (getSelectedDevice() === null && profiles.length > 0) {
        const preferred = profiles.find((profile) => configuration.preferredDeviceName
            && profile.friendlyName.toLowerCase().includes(configuration.preferredDeviceName.toLowerCase()));
        runtime.selectedDeviceId = (preferred || profiles[0]).id;
    }
    if (profiles.length > 0) {
        runtime.serverAddress = ssdp.resolveLocalAddressForPeer(profiles[0].address);
    }
    return profiles;
}

function rescanLibrary() {
    runtime.libraryItems = library.scanLibrary(configuration.libraryRoots || []);
    return runtime.libraryItems.length;
}

function probeDurationSeconds(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
        let output = '';
        probe.stdout.on('data', (chunk) => { output += chunk.toString(); });
        probe.on('error', () => resolve(0));
        probe.on('close', () => resolve(Math.floor(Number(output.trim()) || 0)));
    });
}

function buildMediaUrl(item) {
    return `http://${runtime.serverAddress}:${configuration.port || DEFAULT_PORT}/media/${item.id}${item.extension}`;
}

function buildSubtitleUrl(item) {
    if (item.subtitlePath === '') {
        return '';
    }
    return `http://${runtime.serverAddress}:${configuration.port || DEFAULT_PORT}/subtitle/${item.id}.srt`;
}

async function startPlayback(itemIdentifier, startSeconds) {
    const device = getSelectedDevice();
    const item = getLibraryItem(itemIdentifier);
    if (device === null) {
        throw new Error('No TV selected. Run discovery first.');
    }
    if (item === null) {
        throw new Error('Unknown library item.');
    }
    const durationSeconds = await probeDurationSeconds(item.filePath);
    const outcome = await startAndVerify(device, {
        mediaUrl: buildMediaUrl(item),
        subtitleUrl: buildSubtitleUrl(item),
        title: item.title,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        duration: durationSeconds > 0 ? dlna.formatClockTime(durationSeconds) : ''
    });
    if (outcome.started === false) {
        throw new Error(`TV accepted the request but never started (state ${outcome.state}). Try again, or power-cycle the TV.`);
    }
    runtime.currentItemId = item.id;
    runtime.currentCastSessionId = '';
    if (startSeconds > 0) {
        setTimeout(() => {
            dlna.seekToSeconds(device, startSeconds).catch(() => undefined);
        }, 2500);
    }
    return { title: item.title, durationSeconds };
}

function rememberPosition(itemIdentifier, positionSeconds, durationSeconds) {
    if (itemIdentifier === '') {
        return;
    }
    if (positionSeconds > RESUME_THRESHOLD_SECONDS && (durationSeconds === 0 || positionSeconds < durationSeconds - NEAR_END_SECONDS)) {
        persistedState.resumePositions[itemIdentifier] = Math.floor(positionSeconds);
    } else {
        delete persistedState.resumePositions[itemIdentifier];
    }
    persistedState.lastDeviceId = runtime.selectedDeviceId;
    saveJsonFile(STATE_PATH, persistedState);
}

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    response.end(body);
}

function readRequestBody(request) {
    return new Promise((resolve) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(raw === '' ? {} : JSON.parse(raw));
            } catch (error) {
                void error;
                resolve({});
            }
        });
    });
}

function serveStaticFile(response, filePath, contentType) {
    fs.readFile(filePath, (error, data) => {
        if (error) {
            response.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/plain' });
            response.end('Not found');
        } else {
            response.writeHead(HTTP_OK, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
            response.end(data);
        }
    });
}

function serveMediaFile(request, response, item) {
    let stats = null;
    try {
        stats = fs.statSync(item.filePath);
    } catch (error) {
        void error;
        response.writeHead(HTTP_NOT_FOUND).end('Missing file');
        return;
    }

    const totalSize = stats.size;
    const rangeHeader = request.headers.range;
    const commonHeaders = {
        'Content-Type': item.mimeType,
        'Accept-Ranges': 'bytes',
        'transferMode.dlna.org': 'Streaming',
        'contentFeatures.dlna.org': dlna.DLNA_STREAMING_FLAGS,
        'Connection': 'close'
    };
    if (item.subtitlePath !== '') {
        commonHeaders['CaptionInfo.sec'] = buildSubtitleUrl(item);
    }

    if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        const startByte = match && match[1] !== '' ? Number(match[1]) : 0;
        const endByte = match && match[2] !== '' ? Number(match[2]) : totalSize - 1;
        const safeEnd = Math.min(endByte, totalSize - 1);
        if (startByte > safeEnd) {
            response.writeHead(416, { 'Content-Range': `bytes */${totalSize}` }).end();
        } else {
            response.writeHead(HTTP_PARTIAL_CONTENT, Object.assign({}, commonHeaders, {
                'Content-Range': `bytes ${startByte}-${safeEnd}/${totalSize}`,
                'Content-Length': safeEnd - startByte + 1
            }));
            if (request.method === 'HEAD') {
                response.end();
            } else {
                fs.createReadStream(item.filePath, { start: startByte, end: safeEnd }).pipe(response);
            }
        }
    } else {
        response.writeHead(HTTP_OK, Object.assign({}, commonHeaders, { 'Content-Length': totalSize }));
        if (request.method === 'HEAD') {
            response.end();
        } else {
            fs.createReadStream(item.filePath).pipe(response);
        }
    }
}

const RENDERER_RESET_DELAY_MILLISECONDS = 900;

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const STOPPED_POLL_ATTEMPTS = 8;
const STOPPED_POLL_DELAY_MILLISECONDS = 500;
const PLAYBACK_VERIFY_FIRST_DELAY = 6000;
const PLAYBACK_VERIFY_SECOND_DELAY = 5000;
const PLAYBACK_START_ATTEMPTS = 2;

async function resetRenderer(device) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await dlna.stop(device);
        } catch (error) {
            void error;
        }
        await delay(RENDERER_RESET_DELAY_MILLISECONDS);
    }
    for (let poll = 0; poll < STOPPED_POLL_ATTEMPTS; poll += 1) {
        try {
            const info = await dlna.getTransportInfo(device);
            if (info.state === 'STOPPED' || info.state === 'NO_MEDIA_PRESENT') {
                return true;
            }
        } catch (error) {
            void error;
        }
        await delay(STOPPED_POLL_DELAY_MILLISECONDS);
    }
    return false;
}

async function startAndVerify(device, transportPayload) {
    let lastState = 'UNKNOWN';
    for (let attempt = 1; attempt <= PLAYBACK_START_ATTEMPTS; attempt += 1) {
        await resetRenderer(device);
        await dlna.setTransportUri(device, transportPayload);
        await dlna.play(device);

        await delay(PLAYBACK_VERIFY_FIRST_DELAY);
        let first = { positionSeconds: 0 };
        let second = { positionSeconds: 0 };
        try {
            first = await dlna.getPositionInfo(device);
            await delay(PLAYBACK_VERIFY_SECOND_DELAY);
            second = await dlna.getPositionInfo(device);
            lastState = (await dlna.getTransportInfo(device)).state;
        } catch (error) {
            lastState = 'UNREACHABLE';
        }

        if (lastState === 'PLAYING' && second.positionSeconds > first.positionSeconds) {
            return { started: true, attempts: attempt };
        }
        process.stdout.write(`[play] attempt ${attempt} did not advance (state=${lastState}, ${first.positionSeconds}s -> ${second.positionSeconds}s)\n`);
    }
    return { started: false, attempts: PLAYBACK_START_ATTEMPTS, state: lastState };
}

function buildProxyUrl(sessionId, session) {
    const routeName = session.progressiveUrl === '' ? 'muxed' : 'proxy';
    const generation = session.streamGeneration || 0;
    const offsetSeconds = session.seekOffsetSeconds || 0;
    return `http://${runtime.serverAddress}:${configuration.port || DEFAULT_PORT}/${routeName}/${sessionId}?g=${generation}&offset=${offsetSeconds}`;
}

const SUBTITLE_CACHE_FOLDER = 'cache';
const SUBTITLE_CACHE_DIRECTORY = path.join(__dirname, SUBTITLE_CACHE_FOLDER);
const SUBTITLE_STYLE = 'FontSize=26,Outline=2,Shadow=0,MarginV=40';
const SUBTITLE_OFF = '';

function buildSubtitleFilePath(sessionId) {
    return path.join(SUBTITLE_CACHE_DIRECTORY, `${sessionId}.srt`);
}

function clearSubtitleFile(session) {
    try {
        fs.unlinkSync(buildSubtitleFilePath(session.id));
    } catch (error) {
        void error;
    }
    session.subtitleFileReady = false;
}

async function prepareSubtitleFile(session) {
    const tracks = session.subtitleTracks || [];
    const selected = tracks.find((track) => track.identifier === session.selectedSubtitleId);
    if (session.selectedSubtitleId === SUBTITLE_OFF || selected === undefined) {
        clearSubtitleFile(session);
        return;
    }
    const shiftSeconds = (session.subtitleOffsetSeconds || 0) - (session.seekOffsetSeconds || 0);
    const srtText = await cineby.fetchSubtitleAsSrt(selected.url, shiftSeconds);
    fs.mkdirSync(SUBTITLE_CACHE_DIRECTORY, { recursive: true });
    fs.writeFileSync(buildSubtitleFilePath(session.id), srtText, 'utf8');
    session.subtitleFileReady = true;
    process.stdout.write(`[subtitle] burning ${selected.language} shifted ${shiftSeconds.toFixed(1)}s for ${session.id}\n`);
}

function buildLocalPlaylistUrl(sessionId, trackName) {
    return `http://127.0.0.1:${configuration.port || DEFAULT_PORT}/hls/${sessionId}/${trackName}.m3u8`;
}

function hasSegmentTimeline(session) {
    return session.videoTrack !== undefined && session.videoTrack !== null
        && Array.isArray(session.videoTrack.segments) && session.videoTrack.segments.length > 0;
}

function getSessionTrack(session, trackName) {
    if (trackName === 'audio') {
        return session.audioTrack || null;
    }
    return session.videoTrack || null;
}

function serveSessionPlaylist(response, session, trackName) {
    const track = getSessionTrack(session, trackName);
    if (track === null) {
        response.writeHead(HTTP_NOT_FOUND).end('No such track');
        return;
    }
    const startIndex = cineby.findSegmentIndex(track.segments, session.seekOffsetSeconds);
    const playlistText = cineby.buildTrimmedPlaylist(track, startIndex);
    response.writeHead(HTTP_OK, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Connection': 'close'
    });
    response.end(playlistText);
}

function getCurrentCastSession() {
    if (runtime.currentCastSessionId === '') {
        return null;
    }
    return runtime.castSessions.get(runtime.currentCastSessionId) || null;
}

const timing = {
    seekResetDelayMilliseconds: 500,
    plainStartTimeoutMilliseconds: 14000,
    burnStartTimeoutMilliseconds: 35000,
    positionPollIntervalMilliseconds: 900
};

async function waitForPlaybackToAdvance(device, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    let previousPosition = -1;
    while (Date.now() < deadline) {
        await delay(timing.positionPollIntervalMilliseconds);
        try {
            const positionInfo = await dlna.getPositionInfo(device);
            if (previousPosition >= 0 && positionInfo.positionSeconds > previousPosition) {
                return true;
            }
            previousPosition = positionInfo.positionSeconds;
        } catch (error) {
            void error;
        }
    }
    return false;
}

async function restartCastAtOffset(device, session, targetSeconds) {
    const requestedSeconds = Math.max(0, Math.min(targetSeconds, session.totalDurationSeconds));
    const seekTarget = cineby.resolveSeekTarget(session.videoTrack, requestedSeconds);
    session.seekOffsetSeconds = seekTarget.startSeconds;
    session.streamGeneration = (session.streamGeneration || 0) + 1;
    try {
        await prepareSubtitleFile(session);
    } catch (error) {
        runtime.lastError = `subtitle refresh failed: ${error.message}`;
        process.stdout.write(`[subtitle] refresh failed, continuing without burn: ${error.message}\n`);
        clearSubtitleFile(session);
    }

    let wasPaused = false;
    try {
        wasPaused = (await dlna.getTransportInfo(device)).state === 'PAUSED_PLAYBACK';
    } catch (error) {
        void error;
    }
    const remainingSeconds = Math.max(0, session.totalDurationSeconds - session.seekOffsetSeconds);
    const transportPayload = {
        mediaUrl: buildProxyUrl(session.id, session),
        subtitleUrl: '',
        title: session.title,
        mimeType: session.mimeType,
        sizeBytes: 0,
        duration: remainingSeconds > 0 ? dlna.formatClockTime(remainingSeconds) : ''
    };

    try {
        await dlna.stop(device);
    } catch (error) {
        void error;
    }
    await delay(timing.seekResetDelayMilliseconds);
    await dlna.setTransportUri(device, transportPayload);
    await dlna.play(device);

    const startTimeout = session.subtitleFileReady === true
        ? timing.burnStartTimeoutMilliseconds
        : timing.plainStartTimeoutMilliseconds;
    const isMoving = await waitForPlaybackToAdvance(device, startTimeout);

    if (isMoving === false) {
        const outcome = await startAndVerify(device, transportPayload);
        if (outcome.started === false) {
            throw new Error(`the TV did not resume after the jump (state ${outcome.state}).`);
        }
    }
    if (wasPaused) {
        await dlna.pause(device).catch(() => undefined);
    }
    return session.seekOffsetSeconds;
}

async function serveProxyRequest(request, response, session) {
    const upstreamHeaders = Object.assign({}, session.headers);
    delete upstreamHeaders['Accept-Encoding'];
    if (upstreamHeaders['User-Agent'] === undefined) {
        upstreamHeaders['User-Agent'] = BROWSER_USER_AGENT;
    }
    if (request.headers.range) {
        upstreamHeaders.Range = request.headers.range;
    }

    let upstream = null;
    try {
        upstream = await fetch(session.progressiveUrl, {
            method: request.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: upstreamHeaders,
            redirect: 'follow'
        });
    } catch (error) {
        runtime.lastError = `proxy upstream failed: ${error.message}`;
        process.stdout.write(`[proxy] upstream threw: ${error.message}\n`);
        response.writeHead(502, { 'Content-Type': 'text/plain' }).end('Upstream failed');
        return;
    }

    if (upstream.status === 416 && upstreamHeaders.Range !== undefined) {
        process.stdout.write(`[proxy] upstream 416, retrying without Range\n`);
        delete upstreamHeaders.Range;
        try {
            upstream = await fetch(session.progressiveUrl, {
                method: request.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: upstreamHeaders,
                redirect: 'follow'
            });
        } catch (error) {
            runtime.lastError = `proxy retry failed: ${error.message}`;
            response.writeHead(502, { 'Content-Type': 'text/plain' }).end('Upstream failed');
            return;
        }
    }

    if (upstream.status >= 400) {
        runtime.lastError = `proxy upstream HTTP ${upstream.status} for ${session.progressiveUrl.slice(0, 120)}`;
        process.stdout.write(`[proxy] upstream HTTP ${upstream.status}\n`);
        response.writeHead(502, { 'Content-Type': 'text/plain' }).end(`Upstream HTTP ${upstream.status}`);
        return;
    }

    const outgoingHeaders = {
        'Content-Type': upstream.headers.get('content-type') || session.mimeType,
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
        'transferMode.dlna.org': 'Streaming',
        'contentFeatures.dlna.org': dlna.DLNA_STREAMING_FLAGS,
        'Connection': 'close'
    };
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    if (contentLength) {
        outgoingHeaders['Content-Length'] = contentLength;
    }
    if (contentRange) {
        outgoingHeaders['Content-Range'] = contentRange;
    }

    response.writeHead(upstream.status, outgoingHeaders);
    if (request.method === 'HEAD' || upstream.body === null) {
        response.end();
    } else {
        const { Readable } = require('node:stream');
        const bodyStream = Readable.fromWeb(upstream.body);
        response.on('close', () => { bodyStream.destroy(); });
        bodyStream.on('error', () => { response.destroy(); });
        bodyStream.pipe(response);
    }
}

function serveMuxedRequest(request, response, session) {
    response.writeHead(HTTP_OK, {
        'Content-Type': 'video/mp2t',
        'transferMode.dlna.org': 'Streaming',
        'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
        'Connection': 'close'
    });
    if (request.method === 'HEAD') {
        response.end();
    } else {
        const headerArguments = [];
        for (const [name, value] of Object.entries(session.headers || {})) {
            headerArguments.push('-headers', `${name}: ${value}\r\n`);
        }
        const inputArguments = [];
        if (session.hlsUrl !== undefined && session.hlsUrl !== '') {
            const hlsArguments = [
                '-allowed_extensions', 'ALL',
                '-extension_picky', '0',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ];
            if (session.audioTrack !== undefined && session.audioTrack !== null) {
                inputArguments.push(
                    ...hlsArguments, ...headerArguments, '-i', buildLocalPlaylistUrl(session.id, 'video'),
                    ...hlsArguments, ...headerArguments, '-i', buildLocalPlaylistUrl(session.id, 'audio'),
                    '-map', '0:v:0', '-map', '1:a:0'
                );
            } else {
                inputArguments.push(
                    ...hlsArguments, ...headerArguments, '-i', buildLocalPlaylistUrl(session.id, 'video'),
                    '-map', '0:v:0', '-map', '0:a:0'
                );
            }
        } else {
            inputArguments.push(
                ...headerArguments, '-i', session.videoOnlyUrl,
                ...headerArguments, '-i', session.audioOnlyUrl,
                '-map', '0:v:0', '-map', '1:a:0'
            );
        }
        const videoArguments = session.subtitleFileReady === true
            ? ['-vf', `setpts=PTS-STARTPTS,subtitles=${SUBTITLE_CACHE_FOLDER}/${session.id}.srt:force_style='${SUBTITLE_STYLE}'`,
                '-af', 'asetpts=PTS-STARTPTS',
                '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', '24M', '-bufsize', '48M']
            : ['-c:v', 'copy'];
        process.stdout.write(`[mux] session ${session.id} burn=${session.subtitleFileReady === true} subtitle=${session.selectedSubtitleId || 'none'}\n`);
        const ffmpegProcess = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            ...inputArguments,
            ...videoArguments, '-c:a', 'aac', '-b:a', '192k',
            '-f', 'mpegts', 'pipe:1'
        ], { windowsHide: true, cwd: __dirname });
        ffmpegProcess.stdout.pipe(response);
        ffmpegProcess.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text !== '') {
                runtime.lastError = `ffmpeg: ${text.slice(0, 300)}`;
                process.stdout.write(`[mux] ${text.slice(0, 300)}\n`);
            }
        });
        ffmpegProcess.on('close', (code) => { process.stdout.write(`[mux] ffmpeg exited ${code}\n`); });
        ffmpegProcess.on('error', (error) => {
            process.stdout.write(`[mux] spawn failed: ${error.message}\n`);
            response.destroy();
        });
        response.on('close', () => { ffmpegProcess.kill('SIGKILL'); });
    }
}

async function castRemoteUrl(pageUrl) {
    const device = getSelectedDevice();
    if (device === null) {
        throw new Error('No TV selected.');
    }
    const resolved = await resolve.resolveMedia(pageUrl);
    const sessionId = nextIdentifier('c');
    resolved.id = sessionId;
    runtime.castSessions.set(sessionId, resolved);
    trimMap(runtime.castSessions, CAST_SESSION_LIMIT);

    const mediaUrl = buildProxyUrl(sessionId, resolved);
    const outcome = await startAndVerify(device, {
        mediaUrl,
        subtitleUrl: '',
        title: resolved.title,
        mimeType: resolved.progressiveUrl === '' ? 'video/mp2t' : resolved.mimeType,
        sizeBytes: 0,
        duration: resolved.durationSeconds > 0 ? dlna.formatClockTime(resolved.durationSeconds) : ''
    });
    if (outcome.started === false) {
        throw new Error(`TV accepted the link but never started (state ${outcome.state}). Try again, or power-cycle the TV.`);
    }
    runtime.currentItemId = '';
    runtime.currentCastSessionId = sessionId;
    runtime.currentRemoteTitle = resolved.title;
    return {
        title: resolved.title,
        mediaUrl,
        mode: resolved.progressiveUrl === '' ? 'remux' : 'passthrough',
        height: resolved.height || 0,
        quality: resolved.quality || '',
        provider: resolved.provider || ''
    };
}

function startDownloadJob(pageUrl) {
    const jobId = nextIdentifier('d');
    const targetDirectory = (configuration.libraryRoots || [])[0] || process.cwd();
    const job = { id: jobId, url: pageUrl, percent: 0, line: 'starting', done: false, failed: false };
    runtime.downloadJobs.set(jobId, job);
    trimMap(runtime.downloadJobs, DOWNLOAD_JOB_LIMIT);

    const child = resolve.startDownload(pageUrl, targetDirectory, (update) => {
        if (update.percent !== undefined) {
            job.percent = update.percent;
        }
        job.line = update.line;
    });
    child.on('close', (code) => {
        job.done = true;
        job.failed = code !== 0;
        job.percent = code === 0 ? 100 : job.percent;
        rescanLibrary();
    });
    return job;
}

function convertSubtitleToSrt(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (path.extname(filePath).toLowerCase() === '.vtt') {
        return raw.replace(/^WEBVTT.*\r?\n/, '').replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
    }
    return raw;
}

async function handleApiRequest(request, response, url) {
    const routeName = url.pathname.slice('/api/'.length);

    if (routeName === 'state') {
        const device = getSelectedDevice();
        let playback = { state: 'NO_DEVICE', positionSeconds: 0, durationSeconds: 0, volume: null, title: '' };
        if (device !== null) {
            try {
                const [transportInfo, positionInfo, volumeLevel] = await Promise.all([
                    dlna.getTransportInfo(device),
                    dlna.getPositionInfo(device),
                    dlna.getVolume(device).catch(() => null)
                ]);
                const currentItem = getLibraryItem(runtime.currentItemId);
                playback = {
                    state: transportInfo.state,
                    positionSeconds: positionInfo.positionSeconds,
                    durationSeconds: positionInfo.durationSeconds,
                    volume: volumeLevel,
                    title: currentItem ? currentItem.title : (runtime.currentRemoteTitle || '')
                };
                const castSession = getCurrentCastSession();
                if (castSession !== null && hasSegmentTimeline(castSession)) {
                    playback.durationSeconds = castSession.totalDurationSeconds;
                    const combinedPosition = castSession.seekOffsetSeconds + positionInfo.positionSeconds;
                    playback.positionSeconds = Math.round(Math.max(0, Math.min(combinedPosition, castSession.totalDurationSeconds)));
                    playback.renditions = castSession.renditions;
                    playback.selectedRenditionId = castSession.selectedRenditionId;
                    playback.quality = castSession.quality;
                    playback.provider = castSession.provider;
                    playback.subtitleTracks = (castSession.subtitleTracks || [])
                        .map((track) => ({ identifier: track.identifier, language: track.language }));
                    playback.selectedSubtitleId = castSession.selectedSubtitleId || SUBTITLE_OFF;
                    playback.subtitleOffsetSeconds = castSession.subtitleOffsetSeconds || 0;
                }
                if (transportInfo.state === 'PLAYING' || transportInfo.state === 'PAUSED_PLAYBACK') {
                    rememberPosition(runtime.currentItemId, positionInfo.positionSeconds, positionInfo.durationSeconds);
                }
            } catch (error) {
                playback.state = 'UNREACHABLE';
                runtime.lastError = error.message;
            }
        }
        sendJson(response, HTTP_OK, {
            devices: runtime.devices.map((entry) => ({ id: entry.id, name: entry.friendlyName, address: entry.address })),
            selectedDeviceId: runtime.selectedDeviceId,
            serverAddress: runtime.serverAddress,
            libraryCount: runtime.libraryItems.length,
            playback,
            lastError: runtime.lastError
        });
    } else if (routeName === 'discover' && request.method === 'POST') {
        const profiles = await refreshDevices();
        sendJson(response, HTTP_OK, { devices: profiles.map((entry) => ({ id: entry.id, name: entry.friendlyName, address: entry.address })) });
    } else if (routeName === 'select-device' && request.method === 'POST') {
        const body = await readRequestBody(request);
        runtime.selectedDeviceId = body.deviceId || '';
        persistedState.lastDeviceId = runtime.selectedDeviceId;
        saveJsonFile(STATE_PATH, persistedState);
        sendJson(response, HTTP_OK, { selectedDeviceId: runtime.selectedDeviceId });
    } else if (routeName === 'library') {
        const everything = getAllLibraryItems();
        const matches = library.filterLibrary(everything, url.searchParams.get('q'));
        sendJson(response, HTTP_OK, {
            total: everything.length,
            items: matches.slice(0, 400).map((item) => ({
                id: item.id,
                title: item.title,
                folder: item.folder,
                sizeBytes: item.sizeBytes,
                hasSubtitle: item.subtitlePath !== '',
                resumeSeconds: persistedState.resumePositions[item.id] || 0
            }))
        });
    } else if (routeName === 'scan' && request.method === 'POST') {
        const count = rescanLibrary();
        sendJson(response, HTTP_OK, { count });
    } else if (routeName === 'play' && request.method === 'POST') {
        const body = await readRequestBody(request);
        try {
            const result = await startPlayback(body.itemId, Number(body.startSeconds) || 0);
            sendJson(response, HTTP_OK, { ok: true, title: result.title });
        } catch (error) {
            runtime.lastError = error.message;
            sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
        }
    } else if (routeName === 'cast-url' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const pageUrl = String(body.url || '').trim();
        if (/^https?:\/\//i.test(pageUrl) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'Not a valid http(s) link' });
        } else {
            try {
                const result = await castRemoteUrl(pageUrl);
                sendJson(response, HTTP_OK, Object.assign({ ok: true }, result));
            } catch (error) {
                runtime.lastError = error.message;
                sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
            }
        }
    } else if (routeName === 'download' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const pageUrl = String(body.url || '').trim();
        if (/^https?:\/\//i.test(pageUrl) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'Not a valid http(s) link' });
        } else {
            const job = startDownloadJob(pageUrl);
            sendJson(response, HTTP_OK, { ok: true, jobId: job.id });
        }
    } else if (routeName === 'diagnose' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const pageUrl = String(body.url || '').trim();
        if (/^https?:\/\//i.test(pageUrl) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'Not a valid http(s) link' });
        } else {
            const report = await resolve.diagnoseUrl(pageUrl, body.browser);
            sendJson(response, HTTP_OK, Object.assign({ ok: true }, report));
        }
    } else if (routeName === 'jobs') {
        sendJson(response, HTTP_OK, { jobs: Array.from(runtime.downloadJobs.values()).slice(-6) });
    } else if (routeName === 'control' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const device = getSelectedDevice();
        if (device === null) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'No device selected' });
        } else {
            try {
                if (body.action === 'pause') {
                    await dlna.pause(device);
                } else if (body.action === 'resume') {
                    await dlna.play(device);
                } else if (body.action === 'stop') {
                    await dlna.stop(device);
                    runtime.currentCastSessionId = '';
                    runtime.currentRemoteTitle = '';
                } else if (body.action === 'seek') {
                    const targetSeconds = Number(body.value) || 0;
                    const castSession = getCurrentCastSession();
                    if (castSession !== null && hasSegmentTimeline(castSession)) {
                        await restartCastAtOffset(device, castSession, targetSeconds);
                    } else {
                        await dlna.seekToSeconds(device, targetSeconds);
                    }
                } else if (body.action === 'volume') {
                    await dlna.setVolume(device, Number(body.value) || 0);
                } else {
                    throw new Error(`Unknown action ${body.action}`);
                }
                sendJson(response, HTTP_OK, { ok: true });
            } catch (error) {
                runtime.lastError = error.message;
                sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
            }
        }
    } else if (routeName === 'cast-subtitle' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const device = getSelectedDevice();
        const castSession = getCurrentCastSession();
        if (device === null || castSession === null || hasSegmentTimeline(castSession) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'Nothing streaming that can take subtitles.' });
        } else {
            const requestedSubtitleId = String(body.subtitleId || SUBTITLE_OFF);
            const isKnownSubtitle = requestedSubtitleId === SUBTITLE_OFF
                || (castSession.subtitleTracks || []).some((track) => track.identifier === requestedSubtitleId);
            if (isKnownSubtitle === false) {
                sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'That subtitle track is not offered for this title.' });
                return;
            }
            try {
                castSession.selectedSubtitleId = requestedSubtitleId;
                castSession.subtitleOffsetSeconds = 0;
                await prepareSubtitleFile(castSession);
                await restartCastAtOffset(device, castSession, castSession.seekOffsetSeconds);
                sendJson(response, HTTP_OK, { ok: true, selectedSubtitleId: castSession.selectedSubtitleId });
            } catch (error) {
                runtime.lastError = error.message;
                sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
            }
        }
    } else if (routeName === 'subtitle-offset' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const device = getSelectedDevice();
        const castSession = getCurrentCastSession();
        if (device === null || castSession === null || castSession.subtitleFileReady !== true) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'No subtitle is showing.' });
        } else {
            try {
                castSession.subtitleOffsetSeconds = Number((castSession.subtitleOffsetSeconds + Number(body.deltaSeconds || 0)).toFixed(1));
                await prepareSubtitleFile(castSession);
                await restartCastAtOffset(device, castSession, castSession.seekOffsetSeconds);
                sendJson(response, HTTP_OK, { ok: true, subtitleOffsetSeconds: castSession.subtitleOffsetSeconds });
            } catch (error) {
                runtime.lastError = error.message;
                sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
            }
        }
    } else if (routeName === 'cast-quality' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const device = getSelectedDevice();
        const castSession = getCurrentCastSession();
        if (device === null) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'No TV selected.' });
        } else if (castSession === null || hasSegmentTimeline(castSession) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'Nothing streaming that can change quality.' });
        } else {
            try {
                const resumeSeconds = castSession.seekOffsetSeconds;
                await cineby.switchRendition(castSession, String(body.renditionId || ''));
                const startedAt = await restartCastAtOffset(device, castSession, resumeSeconds);
                sendJson(response, HTTP_OK, { ok: true, quality: castSession.quality, resumedAtSeconds: startedAt });
            } catch (error) {
                runtime.lastError = error.message;
                sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
            }
        }
    } else {
        sendJson(response, HTTP_NOT_FOUND, { error: 'Unknown endpoint' });
    }
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
        serveStaticFile(response, path.join(PUBLIC_DIRECTORY, 'index.html'), 'text/html; charset=utf-8');
    } else if (url.pathname.startsWith('/api/')) {
        handleApiRequest(request, response, url).catch((error) => {
            sendJson(response, HTTP_SERVER_ERROR, { error: error.message });
        });
    } else if (url.pathname.startsWith('/media/')) {
        const identifier = path.basename(url.pathname).split('.')[0];
        const item = getLibraryItem(identifier);
        if (item === null) {
            response.writeHead(HTTP_NOT_FOUND).end('Unknown media');
        } else {
            serveMediaFile(request, response, item);
        }
    } else if (url.pathname.startsWith('/proxy/')) {
        const sessionId = path.basename(url.pathname);
        const session = runtime.castSessions.get(sessionId);
        if (session === undefined) {
            response.writeHead(HTTP_NOT_FOUND).end('Unknown cast session');
        } else {
            serveProxyRequest(request, response, session).catch(() => {
                if (response.headersSent === false) {
                    response.writeHead(502).end('Proxy error');
                }
            });
        }
    } else if (url.pathname.startsWith('/muxed/')) {
        const sessionId = path.basename(url.pathname);
        const session = runtime.castSessions.get(sessionId);
        if (session === undefined) {
            response.writeHead(HTTP_NOT_FOUND).end('Unknown cast session');
        } else {
            serveMuxedRequest(request, response, session);
        }
    } else if (url.pathname.startsWith('/hls/')) {
        const pathParts = url.pathname.split('/').filter((part) => part !== '');
        const sessionId = pathParts[1] || '';
        const trackName = path.basename(url.pathname).split('.')[0];
        const session = runtime.castSessions.get(sessionId);
        if (session === undefined || hasSegmentTimeline(session) === false) {
            response.writeHead(HTTP_NOT_FOUND).end('Unknown cast session');
        } else {
            serveSessionPlaylist(response, session, trackName);
        }
    } else if (url.pathname.startsWith('/subtitle/')) {
        const requester = (request.socket.remoteAddress || '').replace(/^::ffff:/, '');
        process.stdout.write(`[subtitle] ${request.method} ${url.pathname} requested by ${requester}\n`);
        const identifier = path.basename(url.pathname).split('.')[0];
        const item = getLibraryItem(identifier);
        if (item === null || item.subtitlePath === '') {
            response.writeHead(HTTP_NOT_FOUND).end('No subtitle');
        } else {
            try {
                const body = convertSubtitleToSrt(item.subtitlePath);
                response.writeHead(HTTP_OK, { 'Content-Type': 'text/srt; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
                response.end(body);
            } catch (error) {
                void error;
                response.writeHead(HTTP_SERVER_ERROR).end('Subtitle error');
            }
        }
    } else {
        response.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/plain' });
        response.end('Not found');
    }
});

const listenPort = configuration.port || DEFAULT_PORT;

if (require.main === module) {
    server.listen(listenPort, '0.0.0.0', async () => {
        const itemCount = rescanLibrary();
        const addresses = ssdp.listLocalIpv4Addresses();
        runtime.serverAddress = (addresses.find((entry) => entry.address.startsWith('192.168.')) || addresses[0] || { address: '127.0.0.1' }).address;
        process.stdout.write(`tvcast listening on http://${runtime.serverAddress}:${listenPort}\n`);
        process.stdout.write(`library: ${itemCount} videos across ${(configuration.libraryRoots || []).length} root(s)\n`);
        const devices = await refreshDevices();
        for (const device of devices) {
            process.stdout.write(`renderer: ${device.friendlyName} @ ${device.address}\n`);
        }
    });
}

module.exports = {
    runtime,
    timing,
    buildProxyUrl,
    buildLocalPlaylistUrl,
    buildSubtitleFilePath,
    hasSegmentTimeline,
    getSessionTrack,
    serveSessionPlaylist,
    serveMuxedRequest,
    prepareSubtitleFile,
    restartCastAtOffset,
    handleApiRequest,
    getCurrentCastSession,
    getSelectedDevice
};
