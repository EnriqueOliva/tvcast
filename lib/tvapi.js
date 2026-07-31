const fs = require('node:fs');
const path = require('node:path');

const cineby = require('./cineby');
const hls = require('./hls');
const proxy = require('./proxy');
const subtitles = require('./subtitles');
const publications = require('./publications');
const synccheck = require('./synccheck');

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const HTTP_SERVER_ERROR = 500;
const EMPTY_STRING = '';
const SUBTITLE_OFF = '';
const RESUME_NEAR_END_MILLISECONDS = 90000;
const RESUME_MINIMUM_MILLISECONDS = 60000;
const TELEVISION_PORT = 8788;
const FILE_PREFIX = 'file:';
const TELEVISION_PROBE_TIMEOUT_MILLISECONDS = 400;
const TELEVISION_PUSH_TIMEOUT_MILLISECONDS = 4000;
const GENERATED_SUBTITLE_DIRECTORY = path.join(__dirname, '..', 'cache', 'subtitles');
const GENERATED_SUBTITLE_ID = 'autoenglish';
const GENERATED_SUBTITLE_LANGUAGE = 'English (auto)';
const YOUTUBE_ID_PATTERN = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/;
const KIND_DIRECT = 'direct';
const KIND_CINEBY = 'cineby';

const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    response.end(body);
}

function sendText(response, statusCode, contentType, body) {
    response.writeHead(statusCode, {
        'Content-Type': contentType,
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
            if (raw === EMPTY_STRING) {
                resolve({ ok: true, value: {} });
            } else {
                try {
                    resolve({ ok: true, value: JSON.parse(raw) });
                } catch (error) {
                    resolve({ ok: false, error: error.message });
                }
            }
        });
    });
}

function createTelevisionApi(options) {
    const configuration = options.configuration;
    const runtime = options.runtime;
    const resolveMedia = options.resolveMedia;
    const listLibraryItems = options.listLibraryItems;
    const stateFilePath = options.stateFilePath;
    const fetchImplementation = options.fetchImplementation;

    const resolvedOffers = new Map();
    const resumePositions = new Map();
    const measuredOffsets = new Map();

    function buildOffsetKey(contentKey, subtitleId) {
        return `${contentKey}::${subtitleId}`;
    }

    function loadPersisted() {
        try {
            const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
            for (const [key, value] of Object.entries(parsed.resume || {})) {
                resumePositions.set(key, value);
            }
            for (const [key, value] of Object.entries(parsed.measuredOffsets || {})) {
                measuredOffsets.set(key, value);
            }
            return parsed.publications || [];
        } catch (error) {
            void error;
            return [];
        }
    }

    function savePersisted(publicationList) {
        try {
            const payload = {
                publications: publicationList,
                resume: Object.fromEntries(resumePositions),
                measuredOffsets: Object.fromEntries(measuredOffsets)
            };
            fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
            fs.writeFileSync(stateFilePath, JSON.stringify(payload, null, 2), 'utf8');
        } catch (error) {
            void error;
        }
    }

    async function rehydratePublication(publication) {
        if (publication.kind !== 'cineby' && publication.kind !== 'direct') {
            return null;
        }
        const resolved = await resolveMedia(publication.sourceUrl);
        resolved.sourceUrl = publication.sourceUrl;
        attachGeneratedSubtitle(resolved);
        if (publication.selectedRenditionId !== EMPTY_STRING
            && (resolved.renditions || []).some((entry) => entry.identifier === publication.selectedRenditionId)) {
            await cineby.switchRendition(resolved, publication.selectedRenditionId);
        }
        const rebuilt = buildPublicationFromResolved(resolved, publication.selectedSubtitleId, publication.selectedRenditionId);
        rebuilt.id = publication.id;
        rebuilt.contentKey = publication.contentKey;
        rebuilt.createdAt = publication.createdAt;
        rebuilt.subtitleOffsetMilliseconds = publication.subtitleOffsetMilliseconds || 0;
        if (rebuilt.selectedSubtitleId !== SUBTITLE_OFF) {
            await attachSubtitleCues(rebuilt);
        }
        return rebuilt;
    }

    const store = publications.createPublicationStore({
        readPersisted: loadPersisted,
        writePersisted: savePersisted,
        rehydrate: rehydratePublication
    });

    function findGeneratedSubtitle(sourceUrl) {
        const matched = YOUTUBE_ID_PATTERN.exec(String(sourceUrl || EMPTY_STRING));
        if (matched === null) {
            return null;
        }
        const subtitlePath = path.join(GENERATED_SUBTITLE_DIRECTORY, `${matched[1]}.srt`);
        if (fs.existsSync(subtitlePath) === false) {
            return null;
        }
        return {
            identifier: GENERATED_SUBTITLE_ID,
            language: GENERATED_SUBTITLE_LANGUAGE,
            url: EMPTY_STRING,
            localPath: subtitlePath
        };
    }

    function attachGeneratedSubtitle(resolved) {
        const generated = findGeneratedSubtitle(resolved.sourceUrl);
        if (generated !== null) {
            resolved.subtitleTracks = [generated].concat(resolved.subtitleTracks || []);
        }
    }

    function buildDirectPublication(resolved, subtitleId) {
        return {
            id: EMPTY_STRING,
            contentKey: publications.buildContentKey(KIND_DIRECT, resolved.sourceUrl || resolved.title),
            kind: KIND_DIRECT,
            sourceUrl: resolved.sourceUrl || EMPTY_STRING,
            title: resolved.title,
            durationSeconds: resolved.totalDurationSeconds || 0,
            quality: resolved.quality || EMPTY_STRING,
            provider: resolved.provider || EMPTY_STRING,
            width: resolved.width || 0,
            height: resolved.height || 0,
            headers: {},
            httpHeaders: resolved.httpHeaders || {},
            streamUrl: resolved.streamUrl,
            audioStreamUrl: resolved.audioStreamUrl || EMPTY_STRING,
            streamKind: resolved.streamKind,
            packaging: EMPTY_STRING,
            tracks: null,
            renditions: [],
            selectedRenditionId: EMPTY_STRING,
            subtitles: (resolved.subtitleTracks || []).map((track) => ({
                id: track.identifier,
                language: track.language,
                url: track.url || EMPTY_STRING,
                localPath: track.localPath || EMPTY_STRING,
                cues: null
            })),
            selectedSubtitleId: subtitleId || SUBTITLE_OFF,
            subtitleOffsetMilliseconds: 0,
            createdAt: Date.now()
        };
    }

    function buildPublicationFromResolved(resolved, subtitleId, renditionId) {
        if (resolved.streamUrl !== undefined && resolved.streamUrl !== EMPTY_STRING) {
            return buildDirectPublication(resolved, subtitleId);
        }
        const usesFragmentedMp4 = resolved.videoTrack !== undefined
            && resolved.videoTrack !== null
            && resolved.videoTrack.initSegmentUrl !== undefined
            && resolved.videoTrack.initSegmentUrl !== EMPTY_STRING;
        return {
            id: EMPTY_STRING,
            contentKey: publications.buildContentKey('cineby', resolved.sourceUrl || resolved.title),
            kind: 'cineby',
            sourceUrl: resolved.sourceUrl || EMPTY_STRING,
            title: resolved.title,
            durationSeconds: resolved.totalDurationSeconds || 0,
            quality: resolved.quality || EMPTY_STRING,
            provider: resolved.provider || EMPTY_STRING,
            width: resolved.width || 0,
            height: resolved.height || 0,
            headers: resolved.headers || {},
            packaging: usesFragmentedMp4 ? 'fmp4' : 'ts',
            tracks: { video: resolved.videoTrack || null, audio: resolved.audioTrack || null },
            renditions: resolved.renditions || [],
            selectedRenditionId: renditionId || resolved.selectedRenditionId || EMPTY_STRING,
            subtitles: (resolved.subtitleTracks || []).map((track) => ({
                id: track.identifier,
                language: track.language,
                url: track.url,
                cues: null
            })),
            selectedSubtitleId: subtitleId || SUBTITLE_OFF,
            subtitleOffsetMilliseconds: 0,
            createdAt: Date.now()
        };
    }

    async function attachSubtitleCues(publication) {
        const selected = (publication.subtitles || [])
            .find((track) => track.id === publication.selectedSubtitleId);
        if (selected === undefined) {
            publication.selectedSubtitleId = SUBTITLE_OFF;
            return;
        }
        if (selected.cues !== null && selected.cues !== undefined) {
            return;
        }
        if (selected.localPath !== undefined && selected.localPath !== EMPTY_STRING) {
            selected.cues = subtitles.readSidecarCues(selected.localPath);
        } else {
            selected.cues = await subtitles.fetchCues(selected.url);
        }
    }

    const television = { address: EMPTY_STRING, port: TELEVISION_PORT, lastSeenAt: 0 };
    let pendingPlayback = null;

    function buildBaseUrl() {
        return `http://${runtime.serverAddress}:${configuration.port || 8787}`;
    }

    async function probeTelevision(address) {
        try {
            const response = await (fetchImplementation || fetch)(`http://${address}:${TELEVISION_PORT}/ping`, {
                signal: AbortSignal.timeout(TELEVISION_PROBE_TIMEOUT_MILLISECONDS)
            });
            if (response.ok === false) {
                return false;
            }
            const payload = await response.json();
            return payload.app === 'tvcast';
        } catch (error) {
            void error;
            return false;
        }
    }

    async function findTelevision() {
        if (television.address !== EMPTY_STRING && await probeTelevision(television.address)) {
            return television.address;
        }
        const parts = runtime.serverAddress.split('.');
        if (parts.length !== 4) {
            return EMPTY_STRING;
        }
        const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const candidates = [];
        for (let host = 2; host < 255; host += 1) {
            candidates.push(`${subnet}.${host}`);
        }
        const found = await new Promise((resolveSweep) => {
            let outstanding = candidates.length;
            let settled = false;
            for (const candidate of candidates) {
                probeTelevision(candidate).then((isTelevision) => {
                    if (isTelevision && settled === false) {
                        settled = true;
                        resolveSweep(candidate);
                    }
                    outstanding -= 1;
                    if (outstanding === 0 && settled === false) {
                        resolveSweep(EMPTY_STRING);
                    }
                });
            }
        });
        if (found !== EMPTY_STRING) {
            television.address = found;
            television.lastSeenAt = Date.now();
        }
        return found;
    }

    async function pushToTelevision(payload) {
        const address = await findTelevision();
        if (address === EMPTY_STRING) {
            pendingPlayback = payload;
            return { delivered: false, queued: true, reason: 'the Fire TV app is not reachable' };
        }
        try {
            const response = await (fetchImplementation || fetch)(`http://${address}:${TELEVISION_PORT}/play`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(TELEVISION_PUSH_TIMEOUT_MILLISECONDS)
            });
            if (response.ok === false) {
                pendingPlayback = payload;
                return { delivered: false, queued: true, reason: `the Fire TV answered HTTP ${response.status}` };
            }
            television.lastSeenAt = Date.now();
            pendingPlayback = null;
            return { delivered: true, queued: false, reason: EMPTY_STRING };
        } catch (error) {
            pendingPlayback = payload;
            return { delivered: false, queued: true, reason: error.message };
        }
    }

    function buildPlaybackPayload(publication) {
        const base = buildBaseUrl();
        const resume = resumePositions.get(publication.contentKey) || null;
        const isDirect = publication.kind === KIND_DIRECT;
        let mediaUrl = EMPTY_STRING;
        let mediaKind = 'hls';
        if (isDirect) {
            mediaUrl = publication.streamUrl;
            mediaKind = publication.streamKind;
        } else if (hls.hasSeparateAudio(publication)) {
            mediaUrl = `${base}/hls/${publication.id}/master.m3u8`;
        } else {
            mediaUrl = `${base}/hls/${publication.id}/video.m3u8`;
        }
        return {
            publicationId: publication.id,
            contentKey: publication.contentKey,
            title: publication.title,
            durationMilliseconds: publication.durationSeconds * 1000,
            quality: publication.quality,
            provider: publication.provider,
            mediaUrl,
            mediaKind,
            audioUrl: isDirect ? (publication.audioStreamUrl || EMPTY_STRING) : EMPTY_STRING,
            httpHeaders: isDirect ? (publication.httpHeaders || {}) : {},
            subtitles: (publication.subtitles || []).map((track) => ({
                id: track.id,
                language: track.language,
                cuesUrl: `${base}/sub/${publication.id}/${encodeURIComponent(track.id)}.json`
            })),
            selectedSubtitleId: publication.selectedSubtitleId,
            subtitleOffsetMilliseconds: publication.subtitleOffsetMilliseconds || 0,
            resumeMilliseconds: resume === null ? 0 : resume.positionMilliseconds,
            serverBaseUrl: base
        };
    }

    function rememberProgress(body) {
        const contentKey = String(body.contentKey || EMPTY_STRING);
        if (contentKey === EMPTY_STRING) {
            return false;
        }
        const positionMilliseconds = Number(body.positionMilliseconds) || 0;
        const durationMilliseconds = Number(body.durationMilliseconds) || 0;
        const reportedSubtitleId = String(body.subtitleId || EMPTY_STRING);
        const reportedOffset = Number(body.subtitleOffsetMilliseconds) || 0;
        if (reportedSubtitleId !== EMPTY_STRING) {
            measuredOffsets.set(buildOffsetKey(contentKey, reportedSubtitleId), reportedOffset);
        }
        const nearEnd = durationMilliseconds > 0
            && positionMilliseconds > durationMilliseconds - RESUME_NEAR_END_MILLISECONDS;
        if (positionMilliseconds < RESUME_MINIMUM_MILLISECONDS || nearEnd) {
            resumePositions.delete(contentKey);
        } else {
            resumePositions.set(contentKey, {
                positionMilliseconds,
                durationMilliseconds,
                subtitleId: String(body.subtitleId || EMPTY_STRING),
                subtitleOffsetMilliseconds: Number(body.subtitleOffsetMilliseconds) || 0,
                updatedAt: Date.now()
            });
        }
        store.persist();
        return true;
    }

    async function serveTrackPlaylist(response, publication, trackName) {
        const track = hls.getTrack(publication, trackName);
        if (track === null) {
            sendText(response, HTTP_NOT_FOUND, 'text/plain', 'No such track');
            return;
        }
        const base = buildBaseUrl();
        const playlist = hls.buildMediaPlaylist(
            track,
            (index) => `${base}/seg/${publication.id}/${trackName}/${index}`,
            () => `${base}/seg/${publication.id}/${trackName}/init`
        );
        sendText(response, HTTP_OK, PLAYLIST_CONTENT_TYPE, playlist);
    }

    function serveMasterPlaylist(response, publication) {
        const base = buildBaseUrl();
        const playlist = hls.buildMasterPlaylist(
            publication,
            (trackName) => `${base}/hls/${publication.id}/${trackName}.m3u8`
        );
        sendText(response, HTTP_OK, PLAYLIST_CONTENT_TYPE, playlist);
    }

    async function serveSegment(request, response, publication, trackName, segmentReference) {
        const track = hls.getTrack(publication, trackName);
        if (track === null) {
            sendText(response, HTTP_NOT_FOUND, 'text/plain', 'No such track');
            return;
        }
        let segmentUrl = EMPTY_STRING;
        if (segmentReference === 'init') {
            segmentUrl = track.initSegmentUrl || EMPTY_STRING;
        } else {
            const index = Number(segmentReference);
            if (Number.isInteger(index) === false || track.segments[index] === undefined) {
                sendText(response, HTTP_NOT_FOUND, 'text/plain', 'No such segment');
                return;
            }
            segmentUrl = track.segments[index].url;
        }
        if (segmentUrl === EMPTY_STRING) {
            sendText(response, HTTP_NOT_FOUND, 'text/plain', 'No such segment');
            return;
        }
        await proxy.streamUpstreamSegment({
            request,
            response,
            segmentUrl,
            headers: publication.headers,
            packaging: publication.packaging,
            fetchImplementation
        });
    }

    async function serveSubtitle(request, response, publication, trackId, format, offsetMilliseconds) {
        const track = (publication.subtitles || []).find((entry) => entry.id === trackId);
        if (track === undefined) {
            sendText(response, HTTP_NOT_FOUND, 'text/plain', 'No such subtitle');
            return;
        }
        if (track.cues === null || track.cues === undefined) {
            try {
                if (track.localPath !== undefined && track.localPath !== EMPTY_STRING) {
                    track.cues = subtitles.readSidecarCues(track.localPath);
                } else {
                    track.cues = await subtitles.fetchCues(track.url);
                }
            } catch (error) {
                sendText(response, HTTP_SERVER_ERROR, 'text/plain', `Subtitle failed: ${error.message}`);
                return;
            }
        }
        if (format === 'json') {
            sendJson(response, HTTP_OK, subtitles.toCueJson(track.cues, offsetMilliseconds));
        } else {
            sendText(response, HTTP_OK, 'text/vtt; charset=utf-8',
                subtitles.toWebVtt(track.cues, offsetMilliseconds));
        }
    }

    async function pushSubtitleOffset(publication) {
        if (television.address === EMPTY_STRING) {
            return;
        }
        try {
            await (fetchImplementation || fetch)(`http://${television.address}:${TELEVISION_PORT}/offset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contentKey: publication.contentKey,
                    offsetMilliseconds: publication.subtitleOffsetMilliseconds
                }),
                signal: AbortSignal.timeout(TELEVISION_PUSH_TIMEOUT_MILLISECONDS)
            });
        } catch (error) {
            void error;
        }
    }

    async function verifySubtitleSync(publication) {
        const selected = (publication.subtitles || [])
            .find((track) => track.id === publication.selectedSubtitleId);
        const hasVideoSegments = publication.tracks !== null
            && publication.tracks !== undefined
            && publication.tracks.video !== null
            && publication.tracks.video !== undefined;
        if (selected === undefined || selected.cues === null || hasVideoSegments === false) {
            return;
        }
        try {
            const measured = await synccheck.measureOffset({
                segments: publication.tracks.video.segments,
                cues: selected.cues,
                headers: publication.headers
            });
            if (measured.mismatched) {
                publication.subtitleWarning = 'the audio does not match this subtitle track';
                process.stdout.write(`[sync] ${publication.id}: no alignment found, subtitle likely wrong for this stream\n`);
            } else if (measured.confident) {
                publication.subtitleOffsetMilliseconds = measured.offsetMilliseconds;
                publication.subtitleWarning = EMPTY_STRING;
                measuredOffsets.set(
                    buildOffsetKey(publication.contentKey, publication.selectedSubtitleId),
                    measured.offsetMilliseconds);
                process.stdout.write(`[sync] ${publication.id}: corrected by ${measured.offsetMilliseconds}ms`
                    + ` (${measured.windows} windows, ${measured.spread.toFixed(2)}s spread)\n`);
                await pushSubtitleOffset(publication);
            } else {
                process.stdout.write(`[sync] ${publication.id}: inconclusive, leaving the offset alone\n`);
            }
            store.persist();
        } catch (error) {
            process.stdout.write(`[sync] ${publication.id}: verification failed ${error.message}\n`);
        }
    }

    function findLibraryItem(itemIdentifier) {
        return listLibraryItems().find((item) => item.id === itemIdentifier) || null;
    }

    function buildLibraryPayload(item) {
        const base = buildBaseUrl();
        const contentKey = `file:${item.id}`;
        const resume = resumePositions.get(contentKey) || null;
        const hasSubtitle = item.subtitlePath !== undefined && item.subtitlePath !== EMPTY_STRING;
        return {
            publicationId: `${FILE_PREFIX}${item.id}`,
            contentKey,
            title: item.title,
            durationMilliseconds: 0,
            quality: EMPTY_STRING,
            provider: 'library',
            mediaUrl: `${base}/file/${item.id}${item.extension}`,
            mediaKind: 'file',
            subtitles: hasSubtitle
                ? [{ id: 'sidecar', language: 'Sidecar', cuesUrl: `${base}/file/${item.id}/subtitle.json` }]
                : [],
            selectedSubtitleId: hasSubtitle ? 'sidecar' : SUBTITLE_OFF,
            subtitleOffsetMilliseconds: measuredOffsets.get(buildOffsetKey(contentKey, 'sidecar')) || 0,
            resumeMilliseconds: resume === null ? 0 : resume.positionMilliseconds,
            serverBaseUrl: base
        };
    }

    function serveLibraryFile(request, response, item) {
        let stats = null;
        try {
            stats = fs.statSync(item.filePath);
        } catch (error) {
            sendText(response, HTTP_NOT_FOUND, 'text/plain', 'Missing file');
            return;
        }
        const rangeHeader = request.headers.range;
        const commonHeaders = {
            'Content-Type': item.mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
        };
        if (rangeHeader !== undefined) {
            const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
            const startByte = match !== null && match[1] !== EMPTY_STRING ? Number(match[1]) : 0;
            const requestedEnd = match !== null && match[2] !== EMPTY_STRING ? Number(match[2]) : stats.size - 1;
            const endByte = Math.min(requestedEnd, stats.size - 1);
            if (startByte > endByte) {
                response.writeHead(416, { 'Content-Range': `bytes */${stats.size}` }).end();
            } else {
                response.writeHead(206, Object.assign({}, commonHeaders, {
                    'Content-Range': `bytes ${startByte}-${endByte}/${stats.size}`,
                    'Content-Length': endByte - startByte + 1
                }));
                if (request.method === 'HEAD') {
                    response.end();
                } else {
                    fs.createReadStream(item.filePath, { start: startByte, end: endByte }).pipe(response);
                }
            }
        } else {
            response.writeHead(HTTP_OK, Object.assign({}, commonHeaders, { 'Content-Length': stats.size }));
            if (request.method === 'HEAD') {
                response.end();
            } else {
                fs.createReadStream(item.filePath).pipe(response);
            }
        }
    }

    async function handleResolve(request, response) {
        const body = await readRequestBody(request);
        if (body.ok === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'body was not valid JSON' });
            return;
        }
        const pageUrl = String(body.value.url || EMPTY_STRING).trim();
        if (/^https?:\/\//i.test(pageUrl) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'url must be an http or https link' });
            return;
        }
        try {
            const resolved = await resolveMedia(pageUrl);
            resolved.sourceUrl = pageUrl;
            attachGeneratedSubtitle(resolved);
            const offerId = publications.buildPublicationId(pageUrl, EMPTY_STRING, EMPTY_STRING);
            resolvedOffers.set(offerId, resolved);
            const contentKey = publications.buildContentKey('cineby', pageUrl);
            const resume = resumePositions.get(contentKey) || null;
            sendJson(response, HTTP_OK, {
                ok: true,
                offerId,
                title: resolved.title,
                durationSeconds: resolved.totalDurationSeconds || 0,
                quality: resolved.quality || EMPTY_STRING,
                provider: resolved.provider || EMPTY_STRING,
                selectedRenditionId: resolved.selectedRenditionId || EMPTY_STRING,
                resumeMilliseconds: resume === null ? 0 : resume.positionMilliseconds,
                subtitles: (resolved.subtitleTracks || []).map((track) => ({
                    id: track.identifier,
                    language: track.language
                })),
                renditions: (resolved.renditions || []).map((rendition) => ({
                    id: rendition.identifier,
                    label: rendition.displayLabel,
                    height: rendition.height,
                    provider: rendition.provider
                }))
            });
        } catch (error) {
            sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
        }
    }

    async function sendLibraryItem(response, itemIdentifier) {
        const item = findLibraryItem(itemIdentifier);
        if (item === null) {
            sendJson(response, HTTP_NOT_FOUND, { ok: false, error: 'unknown library item' });
        } else {
            const payload = buildLibraryPayload(item);
            const delivery = await pushToTelevision(payload);
            sendJson(response, HTTP_OK, Object.assign({ ok: true }, payload, delivery));
        }
    }

    async function sendPublishedItem(response, publicationId) {
        let publication = null;
        try {
            publication = await store.get(publicationId);
        } catch (error) {
            sendJson(response, HTTP_GONE, { ok: false, error: error.message });
            return;
        }
        if (publication === null) {
            sendJson(response, HTTP_NOT_FOUND, { ok: false, error: 'unknown publication' });
        } else {
            const payload = buildPlaybackPayload(publication);
            const delivery = await pushToTelevision(payload);
            sendJson(response, HTTP_OK, Object.assign({ ok: true }, payload, delivery));
        }
    }

    async function handleSendResolvedOffer(response, body) {
        const offerId = String(body.offerId || EMPTY_STRING);
        const renditionId = String(body.renditionId || EMPTY_STRING);
        const subtitleId = String(body.subtitleId || SUBTITLE_OFF);
        const resolved = resolvedOffers.get(offerId);
        if (resolved === undefined) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'that link was not resolved recently, send it again' });
            return;
        }
        try {
            if (renditionId !== EMPTY_STRING) {
                await cineby.switchRendition(resolved, renditionId);
            }
            const publication = buildPublicationFromResolved(resolved, subtitleId, renditionId);
            publication.id = publications.buildPublicationId(resolved.sourceUrl, renditionId, subtitleId);
            if (subtitleId !== SUBTITLE_OFF) {
                await attachSubtitleCues(publication);
            }
            const cachedOffset = measuredOffsets.get(
                buildOffsetKey(publication.contentKey, publication.selectedSubtitleId));
            const hasCachedOffset = cachedOffset !== undefined;
            if (hasCachedOffset) {
                publication.subtitleOffsetMilliseconds = cachedOffset;
            }
            store.put(publication);
            const payload = buildPlaybackPayload(publication);
            const delivery = await pushToTelevision(payload);
            sendJson(response, HTTP_OK, Object.assign({ ok: true }, payload, delivery, {
                subtitleOffsetMeasured: hasCachedOffset
            }));
            const needsSyncCheck = publication.kind === KIND_CINEBY
                && publication.selectedSubtitleId !== SUBTITLE_OFF
                && hasCachedOffset === false;
            if (needsSyncCheck) {
                verifySubtitleSync(publication);
            }
        } catch (error) {
            sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
        }
    }

    async function handleSend(request, response) {
        const body = await readRequestBody(request);
        if (body.ok === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'body was not valid JSON' });
            return;
        }
        const publicationId = String(body.value.publicationId || EMPTY_STRING);
        if (publicationId.startsWith(FILE_PREFIX)) {
            await sendLibraryItem(response, publicationId.slice(FILE_PREFIX.length));
        } else if (publicationId !== EMPTY_STRING) {
            await sendPublishedItem(response, publicationId);
        } else {
            await handleSendResolvedOffer(response, body.value);
        }
    }

    async function handleRequest(request, response, url) {
        const pathName = url.pathname;

        if (pathName === '/api/hello') {
            sendJson(response, HTTP_OK, {
                name: 'tvcast',
                version: 2,
                serverBaseUrl: buildBaseUrl()
            });
            return true;
        }

        if (pathName === '/api/resolve' && request.method === 'POST') {
            await handleResolve(request, response);
            return true;
        }

        if (pathName === '/api/send' && request.method === 'POST') {
            await handleSend(request, response);
            return true;
        }

        if (pathName.startsWith('/api/play/')) {
            const publicationId = pathName.slice('/api/play/'.length);
            if (publicationId.startsWith(FILE_PREFIX)) {
                const item = findLibraryItem(publicationId.slice(FILE_PREFIX.length));
                if (item === null) {
                    sendJson(response, HTTP_NOT_FOUND, { ok: false, error: 'unknown library item' });
                } else {
                    sendJson(response, HTTP_OK, buildLibraryPayload(item));
                }
                return true;
            }
            let publication = null;
            try {
                publication = await store.get(publicationId);
            } catch (error) {
                sendText(response, HTTP_GONE, 'text/plain', error.message);
                return true;
            }
            if (publication === null) {
                sendJson(response, HTTP_NOT_FOUND, { ok: false, error: 'unknown publication' });
            } else {
                sendJson(response, HTTP_OK, buildPlaybackPayload(publication));
            }
            return true;
        }

        if (pathName === '/api/pending') {
            if (pendingPlayback === null) {
                response.writeHead(HTTP_NO_CONTENT).end();
            } else {
                const payload = pendingPlayback;
                pendingPlayback = null;
                sendJson(response, HTTP_OK, payload);
            }
            return true;
        }

        if (pathName === '/api/tv/register' && request.method === 'POST') {
            television.address = (request.socket.remoteAddress || EMPTY_STRING).replace(/^::ffff:/, EMPTY_STRING);
            television.lastSeenAt = Date.now();
            sendJson(response, HTTP_OK, { ok: true, serverBaseUrl: buildBaseUrl() });
            return true;
        }

        if (pathName === '/api/tv/status') {
            sendJson(response, HTTP_OK, {
                address: television.address,
                port: television.port,
                lastSeenAt: television.lastSeenAt,
                hasPending: pendingPlayback !== null
            });
            return true;
        }

        if (pathName === '/api/catalogue') {
            const published = store.list().map(publications.describeForCatalogue);
            const libraryEntries = listLibraryItems().map((item) => ({
                id: `${FILE_PREFIX}${item.id}`,
                contentKey: `file:${item.id}`,
                kind: 'file',
                title: item.title,
                durationSeconds: 0,
                quality: EMPTY_STRING,
                provider: 'library',
                selectedSubtitleId: item.subtitlePath === EMPTY_STRING ? SUBTITLE_OFF : 'sidecar',
                subtitleOffsetMilliseconds: 0,
                subtitles: [],
                renditions: [],
                createdAt: 0
            }));
            sendJson(response, HTTP_OK, { items: published.concat(libraryEntries) });
            return true;
        }

        if (pathName.startsWith('/file/')) {
            const remainder = pathName.slice('/file/'.length);
            const subtitleMatch = /^([^/]+)\/subtitle\.json$/.exec(remainder);
            const itemIdentifier = subtitleMatch !== null
                ? subtitleMatch[1]
                : remainder.split('.')[0];
            const item = findLibraryItem(itemIdentifier);
            if (item === null) {
                sendText(response, HTTP_NOT_FOUND, 'text/plain', 'Unknown library item');
            } else if (subtitleMatch !== null) {
                try {
                    const cues = subtitles.readSidecarCues(item.subtitlePath);
                    const offsetMilliseconds = Number(url.searchParams.get('offsetMs')) || 0;
                    sendJson(response, HTTP_OK, subtitles.toCueJson(cues, offsetMilliseconds));
                } catch (error) {
                    sendText(response, HTTP_SERVER_ERROR, 'text/plain', `Subtitle failed: ${error.message}`);
                }
            } else {
                serveLibraryFile(request, response, item);
            }
            return true;
        }

        if (pathName === '/api/progress' && request.method === 'POST') {
            const body = await readRequestBody(request);
            if (body.ok === false || rememberProgress(body.value) === false) {
                sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'contentKey is required' });
            } else {
                response.writeHead(HTTP_NO_CONTENT).end();
            }
            return true;
        }

        if (pathName.startsWith('/api/catalogue/') && request.method === 'DELETE') {
            const publicationId = pathName.slice('/api/catalogue/'.length);
            if (store.remove(publicationId)) {
                sendJson(response, HTTP_OK, { ok: true });
            } else {
                sendJson(response, HTTP_NOT_FOUND, { ok: false, error: 'that item was already gone' });
            }
            return true;
        }

        const playbackMatch = /^\/(hls|seg|sub)\/([^/]+)\/(.+)$/.exec(pathName);
        if (playbackMatch === null) {
            return false;
        }

        const area = playbackMatch[1];
        const publicationId = playbackMatch[2];
        const remainder = playbackMatch[3];

        let publication = null;
        try {
            publication = await store.get(publicationId);
        } catch (error) {
            sendText(response, HTTP_GONE, 'text/plain', error.message);
            return true;
        }
        if (publication === null) {
            sendText(response, HTTP_NOT_FOUND, 'text/plain', 'Unknown publication');
            return true;
        }

        if (area === 'hls') {
            const trackName = remainder.replace(/\.m3u8$/, EMPTY_STRING);
            if (trackName === 'master') {
                serveMasterPlaylist(response, publication);
            } else {
                await serveTrackPlaylist(response, publication, trackName);
            }
            return true;
        }

        if (area === 'seg') {
            const segmentParts = remainder.split('/');
            await serveSegment(request, response, publication, segmentParts[0], segmentParts[1]);
            return true;
        }

        const subtitleMatch = /^(.+)\.(json|vtt)$/.exec(remainder);
        if (subtitleMatch === null) {
            sendText(response, HTTP_NOT_FOUND, 'text/plain', 'Unknown subtitle request');
            return true;
        }
        const offsetMilliseconds = Number(url.searchParams.get('offsetMs')) || 0;
        await serveSubtitle(request, response, publication,
            decodeURIComponent(subtitleMatch[1]), subtitleMatch[2], offsetMilliseconds);
        return true;
    }

    return {
        handleRequest,
        store,
        buildPlaybackPayload,
        buildPublicationFromResolved,
        rememberProgress,
        resumePositions,
        resolvedOffers
    };
}

module.exports = { createTelevisionApi };
