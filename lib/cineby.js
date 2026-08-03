const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const SHARED_TMDB_API_KEY = '269890f657dddf4635473cf4cf456576';
const VIDEASY_API_BASE = 'https://api.speedracelight.com';
const DECRYPT_ENDPOINT = 'https://enc-dec.app/api/dec-videasy';
const CINEBY_ORIGIN = 'https://www.cineby.at';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const SEED_ATTEMPTS = 4;
const SEED_RETRY_MILLISECONDS = 1200;
const SEED_DEFAULT_TTL_MILLISECONDS = 30000;
const SEED_SAFETY_MARGIN_MILLISECONDS = 5000;
const METADATA_TIMEOUT_MILLISECONDS = 12000;
const SOURCES_TIMEOUT_MILLISECONDS = 25000;
const DECRYPT_TIMEOUT_MILLISECONDS = 20000;
const PLAYLIST_TIMEOUT_MILLISECONDS = 15000;

const DEFAULT_MAXIMUM_HEIGHT = 1080;
const ULTRA_HIGH_DEFINITION_HEIGHT = 2160;
const HTTP_OK = 200;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MILLISECONDS_PER_SECOND = 1000;
const YEAR_LENGTH = 4;
const NUMBER_PAD_LENGTH = 2;
const PAD_CHARACTER = '0';
const NO_HEIGHT = 0;
const FIRST_INDEX = 0;
const NO_BANDWIDTH = 0;
const NO_PROGRESS = 0;
const NO_PERCENT = -1;
const PERCENT_SCALE = 100;
const DURATION_TOLERANCE_RATIO = 0.10;
const DURATION_TIE_BAND_RATIO = 0.02;
const MINIMUM_PLAYABLE_SECONDS = 300;
const DEFAULT_TARGET_DURATION = 10;
const SEGMENT_DURATION_PRECISION = 3;

const MOVIE_MEDIA_TYPE = 'movie';
const TELEVISION_MEDIA_TYPE = 'tv';
const FIRST_SEASON = '1';
const FIRST_EPISODE = '1';
const EMPTY_STRING = '';
const HLS_MIME_TYPE = 'application/x-mpegURL';
const TRANSPORT_STREAM_MIME_TYPE = 'video/mp2t';
const PREFERRED_SUBTITLE_LANGUAGE = 'english';

const PATH_SEPARATOR = '/';
const TYPE_SEGMENT_INDEX = 0;
const IDENTIFIER_SEGMENT_INDEX = 1;
const SEASON_SEGMENT_INDEX = 2;
const EPISODE_SEGMENT_INDEX = 3;

const PLAYLIST_HEADER_TAG = '#EXTM3U';
const STREAM_INFO_TAG = '#EXT-X-STREAM-INF';
const SEGMENT_INFO_TAG = '#EXTINF:';
const INIT_SEGMENT_TAG = '#EXT-X-MAP';
const MEDIA_TAG = '#EXT-X-MEDIA';
const COMMENT_PREFIX = '#';

const SEGMENT_PLAYBACK_MODE = 'segments';
const PAIRED_PLAYBACK_MODE = 'paired';

const CINEBY_HOST_PATTERN = /(^|\.)cineby\.(at|app|sc|gd|tech|ws|today|store|asia|dev)$/i;
const MEDIA_PATH_PATTERN = /^\/(movie|tv)\//;
const NUMERIC_PATTERN = /^\d+$/;
const ULTRA_HIGH_DEFINITION_PATTERN = /4k|2160/i;
const QUALITY_NUMBER_PATTERN = /(\d{3,4})/;
const URL_QUALITY_PATTERN = /\/(2160|1440|1080|720|480|360)p?\//;
const RESOLUTION_PATTERN = /RESOLUTION=\d+x(\d+)/i;
const BANDWIDTH_PATTERN = /BANDWIDTH=(\d+)/i;
const CODECS_PATTERN = /CODECS="([^"]+)"/i;
const UNSUPPORTED_CODEC_PREFIXES = ['av01', 'vp09', 'dvh1', 'dvhe'];
const MEDIA_URI_PATTERN = /URI="([^"]+)"/i;
const AUDIO_TYPE_PATTERN = /TYPE=AUDIO/i;
const JSON_BODY_PREFIX = '{';
const CUE_TIMING_PATTERN = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

const PROVIDERS = [
    { identifier: 'cdn', name: 'Yoru' },
    { identifier: 'm4uhd', name: 'Breach' },
    { identifier: 'vsrc', name: 'Neon' },
    { identifier: 'hdmovie', name: 'Vyse' }
];

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

function isCinebyUrl(pageUrl) {
    try {
        const parsedUrl = new URL(pageUrl);
        return CINEBY_HOST_PATTERN.test(parsedUrl.hostname) && MEDIA_PATH_PATTERN.test(parsedUrl.pathname);
    } catch (error) {
        void error;
        return false;
    }
}

function parseCinebyUrl(pageUrl) {
    const parsedUrl = new URL(pageUrl);
    const segments = parsedUrl.pathname.split(PATH_SEPARATOR).filter((segment) => segment !== EMPTY_STRING);
    const mediaType = segments[TYPE_SEGMENT_INDEX];
    if (mediaType !== MOVIE_MEDIA_TYPE && mediaType !== TELEVISION_MEDIA_TYPE) {
        throw new Error(`Cineby: "${parsedUrl.pathname}" is not a movie or tv link`);
    }
    const tmdbId = segments[IDENTIFIER_SEGMENT_INDEX] || EMPTY_STRING;
    if (NUMERIC_PATTERN.test(tmdbId) === false) {
        throw new Error('Cineby: that link carries no TMDB id');
    }
    if (mediaType === TELEVISION_MEDIA_TYPE) {
        return {
            mediaType,
            tmdbId,
            season: segments[SEASON_SEGMENT_INDEX] || FIRST_SEASON,
            episode: segments[EPISODE_SEGMENT_INDEX] || FIRST_EPISODE
        };
    }
    return { mediaType, tmdbId, season: FIRST_SEASON, episode: FIRST_EPISODE };
}

function buildRequestHeaders() {
    return {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: '*/*',
        Origin: CINEBY_ORIGIN,
        Referer: `${CINEBY_ORIGIN}/`
    };
}

async function fetchTmdbJson(resourcePath) {
    const configuration = loadConfiguration();
    const apiKey = configuration.tmdbApiKey || SHARED_TMDB_API_KEY;
    const response = await fetch(`${TMDB_API_BASE}${resourcePath}?api_key=${apiKey}&language=en`, {
        headers: { 'User-Agent': BROWSER_USER_AGENT },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MILLISECONDS)
    });
    if (response.ok === false) {
        throw new Error(`TMDB returned HTTP ${response.status} for ${resourcePath}`);
    }
    return response.json();
}

function extractYear(dateText) {
    return String(dateText || EMPTY_STRING).slice(0, YEAR_LENGTH);
}

function minutesToSeconds(minutes) {
    return Math.floor(Number(minutes || 0) * SECONDS_PER_MINUTE);
}

async function fetchMetadata(parsed) {
    if (parsed.mediaType === MOVIE_MEDIA_TYPE) {
        const movie = await fetchTmdbJson(`/movie/${parsed.tmdbId}`);
        const externalIds = await fetchTmdbJson(`/movie/${parsed.tmdbId}/external_ids`).catch(() => ({}));
        return {
            title: movie.title || movie.original_title || 'Cineby movie',
            year: extractYear(movie.release_date),
            imdbId: externalIds.imdb_id || EMPTY_STRING,
            episodeTitle: EMPTY_STRING,
            durationSeconds: minutesToSeconds(movie.runtime)
        };
    }
    const show = await fetchTmdbJson(`/tv/${parsed.tmdbId}`);
    const externalIds = await fetchTmdbJson(`/tv/${parsed.tmdbId}/external_ids`).catch(() => ({}));
    const episode = await fetchTmdbJson(`/tv/${parsed.tmdbId}/season/${parsed.season}/episode/${parsed.episode}`).catch(() => ({}));
    return {
        title: show.name || show.original_name || 'Cineby show',
        year: extractYear(show.first_air_date),
        imdbId: externalIds.imdb_id || EMPTY_STRING,
        episodeTitle: episode.name || EMPTY_STRING,
        durationSeconds: minutesToSeconds(episode.runtime)
    };
}

async function requestSeed(tmdbId) {
    const response = await fetch(`${VIDEASY_API_BASE}/seed?mediaId=${tmdbId}`, {
        headers: buildRequestHeaders(),
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MILLISECONDS)
    });
    if (response.ok === false) {
        throw new Error(`the seed request returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!payload.seed) {
        throw new Error('the seed response carried no seed');
    }
    return {
        seed: payload.seed,
        ttlMilliseconds: Number(payload.ttlMs) || SEED_DEFAULT_TTL_MILLISECONDS
    };
}

function pause(milliseconds) {
    return new Promise((done) => setTimeout(done, milliseconds));
}

const seedCache = new Map();

// The seed service stamps every seed with a ttl of about half a minute, so the cache has to
// expire on the service's own clock. Holding one any longer just hands the providers a seed
// they will reject.
function readCachedSeed(tmdbId) {
    const cached = seedCache.get(tmdbId);
    if (cached !== undefined && Date.now() < cached.expiresAt) {
        return cached.seed;
    }
    return EMPTY_STRING;
}

// Every provider needs the same seed for the same title, so it is fetched once and shared.
// Asking four times in parallel is what used to earn a 429 from the seed service.
async function fetchSeed(tmdbId) {
    const cached = readCachedSeed(tmdbId);
    if (cached !== EMPTY_STRING) {
        return cached;
    }
    let lastFailure = null;
    for (let attempt = FIRST_INDEX; attempt < SEED_ATTEMPTS; attempt += 1) {
        if (attempt > FIRST_INDEX) {
            await pause(SEED_RETRY_MILLISECONDS * attempt);
        }
        try {
            const issued = await requestSeed(tmdbId);
            const usableFor = issued.ttlMilliseconds - SEED_SAFETY_MARGIN_MILLISECONDS;
            if (usableFor > 0) {
                seedCache.set(tmdbId, { seed: issued.seed, expiresAt: Date.now() + usableFor });
            }
            return issued.seed;
        } catch (error) {
            lastFailure = error;
        }
    }
    throw lastFailure;
}

function buildSourcesUrl(provider, metadata, parsed, seed) {
    const doubleEncodedTitle = encodeURIComponent(encodeURIComponent(metadata.title));
    const parameters = [
        `title=${doubleEncodedTitle}`,
        `mediaType=${parsed.mediaType}`,
        `year=${encodeURIComponent(metadata.year)}`,
        `tmdbId=${parsed.tmdbId}`,
        `imdbId=${encodeURIComponent(metadata.imdbId)}`,
        `seasonId=${encodeURIComponent(parsed.season)}`,
        `episodeId=${encodeURIComponent(parsed.episode)}`,
        'enc=2',
        `seed=${encodeURIComponent(seed)}`
    ];
    return `${VIDEASY_API_BASE}/${provider.identifier}/sources-with-title?${parameters.join('&')}`;
}

function describeProviderError(body) {
    try {
        const parsedBody = JSON.parse(body);
        return String(parsedBody.message || parsedBody.error || body);
    } catch (error) {
        void error;
        return body.slice(0, 160);
    }
}

async function fetchEncryptedSources(provider, metadata, parsed, seed) {
    const response = await fetch(buildSourcesUrl(provider, metadata, parsed, seed), {
        headers: buildRequestHeaders(),
        signal: AbortSignal.timeout(SOURCES_TIMEOUT_MILLISECONDS)
    });
    const body = await response.text();
    if (body.trim() === EMPTY_STRING) {
        throw new Error(`returned nothing (HTTP ${response.status})`);
    } else if (body.startsWith(JSON_BODY_PREFIX)) {
        throw new Error(describeProviderError(body));
    } else if (response.ok === false) {
        throw new Error(`returned HTTP ${response.status}`);
    }
    return body;
}

async function decryptSources(encryptedText, tmdbId, seed) {
    const response = await fetch(DECRYPT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_USER_AGENT },
        body: JSON.stringify({ text: encryptedText, id: tmdbId, seed }),
        signal: AbortSignal.timeout(DECRYPT_TIMEOUT_MILLISECONDS)
    });
    if (response.ok === false) {
        throw new Error(`the decrypt service returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.status !== undefined && Number(payload.status) !== HTTP_OK) {
        throw new Error(`the decrypt service rejected the blob (status ${payload.status})`);
    }
    return payload.result || payload;
}

function parseQualityHeight(quality, mediaUrl) {
    const label = String(quality || EMPTY_STRING);
    const labelMatch = QUALITY_NUMBER_PATTERN.exec(label);
    const urlMatch = URL_QUALITY_PATTERN.exec(String(mediaUrl || EMPTY_STRING));
    if (ULTRA_HIGH_DEFINITION_PATTERN.test(label)) {
        return ULTRA_HIGH_DEFINITION_HEIGHT;
    } else if (labelMatch !== null) {
        return Number(labelMatch[1]);
    } else if (urlMatch !== null) {
        return Number(urlMatch[1]);
    } else {
        return NO_HEIGHT;
    }
}

function collectSources(payload) {
    if (Array.isArray(payload.sources) && payload.sources.length > 0) {
        return payload.sources;
    } else if (payload.streams !== undefined && payload.streams !== null && typeof payload.streams === 'object') {
        return Object.entries(payload.streams).map(([quality, url]) => ({ quality, url }));
    } else if (payload.url) {
        return [{ quality: EMPTY_STRING, url: payload.url }];
    } else {
        return [];
    }
}

function describeSources(payload) {
    return collectSources(payload)
        .filter((source) => typeof source.url === 'string' && source.url !== EMPTY_STRING)
        .map((source) => ({
            url: source.url,
            quality: String(source.quality || EMPTY_STRING),
            height: parseQualityHeight(source.quality, source.url)
        }));
}

const LANGUAGE_NAMES = {
    en: 'English', eng: 'English', english: 'English',
    es: 'Spanish', spa: 'Spanish', spanish: 'Spanish', 'espanol': 'Spanish',
    pt: 'Portuguese', por: 'Portuguese', portuguese: 'Portuguese',
    fr: 'French', fra: 'French', fre: 'French', french: 'French',
    de: 'German', deu: 'German', ger: 'German', german: 'German',
    it: 'Italian', ita: 'Italian', italian: 'Italian',
    ar: 'Arabic', ara: 'Arabic', arabic: 'Arabic',
    ru: 'Russian', rus: 'Russian', russian: 'Russian',
    ja: 'Japanese', jpn: 'Japanese', japanese: 'Japanese',
    ko: 'Korean', kor: 'Korean', korean: 'Korean',
    zh: 'Chinese', zho: 'Chinese', chi: 'Chinese', chinese: 'Chinese',
    tr: 'Turkish', tur: 'Turkish', turkish: 'Turkish'
};

function describeLanguage(rawLanguage) {
    const trimmed = String(rawLanguage || EMPTY_STRING).trim();
    const key = trimmed.toLowerCase().replace(/[^a-z]/g, EMPTY_STRING);
    if (LANGUAGE_NAMES[key] !== undefined) {
        return LANGUAGE_NAMES[key];
    }
    if (trimmed === EMPTY_STRING) {
        return 'Unknown';
    }
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function collectSubtitleTracks(payload) {
    const tracks = Array.isArray(payload.subtitles) ? payload.subtitles : [];
    const seenLanguages = new Set();
    const collected = [];
    for (const track of tracks) {
        const language = String(track.language || track.lang || EMPTY_STRING);
        const trackUrl = String(track.url || EMPTY_STRING);
        const languageKey = language.toLowerCase();
        if (trackUrl !== EMPTY_STRING && language !== EMPTY_STRING && seenLanguages.has(languageKey) === false) {
            seenLanguages.add(languageKey);
            collected.push({ language, url: trackUrl });
        }
    }
    collected.sort((left, right) => {
        const leftIsPreferred = left.language.toLowerCase().startsWith(PREFERRED_SUBTITLE_LANGUAGE);
        const rightIsPreferred = right.language.toLowerCase().startsWith(PREFERRED_SUBTITLE_LANGUAGE);
        if (leftIsPreferred === rightIsPreferred) {
            return 0;
        } else if (leftIsPreferred) {
            return -1;
        } else {
            return 1;
        }
    });
    return collected;
}

function gatherSubtitleTracks(outcomes) {
    const seenLanguages = new Set();
    const gathered = [];
    for (const outcome of outcomes) {
        if (outcome.payload !== null) {
            for (const track of collectSubtitleTracks(outcome.payload)) {
                const language = describeLanguage(track.language);
                const key = language.toLowerCase();
                if (seenLanguages.has(key) === false) {
                    seenLanguages.add(key);
                    gathered.push({
                        identifier: key.replace(/[^a-z0-9]/g, EMPTY_STRING),
                        language,
                        url: track.url,
                        provider: outcome.provider.name
                    });
                }
            }
        }
    }
    gathered.sort((left, right) => {
        const leftIsPreferred = left.language === 'English';
        const rightIsPreferred = right.language === 'English';
        if (leftIsPreferred !== rightIsPreferred) {
            return leftIsPreferred ? -1 : 1;
        }
        return left.language.localeCompare(right.language);
    });
    return gathered;
}

function parseCueTimings(line) {
    const match = CUE_TIMING_PATTERN.exec(line);
    if (match === null) {
        return null;
    }
    const toSeconds = (hours, minutes, seconds, fraction) => {
        const hourPart = hours === undefined ? 0 : Number(hours.replace(':', EMPTY_STRING));
        const milliseconds = Number(String(fraction).padEnd(3, '0'));
        return hourPart * SECONDS_PER_HOUR + Number(minutes) * SECONDS_PER_MINUTE + Number(seconds)
            + milliseconds / MILLISECONDS_PER_SECOND;
    };
    return {
        start: toSeconds(match[1], match[2], match[3], match[4]),
        end: toSeconds(match[5], match[6], match[7], match[8])
    };
}

function parseSubtitleCues(text) {
    const lines = text.replace(/^﻿/, EMPTY_STRING).split(/\r?\n/);
    const cues = [];
    let current = null;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        const timings = parseCueTimings(line);
        if (timings !== null) {
            current = { start: timings.start, end: timings.end, lines: [] };
            cues.push(current);
        } else if (line === EMPTY_STRING) {
            current = null;
        } else if (current !== null) {
            const cleaned = line.replace(/<(?!\/?[ibu]>)[^>]*>/g, EMPTY_STRING).trim();
            if (cleaned !== EMPTY_STRING) {
                current.lines.push(cleaned);
            }
        }
    }
    return cues.filter((cue) => cue.lines.length > 0);
}

function formatSrtTimestamp(totalSeconds) {
    const safeSeconds = Math.max(0, totalSeconds);
    const hours = Math.floor(safeSeconds / SECONDS_PER_HOUR);
    const minutes = Math.floor((safeSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const seconds = Math.floor(safeSeconds % SECONDS_PER_MINUTE);
    const milliseconds = Math.round((safeSeconds - Math.floor(safeSeconds)) * MILLISECONDS_PER_SECOND);
    const pad = (value, width) => String(value).padStart(width, PAD_CHARACTER);
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(Math.min(milliseconds, 999), 3)}`;
}

function buildShiftedSrt(text, shiftSeconds) {
    const cues = parseSubtitleCues(text);
    const output = [];
    let index = 1;
    for (const cue of cues) {
        const start = cue.start + shiftSeconds;
        const end = cue.end + shiftSeconds;
        if (end > 0) {
            output.push(String(index));
            output.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
            output.push(cue.lines.join('\n'));
            output.push(EMPTY_STRING);
            index += 1;
        }
    }
    return { text: output.join('\n'), cueCount: index - 1 };
}

async function fetchSubtitleAsSrt(subtitleUrl, shiftSeconds) {
    const response = await fetch(subtitleUrl, {
        headers: buildRequestHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MILLISECONDS)
    });
    if (response.ok === false) {
        throw new Error(`subtitle download returned HTTP ${response.status}`);
    }
    const raw = await response.text();
    const converted = buildShiftedSrt(raw, shiftSeconds);
    if (converted.cueCount === 0) {
        throw new Error('that subtitle file had no usable lines');
    }
    return converted.text;
}

function buildDisplayTitle(metadata, parsed) {
    if (parsed.mediaType === TELEVISION_MEDIA_TYPE) {
        const seasonNumber = String(parsed.season).padStart(NUMBER_PAD_LENGTH, PAD_CHARACTER);
        const episodeNumber = String(parsed.episode).padStart(NUMBER_PAD_LENGTH, PAD_CHARACTER);
        let displayTitle = `${metadata.title} S${seasonNumber}E${episodeNumber}`;
        if (metadata.episodeTitle !== EMPTY_STRING) {
            displayTitle = `${displayTitle} - ${metadata.episodeTitle}`;
        }
        return displayTitle;
    }
    return metadata.title;
}

async function loadProviderPayload(provider, metadata, parsed, seed) {
    const encryptedText = await fetchEncryptedSources(provider, metadata, parsed, seed);
    return decryptSources(encryptedText, parsed.tmdbId, seed);
}

async function loadEveryProviderPayload(metadata, parsed) {
    let seed = EMPTY_STRING;
    try {
        seed = await fetchSeed(parsed.tmdbId);
    } catch (error) {
        return PROVIDERS.map((provider) => ({ provider, payload: null, error }));
    }
    const attempts = PROVIDERS.map((provider) => loadProviderPayload(provider, metadata, parsed, seed)
        .then((payload) => ({ provider, payload, error: null }))
        .catch((error) => ({ provider, payload: null, error })));
    return Promise.all(attempts);
}

function buildRenditions(outcomes) {
    const renditions = [];
    for (const outcome of outcomes) {
        if (outcome.payload !== null) {
            for (const source of describeSources(outcome.payload)) {
                const label = source.quality !== EMPTY_STRING ? source.quality : `${source.height}p`;
                renditions.push({
                    identifier: `${outcome.provider.identifier}:${label}`,
                    label,
                    displayLabel: label,
                    provider: outcome.provider.name,
                    height: source.height,
                    url: source.url
                });
            }
        }
    }
    renditions.sort((left, right) => right.height - left.height);
    return renditions;
}

function describeHeight(height) {
    if (height >= ULTRA_HIGH_DEFINITION_HEIGHT) {
        return '4K';
    } else if (height > NO_HEIGHT) {
        return `${height}p`;
    } else {
        return 'unknown';
    }
}

function describeRendition(rendition) {
    return `${describeHeight(rendition.height)} · ${rendition.provider}`;
}

function applyDisplayLabels(renditions) {
    const labelCounts = new Map();
    for (const rendition of renditions) {
        rendition.label = describeHeight(rendition.height);
        labelCounts.set(rendition.label, (labelCounts.get(rendition.label) || 0) + 1);
    }
    for (const rendition of renditions) {
        if (labelCounts.get(rendition.label) > 1) {
            rendition.displayLabel = `${rendition.label} · ${rendition.provider}`;
        } else {
            rendition.displayLabel = rendition.label;
        }
    }
    return renditions;
}

function orderRenditionsByPreference(renditions, maximumHeight) {
    const withinCeiling = renditions.filter((rendition) => rendition.height <= maximumHeight);
    const aboveCeiling = renditions.filter((rendition) => rendition.height > maximumHeight);
    return withinCeiling.concat(aboveCeiling);
}

function parseStreamInfo(line) {
    const resolutionMatch = RESOLUTION_PATTERN.exec(line);
    const bandwidthMatch = BANDWIDTH_PATTERN.exec(line);
    const codecsMatch = CODECS_PATTERN.exec(line);
    return {
        height: resolutionMatch !== null ? Number(resolutionMatch[1]) : NO_HEIGHT,
        bandwidth: bandwidthMatch !== null ? Number(bandwidthMatch[1]) : NO_BANDWIDTH,
        codecs: codecsMatch !== null ? codecsMatch[1] : EMPTY_STRING
    };
}

function isPlayableCodec(codecs) {
    if (codecs === EMPTY_STRING) {
        return true;
    }
    for (const unsupported of UNSUPPORTED_CODEC_PREFIXES) {
        if (codecs.toLowerCase().includes(unsupported)) {
            return false;
        }
    }
    return true;
}

function parseMediaRendition(line, baseUrl) {
    const uriMatch = MEDIA_URI_PATTERN.exec(line);
    if (uriMatch === null) {
        return null;
    }
    return new URL(uriMatch[1], baseUrl).toString();
}

function parsePlaylistText(text, baseUrl) {
    const variants = [];
    const segments = [];
    const audioPlaylists = [];
    let initSegmentUrl = EMPTY_STRING;
    let pendingDuration = 0;
    let pendingVariant = null;
    let totalSeconds = 0;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith(INIT_SEGMENT_TAG)) {
            const parsedInitUrl = parseMediaRendition(line, baseUrl);
            if (parsedInitUrl !== null) {
                initSegmentUrl = parsedInitUrl;
            }
        } else if (line.startsWith(MEDIA_TAG) && AUDIO_TYPE_PATTERN.test(line)) {
            const audioUrl = parseMediaRendition(line, baseUrl);
            if (audioUrl !== null) {
                audioPlaylists.push(audioUrl);
            }
        } else if (line.startsWith(STREAM_INFO_TAG)) {
            pendingVariant = parseStreamInfo(line);
        } else if (line.startsWith(SEGMENT_INFO_TAG)) {
            pendingDuration = Number.parseFloat(line.slice(SEGMENT_INFO_TAG.length)) || 0;
        } else if (line !== EMPTY_STRING && line.startsWith(COMMENT_PREFIX) === false) {
            const absoluteUrl = new URL(line, baseUrl).toString();
            if (pendingVariant !== null) {
                variants.push(Object.assign(pendingVariant, { url: absoluteUrl }));
                pendingVariant = null;
            } else {
                segments.push({ url: absoluteUrl, duration: pendingDuration, start: totalSeconds });
                totalSeconds += pendingDuration;
                pendingDuration = 0;
            }
        }
    }
    return { variants, segments, totalSeconds, audioPlaylists, initSegmentUrl };
}

async function fetchPlaylistText(playlistUrl) {
    const response = await fetch(playlistUrl, {
        headers: buildRequestHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MILLISECONDS)
    });
    if (response.ok === false) {
        throw new Error(`playlist returned HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.includes(PLAYLIST_HEADER_TAG) === false) {
        throw new Error('that source is not a playlist, it redirects elsewhere');
    }
    return { text, finalUrl: response.url || playlistUrl };
}

function pickVariantForCeiling(variants, maximumHeight) {
    const ordered = variants.slice().sort((left, right) => (right.height - left.height)
        || (right.bandwidth - left.bandwidth));
    const withinCeiling = ordered.filter((variant) => variant.height <= maximumHeight);
    if (withinCeiling.length > 0) {
        return withinCeiling[FIRST_INDEX];
    }
    return ordered[ordered.length - 1];
}

async function resolveTimeline(playlistUrl, maximumHeight) {
    const ceiling = Number(maximumHeight || DEFAULT_MAXIMUM_HEIGHT);
    const first = await fetchPlaylistText(playlistUrl);
    const parsedFirst = parsePlaylistText(first.text, first.finalUrl);

    if (parsedFirst.segments.length > 0) {
        return {
            mode: SEGMENT_PLAYBACK_MODE,
            video: { segments: parsedFirst.segments, initSegmentUrl: parsedFirst.initSegmentUrl },
            audio: null,
            totalSeconds: parsedFirst.totalSeconds,
            playlistUrl: first.finalUrl,
            height: NO_HEIGHT
        };
    }

    if (parsedFirst.variants.length === 0) {
        throw new Error('the playlist listed no segments');
    }

    const playableVariants = parsedFirst.variants.filter((candidate) => isPlayableCodec(candidate.codecs));
    if (playableVariants.length === 0) {
        throw new Error('every rendition uses a codec this television cannot decode');
    }
    const variant = pickVariantForCeiling(playableVariants, ceiling);
    const second = await fetchPlaylistText(variant.url);
    const parsedSecond = parsePlaylistText(second.text, second.finalUrl);
    if (parsedSecond.segments.length === 0) {
        throw new Error('the variant playlist listed no segments');
    }
    const video = { segments: parsedSecond.segments, initSegmentUrl: parsedSecond.initSegmentUrl };

    if (parsedFirst.audioPlaylists.length === 0) {
        return {
            mode: SEGMENT_PLAYBACK_MODE,
            video,
            audio: null,
            totalSeconds: parsedSecond.totalSeconds,
            playlistUrl: second.finalUrl,
            height: variant.height
        };
    }

    const audioPlaylist = await fetchPlaylistText(parsedFirst.audioPlaylists[FIRST_INDEX]);
    const parsedAudio = parsePlaylistText(audioPlaylist.text, audioPlaylist.finalUrl);
    if (parsedAudio.segments.length === 0) {
        throw new Error('the audio playlist listed no segments');
    }
    return {
        mode: PAIRED_PLAYBACK_MODE,
        video,
        audio: { segments: parsedAudio.segments, initSegmentUrl: parsedAudio.initSegmentUrl },
        totalSeconds: parsedSecond.totalSeconds,
        playlistUrl: second.finalUrl,
        height: variant.height
    };
}

function isPlausibleDuration(actualSeconds, expectedSeconds) {
    if (expectedSeconds <= 0) {
        return actualSeconds >= MINIMUM_PLAYABLE_SECONDS;
    }
    const lowestAccepted = expectedSeconds * (1 - DURATION_TOLERANCE_RATIO);
    const highestAccepted = expectedSeconds * (1 + DURATION_TOLERANCE_RATIO);
    return actualSeconds >= lowestAccepted && actualSeconds <= highestAccepted;
}

function computeDurationErrorRatio(actualSeconds, expectedSeconds) {
    if (expectedSeconds <= 0) {
        return 0;
    }
    return Math.abs(actualSeconds - expectedSeconds) / expectedSeconds;
}

function describeDurationMismatch(rendition, actualSeconds, expectedSeconds) {
    const actualMinutes = Math.round(actualSeconds / SECONDS_PER_MINUTE);
    const expectedMinutes = Math.round(expectedSeconds / SECONDS_PER_MINUTE);
    return `${describeRendition(rendition)}: runs ${actualMinutes} min, expected about ${expectedMinutes} min`;
}

async function inspectRendition(rendition, expectedSeconds, maximumHeight) {
    try {
        const timeline = await resolveTimeline(rendition.url, maximumHeight);
        if (timeline.height > NO_HEIGHT) {
            rendition.height = timeline.height;
        }
        const usable = isPlausibleDuration(timeline.totalSeconds, expectedSeconds);
        return {
            rendition,
            timeline,
            usable,
            durationErrorRatio: computeDurationErrorRatio(timeline.totalSeconds, expectedSeconds),
            reason: usable ? EMPTY_STRING : describeDurationMismatch(rendition, timeline.totalSeconds, expectedSeconds)
        };
    } catch (error) {
        return { rendition, timeline: null, usable: false, reason: `${describeRendition(rendition)}: ${error.message}` };
    }
}

async function inspectEveryRendition(renditions, expectedSeconds, maximumHeight, onInspected) {
    let completed = FIRST_INDEX;
    const total = renditions.length;
    return Promise.all(renditions.map((rendition) =>
        inspectRendition(rendition, expectedSeconds, maximumHeight).then((inspection) => {
            completed += 1;
            if (onInspected !== undefined) {
                onInspected(completed, total);
            }
            return inspection;
        })));
}

async function selectRendition(renditions, maximumHeight, expectedSeconds, onInspected) {
    const inspections = await inspectEveryRendition(renditions, expectedSeconds, maximumHeight, onInspected);
    const usable = inspections.filter((inspection) => inspection.usable);
    const rejections = inspections.filter((inspection) => inspection.usable === false).map((inspection) => inspection.reason);
    if (usable.length === 0) {
        return { rendition: null, timeline: null, offered: [], rejections };
    }
    const closestErrorRatio = Math.min(...usable.map((inspection) => inspection.durationErrorRatio));
    const rightLength = usable.filter((inspection) =>
        inspection.durationErrorRatio <= closestErrorRatio + DURATION_TIE_BAND_RATIO);

    const usableRenditions = applyDisplayLabels(rightLength.map((inspection) => inspection.rendition));
    usableRenditions.sort((left, right) => right.height - left.height);
    const ordered = orderRenditionsByPreference(usableRenditions, maximumHeight);
    const bestHeight = ordered[FIRST_INDEX].height;
    const tied = ordered.filter((rendition) => rendition.height === bestHeight);
    const findInspection = (rendition) => rightLength.find((inspection) => inspection.rendition.identifier === rendition.identifier);
    const seekable = tied.find((rendition) => findInspection(rendition).timeline.mode === SEGMENT_PLAYBACK_MODE);
    const preferred = seekable !== undefined ? seekable : tied[FIRST_INDEX];
    const chosen = findInspection(preferred);
    return {
        rendition: chosen.rendition,
        timeline: chosen.timeline,
        offered: usableRenditions,
        rejections
    };
}

function findSegmentIndex(segments, targetSeconds) {
    let index = FIRST_INDEX;
    for (let position = FIRST_INDEX; position < segments.length; position += 1) {
        if (segments[position].start > targetSeconds) {
            break;
        }
        index = position;
    }
    return index;
}

function resolveSeekTarget(track, requestedSeconds) {
    const segmentIndex = findSegmentIndex(track.segments, requestedSeconds);
    return { segmentIndex, startSeconds: track.segments[segmentIndex].start };
}

function buildTrimmedPlaylist(track, fromIndex) {
    const remaining = track.segments.slice(fromIndex);
    let longestSegment = 0;
    for (const segment of remaining) {
        if (segment.duration > longestSegment) {
            longestSegment = segment.duration;
        }
    }
    const targetDuration = Math.ceil(longestSegment) || DEFAULT_TARGET_DURATION;
    const playlistVersion = track.initSegmentUrl !== EMPTY_STRING ? '#EXT-X-VERSION:7' : '#EXT-X-VERSION:3';
    const lines = [
        PLAYLIST_HEADER_TAG,
        playlistVersion,
        '#EXT-X-PLAYLIST-TYPE:VOD',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        '#EXT-X-MEDIA-SEQUENCE:0'
    ];
    if (track.initSegmentUrl !== EMPTY_STRING) {
        lines.push(`${INIT_SEGMENT_TAG}:URI="${track.initSegmentUrl}"`);
    }
    for (const segment of remaining) {
        lines.push(`${SEGMENT_INFO_TAG}${segment.duration.toFixed(SEGMENT_DURATION_PRECISION)},`);
        lines.push(segment.url);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
}

function summariseRenditions(renditions) {
    return renditions.map((rendition) => ({
        identifier: rendition.identifier,
        displayLabel: rendition.displayLabel,
        height: rendition.height,
        provider: rendition.provider
    }));
}

function buildRenditionUrlMap(renditions) {
    const urlByIdentifier = {};
    for (const rendition of renditions) {
        urlByIdentifier[rendition.identifier] = rendition.url;
    }
    return urlByIdentifier;
}

function buildSession(rendition, timeline, subtitleTracks, metadata, parsed, renditions, handHlsToTelevision) {
    const session = {
        title: buildDisplayTitle(metadata, parsed),
        durationSeconds: Math.floor(timeline.totalSeconds),
        totalDurationSeconds: Math.floor(timeline.totalSeconds),
        headers: buildRequestHeaders(),
        height: rendition.height,
        quality: rendition.displayLabel,
        provider: rendition.provider,
        hlsUrl: timeline.playlistUrl,
        videoTrack: timeline.video,
        audioTrack: timeline.audio,
        playbackMode: timeline.mode,
        seekOffsetSeconds: 0,
        renditions: summariseRenditions(renditions),
        renditionUrls: buildRenditionUrlMap(renditions),
        selectedRenditionId: rendition.identifier,
        subtitleTracks,
        selectedSubtitleId: EMPTY_STRING,
        subtitleOffsetSeconds: 0,
        videoOnlyUrl: EMPTY_STRING,
        audioOnlyUrl: EMPTY_STRING,
        supportsRanges: false
    };
    if (handHlsToTelevision) {
        session.mimeType = HLS_MIME_TYPE;
        session.progressiveUrl = timeline.playlistUrl;
    } else {
        session.mimeType = TRANSPORT_STREAM_MIME_TYPE;
        session.progressiveUrl = EMPTY_STRING;
    }
    return session;
}

async function resolveCineby(pageUrl, options) {
    const reportStage = (options || {}).onStage || reportNothing;
    const parsed = parseCinebyUrl(pageUrl);
    const configuration = loadConfiguration();
    const maximumHeight = Number(configuration.cinebyMaximumHeight || DEFAULT_MAXIMUM_HEIGHT);
    const handHlsToTelevision = configuration.cinebyDirectHls === true;

    reportStage('looking up the title');
    const metadata = await fetchMetadata(parsed);
    const displayTitle = buildDisplayTitle(metadata, parsed);

    reportStage(`asking ${PROVIDERS.length} sources`, { label: displayTitle });
    const outcomes = await loadEveryProviderPayload(metadata, parsed);
    const renditions = buildRenditions(outcomes);

    if (renditions.length === 0) {
        const failures = outcomes
            .filter((outcome) => outcome.error !== null)
            .map((outcome) => `  - ${outcome.provider.name}: ${outcome.error.message}`)
            .join('\n');
        throw new Error(`Cineby found no source for "${metadata.title}".\n${failures}`);
    }

    reportStage(`checking ${renditions.length} streams`, { label: displayTitle, percent: NO_PROGRESS });
    const selection = await selectRendition(renditions, maximumHeight, metadata.durationSeconds,
        (completed, total) => reportStage(`checking ${total} streams`, {
            detail: `${completed} of ${total} checked`,
            percent: Math.round((completed / total) * PERCENT_SCALE)
        }));
    if (selection.rendition === null) {
        const rejectionList = selection.rejections.map((entry) => `  - ${entry}`).join('\n');
        throw new Error(`Cineby found sources for "${metadata.title}" but none was usable.\n${rejectionList}`);
    }

    reportStage(`picked ${selection.rendition.displayLabel}`, {
        label: displayTitle,
        detail: EMPTY_STRING,
        percent: NO_PERCENT
    });
    const subtitleTracks = gatherSubtitleTracks(outcomes);
    return buildSession(selection.rendition, selection.timeline, subtitleTracks, metadata, parsed, selection.offered, handHlsToTelevision);
}

async function switchRendition(session, renditionIdentifier) {
    const match = session.renditions.find((rendition) => rendition.identifier === renditionIdentifier);
    if (match === undefined) {
        throw new Error('that quality is not on the list for this title');
    }
    const stored = session.renditionUrls || {};
    const targetUrl = stored[renditionIdentifier];
    if (!targetUrl) {
        throw new Error('that quality has no stored playlist url');
    }
    const configuration = loadConfiguration();
    const targetHeight = Math.max(match.height, Number(configuration.cinebyMaximumHeight || DEFAULT_MAXIMUM_HEIGHT));
    const timeline = await resolveTimeline(targetUrl, targetHeight);
    session.videoTrack = timeline.video;
    session.audioTrack = timeline.audio;
    session.hlsUrl = timeline.playlistUrl;
    session.playbackMode = timeline.mode;
    session.totalDurationSeconds = Math.floor(timeline.totalSeconds);
    session.durationSeconds = Math.floor(timeline.totalSeconds);
    session.selectedRenditionId = renditionIdentifier;
    session.quality = match.displayLabel;
    session.height = match.height;
    session.provider = match.provider;
    return session;
}

async function diagnoseCineby(pageUrl) {
    const parsed = parseCinebyUrl(pageUrl);
    const configuration = loadConfiguration();
    const maximumHeight = Number(configuration.cinebyMaximumHeight || DEFAULT_MAXIMUM_HEIGHT);
    const results = [];
    let metadata = null;

    try {
        metadata = await fetchMetadata(parsed);
    } catch (error) {
        results.push({ label: 'tmdb metadata', ok: false, reason: 'TMDB lookup failed', detail: error.message, elapsedSeconds: 0 });
        return { url: pageUrl, results, winner: null, verdict: 'blocked', unsupportedSite: false };
    }

    const startedAt = Date.now();
    const outcomes = await loadEveryProviderPayload(metadata, parsed);
    const gatherSeconds = Math.round((Date.now() - startedAt) / 1000);

    for (const outcome of outcomes) {
        if (outcome.payload === null) {
            results.push({
                label: outcome.provider.name,
                ok: false,
                reason: 'provider failed',
                detail: String(outcome.error.message || EMPTY_STRING).slice(0, 400),
                elapsedSeconds: gatherSeconds
            });
        } else {
            const sources = describeSources(outcome.payload);
            let bestHeight = NO_HEIGHT;
            for (const source of sources) {
                if (source.height > bestHeight) {
                    bestHeight = source.height;
                }
            }
            results.push({
                label: outcome.provider.name,
                ok: sources.length > 0,
                extractor: `cineby/${outcome.provider.identifier}`,
                title: buildDisplayTitle(metadata, parsed),
                formatCount: sources.length,
                bestHeight,
                reason: sources.length === 0 ? 'no playable source' : undefined,
                detail: sources.length === 0 ? 'the provider answered but listed no stream url' : undefined,
                elapsedSeconds: gatherSeconds
            });
        }
    }

    const renditions = buildRenditions(outcomes);
    let chosen = null;
    if (renditions.length > 0) {
        const selection = await selectRendition(renditions, maximumHeight, metadata.durationSeconds);
        if (selection.rendition !== null) {
            chosen = {
                label: `chosen: ${selection.rendition.displayLabel}`,
                ok: true,
                extractor: `cineby/${selection.rendition.provider}`,
                title: buildDisplayTitle(metadata, parsed),
                formatCount: renditions.length,
                bestHeight: selection.rendition.height,
                elapsedSeconds: Math.round(selection.timeline.totalSeconds / SECONDS_PER_MINUTE)
            };
            results.push(chosen);
        }
        for (const rejection of selection.rejections) {
            results.push({ label: 'rejected', ok: false, reason: 'unusable', detail: rejection, elapsedSeconds: 0 });
        }
    }

    const winner = chosen || results.find((entry) => entry.ok) || null;
    return {
        url: pageUrl,
        results,
        winner,
        verdict: winner === null ? 'blocked' : 'works',
        unsupportedSite: false
    };
}

module.exports = {
    isCinebyUrl,
    parseCinebyUrl,
    fetchMetadata,
    loadEveryProviderPayload,
    gatherSubtitleTracks,
    resolveCineby,
    diagnoseCineby,
    switchRendition,
    resolveTimeline,
    findSegmentIndex,
    resolveSeekTarget,
    buildShiftedSrt,
    parsePlaylistText,
    isPlausibleDuration,
    isPlayableCodec,
    computeDurationErrorRatio,
    parseQualityHeight,
    describeLanguage,
    buildTrimmedPlaylist,
    fetchSubtitleAsSrt,
    parseSubtitleCues,
    formatSrtTimestamp,
    BROWSER_USER_AGENT,
    CINEBY_ORIGIN
};
