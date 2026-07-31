const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const cineby = require('./cineby');

const YT_DLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp.exe');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const RESOLVE_TIMEOUT_MILLISECONDS = 45000;
const DIRECT_PROBE_TIMEOUT_MILLISECONDS = 8000;
const MAXIMUM_REMUX_HEIGHT = 1080;
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

function buildCommonArguments(overrides) {
    const configuration = loadConfiguration();
    const settings = Object.assign({
        cookiesFromBrowser: configuration.ytdlpCookiesFromBrowser || '',
        impersonate: configuration.ytdlpImpersonate || '',
        extraArguments: configuration.ytdlpExtraArgs || []
    }, overrides || {});

    const argumentList = ['--no-warnings', '--no-playlist'];
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
        renditions: [],
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

async function probeDirectMedia(url) {
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MILLISECONDS)
        });
        const contentType = (response.headers.get('content-type') || EMPTY_STRING).toLowerCase();
        const isHls = looksLikeHlsContentType(contentType) || looksLikeHlsUrl(url);
        const isMedia = contentType.startsWith('video/')
            || contentType.startsWith('audio/')
            || contentType === 'application/octet-stream';
        if (response.ok && (isHls || isMedia)) {
            return buildDirectStream({
                title: titleFromUrl(url),
                streamUrl: response.url || url,
                streamKind: isHls ? STREAM_KIND_HLS : STREAM_KIND_FILE
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

function pickProgressive(formats) {
    const candidates = formats.filter(isProgressiveFormat);
    candidates.sort((left, right) => scoreFormat(right) - scoreFormat(left));
    if (candidates.length > 0) {
        return candidates[0];
    }
    return null;
}

function pickSplitPair(formats) {
    const videoCandidates = formats.filter((format) => format.vcodec && format.vcodec !== 'none'
        && (format.acodec === 'none' || !format.acodec)
        && (format.height || 0) <= MAXIMUM_REMUX_HEIGHT
        && (format.protocol === 'https' || format.protocol === 'http'));
    const audioCandidates = formats.filter((format) => format.acodec && format.acodec !== 'none'
        && (format.vcodec === 'none' || !format.vcodec)
        && (format.protocol === 'https' || format.protocol === 'http'));
    videoCandidates.sort((left, right) => scoreFormat(right) - scoreFormat(left));
    audioCandidates.sort((left, right) => (right.abr || 0) - (left.abr || 0));
    if (videoCandidates.length > 0 && audioCandidates.length > 0) {
        return { video: videoCandidates[0], audio: audioCandidates[0] };
    }
    return null;
}

async function resolveMedia(pageUrl) {
    if (cineby.isCinebyUrl(pageUrl)) {
        return cineby.resolveCineby(pageUrl);
    }

    const direct = await probeDirectMedia(pageUrl);
    if (direct !== null) {
        return direct;
    }

    const rawJson = await runYtDlp(buildCommonArguments().concat(['-J', '--no-check-certificate', pageUrl]));
    const info = JSON.parse(rawJson);
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const title = info.title || titleFromUrl(pageUrl);
    const durationSeconds = Math.floor(Number(info.duration) || 0);
    const subtitleTracks = collectYtDlpSubtitles(info);
    const provider = info.extractor_key || info.extractor || 'direct link';

    const manifestUrl = pickHlsManifest(info, formats);
    if (manifestUrl !== EMPTY_STRING) {
        return buildDirectStream({
            title,
            durationSeconds,
            provider,
            streamUrl: manifestUrl,
            streamKind: STREAM_KIND_HLS,
            httpHeaders: info.http_headers || {},
            subtitleTracks
        });
    }

    const progressive = pickProgressive(formats);
    const pair = pickSplitPair(formats);
    const progressiveHeight = progressive === null ? 0 : (progressive.height || 0);
    const pairHeight = pair === null ? 0 : (pair.video.height || 0);
    if (pair !== null && pairHeight > progressiveHeight) {
        return buildDirectStream({
            title,
            durationSeconds,
            provider,
            quality: `${pairHeight}p`,
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
            quality: progressive.height ? `${progressive.height}p` : EMPTY_STRING,
            width: progressive.width || 0,
            height: progressive.height || 0,
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
            quality: info.height ? `${info.height}p` : EMPTY_STRING,
            width: info.width || 0,
            height: info.height || 0,
            streamUrl: info.url,
            streamKind: looksLikeHlsUrl(info.url) ? STREAM_KIND_HLS : STREAM_KIND_FILE,
            httpHeaders: info.http_headers || {},
            subtitleTracks
        });
    }

    throw new Error('No playable stream found for that link');
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

module.exports = { resolveMedia, startDownload, diagnoseUrl, YT_DLP_PATH };
