const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const YT_DLP_PATH = path.join(PROJECT_ROOT, 'bin', 'yt-dlp.exe');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const REPLACEMENT_CHARACTER = '�';
const EMPTY_STRING = '';
const TITLE_BUFFER_BYTES = 16 * 1024 * 1024;

function log(message) {
    process.stdout.write(`${message}\n`);
}

function buildYtDlpArguments(specific) {
    let configuration = {};
    try {
        configuration = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        void error;
    }
    const shared = ['--no-warnings', '--encoding', 'UTF-8'];
    if (configuration.ytdlpCookiesFromBrowser) {
        shared.push('--cookies-from-browser', configuration.ytdlpCookiesFromBrowser);
    }
    for (const extra of configuration.ytdlpExtraArgs || []) {
        shared.push(extra);
    }
    return shared.concat(specific);
}

function readTitles(urls) {
    const printed = spawnSync(YT_DLP_PATH,
        buildYtDlpArguments(['--flat-playlist', '--print', '%(webpage_url)s\t%(title)s'].concat(urls)),
        { windowsHide: true, maxBuffer: TITLE_BUFFER_BYTES });
    const output = (printed.stdout || Buffer.alloc(0)).toString('utf8');
    const titles = new Map();
    for (const line of output.split(/\r?\n/)) {
        const separator = line.indexOf('\t');
        if (separator > 0) {
            titles.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
        }
    }
    return titles;
}

function identifierOf(sourceUrl) {
    try {
        return new URL(sourceUrl).searchParams.get('v') || EMPTY_STRING;
    } catch (error) {
        void error;
        return EMPTY_STRING;
    }
}

async function main() {
    const collection = process.argv[2];
    const serverBaseUrl = process.argv[3] || DEFAULT_SERVER;
    if (collection === undefined) {
        process.stderr.write('usage: node tools/repair-titles.cjs <collection> [server-base-url]\n');
        process.exit(1);
    }

    const listed = await fetch(`${serverBaseUrl}/api/links?collection=${encodeURIComponent(collection)}`);
    const links = (await listed.json()).items || [];
    const broken = links.filter((entry) => entry.title.includes(REPLACEMENT_CHARACTER));
    log(`${links.length} links in "${collection}", ${broken.length} with a mangled title`);
    if (broken.length === 0) {
        return;
    }

    const titles = readTitles(broken.map((entry) => entry.url));
    log(`${titles.size} titles read back in one pass`);

    let repaired = 0;
    for (const entry of broken) {
        const identifier = identifierOf(entry.url);
        let title = titles.get(entry.url);
        if (title === undefined) {
            for (const [key, value] of titles) {
                if (identifier !== EMPTY_STRING && key.includes(identifier)) {
                    title = value;
                }
            }
        }
        if (title === undefined || title.includes(REPLACEMENT_CHARACTER)) {
            log(`  could not repair ${entry.url}`);
            continue;
        }
        const response = await fetch(`${serverBaseUrl}/api/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ url: entry.url, title, collection })
        });
        if (response.ok) {
            repaired += 1;
        } else {
            log(`  server refused ${entry.url}: HTTP ${response.status}`);
        }
    }
    log(`${repaired} titles repaired`);
}

main();
