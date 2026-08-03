const fs = require('node:fs');
const path = require('node:path');

const STATE_PATH = path.join(__dirname, '..', 'tvstate.json');
const MAIN_COLLECTION = 'main';
const YOUTUBE_HOST_PATTERN = /(^|\.)(youtube\.com|youtu\.be)$/i;

function hostOf(sourceUrl) {
    try {
        return new URL(sourceUrl).hostname;
    } catch (error) {
        void error;
        return '';
    }
}

function main() {
    const collection = process.argv[2];
    if (collection === undefined) {
        process.stderr.write('usage: node tools/migrate-collections.cjs <collection-for-existing-youtube-links>\n');
        process.exit(1);
    }
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const links = state.links || [];
    let moved = 0;
    for (const entry of links) {
        if (entry.collection === undefined) {
            entry.collection = YOUTUBE_HOST_PATTERN.test(hostOf(entry.url)) ? collection : MAIN_COLLECTION;
            entry.addedAt = entry.addedAt || entry.lastSentAt || Date.now();
            moved += 1;
        }
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    const counts = new Map();
    for (const entry of links) {
        counts.set(entry.collection, (counts.get(entry.collection) || 0) + 1);
    }
    process.stdout.write(`${moved} links given a collection\n`);
    for (const [name, count] of counts) {
        process.stdout.write(`  ${name}: ${count}\n`);
    }
}

main();
