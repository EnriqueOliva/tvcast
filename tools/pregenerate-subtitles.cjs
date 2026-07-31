const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const YT_DLP_PATH = path.join(PROJECT_ROOT, 'bin', 'yt-dlp.exe');
const PYTHON_PATH = 'C:\\workshops\\live-transcript\\.venv\\Scripts\\python.exe';
const TRANSLATE_SCRIPT = path.join(__dirname, 'translate-episode.py');
const SUBTITLE_DIRECTORY = path.join(PROJECT_ROOT, 'cache', 'subtitles');
const AUDIO_DIRECTORY = path.join(PROJECT_ROOT, 'cache', 'audio');
const VIDEO_IDS_PARAMETER = 'video_ids';
const EMPTY_STRING = '';
const DEFAULT_SOURCE_LANGUAGE = 'tr';

function log(message) {
    process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

function extractVideoIdentifiers(sourceUrl) {
    const parsed = new URL(sourceUrl);
    const inline = parsed.searchParams.get(VIDEO_IDS_PARAMETER);
    if (inline !== null && inline !== EMPTY_STRING) {
        return inline.split(',').map((entry) => entry.trim()).filter((entry) => entry !== EMPTY_STRING);
    }
    const listed = spawnSync(YT_DLP_PATH,
        ['--no-warnings', '--flat-playlist', '--print', '%(id)s', sourceUrl],
        { encoding: 'utf8', windowsHide: true });
    if (listed.status !== 0) {
        throw new Error(`could not list that playlist: ${(listed.stderr || EMPTY_STRING).trim().slice(0, 200)}`);
    }
    return listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry !== EMPTY_STRING);
}

function readEpisodeTitle(videoIdentifier) {
    const printed = spawnSync(YT_DLP_PATH,
        ['--no-warnings', '--print', '%(title)s', `https://www.youtube.com/watch?v=${videoIdentifier}`],
        { encoding: 'utf8', windowsHide: true });
    if (printed.status === 0) {
        return printed.stdout.trim().split(/\r?\n/)[0] || videoIdentifier;
    }
    return videoIdentifier;
}

function downloadAudio(videoIdentifier) {
    const template = path.join(AUDIO_DIRECTORY, `${videoIdentifier}.%(ext)s`);
    const downloaded = spawnSync(YT_DLP_PATH, [
        '--no-warnings', '--no-playlist', '-f', 'bestaudio',
        '-o', template, `https://www.youtube.com/watch?v=${videoIdentifier}`
    ], { encoding: 'utf8', windowsHide: true });
    if (downloaded.status !== 0) {
        throw new Error(`audio download failed: ${(downloaded.stderr || EMPTY_STRING).trim().split('\n').slice(-2).join(' ')}`);
    }
    const candidates = fs.readdirSync(AUDIO_DIRECTORY)
        .filter((entry) => entry.startsWith(`${videoIdentifier}.`));
    if (candidates.length === 0) {
        throw new Error('yt-dlp reported success but wrote no audio file');
    }
    return path.join(AUDIO_DIRECTORY, candidates[0]);
}

function translateAudio(audioPath, subtitlePath, sourceLanguage) {
    const partialPath = `${subtitlePath}.partial`;
    const translated = spawnSync(PYTHON_PATH,
        [TRANSLATE_SCRIPT, audioPath, partialPath, sourceLanguage],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (translated.status !== 0) {
        try {
            fs.unlinkSync(partialPath);
        } catch (error) {
            void error;
        }
        throw new Error(`whisper failed: ${(translated.stderr || EMPTY_STRING).trim().split('\n').slice(-2).join(' ')}`);
    }
    fs.renameSync(partialPath, subtitlePath);
    return (translated.stderr || EMPTY_STRING).trim().split('\n').pop();
}

function main() {
    const sourceUrl = process.argv[2];
    const sourceLanguage = process.argv[3] || DEFAULT_SOURCE_LANGUAGE;
    if (sourceUrl === undefined) {
        process.stderr.write('usage: node tools/pregenerate-subtitles.cjs <playlist-or-watch-url> [source-language]\n');
        process.exit(1);
    }

    fs.mkdirSync(SUBTITLE_DIRECTORY, { recursive: true });
    fs.mkdirSync(AUDIO_DIRECTORY, { recursive: true });

    const identifiers = extractVideoIdentifiers(sourceUrl);
    log(`${identifiers.length} videos in the queue, translating ${sourceLanguage} to English`);

    let done = 0;
    let failed = 0;
    for (let index = 0; index < identifiers.length; index += 1) {
        const videoIdentifier = identifiers[index];
        const subtitlePath = path.join(SUBTITLE_DIRECTORY, `${videoIdentifier}.srt`);
        const position = `${index + 1}/${identifiers.length}`;

        if (fs.existsSync(subtitlePath)) {
            log(`${position} ${videoIdentifier} already done, skipping`);
            done += 1;
            continue;
        }

        const startedAt = Date.now();
        let audioPath = EMPTY_STRING;
        try {
            const title = readEpisodeTitle(videoIdentifier);
            log(`${position} ${videoIdentifier} starting: ${title}`);
            audioPath = downloadAudio(videoIdentifier);
            const summary = translateAudio(audioPath, subtitlePath, sourceLanguage);
            const elapsedMinutes = ((Date.now() - startedAt) / 60000).toFixed(1);
            log(`${position} ${videoIdentifier} done in ${elapsedMinutes} min, ${summary}`);
            done += 1;
        } catch (error) {
            log(`${position} ${videoIdentifier} FAILED: ${error.message}`);
            failed += 1;
        } finally {
            if (audioPath !== EMPTY_STRING && fs.existsSync(audioPath)) {
                fs.unlinkSync(audioPath);
            }
        }
    }

    log(`finished: ${done} ready, ${failed} failed`);
}

main();
