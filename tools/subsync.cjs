const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cineby = require('../lib/cineby');

const PYTHON_CANDIDATES = [
    'C:\\workshops\\live-transcript\\.venv\\Scripts\\python.exe',
    'C:\\workshops\\sotvox\\.venv\\Scripts\\python.exe'
];
const PYTHON = PYTHON_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || PYTHON_CANDIDATES[0];
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');
const SAMPLE_PORT = 8913;
const BIN_SECONDS = 0.02;
const MAX_SHIFT_SECONDS = 30;
const WINDOW_SECONDS = 240;
const SAMPLE_FRACTIONS = [0.08, 0.28, 0.48, 0.68, 0.88];

function log(message) {
    process.stdout.write(`${message}\n`);
}

function servePlaylist(text) {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        response.end(text);
    });
    return new Promise((resolve) => {
        server.listen(SAMPLE_PORT, '127.0.0.1', () => resolve(server));
    });
}

function extractAudio(headers, outputPath, seconds) {
    const headerText = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n') + '\r\n';
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-allowed_extensions', 'ALL', '-extension_picky', '0',
        '-headers', headerText,
        '-i', `http://127.0.0.1:${SAMPLE_PORT}/p.m3u8`,
        '-t', String(seconds),
        '-vn', '-ac', '1', '-ar', '16000',
        outputPath, '-y'
    ];
    return new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args, { windowsHide: true });
        let errorText = '';
        child.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(errorText.slice(-300)));
            }
        });
    });
}

function transcribe(audioPath, modelSize, offsetSeconds) {
    return new Promise((resolve, reject) => {
        const child = spawn(PYTHON, [TRANSCRIBE_SCRIPT, audioPath, modelSize, String(offsetSeconds)], { windowsHide: true });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.stderr.on('data', (chunk) => { err += chunk.toString(); });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(err.slice(-400)));
            } else {
                try {
                    resolve(JSON.parse(out));
                } catch (error) {
                    reject(new Error('transcriber returned unparsable output'));
                }
            }
        });
    });
}

function parseSrtIntervals(srtText) {
    const intervals = [];
    const pattern = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g;
    let match = pattern.exec(srtText);
    while (match !== null) {
        const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
        intervals.push({
            start: toSeconds(match[1], match[2], match[3], match[4]),
            end: toSeconds(match[5], match[6], match[7], match[8])
        });
        match = pattern.exec(srtText);
    }
    return intervals;
}

function buildTimeline(intervals, fromSeconds, toSeconds) {
    const bins = Math.ceil((toSeconds - fromSeconds) / BIN_SECONDS);
    const timeline = new Float64Array(bins);
    for (const interval of intervals) {
        const first = Math.max(0, Math.floor((interval.start - fromSeconds) / BIN_SECONDS));
        const last = Math.min(bins, Math.ceil((interval.end - fromSeconds) / BIN_SECONDS));
        for (let index = first; index < last; index += 1) {
            timeline[index] = 1;
        }
    }
    return timeline;
}

function bestOffset(speech, subtitle) {
    const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
    const speechMean = mean(speech);
    const subtitleMean = mean(subtitle);
    const maxShiftBins = Math.round(MAX_SHIFT_SECONDS / BIN_SECONDS);
    let best = { offsetSeconds: 0, score: -2 };
    for (let shift = -maxShiftBins; shift <= maxShiftBins; shift += 1) {
        let numerator = 0;
        let speechVariance = 0;
        let subtitleVariance = 0;
        for (let index = 0; index < subtitle.length; index += 1) {
            const shifted = index + shift;
            if (shifted < 0 || shifted >= speech.length) {
                continue;
            }
            const a = speech[shifted] - speechMean;
            const b = subtitle[index] - subtitleMean;
            numerator += a * b;
            speechVariance += a * a;
            subtitleVariance += b * b;
        }
        const score = numerator / Math.sqrt((speechVariance * subtitleVariance) || 1);
        if (score > best.score) {
            best = { offsetSeconds: shift * BIN_SECONDS, score };
        }
    }
    return best;
}

function tokenise(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter((word) => word.length > 2);
}

function similarity(leftTokens, rightTokens) {
    if (leftTokens.length === 0 || rightTokens.length === 0) {
        return 0;
    }
    const rightSet = new Set(rightTokens);
    let shared = 0;
    for (const token of leftTokens) {
        if (rightSet.has(token)) {
            shared += 1;
        }
    }
    return shared / Math.min(leftTokens.length, rightTokens.length);
}

const TEXT_SEARCH_RADIUS_SECONDS = 45;
const SIMILARITY_THRESHOLD = 0.5;
const MINIMUM_MATCHES = 6;
const MINIMUM_MATCH_RATE = 0.2;

function measureTextAgreement(spokenSegments, cues) {
    let matched = 0;
    let compared = 0;
    const deltas = [];
    for (const spoken of spokenSegments) {
        const spokenTokens = tokenise(spoken.text);
        if (spokenTokens.length < 3) {
            continue;
        }
        let bestCue = null;
        let bestScore = 0;
        for (const cue of cues) {
            if (Math.abs(cue.start - spoken.start) > TEXT_SEARCH_RADIUS_SECONDS) {
                continue;
            }
            const score = similarity(spokenTokens, tokenise(cue.text));
            if (score > bestScore) {
                bestScore = score;
                bestCue = cue;
            }
        }
        compared += 1;
        if (bestCue !== null && bestScore >= SIMILARITY_THRESHOLD) {
            matched += 1;
            deltas.push(bestCue.start - spoken.start);
        }
    }
    const matchRate = compared === 0 ? 0 : matched / compared;
    const isConfident = matched >= MINIMUM_MATCHES && matchRate >= MINIMUM_MATCH_RATE;
    return { matched, compared, deltas, matchRate, isConfident };
}

function median(values) {
    if (values.length === 0) {
        return null;
    }
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function parseSrtCues(srtText) {
    const cues = [];
    const blocks = srtText.split(/\r?\n\r?\n/);
    for (const block of blocks) {
        const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
        if (lines.length < 2) {
            continue;
        }
        const timing = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(lines.join('\n'));
        if (timing === null) {
            continue;
        }
        const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
        const textLines = lines.filter((line) => /-->/.test(line) === false && /^\d+$/.test(line.trim()) === false);
        cues.push({
            start: toSeconds(timing[1], timing[2], timing[3], timing[4]),
            end: toSeconds(timing[5], timing[6], timing[7], timing[8]),
            text: textLines.join(' ')
        });
    }
    return cues;
}

async function main() {
    const pageUrl = process.argv[2];
    const modelSize = process.argv[3] || 'base.en';
    if (!pageUrl) {
        log('usage: node tools/subsync.cjs <cineby url> [whisper model]');
        process.exit(1);
    }

    log(`resolving ${pageUrl}`);
    const session = await cineby.resolveCineby(pageUrl);
    log(`  ${session.title} | ${session.quality} | ${Math.round(session.totalDurationSeconds / 60)} min | subtitles: ${session.subtitleTracks.map((t) => t.language).join(', ') || 'none'}`);
    if (session.subtitleTracks.length === 0) {
        log('no subtitle track to check');
        return;
    }

    const track = session.subtitleTracks[0];
    const srtText = await cineby.fetchSubtitleAsSrt(track.url, 0);
    const cues = parseSrtCues(srtText);
    const intervals = parseSrtIntervals(srtText);
    log(`  subtitle "${track.language}" from ${track.provider}: ${cues.length} cues`);

    const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'subsync-'));
    const results = [];

    for (const fraction of SAMPLE_FRACTIONS) {
        const requested = session.totalDurationSeconds * fraction;
        const target = cineby.resolveSeekTarget(session.videoTrack, requested);
        const playlist = cineby.buildTrimmedPlaylist(session.videoTrack, target.segmentIndex);
        const server = await servePlaylist(playlist);
        const audioPath = path.join(workDirectory, `w${Math.round(target.startSeconds)}.wav`);
        log(`window at ${(target.startSeconds / 60).toFixed(1)} min: pulling ${WINDOW_SECONDS}s of audio`);
        try {
            await extractAudio(session.headers, audioPath, WINDOW_SECONDS);
        } finally {
            server.close();
        }

        log('  transcribing');
        const spoken = await transcribe(audioPath, modelSize, target.startSeconds);
        if (spoken.length === 0) {
            log('  no speech recognised in this window, skipping');
            continue;
        }

        const from = target.startSeconds;
        const to = target.startSeconds + WINDOW_SECONDS;
        const speechTimeline = buildTimeline(spoken, from, to);
        const subtitleTimeline = buildTimeline(intervals, from, to);
        const correlation = bestOffset(speechTimeline, subtitleTimeline);
        const agreement = measureTextAgreement(spoken, cues);
        const textOffset = median(agreement.deltas);

        results.push({
            filmMinute: target.startSeconds / 60,
            spokenSegments: spoken.length,
            correlationOffset: correlation.offsetSeconds,
            correlationScore: correlation.score,
            matched: agreement.matched,
            compared: agreement.compared,
            textOffset,
            matched: agreement.matched,
            compared: agreement.compared,
            matchRate: agreement.matchRate,
            isConfident: agreement.isConfident
        });

        log(`  speech segments: ${spoken.length}`);
        log(`  correlation offset: ${correlation.offsetSeconds >= 0 ? '+' : ''}${correlation.offsetSeconds.toFixed(2)}s (score ${correlation.score.toFixed(3)})`);
        log(`  text matches: ${agreement.matched}/${agreement.compared} (${(agreement.matchRate * 100).toFixed(0)}%)`
            + (textOffset === null ? '' : `, median delta ${textOffset >= 0 ? '+' : ''}${textOffset.toFixed(2)}s`)
            + (agreement.isConfident ? '' : '  <- too few matches to trust'));
    }

    fs.rmSync(workDirectory, { recursive: true, force: true });

    log('');
    log('=== verdict ===');
    const usable = results.filter((entry) => entry.isConfident && entry.textOffset !== null);
    for (const entry of results.filter((candidate) => candidate.isConfident === false)) {
        log(`  ${entry.filmMinute.toFixed(0).padStart(4)} min: INCONCLUSIVE, only ${entry.matched}/${entry.compared} lines matched`);
    }
    if (usable.length === 0) {
        log('could not align: no window produced enough confident matches.');
        log('That means the transcript and the subtitle do not agree anywhere, which points at');
        log('a subtitle for a different cut rather than a timing offset.');
        return;
    }
    const offsets = usable.map((entry) => entry.textOffset);
    const overall = median(offsets);
    const totalMatched = usable.reduce((sum, entry) => sum + entry.matched, 0);
    const totalCompared = usable.reduce((sum, entry) => sum + entry.compared, 0);
    for (const entry of usable) {
        log(`  ${entry.filmMinute.toFixed(0).padStart(4)} min: ${entry.textOffset >= 0 ? '+' : ''}${entry.textOffset.toFixed(2)}s  (${entry.matched}/${entry.compared} lines matched)`);
    }
    const first = usable[0];
    const last = usable[usable.length - 1];
    const drift = usable.length > 1 ? (last.textOffset - first.textOffset) : 0;
    const spanMinutes = usable.length > 1 ? (last.filmMinute - first.filmMinute) : 0;

    log('');
    log(`  overall offset : ${overall >= 0 ? '+' : ''}${overall.toFixed(2)}s  (positive = subtitles run late)`);
    log(`  drift          : ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s across ${spanMinutes.toFixed(0)} min`);
    log(`  confidence     : ${totalMatched}/${totalCompared} spoken lines matched a cue`);
    const verdict = Math.abs(overall) <= 0.5 && Math.abs(drift) <= 0.5
        ? 'IN SYNC'
        : (Math.abs(drift) > 0.5 ? 'DRIFTING' : 'CONSTANT OFFSET');
    log(`  verdict        : ${verdict}`);
}

main().catch((error) => {
    log(`failed: ${error.message}`);
    process.exit(1);
});
