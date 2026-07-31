const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PYTHON = 'C:\\workshops\\live-transcript\\.venv\\Scripts\\python.exe';
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');
const MODEL_SIZE = 'small.en';
const SEGMENTS_PER_WINDOW = 16;
const MINIMUM_CUE_WORDS = 5;
const MINIMUM_MATCH_SCORE = 0.6;
const MINIMUM_MATCHES = 5;
const MATCH_TOLERANCE_SECONDS = 2.5;
const SHIFT_SEARCH_SECONDS = 400;
const SHIFT_STEP_SECONDS = 0.25;
const MILLISECONDS_PER_SECOND = 1000;
const EMPTY_STRING = '';

function log(message) {
    process.stdout.write(`${message}\n`);
}

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
                reject(new Error(standardError.slice(-300) || `exit ${code}`));
            }
        });
    });
}

async function loadTimeline(playlistUrl) {
    const text = await (await fetch(playlistUrl)).text();
    const lines = text.split(/\r?\n/);
    const segments = [];
    let elapsedSeconds = 0;
    let pendingDuration = 0;
    for (const line of lines) {
        const durationMatch = /^#EXTINF:([0-9.]+)/.exec(line);
        if (durationMatch !== null) {
            pendingDuration = Number(durationMatch[1]);
        } else if (line !== EMPTY_STRING && line.startsWith('#') === false) {
            segments.push({ url: line.trim(), start: elapsedSeconds, duration: pendingDuration });
            elapsedSeconds += pendingDuration;
            pendingDuration = 0;
        }
    }
    return segments;
}

async function buildWindowAudio(segments, startIndex, audioPath) {
    const rawPath = `${audioPath}.ts`;
    const chunks = [];
    for (let index = startIndex; index < Math.min(startIndex + SEGMENTS_PER_WINDOW, segments.length); index += 1) {
        const response = await fetch(segments[index].url);
        if (response.ok === false) {
            throw new Error(`segment ${index} returned HTTP ${response.status}`);
        }
        chunks.push(Buffer.from(await response.arrayBuffer()));
    }
    fs.writeFileSync(rawPath, Buffer.concat(chunks));
    await runProcess('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', rawPath,
        '-vn', '-ac', '1', '-ar', '16000',
        '-y', audioPath
    ]);
    fs.unlinkSync(rawPath);
}

function findBestShift(spokenLines, cues, windowStartSeconds) {
    const usableCues = cues.filter((cue) => normaliseWords(cue.t).length >= MINIMUM_CUE_WORDS);
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
                const cueStart = cue.s / MILLISECONDS_PER_SECOND;
                if (Math.abs(cueStart - targetSeconds) > MATCH_TOLERANCE_SECONDS) {
                    continue;
                }
                const cueWords = normaliseWords(cue.t);
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

async function main() {
    const publicationId = process.argv[2];
    const subtitleId = process.argv[3] || 'english';
    const baseUrl = process.argv[4] || 'http://127.0.0.1:8787';
    const requestedStarts = (process.argv[5] || '600,1400,2200').split(',').map(Number);

    if (publicationId === undefined) {
        log('usage: node tools/measure-sync.cjs <publicationId> [subtitleId] [baseUrl] [windowStarts]');
        process.exit(1);
    }

    const segments = await loadTimeline(`${baseUrl}/hls/${publicationId}/video.m3u8`);
    const cues = await (await fetch(`${baseUrl}/sub/${publicationId}/${encodeURIComponent(subtitleId)}.json`)).json();
    log(`${segments.length} segments, ${cues.length} cues`);
    log(`  video runs ${(segments[segments.length - 1].start + segments[segments.length - 1].duration).toFixed(0)}s`);
    log(`  cues span ${(cues[0].s / MILLISECONDS_PER_SECOND).toFixed(0)}s to ${(cues[cues.length - 1].e / MILLISECONDS_PER_SECOND).toFixed(0)}s`);

    const results = [];
    for (const requestedStart of requestedStarts) {
        const startIndex = segments.findIndex((segment) => segment.start >= requestedStart);
        if (startIndex < 0) {
            continue;
        }
        const exactStart = segments[startIndex].start;
        const audioPath = path.join(os.tmpdir(), `tvcast-sync-${startIndex}.wav`);
        try {
            await buildWindowAudio(segments, startIndex, audioPath);
            const spoken = JSON.parse(await runProcess(PYTHON, [TRANSCRIBE_SCRIPT, audioPath, MODEL_SIZE, '0']));
            const best = findBestShift(spoken, cues, exactStart);
            if (best.matches >= MINIMUM_MATCHES) {
                log(`  window at ${exactStart.toFixed(0)}s: subtitles are ${best.shift >= 0 ? 'LATE' : 'EARLY'} by ${Math.abs(best.shift).toFixed(2)}s  (${best.matches} of ${spoken.length} lines matched)`);
                results.push({ start: exactStart, shift: best.shift });
            } else {
                log(`  window at ${exactStart.toFixed(0)}s: INCONCLUSIVE (${best.matches} matches, best shift ${best.shift.toFixed(1)}s)`);
            }
        } catch (error) {
            log(`  window at ${exactStart.toFixed(0)}s: FAILED ${error.message.slice(0, 140)}`);
        } finally {
            try {
                fs.unlinkSync(audioPath);
            } catch (error) {
                void error;
            }
        }
    }

    if (results.length >= 2) {
        const spread = Math.max(...results.map((entry) => entry.shift)) - Math.min(...results.map((entry) => entry.shift));
        const median = results.map((entry) => entry.shift).sort((left, right) => left - right)[Math.floor(results.length / 2)];
        log('');
        log(`  agreement across windows: ${spread.toFixed(2)}s spread`);
        if (spread < 1.5) {
            log(`  VERDICT: constant offset. Subtitles need shifting by ${(-median).toFixed(2)}s`);
            log(`           subtitleOffsetMilliseconds = ${Math.round(-median * MILLISECONDS_PER_SECOND)}`);
        } else {
            log(`  VERDICT: windows disagree by ${spread.toFixed(1)}s, so this is not a single offset.`);
        }
    }
}

main().catch((error) => {
    log(`crashed: ${error.message}`);
    process.exit(1);
});
