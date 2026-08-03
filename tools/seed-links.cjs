const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const YT_DLP_PATH = path.join(PROJECT_ROOT, 'bin', 'yt-dlp.exe');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const VIDEO_IDS_PARAMETER = 'video_ids';
const EMPTY_STRING = '';
const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const DEFAULT_COLLECTION = 'main';

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

function extractVideoIdentifiers(sourceUrl) {
    const inline = new URL(sourceUrl).searchParams.get(VIDEO_IDS_PARAMETER);
    if (inline !== null && inline !== EMPTY_STRING) {
        return inline.split(',').map((entry) => entry.trim()).filter((entry) => entry !== EMPTY_STRING);
    }
    const listed = spawnSync(YT_DLP_PATH,
        buildYtDlpArguments(['--flat-playlist', '--print', '%(id)s', sourceUrl]),
        { encoding: 'utf8', windowsHide: true });
    if (listed.status !== 0) {
        throw new Error(`could not list that playlist: ${(listed.stderr || EMPTY_STRING).trim().slice(0, 200)}`);
    }
    return listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry !== EMPTY_STRING);
}

function readTitles(identifiers) {
    const urls = identifiers.map((identifier) => `https://www.youtube.com/watch?v=${identifier}`);
    const printed = spawnSync(YT_DLP_PATH,
        buildYtDlpArguments(['--flat-playlist', '--print', '%(id)s\t%(title)s'].concat(urls)),
        { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const titles = new Map();
    for (const line of (printed.stdout || EMPTY_STRING).split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts.length === 2 && parts[0].trim() !== EMPTY_STRING) {
            titles.set(parts[0].trim(), parts[1].trim());
        }
    }
    return titles;
}

async function main() {
    const sourceUrl = process.argv[2];
    const collection = process.argv[3] || DEFAULT_COLLECTION;
    const serverBaseUrl = process.argv[4] || DEFAULT_SERVER;
    if (sourceUrl === undefined) {
        process.stderr.write('usage: node tools/seed-links.cjs <playlist-or-watch-url> [collection] [server-base-url]\n');
        process.exit(1);
    }

    const identifiers = extractVideoIdentifiers(sourceUrl);
    log(`${identifiers.length} videos found, fetching titles in one pass`);
    const titles = readTitles(identifiers);
    log(`${titles.size} titles resolved`);

    let stored = 0;
    for (const identifier of identifiers.slice().reverse()) {
        const pageUrl = `https://www.youtube.com/watch?v=${identifier}`;
        const response = await fetch(`${serverBaseUrl}/api/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: pageUrl,
                title: titles.get(identifier) || pageUrl,
                collection
            })
        });
        if (response.ok) {
            stored += 1;
        } else {
            log(`could not store ${identifier}: HTTP ${response.status}`);
        }
    }
    log(`${stored} links stored on the pc under "${collection}"`);
}

main();
