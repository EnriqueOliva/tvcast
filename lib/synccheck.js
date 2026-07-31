const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PYTHON_PATH = 'C:\\workshops\\live-transcript\\.venv\\Scripts\\python.exe';
const TRANSCRIBE_SCRIPT = path.join(__dirname, '..', 'tools', 'transcribe.py');
const MODEL_SIZE = 'small.en';
const SEGMENTS_PER_WINDOW = 16;
const MINIMUM_CUE_WORDS = 5;
const MINIMUM_MATCH_SCORE = 0.6;
const MINIMUM_MATCHES = 6;
const MATCH_TOLERANCE_SECONDS = 2.5;
const SHIFT_SEARCH_SECONDS = 60;
const SHIFT_STEP_SECONDS = 0.25;
const MAXIMUM_AGREEMENT_SPREAD_SECONDS = 2;
const MILLISECONDS_PER_SECOND = 1000;
const EMPTY_STRING = '';

function normaliseWords(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter((word) => word.length > 2);
}

function runProcess(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        let standardOutput = EMPTY_STRING;
        let standardError = EMPTY_STRING;
        child.stdout.on('data', (chunk) => { standardOutput += chunk.toString(); });
        child.stderr.on('data', (chunk) => { standardError += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve(standardOutput);
            } else {
                reject(new Error(standardError.slice(-200) || `exit ${code}`));
            }
        });
    });
}

function findBestShift(spokenLines, cues, windowStartSeconds) {
    const usableCues = cues.filter((cue) => normaliseWords(cue.lines.join(' ')).length >= MINIMUM_CUE_WORDS);
    let best = { shift: 0, matches: 0 };
    for (let shift = -SHIFT_SEARCH_SECONDS; shift <= SHIFT_SEARCH_SECONDS; shift += SHIFT_STEP_SECONDS) {
        let matches = 0;
        for (const spoken of spokenLines) {
            const spokenWords = new Set(normaliseWords(spoken.text || EMPTY_STRING));
            if (spokenWords.size < MINIMUM_CUE_WORDS) {
                continue;
            }
            const targetSeconds = windowStartSeconds + spoken.start + shift;
            for (const cue of usableCues) {
                if (Math.abs(cue.start - targetSeconds) > MATCH_TOLERANCE_SECONDS) {
                    continue;
                }
                const cueWords = normaliseWords(cue.lines.join(' '));
                let common = 0;
                for (const word of cueWords) {
                    if (spokenWords.has(word)) {
                        common += 1;
                    }
                }
                if (common / cueWords.length >= MINIMUM_MATCH_SCORE) {
                    matches += 1;
                    break;
                }
            }
        }
        if (matches > best.matches) {
            best = { shift, matches };
        }
    }
    return best;
}

async function buildWindowAudio(segmentUrls, headers, startIndex, audioPath) {
    const rawPath = `${audioPath}.ts`;
    const chunks = [];
    const upperBound = Math.min(startIndex + SEGMENTS_PER_WINDOW, segmentUrls.length);
    for (let index = startIndex; index < upperBound; index += 1) {
        const response = await fetch(segmentUrls[index], { headers });
        if (response.ok === false) {
            throw new Error(`segment ${index} returned HTTP ${response.status}`);
        }
        chunks.push(Buffer.from(await response.arrayBuffer()));
    }
    fs.writeFileSync(rawPath, Buffer.concat(chunks));
    await runProcess('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', rawPath, '-vn', '-ac', '1', '-ar', '16000', '-y', audioPath
    ]);
    fs.unlinkSync(rawPath);
}

async function measureOffset(options) {
    const segments = options.segments;
    const cues = options.cues;
    const headers = options.headers || {};
    const totalSeconds = segments[segments.length - 1].start + segments[segments.length - 1].duration;
    const probePoints = [0.35, 0.55, 0.75].map((fraction) => totalSeconds * fraction);
    const segmentUrls = segments.map((segment) => segment.url);
    const results = [];

    for (const probePoint of probePoints) {
        const startIndex = segments.findIndex((segment) => segment.start >= probePoint);
        if (startIndex < 0) {
            continue;
        }
        const audioPath = path.join(os.tmpdir(), `tvcast-verify-${Date.now()}-${startIndex}.wav`);
        try {
            await buildWindowAudio(segmentUrls, headers, startIndex, audioPath);
            const spoken = JSON.parse(await runProcess(PYTHON_PATH, [TRANSCRIBE_SCRIPT, audioPath, MODEL_SIZE, '0']));
            const best = findBestShift(spoken, cues, segments[startIndex].start);
            if (best.matches >= MINIMUM_MATCHES) {
                results.push(best.shift);
            }
        } catch (error) {
            void error;
        } finally {
            try {
                fs.unlinkSync(audioPath);
            } catch (error) {
                void error;
            }
        }
    }

    if (results.length === 0) {
        return { confident: false, mismatched: true, offsetMilliseconds: 0, windows: 0 };
    }
    if (results.length === 1) {
        return { confident: false, mismatched: false, offsetMilliseconds: 0, windows: 1 };
    }

    const spread = Math.max(...results) - Math.min(...results);
    const sorted = results.slice().sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (spread > MAXIMUM_AGREEMENT_SPREAD_SECONDS) {
        return { confident: false, mismatched: false, offsetMilliseconds: 0, windows: results.length, spread };
    }
    return {
        confident: true,
        mismatched: false,
        offsetMilliseconds: Math.round(-median * MILLISECONDS_PER_SECOND),
        windows: results.length,
        spread
    };
}

module.exports = { measureOffset, findBestShift, normaliseWords };
