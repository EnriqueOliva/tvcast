const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const cineby = require('./cineby');
const embeds = require('./embeds');

const YT_DLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp.exe');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const RESOLVE_TIMEOUT_MILLISECONDS = 45000;
const EMBEDDED_RESOLVE_TIMEOUT_MILLISECONDS = 30000;
const DIRECT_PROBE_TIMEOUT_MILLISECONDS = 8000;
const TELEVISION_MAXIMUM_HEIGHT = 1080;
const NO_HEIGHT = 0;
const FIRST_INDEX = 0;
const EMPTY_STRING = '';
const STREAM_KIND_HLS = 'hls';
const STREAM_KIND_FILE = 'file';
const STREAM_KIND_SPLIT = 'split';
const HLS_EXTENSION_PATTERN = /\.m3u8(\?|$)/i;
const HLS_CONTENT_TYPES = [
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'application/mpegurl',
    'audio/mpegurl',
    'audio/x-mpegurl'
];
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ILLEGAL_FILENAME_PATTERN = /[\\/:*?"<>|]/g;
const FILENAME_REPLACEMENT = '';
const DOWNLOAD_FAILURE_CODE = 1;
const MIME_TYPE_BY_EXTENSION = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    ts: 'video/mp2t',
    flv: 'video/x-flv'
};

function loadConfiguration() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        void error;
        return {};
    }
}

function reportNothing() {
    return null;
}

function buildCommonArguments(overrides) {
    const configuration = loadConfiguration();
    const settings = Object.assign({
        cookiesFromBrowser: configuration.ytdlpCookiesFromBrowser || '',
        impersonate: configuration.ytdlpImpersonate || '',
        extraArguments: configuration.ytdlpExtraArgs || []
    }, overrides || {});

    // yt-dlp writes stdout in the Windows ANSI codepage unless told otherwise, which turns
    // every accented title into replacement characters.
    const argumentList = ['--no-warnings', '--no-playlist', '--encoding', 'UTF-8'];
    if (settings.cookiesFromBrowser !== '') {
        argumentList.push('--cookies-from-browser', settings.cookiesFromBrowser);
    }
    if (settings.impersonate !== '') {
        argumentList.push('--impersonate', settings.impersonate);
    }
    for (const extra of settings.extraArguments) {
        argumentList.push(extra);
    }
    return argumentList;
}

function runYtDlp(argumentList, timeoutMilliseconds) {
    return new Promise((resolve, reject) => {
        const child = spawn(YT_DLP_PATH, argumentList, { windowsHide: true });
        let standardOutput = '';
        let standardError = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('yt-dlp timed out'));
        }, timeoutMilliseconds || RESOLVE_TIMEOUT_MILLISECONDS);

        child.stdout.on('data', (chunk) => { standardOutput += chunk.toString(); });
        child.stderr.on('data', (chunk) => { standardError += chunk.toString(); });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(standardOutput);
            } else {
                reject(new Error(standardError.trim().split('\n').slice(-3).join(' ') || `yt-dlp exited ${code}`));
            }
        });
    });
}

function looksLikeHlsUrl(url) {
    return HLS_EXTENSION_PATTERN.test(String(url || EMPTY_STRING));
}

function looksLikeHlsContentType(contentType) {
    return HLS_CONTENT_TYPES.some((candidate) => contentType.startsWith(candidate));
}

function buildDirectStream(settings) {
    return {
        title: settings.title,
        totalDurationSeconds: settings.durationSeconds || 0,
        durationSeconds: settings.durationSeconds || 0,
        quality: settings.quality || EMPTY_STRING,
        provider: settings.provider || 'direct link',
        width: settings.width || 0,
        height: settings.height || 0,
        streamUrl: settings.streamUrl,
        audioStreamUrl: settings.audioStreamUrl || EMPTY_STRING,
        streamKind: settings.streamKind,
        httpHeaders: settings.httpHeaders || {},
        subtitleTracks: settings.subtitleTracks || [],
        renditions: settings.renditions || [],
        selectedRenditionId: settings.selectedRenditionId || EMPTY_STRING,
        videoTrack: null,
        audioTrack: null,
        headers: {}
    };
}

function titleFromUrl(url) {
    try {
        const name = decodeURIComponent(path.basename(new URL(url).pathname));
        if (name !== EMPTY_STRING && name !== '/') {
            return name.replace(/\.[a-z0-9]{2,5}$/i, EMPTY_STRING) || 'Direct stream';
        }
    } catch (error) {
        void error;
    }
    return 'Direct stream';
}

function buildProbeHeaders(extraHeaders) {
    return Object.assign({ 'User-Agent': BROWSER_USER_AGENT }, extraHeaders || {});
}

async function requestMediaHeaders(url, extraHeaders) {
    const headers = buildProbeHeaders(extraHeaders);
    const head = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers,
        signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MILLISECONDS)
    });
    if (head.ok) {
        return head;
    }
    return fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: Object.assign({ Range: 'bytes=0-0' }, headers),
        signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MILLISECONDS)
    });
}

async function probeDirectMedia(url, settings) {
    const options = settings || {};
    try {
        const response = await requestMediaHeaders(url, options.httpHeaders);
        const contentType = (response.headers.get('content-type') || EMPTY_STRING).toLowerCase();
        const isHls = looksLikeHlsContentType(contentType) || looksLikeHlsUrl(url);
        const isMedia = contentType.startsWith('video/')
            || contentType.startsWith('audio/')
            || contentType === 'application/octet-stream';
        if (response.ok && (isHls || isMedia)) {
            if (response.body !== null && response.body !== undefined) {
                response.body.cancel().catch(() => null);
            }
            return buildDirectStream({
                title: options.title || titleFromUrl(url),
                provider: options.provider || 'direct link',
                streamUrl: response.url || url,
                streamKind: isHls ? STREAM_KIND_HLS : STREAM_KIND_FILE,
                httpHeaders: options.httpHeaders || {},
                selectedRenditionId: String(TELEVISION_MAXIMUM_HEIGHT)
            });
        }
    } catch (error) {
        void error;
    }
    return null;
}

function collectYtDlpSubtitles(info) {
    const collected = [];
    const available = info.subtitles || {};
    for (const languageCode of Object.keys(available)) {
        const entries = Array.isArray(available[languageCode]) ? available[languageCode] : [];
        const preferred = entries.find((entry) => entry.ext === 'vtt')
            || entries.find((entry) => entry.ext === 'srt')
            || entries[0];
        if (preferred !== undefined && preferred.url) {
            collected.push({
                identifier: languageCode.toLowerCase().replace(/[^a-z0-9]/g, EMPTY_STRING),
                language: preferred.name || languageCode,
                url: preferred.url
            });
        }
    }
    return collected;
}

function collectVideoHeights(formats) {
    const heights = new Set();
    for (const format of formats) {
        const carriesVideo = format.vcodec !== undefined && format.vcodec !== 'none';
        if (carriesVideo && format.height > 0) {
            heights.add(format.height);
        }
    }
    return Array.from(heights).sort((left, right) => right - left);
}

function pickHeightWithinCeiling(heights, ceilingHeight) {
    const withinCeiling = heights.filter((height) => height <= ceilingHeight);
    if (withinCeiling.length > 0) {
        return Math.max.apply(null, withinCeiling);
    }
    if (heights.length > 0) {
        return Math.min.apply(null, heights);
    }
    return NO_HEIGHT;
}

function pickHlsManifest(info, formats) {
    if (typeof info.manifest_url === 'string' && info.manifest_url !== EMPTY_STRING) {
        return info.manifest_url;
    }
    for (const format of formats) {
        const usesHls = String(format.protocol || EMPTY_STRING).startsWith('m3u8');
        if (usesHls && typeof format.manifest_url === 'string' && format.manifest_url !== EMPTY_STRING) {
            return format.manifest_url;
        }
    }
    return EMPTY_STRING;
}

function isProgressiveFormat(format) {
    const protocol = format.protocol || '';
    const usesPlainHttp = protocol === 'https' || protocol === 'http';
    return usesPlainHttp && format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none';
}

function scoreFormat(format) {
    return (format.height || 0) * 1000 + (format.tbr || 0);
}

function chooseWithinCeiling(candidates, ceilingHeight) {
    if (candidates.length === 0) {
        return null;
    }
    const withinCeiling = candidates.filter((format) => (format.height || NO_HEIGHT) <= ceilingHeight);
    if (withinCeiling.length > 0) {
        const ordered = withinCeiling.slice().sort((left, right) => scoreFormat(right) - scoreFormat(left));
        return ordered[FIRST_INDEX];
    }
    const aboveCeiling = candidates.slice()
        .sort((left, right) => (left.height || NO_HEIGHT) - (right.height || NO_HEIGHT));
    return aboveCeiling[FIRST_INDEX];
}

function pickProgressive(formats) {
    return chooseWithinCeiling(formats.filter(isProgressiveFormat), TELEVISION_MAXIMUM_HEIGHT);
}

function pickSplitPair(formats) {
    const videoCandidates = formats.filter((format) => format.vcodec && format.vcodec !== 'none'
        && (format.acodec === 'none' || !format.acodec)
        && (format.protocol === 'https' || format.protocol === 'http'));
    const audioCandidates = formats.filter((format) => format.acodec && format.acodec !== 'none'
        && (format.vcodec === 'none' || !format.vcodec)
        && (format.protocol === 'https' || format.protocol === 'http'));
    audioCandidates.sort((left, right) => (right.abr || 0) - (left.abr || 0));
    const video = chooseWithinCeiling(videoCandidates, TELEVISION_MAXIMUM_HEIGHT);
    if (video !== null && audioCandidates.length > 0) {
        return { video, audio: audioCandidates[FIRST_INDEX] };
    }
    return null;
}

function describeHeight(height) {
    if (height > NO_HEIGHT) {
        return `${height}p`;
    }
    return EMPTY_STRING;
}

function buildStreamFromInfo(info, pageUrl) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const title = info.title || titleFromUrl(pageUrl);
    const durationSeconds = Math.floor(Number(info.duration) || 0);
    const subtitleTracks = collectYtDlpSubtitles(info);
    const provider = info.extractor_key || info.extractor || 'direct link';

    const manifestUrl = pickHlsManifest(info, formats);
    if (manifestUrl !== EMPTY_STRING) {
        const chosenHeight = pickHeightWithinCeiling(collectVideoHeights(formats), TELEVISION_MAXIMUM_HEIGHT);
        return buildDirectStream({
            title,
            durationSeconds,
            provider,
            quality: describeHeight(chosenHeight),
            height: chosenHeight,
            streamUrl: manifestUrl,
            streamKind: STREAM_KIND_HLS,
            httpHeaders: info.http_headers || {},
            subtitleTracks,
            selectedRenditionId: String(chosenHeight > NO_HEIGHT ? chosenHeight : TELEVISION_MAXIMUM_HEIGHT)
        });
    }

    const progressive = pickProgressive(formats);
    const pair = pickSplitPair(formats);
    const progressiveHeight = progressive === null ? NO_HEIGHT : (progressive.height || NO_HEIGHT);
    const pairHeight = pair === null ? NO_HEIGHT : (pair.video.height || NO_HEIGHT);
    if (pair !== null && pairHeight > progressiveHeight) {
        return buildDirectStream({
            title,
            durationSeconds,
            provider,
            quality: describeHeight(pairHeight),
            width: pair.video.width || 0,
            height: pairHeight,
            streamUrl: pair.video.url,
            audioStreamUrl: pair.audio.url,
            streamKind: STREAM_KIND_SPLIT,
            httpHeaders: pair.video.http_headers || info.http_headers || {},
            subtitleTracks
        });
    }

    if (progressive !== null) {
        return buildDirectStream({
            title,
            durationSeconds,
            provider,
            quality: describeHeight(progressiveHeight),
            width: progressive.width || 0,
            height: progressiveHeight,
            streamUrl: progressive.url,
            streamKind: looksLikeHlsUrl(progressive.url) ? STREAM_KIND_HLS : STREAM_KIND_FILE,
            httpHeaders: progressive.http_headers || info.http_headers || {},
            subtitleTracks
        });
    }

    if (info.url) {
        return buildDirectStream({
            title,
            durationSeconds,
            provider,
            quality: describeHeight(info.height || NO_HEIGHT),
            width: info.width || 0,
            height: info.height || NO_HEIGHT,
            streamUrl: info.url,
            streamKind: looksLikeHlsUrl(info.url) ? STREAM_KIND_HLS : STREAM_KIND_FILE,
            httpHeaders: info.http_headers || {},
            subtitleTracks
        });
    }

    return null;
}

async function resolveWithExtractor(pageUrl, timeoutMilliseconds) {
    const rawJson = await runYtDlp(
        buildCommonArguments().concat(['-J', '--no-check-certificate', pageUrl]),
        timeoutMilliseconds);
    const stream = buildStreamFromInfo(JSON.parse(rawJson), pageUrl);
    if (stream === null) {
        throw new Error('No playable stream found for that link');
    }
    return stream;
}

async function probeEveryCandidate(mediaUrls, pageUrl, pageTitle) {
    for (const mediaUrl of mediaUrls) {
        const found = await probeDirectMedia(mediaUrl, {
            title: pageTitle === EMPTY_STRING ? titleFromUrl(pageUrl) : pageTitle,
            provider: new URL(pageUrl).hostname,
            httpHeaders: { Referer: pageUrl, 'User-Agent': BROWSER_USER_AGENT }
        });
        if (found !== null) {
            return found;
        }
    }
    return null;
}

async function resolveThroughEmbeds(pageUrl, fetchImplementation, onStage) {
    const reportStage = onStage || reportNothing;
    let page = null;
    try {
        page = await embeds.inspectPage(pageUrl, fetchImplementation);
    } catch (error) {
        void error;
        return null;
    }

    reportStage('looking inside the page', {
        label: page.title === EMPTY_STRING ? undefined : page.title,
        detail: `${page.mediaUrls.length} video links, ${page.frameUrls.length} embedded players`
    });
    const direct = await probeEveryCandidate(page.mediaUrls, pageUrl, page.title);
    if (direct !== null) {
        return direct;
    }

    let frameNumber = FIRST_INDEX;
    for (const frameUrl of page.frameUrls) {
        frameNumber += 1;
        reportStage('opening the embedded player', {
            detail: `player ${frameNumber} of ${page.frameUrls.length}`
        });
        try {
            const extracted = await resolveWithExtractor(frameUrl, EMBEDDED_RESOLVE_TIMEOUT_MILLISECONDS);
            if (page.title !== EMPTY_STRING) {
                extracted.title = page.title;
            }
            return extracted;
        } catch (error) {
            void error;
        }
        let frame = null;
        try {
            frame = await embeds.inspectPage(frameUrl, fetchImplementation);
        } catch (error) {
            void error;
        }
        if (frame !== null) {
            const fromFrame = await probeEveryCandidate(frame.mediaUrls, frameUrl,
                page.title === EMPTY_STRING ? frame.title : page.title);
            if (fromFrame !== null) {
                return fromFrame;
            }
        }
    }
    return null;
}

async function resolveMedia(pageUrl, options) {
    const settings = options || {};
    const reportStage = settings.onStage || reportNothing;

    if (cineby.isCinebyUrl(pageUrl)) {
        return cineby.resolveCineby(pageUrl, { onStage: reportStage });
    }

    reportStage('checking if that is a video link');
    const direct = await probeDirectMedia(pageUrl);
    if (direct !== null) {
        return direct;
    }

    const fetchImplementation = settings.fetchImplementation;
    let extractorFailure = null;
    reportStage('reading the page with yt-dlp');
    try {
        return await resolveWithExtractor(pageUrl, RESOLVE_TIMEOUT_MILLISECONDS);
    } catch (error) {
        extractorFailure = error;
    }

    reportStage('looking inside the page');
    const embedded = await resolveThroughEmbeds(pageUrl, fetchImplementation, reportStage);
    if (embedded !== null) {
        return embedded;
    }
    throw extractorFailure;
}

function attachDownloadProgress(child, onProgress) {
    let lastLine = '';
    child.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
            if (line.trim() !== '') {
                lastLine = line.trim();
                const percentMatch = /\[download\]\s+([\d.]+)%/.exec(line);
                if (percentMatch) {
                    onProgress({ percent: Number(percentMatch[1]), line: lastLine });
                } else {
                    onProgress({ line: lastLine });
                }
            }
        }
    });
    child.stderr.on('data', (chunk) => { onProgress({ line: chunk.toString().trim() }); });
}

function buildDownloadArguments(targetDirectory, outputTemplate, mediaUrl, extraArguments) {
    return buildCommonArguments().concat([
        '--newline',
        '--restrict-filenames',
        '-f', 'bv*+ba/b',
        '--merge-output-format', 'mkv',
        '-o', path.join(targetDirectory, outputTemplate)
    ], extraArguments, [mediaUrl]);
}

function startCinebyDownload(pageUrl, targetDirectory, onProgress) {
    const facade = new EventEmitter();
    let child = null;
    let stopped = false;

    facade.kill = (signal) => {
        stopped = true;
        if (child !== null) {
            child.kill(signal);
        }
    };

    onProgress({ line: 'resolving the cineby link' });
    cineby.resolveCineby(pageUrl).then((resolved) => {
        if (stopped === false) {
            const safeTitle = resolved.title.replace(ILLEGAL_FILENAME_PATTERN, FILENAME_REPLACEMENT);
            const argumentList = buildDownloadArguments(
                targetDirectory,
                `${safeTitle}.%(ext)s`,
                resolved.hlsUrl,
                ['--user-agent', cineby.BROWSER_USER_AGENT, '--referer', `${cineby.CINEBY_ORIGIN}/`]
            );
            child = spawn(YT_DLP_PATH, argumentList, { windowsHide: true });
            attachDownloadProgress(child, onProgress);
            child.on('close', (code) => { facade.emit('close', code); });
            child.on('error', (error) => {
                onProgress({ line: error.message });
                facade.emit('close', DOWNLOAD_FAILURE_CODE);
            });
        }
    }).catch((error) => {
        onProgress({ line: error.message });
        facade.emit('close', DOWNLOAD_FAILURE_CODE);
    });

    return facade;
}

function startDownload(pageUrl, targetDirectory, onProgress) {
    if (cineby.isCinebyUrl(pageUrl)) {
        return startCinebyDownload(pageUrl, targetDirectory, onProgress);
    }
    const argumentList = buildDownloadArguments(targetDirectory, '%(title)s.%(ext)s', pageUrl, []);
    const child = spawn(YT_DLP_PATH, argumentList, { windowsHide: true });
    attachDownloadProgress(child, onProgress);
    return child;
}

const DIAGNOSTIC_TIMEOUT_MILLISECONDS = 60000;

function summariseFailure(message) {
    const text = String(message || '');
    if (/403|forbidden/i.test(text)) {
        return 'blocked (HTTP 403)';
    } else if (/429|rate.?limit/i.test(text)) {
        return 'rate limited';
    } else if (/captcha|challenge|cloudflare|just a moment|bot/i.test(text)) {
        return 'bot challenge';
    } else if (/sign in|login|account|cookies/i.test(text)) {
        return 'needs a logged-in session';
    } else if (/unsupported url|no video|generic/i.test(text)) {
        return 'no extractor for this site';
    } else if (/timed out/i.test(text)) {
        return 'timed out';
    } else if (/drm|widevine|encrypted/i.test(text)) {
        return 'DRM protected';
    } else {
        return 'failed';
    }
}

async function attemptResolve(pageUrl, label, overrides) {
    const startedAt = Date.now();
    try {
        const rawJson = await runYtDlp(
            buildCommonArguments(overrides).concat(['-J', '--no-check-certificate', pageUrl]),
            DIAGNOSTIC_TIMEOUT_MILLISECONDS
        );
        const info = JSON.parse(rawJson);
        const formats = Array.isArray(info.formats) ? info.formats : [];
        const best = pickProgressive(formats) || (pickSplitPair(formats) || {}).video || null;
        return {
            label,
            ok: true,
            extractor: info.extractor_key || info.extractor || 'unknown',
            title: info.title || '',
            formatCount: formats.length,
            bestHeight: best ? (best.height || 0) : 0,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000)
        };
    } catch (error) {
        return {
            label,
            ok: false,
            reason: summariseFailure(error.message),
            detail: String(error.message || '').slice(0, 400),
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000)
        };
    }
}

async function diagnoseUrl(pageUrl, cookieBrowser) {
    if (cineby.isCinebyUrl(pageUrl)) {
        return cineby.diagnoseCineby(pageUrl);
    }

    const browser = cookieBrowser || loadConfiguration().ytdlpCookiesFromBrowser || 'firefox';
    const attempts = [
        { label: 'plain', overrides: { cookiesFromBrowser: '', impersonate: '', extraArguments: [] } },
        { label: 'impersonate chrome', overrides: { cookiesFromBrowser: '', impersonate: 'chrome', extraArguments: [] } },
        { label: `cookies from ${browser}`, overrides: { cookiesFromBrowser: browser, impersonate: '', extraArguments: [] } },
        { label: `cookies + impersonate`, overrides: { cookiesFromBrowser: browser, impersonate: 'chrome', extraArguments: [] } }
    ];
    const results = [];
    let unsupportedSite = false;
    for (const attempt of attempts) {
        const outcome = await attemptResolve(pageUrl, attempt.label, attempt.overrides);
        results.push(outcome);
        if (outcome.ok) {
            break;
        }
        if (/unsupported url/i.test(outcome.detail || '')) {
            unsupportedSite = true;
            break;
        }
    }
    const winner = results.find((entry) => entry.ok) || null;
    const verdict = winner ? 'works'
        : unsupportedSite ? 'no-extractor'
        : 'blocked';
    return { url: pageUrl, results, winner, verdict, unsupportedSite };
}

module.exports = {
    resolveMedia,
    resolveThroughEmbeds,
    buildCommonArguments,
    buildDownloadArguments,
    buildStreamFromInfo,
    chooseWithinCeiling,
    pickHeightWithinCeiling,
    pickProgressive,
    pickSplitPair,
    startDownload,
    diagnoseUrl,
    YT_DLP_PATH,
    TELEVISION_MAXIMUM_HEIGHT
};
