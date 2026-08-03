const EMPTY_STRING = '';
const PAGE_FETCH_TIMEOUT_MILLISECONDS = 12000;
const MAXIMUM_PAGE_BYTES = 3 * 1024 * 1024;
const MAXIMUM_MEDIA_CANDIDATES = 12;
const MAXIMUM_FRAME_CANDIDATES = 8;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MEDIA_URL_PATTERN = /https?:(?:\\\/|\/)(?:\\\/|\/)[^\s"'<>]*?\.(?:m3u8|mpd|mp4|m4v|webm|mkv)(?:\?[^\s"'<>]*)?/gi;
const RELATIVE_MEDIA_PATTERN = /["'(](\/[^\s"'<>()]*?\.(?:m3u8|mpd|mp4|m4v|webm|mkv)(?:\?[^\s"'<>()]*)?)["')]/gi;
const FRAME_SOURCE_PATTERN = /<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const ESCAPED_SLASH_PATTERN = /\\\//g;
const SLASH = '/';
const HTML_ENTITY_AMPERSAND = /&amp;/gi;

function decodeCandidate(rawUrl) {
    return String(rawUrl)
        .replace(ESCAPED_SLASH_PATTERN, SLASH)
        .replace(HTML_ENTITY_AMPERSAND, '&')
        .trim();
}

function toAbsolute(candidate, pageUrl) {
    try {
        return new URL(candidate, pageUrl).toString();
    } catch (error) {
        void error;
        return EMPTY_STRING;
    }
}

function collectMatches(pattern, text, captureIndex) {
    const found = [];
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
        found.push(captureIndex === undefined ? match[0] : match[captureIndex]);
        match = pattern.exec(text);
    }
    return found;
}

function addUnique(collected, value, limit) {
    if (value !== EMPTY_STRING && collected.includes(value) === false && collected.length < limit) {
        collected.push(value);
    }
}

function findMediaUrls(html, pageUrl) {
    const collected = [];
    for (const raw of collectMatches(MEDIA_URL_PATTERN, html)) {
        addUnique(collected, decodeCandidate(raw), MAXIMUM_MEDIA_CANDIDATES);
    }
    for (const raw of collectMatches(RELATIVE_MEDIA_PATTERN, html, 1)) {
        addUnique(collected, toAbsolute(decodeCandidate(raw), pageUrl), MAXIMUM_MEDIA_CANDIDATES);
    }
    return collected;
}

function findFrameUrls(html, pageUrl) {
    const collected = [];
    for (const raw of collectMatches(FRAME_SOURCE_PATTERN, html, 1)) {
        const absolute = toAbsolute(decodeCandidate(raw), pageUrl);
        const isSameDocument = absolute === pageUrl || absolute.startsWith('about:') || absolute.startsWith('data:');
        if (isSameDocument === false) {
            addUnique(collected, absolute, MAXIMUM_FRAME_CANDIDATES);
        }
    }
    return collected;
}

function readTitle(html) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (match === null) {
        return EMPTY_STRING;
    }
    return match[1].replace(/\s+/g, ' ').trim();
}

async function fetchPageText(pageUrl, fetchImplementation) {
    const call = fetchImplementation || fetch;
    const response = await call(pageUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MILLISECONDS)
    });
    if (response.ok === false) {
        throw new Error(`that page answered HTTP ${response.status}`);
    }
    const body = await response.text();
    return body.slice(0, MAXIMUM_PAGE_BYTES);
}

async function inspectPage(pageUrl, fetchImplementation) {
    const html = await fetchPageText(pageUrl, fetchImplementation);
    return {
        title: readTitle(html),
        mediaUrls: findMediaUrls(html, pageUrl),
        frameUrls: findFrameUrls(html, pageUrl)
    };
}

module.exports = {
    inspectPage,
    findMediaUrls,
    findFrameUrls,
    readTitle,
    BROWSER_USER_AGENT
};
