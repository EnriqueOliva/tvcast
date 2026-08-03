const fs = require('node:fs');
const path = require('node:path');

const hls = require('./hls');
const proxy = require('./proxy');
const subtitles = require('./subtitles');
const publications = require('./publications');
const synccheck = require('./synccheck');
const languages = require('./languages');
const activityJournal = require('./activity');

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
const PRESENCE_CHECK_INTERVAL_MILLISECONDS = 10000;
const SENT_LINK_LIMIT = 400;
const GENERATED_SUBTITLE_DIRECTORY = path.join(__dirname, '..', 'cache', 'subtitles');
const GENERATED_SUBTITLE_ID = 'autoenglish';
const GENERATED_SUBTITLE_LANGUAGE = 'English (auto)';
const YOUTUBE_ID_PATTERN = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/;
const KIND_DIRECT = 'direct';
const KIND_CINEBY = 'cineby';
const MAIN_COLLECTION = 'main';
const APPLICATION_NAME = 'capytv';
const TELEVISION_MAXIMUM_HEIGHT = 1080;

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
    const activity = options.activity || activityJournal.createActivityJournal();

    const televisionPort = configuration.televisionPort || TELEVISION_PORT;

    const resolvedOffers = new Map();
    const resumePositions = new Map();
    const measuredOffsets = new Map();
    const sentLinks = new Map();

    function rememberLink(sourceUrl, title, collection) {
        if (sourceUrl === EMPTY_STRING) {
            return;
        }
        // A link that is already filed stays filed. Pasting an episode url into the main box
        // must not tear it out of its series, and the phone always names a collection.
        const existing = sentLinks.get(sourceUrl);
        let belongsTo = MAIN_COLLECTION;
        if (existing !== undefined) {
            belongsTo = existing.collection || MAIN_COLLECTION;
        } else if (collection !== undefined && collection !== EMPTY_STRING) {
            belongsTo = collection;
        }
        let displayTitle = title;
        if (displayTitle === undefined || displayTitle === EMPTY_STRING) {
            displayTitle = existing === undefined ? sourceUrl : existing.title;
        }
        sentLinks.delete(sourceUrl);
        sentLinks.set(sourceUrl, {
            url: sourceUrl,
            title: displayTitle,
            collection: belongsTo,
            addedAt: existing === undefined ? Date.now() : (existing.addedAt || existing.lastSentAt || Date.now()),
            lastSentAt: Date.now()
        });
        while (sentLinks.size > SENT_LINK_LIMIT) {
            sentLinks.delete(sentLinks.keys().next().value);
        }
    }

    function collectionOf(entry) {
        return entry.collection || MAIN_COLLECTION;
    }

    // The main list is a history, so the most recently sent link belongs on top. A collection
    // is a series in a fixed running order, so playing episode seven must not shuffle it: those
    // sort on when the link was first added and never move again.
    function listLinks(collection) {
        const wanted = collection === undefined || collection === EMPTY_STRING ? MAIN_COLLECTION : collection;
        const matching = Array.from(sentLinks.values())
            .filter((entry) => collectionOf(entry) === wanted);
        if (wanted === MAIN_COLLECTION) {
            return matching.sort((left, right) => right.lastSentAt - left.lastSentAt);
        }
        return matching.sort((left, right) =>
            (right.addedAt || right.lastSentAt) - (left.addedAt || left.lastSentAt));
    }

    function listCollections() {
        const counts = new Map();
        for (const entry of sentLinks.values()) {
            const name = collectionOf(entry);
            counts.set(name, (counts.get(name) || 0) + 1);
        }
        return Array.from(counts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

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
            for (const entry of parsed.links || []) {
                sentLinks.set(entry.url, entry);
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
                measuredOffsets: Object.fromEntries(measuredOffsets),
                links: Array.from(sentLinks.values())
            };
            fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
            fs.writeFileSync(stateFilePath, JSON.stringify(payload, null, 2), 'utf8');
        } catch (error) {
            void error;
        }
    }

    async function rehydratePublication(publication) {
        if (publication.kind !== KIND_CINEBY && publication.kind !== KIND_DIRECT) {
            return null;
        }
        const entry = activity.begin(activityJournal.KIND_RESOLVE,
            publication.title || publication.sourceUrl);
        try {
            const resolved = await resolveMedia(publication.sourceUrl,
                { onStage: activity.reporterFor(entry) });
            resolved.sourceUrl = publication.sourceUrl;
            attachGeneratedSubtitle(resolved);
            const stillOffered = (resolved.subtitleTracks || [])
                .some((track) => track.identifier === publication.selectedSubtitleId);
            const subtitleId = stillOffered
                ? publication.selectedSubtitleId
                : languages.pickDefaultSubtitleId(resolved.subtitleTracks || []);
            const rebuilt = buildPublicationFromResolved(resolved, subtitleId, EMPTY_STRING);
            rebuilt.id = publication.id;
            rebuilt.contentKey = publication.contentKey;
            rebuilt.createdAt = publication.createdAt;
            rebuilt.subtitleOffsetMilliseconds = publication.subtitleOffsetMilliseconds || 0;
            if (rebuilt.selectedSubtitleId !== SUBTITLE_OFF) {
                activity.step(entry, 'loading subtitles',
                    { label: rebuilt.title, detail: describeSubtitleChoice(rebuilt) });
                await attachSubtitleCues(rebuilt);
            }
            activity.succeed(entry, 'ready to play', EMPTY_STRING);
            return rebuilt;
        } catch (error) {
            activity.fail(entry, error.message);
            throw error;
        }
    }

    function contentKeyForResolved(resolved) {
        const isDirectStream = resolved.streamUrl !== undefined && resolved.streamUrl !== EMPTY_STRING;
        const kind = isDirectStream ? KIND_DIRECT : KIND_CINEBY;
        return publications.buildContentKey(kind, resolved.sourceUrl || resolved.title);
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
            resolved.subtitleTracks = [generated];
        } else {
            resolved.subtitleTracks = languages.orderSubtitleTracks(resolved.subtitleTracks || []);
        }
    }

    function chooseSubtitleForSend(subtitleTracks, requestedId, contentKey) {
        if (requestedId !== undefined && requestedId !== null) {
            return String(requestedId);
        }
        const remembered = resumePositions.get(contentKey);
        const rememberedId = remembered === undefined ? EMPTY_STRING : String(remembered.subtitleId || EMPTY_STRING);
        const stillOffered = (subtitleTracks || [])
            .some((track) => track.identifier === rememberedId);
        if (remembered !== undefined && (rememberedId === SUBTITLE_OFF || stillOffered)) {
            return rememberedId;
        }
        return languages.pickDefaultSubtitleId(subtitleTracks || []);
    }

    function buildDirectPublication(resolved, subtitleId, renditionId) {
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
            renditions: resolved.renditions || [],
            selectedRenditionId: renditionId || resolved.selectedRenditionId || EMPTY_STRING,
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
            return buildDirectPublication(resolved, subtitleId, renditionId);
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

    function describeSubtitleChoice(publication) {
        const chosen = (publication.subtitles || [])
            .find((track) => track.id === publication.selectedSubtitleId);
        if (chosen === undefined) {
            return EMPTY_STRING;
        }
        return chosen.language;
    }

    async function loadCuesFor(track) {
        const isLocalFile = track.localPath !== undefined && track.localPath !== EMPTY_STRING;
        if (isLocalFile) {
            track.cues = subtitles.readSidecarCues(track.localPath);
        } else if (track.cues === null || track.cues === undefined) {
            track.cues = await subtitles.fetchCues(track.url);
        }
    }

    // A subtitle track the site has withdrawn must never stop the film from playing.
    // Try the chosen one, then each remaining track in preference order, then give up
    // and play with subtitles off.
    async function attachSubtitleCues(publication) {
        const offered = publication.subtitles || [];
        const chosen = offered.find((track) => track.id === publication.selectedSubtitleId);
        const order = chosen === undefined
            ? offered
            : [chosen].concat(offered.filter((track) => track.id !== chosen.id));
        const refusals = [];
        for (const track of order) {
            try {
                await loadCuesFor(track);
                publication.selectedSubtitleId = track.id;
                publication.subtitleWarning = EMPTY_STRING;
                return;
            } catch (error) {
                refusals.push(`${track.language}: ${error.message}`);
                process.stdout.write(
                    `[subtitles] ${publication.id} could not load ${track.id}: ${error.message}\n`);
            }
        }
        publication.selectedSubtitleId = SUBTITLE_OFF;
        if (refusals.length > 0) {
            publication.subtitleWarning = `no subtitle track would load (${refusals.join('; ')})`;
        } else {
            publication.subtitleWarning = EMPTY_STRING;
        }
    }

    const television = { address: EMPTY_STRING, port: televisionPort, lastSeenAt: 0 };
    let pendingPlayback = null;
    let lastPresenceCheckAt = 0;
    const nowPlaying = { contentKey: EMPTY_STRING, subtitleId: EMPTY_STRING, subtitleOffsetMilliseconds: 0 };

    async function refreshTelevisionPresence() {
        const now = Date.now();
        if (now - lastPresenceCheckAt < PRESENCE_CHECK_INTERVAL_MILLISECONDS) {
            return;
        }
        lastPresenceCheckAt = now;
        const address = await findTelevision();
        if (address === EMPTY_STRING) {
            television.address = EMPTY_STRING;
        }
    }

    function buildBaseUrl() {
        return `http://${runtime.serverAddress}:${configuration.port || 8787}`;
    }

    async function probeTelevision(address) {
        try {
            const response = await (fetchImplementation || fetch)(`http://${address}:${televisionPort}/ping`, {
                signal: AbortSignal.timeout(TELEVISION_PROBE_TIMEOUT_MILLISECONDS)
            });
            if (response.ok === false) {
                return false;
            }
            const payload = await response.json();
            return payload.app === APPLICATION_NAME;
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
            const response = await (fetchImplementation || fetch)(`http://${address}:${televisionPort}/play`, {
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
            maxVideoHeight: TELEVISION_MAXIMUM_HEIGHT,
            subtitles: (publication.subtitles || []).map((track) => ({
                id: track.id,
                language: track.language,
                cuesUrl: `${base}/sub/${publication.id}/${encodeURIComponent(track.id)}.json`
            })),
            selectedSubtitleId: publication.selectedSubtitleId,
            subtitleOffsetMilliseconds: publication.subtitleOffsetMilliseconds || 0,
            subtitleWarning: publication.subtitleWarning || EMPTY_STRING,
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
        nowPlaying.contentKey = contentKey;
        nowPlaying.subtitleId = reportedSubtitleId;
        nowPlaying.subtitleOffsetMilliseconds = reportedOffset;
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
        const isLocalFile = track.localPath !== undefined && track.localPath !== EMPTY_STRING;
        if (isLocalFile || track.cues === null || track.cues === undefined) {
            try {
                if (isLocalFile) {
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
            await (fetchImplementation || fetch)(`http://${television.address}:${televisionPort}/offset`, {
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
        const entry = activity.begin(activityJournal.KIND_RESOLVE, publication.title);
        activity.step(entry, 'checking the subtitles line up', { detail: selected.language });
        try {
            const measured = await synccheck.measureOffset({
                segments: publication.tracks.video.segments,
                cues: selected.cues,
                headers: publication.headers
            });
            if (measured.mismatched) {
                publication.subtitleWarning = 'the audio does not match this subtitle track';
                process.stdout.write(`[sync] ${publication.id}: no alignment found, subtitle likely wrong for this stream\n`);
                activity.succeed(entry, 'the subtitles do not match this audio', selected.language);
            } else if (measured.confident) {
                publication.subtitleOffsetMilliseconds = measured.offsetMilliseconds;
                publication.subtitleWarning = EMPTY_STRING;
                measuredOffsets.set(
                    buildOffsetKey(publication.contentKey, publication.selectedSubtitleId),
                    measured.offsetMilliseconds);
                process.stdout.write(`[sync] ${publication.id}: corrected by ${measured.offsetMilliseconds}ms`
                    + ` (${measured.windows} windows, ${measured.spread.toFixed(2)}s spread)\n`);
                await pushSubtitleOffset(publication);
                activity.succeed(entry, 'subtitles aligned',
                    `${Math.round(measured.offsetMilliseconds / 100) / 10} s`);
            } else {
                process.stdout.write(`[sync] ${publication.id}: inconclusive, leaving the offset alone\n`);
                activity.succeed(entry, 'subtitles left as they are', EMPTY_STRING);
            }
            store.persist();
        } catch (error) {
            process.stdout.write(`[sync] ${publication.id}: verification failed ${error.message}\n`);
            activity.fail(entry, error.message);
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
        const entry = activity.begin(activityJournal.KIND_RESOLVE, pageUrl);
        try {
            const resolved = await resolveMedia(pageUrl, { onStage: activity.reporterFor(entry) });
            resolved.sourceUrl = pageUrl;
            attachGeneratedSubtitle(resolved);
            activity.succeed(entry, 'ready to play', resolved.title);
            const offerId = publications.buildPublicationId(pageUrl);
            resolvedOffers.set(offerId, resolved);
            const contentKey = contentKeyForResolved(resolved);
            const resume = resumePositions.get(contentKey) || null;
            sendJson(response, HTTP_OK, {
                ok: true,
                offerId,
                title: resolved.title,
                durationSeconds: resolved.totalDurationSeconds || 0,
                quality: resolved.quality || EMPTY_STRING,
                provider: resolved.provider || EMPTY_STRING,
                resumeMilliseconds: resume === null ? 0 : resume.positionMilliseconds,
                subtitles: (resolved.subtitleTracks || []).map((track) => ({
                    id: track.identifier,
                    language: track.language
                }))
            });
        } catch (error) {
            activity.fail(entry, error.message);
            sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
        }
    }

    async function deliverPayload(response, payload, entry) {
        activity.step(entry, 'sending to the tv', { label: payload.title });
        const delivery = await pushToTelevision(payload);
        activity.succeed(entry,
            delivery.delivered ? 'playing on the tv' : 'waiting for the tv',
            delivery.reason);
        sendJson(response, HTTP_OK, Object.assign({ ok: true }, payload, delivery));
    }

    async function sendLibraryItem(response, itemIdentifier) {
        const item = findLibraryItem(itemIdentifier);
        if (item === null) {
            sendJson(response, HTTP_NOT_FOUND, { ok: false, error: 'unknown library item' });
        } else {
            const entry = activity.begin(activityJournal.KIND_RESOLVE, item.title);
            await deliverPayload(response, buildLibraryPayload(item), entry);
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
            const entry = activity.begin(activityJournal.KIND_RESOLVE, publication.title);
            await deliverPayload(response, buildPlaybackPayload(publication), entry);
        }
    }

    async function publishAndPush(response, resolved, subtitleId, collection, entry) {
        try {
            const publication = buildPublicationFromResolved(resolved, subtitleId, EMPTY_STRING);
            publication.id = publications.buildPublicationId(resolved.sourceUrl);
            if (subtitleId !== SUBTITLE_OFF) {
                activity.step(entry, 'loading subtitles',
                    { label: publication.title, detail: describeSubtitleChoice(publication) });
                await attachSubtitleCues(publication);
            }
            const cachedOffset = measuredOffsets.get(
                buildOffsetKey(publication.contentKey, publication.selectedSubtitleId));
            const hasCachedOffset = cachedOffset !== undefined;
            if (hasCachedOffset) {
                publication.subtitleOffsetMilliseconds = cachedOffset;
            }
            store.put(publication);
            rememberLink(publication.sourceUrl, publication.title, collection);
            const payload = buildPlaybackPayload(publication);
            activity.step(entry, 'sending to the tv',
                { label: publication.title, detail: EMPTY_STRING });
            const delivery = await pushToTelevision(payload);
            store.persist();
            activity.succeed(entry,
                delivery.delivered ? 'playing on the tv' : 'waiting for the tv',
                delivery.reason);
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
            activity.fail(entry, error.message);
            sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
        }
    }

    async function handleSendResolvedOffer(response, body) {
        const offerId = String(body.offerId || EMPTY_STRING);
        const resolved = resolvedOffers.get(offerId);
        if (resolved === undefined) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'that link was not resolved recently, send it again' });
            return;
        }
        const entry = activity.begin(activityJournal.KIND_RESOLVE, resolved.title || offerId);
        const subtitleId = chooseSubtitleForSend(
            resolved.subtitleTracks, body.subtitleId, contentKeyForResolved(resolved));
        await publishAndPush(response, resolved, subtitleId, body.collection, entry);
    }

    async function handleSendByUrl(response, pageUrl, body) {
        const entry = activity.begin(activityJournal.KIND_RESOLVE, pageUrl);
        let resolved = null;
        try {
            resolved = await resolveMedia(pageUrl, { onStage: activity.reporterFor(entry) });
            resolved.sourceUrl = pageUrl;
            attachGeneratedSubtitle(resolved);
        } catch (error) {
            activity.fail(entry, error.message);
            sendJson(response, HTTP_SERVER_ERROR, { ok: false, error: error.message });
            return;
        }
        resolvedOffers.set(publications.buildPublicationId(pageUrl), resolved);
        const subtitleId = chooseSubtitleForSend(
            resolved.subtitleTracks, body.subtitleId, contentKeyForResolved(resolved));
        await publishAndPush(response, resolved, subtitleId, body.collection, entry);
    }

    async function handleSend(request, response) {
        const body = await readRequestBody(request);
        if (body.ok === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'body was not valid JSON' });
            return;
        }
        const publicationId = String(body.value.publicationId || EMPTY_STRING);
        const pageUrl = String(body.value.url || EMPTY_STRING).trim();
        if (publicationId.startsWith(FILE_PREFIX)) {
            await sendLibraryItem(response, publicationId.slice(FILE_PREFIX.length));
        } else if (publicationId !== EMPTY_STRING) {
            await sendPublishedItem(response, publicationId);
        } else if (/^https?:\/\//i.test(pageUrl)) {
            await handleSendByUrl(response, pageUrl, body.value);
        } else {
            await handleSendResolvedOffer(response, body.value);
        }
    }

    async function handleRequest(request, response, url) {
        const pathName = url.pathname;

        if (pathName === '/api/hello') {
            sendJson(response, HTTP_OK, {
                name: APPLICATION_NAME,
                version: 3,
                serverBaseUrl: buildBaseUrl()
            });
            return true;
        }

        if (pathName === '/api/activity') {
            sendJson(response, HTTP_OK, activity.snapshot());
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
            await refreshTelevisionPresence();
            sendJson(response, HTTP_OK, {
                address: television.address,
                port: television.port,
                lastSeenAt: television.lastSeenAt,
                hasPending: pendingPlayback !== null
            });
            return true;
        }

        if (pathName === '/api/subtitle-offset' && request.method === 'POST') {
            const body = await readRequestBody(request);
            if (body.ok === false || nowPlaying.contentKey === EMPTY_STRING) {
                sendJson(response, HTTP_BAD_REQUEST,
                    { ok: false, error: 'nothing is playing on the tv yet' });
            } else {
                const delta = Number(body.value.deltaMilliseconds) || 0;
                nowPlaying.subtitleOffsetMilliseconds += delta;
                measuredOffsets.set(
                    buildOffsetKey(nowPlaying.contentKey, nowPlaying.subtitleId),
                    nowPlaying.subtitleOffsetMilliseconds);
                store.persist();
                await pushSubtitleOffset({
                    contentKey: nowPlaying.contentKey,
                    subtitleOffsetMilliseconds: nowPlaying.subtitleOffsetMilliseconds
                });
                sendJson(response, HTTP_OK,
                    { ok: true, subtitleOffsetMilliseconds: nowPlaying.subtitleOffsetMilliseconds });
            }
            return true;
        }

        if (pathName === '/api/links' && request.method === 'POST') {
            const body = await readRequestBody(request);
            const pageUrl = body.ok ? String(body.value.url || EMPTY_STRING).trim() : EMPTY_STRING;
            if (/^https?:\/\//i.test(pageUrl) === false) {
                sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'url must be an http or https link' });
            } else {
                rememberLink(pageUrl, String(body.value.title || pageUrl), body.value.collection);
                store.persist();
                sendJson(response, HTTP_OK, { ok: true, count: sentLinks.size });
            }
            return true;
        }

        if (pathName === '/api/links') {
            sendJson(response, HTTP_OK, { items: listLinks(url.searchParams.get('collection')) });
            return true;
        }

        if (pathName === '/api/collections') {
            sendJson(response, HTTP_OK, { items: listCollections() });
            return true;
        }

        if (pathName.startsWith('/api/links/') && request.method === 'DELETE') {
            const target = decodeURIComponent(pathName.slice('/api/links/'.length));
            if (sentLinks.delete(target)) {
                store.persist();
                sendJson(response, HTTP_OK, { ok: true });
            } else {
                sendJson(response, HTTP_NOT_FOUND, { ok: false, error: 'that link was already gone' });
            }
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
        activity,
        buildPlaybackPayload,
        buildPublicationFromResolved,
        chooseSubtitleForSend,
        rememberProgress,
        rememberLink,
        listLinks,
        listCollections,
        resumePositions,
        resolvedOffers
    };
}

module.exports = { createTelevisionApi };
