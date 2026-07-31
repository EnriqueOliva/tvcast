const fs = require('node:fs');
const path = require('node:path');

const cineby = require('./cineby');

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const PAD_CHARACTER = '0';
const EMPTY_STRING = '';

const WEBVTT_HEADER = 'WEBVTT';
const STYLE_BLOCK_PATTERN = /^\[(Script Info|V4\+? Styles|Fonts|Graphics)\][\s\S]*?(?=^\[|\Z)/gm;

function formatWebVttTimestamp(totalSeconds) {
    const safeSeconds = Math.max(0, totalSeconds);
    const hours = Math.floor(safeSeconds / SECONDS_PER_HOUR);
    const minutes = Math.floor((safeSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const seconds = Math.floor(safeSeconds % SECONDS_PER_MINUTE);
    const milliseconds = Math.round((safeSeconds - Math.floor(safeSeconds)) * MILLISECONDS_PER_SECOND);
    const pad = (value, width) => String(value).padStart(width, PAD_CHARACTER);
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(Math.min(milliseconds, 999), 3)}`;
}

function stripByteOrderMark(text) {
    if (text.charCodeAt(0) === 0xFEFF) {
        return text.slice(1);
    }
    return text;
}

function shiftCues(cues, offsetMilliseconds) {
    const offsetSeconds = offsetMilliseconds / MILLISECONDS_PER_SECOND;
    const shifted = [];
    for (const cue of cues) {
        const start = cue.start + offsetSeconds;
        const end = cue.end + offsetSeconds;
        if (end > 0) {
            shifted.push({ start: Math.max(0, start), end, lines: cue.lines });
        }
    }
    return shifted;
}

function toCueJson(cues, offsetMilliseconds) {
    return shiftCues(cues, offsetMilliseconds || 0).map((cue) => ({
        s: Math.round(cue.start * MILLISECONDS_PER_SECOND),
        e: Math.round(cue.end * MILLISECONDS_PER_SECOND),
        t: cue.lines.join('\n')
    }));
}

function toWebVtt(cues, offsetMilliseconds) {
    const shifted = shiftCues(cues, offsetMilliseconds || 0);
    const output = [WEBVTT_HEADER, EMPTY_STRING];
    for (const cue of shifted) {
        output.push(`${formatWebVttTimestamp(cue.start)} --> ${formatWebVttTimestamp(cue.end)}`);
        output.push(cue.lines.join('\n'));
        output.push(EMPTY_STRING);
    }
    return output.join('\n');
}

async function fetchCues(subtitleUrl) {
    const srtText = await cineby.fetchSubtitleAsSrt(subtitleUrl, 0);
    const cues = cineby.parseSubtitleCues(stripByteOrderMark(srtText));
    if (cues.length === 0) {
        throw new Error('that subtitle file had no usable lines');
    }
    return cues;
}

function readSidecarCues(filePath) {
    const raw = stripByteOrderMark(fs.readFileSync(filePath, 'utf8'));
    const extension = path.extname(filePath).toLowerCase();
    const cleaned = extension === '.ass' || extension === '.ssa'
        ? raw.replace(STYLE_BLOCK_PATTERN, EMPTY_STRING)
        : raw;
    const cues = cineby.parseSubtitleCues(cleaned);
    if (cues.length === 0) {
        throw new Error(`no usable subtitle lines in ${path.basename(filePath)}`);
    }
    return cues;
}

module.exports = {
    fetchCues,
    readSidecarCues,
    toCueJson,
    toWebVtt,
    shiftCues,
    formatWebVttTimestamp,
    stripByteOrderMark
};
