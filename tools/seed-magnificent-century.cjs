const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The Magnificent Century channel carries the whole run plus thousands of short clips, and
// most episodes were uploaded more than once. Keep only the full episodes, one upload each,
// and file them in running order.

const PROJECT_ROOT = path.join(__dirname, '..');
const YT_DLP_PATH = path.join(PROJECT_ROOT, 'bin', 'yt-dlp.exe');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const CHANNEL_URL = 'https://www.youtube.com/channel/UCXQWPE9GietMsPVvqL3KiEQ/videos';
const COLLECTION = 'suleiman';
const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const EMPTY_STRING = '';

const EPISODE_TITLE_PATTERN = /^Magnificent Century Episode (\d+)\b/;
const SHORTEST_REAL_EPISODE_SECONDS = 3000;
const ULTRA_HIGH_DEFINITION_SCORE = 400;
const REMASTERED_SCORE = 200;
const HIGH_DEFINITION_SCORE = 100;

function log(message) {
    process.stdout.write(`${message}\n`);
}

function loadConfiguration() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        void error;
        return {};
    }
}

function buildYtDlpArguments(specific) {
    const configuration = loadConfiguration();
    const shared = ['--no-warnings', '--encoding', 'UTF-8'];
    if (configuration.ytdlpCookiesFromBrowser) {
        shared.push('--cookies-from-browser', configuration.ytdlpCookiesFromBrowser);
    }
    for (const extra of configuration.ytdlpExtraArgs || []) {
        shared.push(extra);
    }
    return shared.concat(specific);
}

function listChannelVideos(cachePath) {
    if (cachePath !== undefined && fs.existsSync(cachePath)) {
        log(`reading the channel listing from ${cachePath}`);
        return fs.readFileSync(cachePath, 'utf8');
    }
    log('listing every video on the channel, this takes a couple of minutes');
    const listed = spawnSync(YT_DLP_PATH,
        buildYtDlpArguments(['--flat-playlist', '--print', '%(id)s|%(duration)s|%(title)s', CHANNEL_URL]),
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) {
        throw new Error(`could not list the channel: ${(listed.stderr || EMPTY_STRING).trim().slice(0, 300)}`);
    }
    if (cachePath !== undefined) {
        fs.writeFileSync(cachePath, listed.stdout, 'utf8');
    }
    return listed.stdout;
}

// A 4K remaster beats a plain HD re-upload of the same episode, and a longer cut beats a
// shorter one when the labels are equal.
function scoreUpload(title, durationSeconds) {
    let score = 0;
    if (/\b4K\b/i.test(title)) {
        score += ULTRA_HIGH_DEFINITION_SCORE;
    }
    if (/REMASTERED/i.test(title)) {
        score += REMASTERED_SCORE;
    }
    if (/\bHD\b/i.test(title)) {
        score += HIGH_DEFINITION_SCORE;
    }
    return { score, durationSeconds };
}

function isBetter(candidate, existing) {
    if (existing === undefined) {
        return true;
    }
    if (candidate.score !== existing.score) {
        return candidate.score > existing.score;
    }
    return candidate.durationSeconds > existing.durationSeconds;
}

function collectEpisodes(listing) {
    const bestByNumber = new Map();
    let considered = 0;
    for (const line of listing.split(/\r?\n/)) {
        if (line === EMPTY_STRING) {
            continue;
        }
        const firstBar = line.indexOf('|');
        const secondBar = line.indexOf('|', firstBar + 1);
        if (firstBar < 0 || secondBar < 0) {
            continue;
        }
        const identifier = line.slice(0, firstBar);
        const durationSeconds = Number(line.slice(firstBar + 1, secondBar));
        const title = line.slice(secondBar + 1).trim();
        const matched = EPISODE_TITLE_PATTERN.exec(title);
        if (matched === null || durationSeconds < SHORTEST_REAL_EPISODE_SECONDS) {
            continue;
        }
        considered += 1;
        const number = Number(matched[1]);
        const ranked = Object.assign({ identifier, title, number }, scoreUpload(title, durationSeconds));
        if (isBetter(ranked, bestByNumber.get(number))) {
            bestByNumber.set(number, ranked);
        }
    }
    log(`${considered} full episode uploads, ${bestByNumber.size} distinct episodes`);
    return Array.from(bestByNumber.values()).sort((left, right) => left.number - right.number);
}

function buildDisplayTitle(episode) {
    return `Magnificent Century ${String(episode.number).padStart(3, '0')}`;
}

async function main() {
    const serverBaseUrl = process.argv[2] || DEFAULT_SERVER;
    const cachePath = process.argv[3];
    const episodes = collectEpisodes(listChannelVideos(cachePath));
    if (episodes.length === 0) {
        throw new Error('no episodes found on that channel');
    }
    log(`episodes ${episodes[0].number} to ${episodes[episodes.length - 1].number}`);

    // A collection is shown newest first, so the last one stored is the one that appears at
    // the top. Store them backwards and episode one lands where it belongs.
    let stored = 0;
    for (const episode of episodes.slice().reverse()) {
        const pageUrl = `https://www.youtube.com/watch?v=${episode.identifier}`;
        const response = await fetch(`${serverBaseUrl}/api/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: pageUrl,
                title: buildDisplayTitle(episode),
                collection: COLLECTION
            })
        });
        if (response.ok) {
            stored += 1;
        } else {
            log(`could not store episode ${episode.number}: HTTP ${response.status}`);
        }
    }
    log(`${stored} episodes stored on the pc under "${COLLECTION}"`);
}

main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
});
