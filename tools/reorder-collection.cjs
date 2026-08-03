const fs = require('node:fs');
const path = require('node:path');

const STATE_PATH = path.join(__dirname, '..', 'tvstate.json');
const EPISODE_NUMBER_PATTERN = /(\d+)\s*\.\s*B[oö]l[uü]m/i;
const ONE_MINUTE_MILLISECONDS = 60000;
const NO_EPISODE = Number.MAX_SAFE_INTEGER;

function episodeNumberOf(title) {
    const matched = EPISODE_NUMBER_PATTERN.exec(String(title || ''));
    if (matched === null) {
        return NO_EPISODE;
    }
    return Number(matched[1]);
}

function main() {
    const collection = process.argv[2];
    if (collection === undefined) {
        process.stderr.write('usage: node tools/reorder-collection.cjs <collection>\n');
        process.exit(1);
    }
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const links = state.links || [];
    const members = links.filter((entry) => (entry.collection || 'main') === collection);
    if (members.length === 0) {
        process.stderr.write(`no links in "${collection}"\n`);
        process.exit(1);
    }

    members.sort((left, right) => episodeNumberOf(left.title) - episodeNumberOf(right.title));

    // The list shows the newest addedAt first, so episode one needs the latest stamp.
    const base = Date.now();
    members.forEach((entry, index) => {
        entry.addedAt = base - index * ONE_MINUTE_MILLISECONDS;
    });

    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    process.stdout.write(`${members.length} links in "${collection}" put back in episode order\n`);
    for (const entry of members.slice(0, 3)) {
        process.stdout.write(`  ${entry.title}\n`);
    }
    process.stdout.write('  ...\n');
    for (const entry of members.slice(-2)) {
        process.stdout.write(`  ${entry.title}\n`);
    }
}

main();
