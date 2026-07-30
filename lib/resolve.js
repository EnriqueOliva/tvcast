const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const cineby = require('./cineby');

const YT_DLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp.exe');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const RESOLVE_TIMEOUT_MILLISECONDS = 45000;
const DIRECT_PROBE_TIMEOUT_MILLISECONDS = 8000;
const QUALITY_GAIN_THRESHOLD = 360;
const MAXIMUM_REMUX_HEIGHT = 1080;
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

async function probeDirectMedia(url) {
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MILLISECONDS)
        });
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (response.ok && (contentType.startsWith('video/') || contentType.startsWith('audio/') || contentType === 'application/octet-stream')) {
            return {
                title: decodeURIComponent(path.basename(new URL(url).pathname)) || 'Direct stream',
                mimeType: contentType.startsWith('video/') || contentType.startsWith('audio/') ? contentType : 'video/mp4',
                progressiveUrl: response.url || url,
                headers: {},
                durationSeconds: 0,
                supportsRanges: (response.headers.get('accept-ranges') || '').includes('bytes'),
                videoOnlyUrl: '',
                audioOnlyUrl: ''
            };
        }
    } catch (error) {
        void error;
    }
    return null;
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
    const title = info.title || 'Cast stream';
    const durationSeconds = Math.floor(Number(info.duration) || 0);

    const progressive = pickProgressive(formats);
    const pair = pickSplitPair(formats);
    const progressiveHeight = progressive ? (progressive.height || 0) : 0;
    const pairHeight = pair ? (pair.video.height || 0) : 0;
    const remuxIsWorthIt = pair !== null && pairHeight >= progressiveHeight + QUALITY_GAIN_THRESHOLD;

    if (progressive !== null && remuxIsWorthIt === false) {
        return {
            title,
            mimeType: MIME_TYPE_BY_EXTENSION[progressive.ext] || 'video/mp4',
            progressiveUrl: progressive.url,
            headers: progressive.http_headers || info.http_headers || {},
            durationSeconds,
            supportsRanges: true,
            videoOnlyUrl: '',
            audioOnlyUrl: '',
            height: progressiveHeight
        };
    }

    if (pair !== null) {
        return {
            title,
            mimeType: 'video/mp2t',
            progressiveUrl: '',
            headers: pair.video.http_headers || info.http_headers || {},
            durationSeconds,
            supportsRanges: false,
            videoOnlyUrl: pair.video.url,
            audioOnlyUrl: pair.audio.url,
            height: pairHeight
        };
    }

    if (info.url) {
        return {
            title,
            mimeType: MIME_TYPE_BY_EXTENSION[info.ext] || 'video/mp4',
            progressiveUrl: info.url,
            headers: info.http_headers || {},
            durationSeconds,
            supportsRanges: true,
            videoOnlyUrl: '',
            audioOnlyUrl: '',
            height: info.height || 0
        };
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
