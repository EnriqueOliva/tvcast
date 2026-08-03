const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

const MUTATIONS = [
    {
        name: 'english is no longer preferred by default',
        file: 'lib/languages.js',
        from: '    return readTrackIdentifier(ordered[0]);',
        to: '    return readTrackIdentifier(ordered[ordered.length - 1]);'
    },
    {
        name: 'subtitle tracks are no longer ordered by language',
        file: 'lib/languages.js',
        from: '    return decorated.map((entry) => entry.track);',
        to: '    return (tracks || []).slice();'
    },
    {
        name: 'the television is no longer capped at 1080p',
        file: 'lib/tvapi.js',
        from: '            maxVideoHeight: TELEVISION_MAXIMUM_HEIGHT,',
        to: '            maxVideoHeight: 0,'
    },
    {
        name: 'links forget which collection they belong to',
        file: 'lib/tvapi.js',
        from: '            belongsTo = existing.collection || MAIN_COLLECTION;',
        to: '            belongsTo = MAIN_COLLECTION;'
    },
    {
        name: 'the language the user watched in is not restored',
        file: 'lib/tvapi.js',
        from: '        if (remembered !== undefined && (rememberedId === SUBTITLE_OFF || stillOffered)) {',
        to: '        if (false) {'
    },
    {
        name: 'a broken subtitle kills the whole send again',
        file: 'lib/tvapi.js',
        from: '        publication.selectedSubtitleId = SUBTITLE_OFF;\n        if (refusals.length > 0) {',
        to: '        throw new Error(\'no subtitle could be loaded\');\n        if (refusals.length > 0) {'
    },
    {
        name: 'a broken subtitle no longer falls through to the next language',
        file: 'lib/tvapi.js',
        from: '        for (const track of order) {',
        to: '        for (const track of order.slice(0, 1)) {'
    },
    {
        name: 'every subtitle choice mints a new publication again',
        file: 'lib/publications.js',
        from: '        .update(String(sourceUrl))',
        to: '        .update(String(sourceUrl) + Math.random())'
    },
    {
        name: 'subtitle shifting moves cues the wrong way',
        file: 'lib/subtitles.js',
        from: '        const start = cue.start + offsetSeconds;\n        const end = cue.end + offsetSeconds;',
        to: '        const start = cue.start - offsetSeconds;\n        const end = cue.end - offsetSeconds;'
    },
    {
        name: 'the resolver ignores the 1080p ceiling',
        file: 'lib/resolve.js',
        from: '    const withinCeiling = candidates.filter((format) => (format.height || NO_HEIGHT) <= ceilingHeight);',
        to: '    const withinCeiling = candidates.slice();'
    },
    {
        name: 'the height ceiling always takes the tallest',
        file: 'lib/resolve.js',
        from: '    const withinCeiling = heights.filter((height) => height <= ceilingHeight);',
        to: '    const withinCeiling = heights.slice();'
    },
    {
        name: 'resume positions are never remembered',
        file: 'lib/tvapi.js',
        from: '            resumePositions.set(contentKey, {',
        to: '            resumePositions.delete(contentKey) || resumePositions.set(contentKey, {'
    },
    {
        name: 'the embed scraper stops following iframes',
        file: 'lib/resolve.js',
        from: '    for (const frameUrl of page.frameUrls) {',
        to: '    for (const frameUrl of []) {'
    },
    {
        name: 'a subtitle file is cached instead of re-read from disk',
        file: 'lib/tvapi.js',
        from: '        if (isLocalFile || track.cues === null || track.cues === undefined) {',
        to: '        if (track.cues === null || track.cues === undefined) {'
    },
    {
        name: 'a series reshuffles whenever an episode is replayed',
        file: 'lib/tvapi.js',
        from: '        return matching.sort((left, right) =>\n            (right.addedAt || right.lastSentAt) - (left.addedAt || left.lastSentAt));',
        to: '        return matching.sort((left, right) => right.lastSentAt - left.lastSentAt);'
    },
    {
        name: 'yt-dlp output is decoded with the wrong codepage again',
        file: 'lib/resolve.js',
        from: "    const argumentList = ['--no-warnings', '--no-playlist', '--encoding', 'UTF-8'];",
        to: "    const argumentList = ['--no-warnings', '--no-playlist'];"
    },
    {
        name: 'a queued push is delivered twice',
        file: 'lib/tvapi.js',
        from: '                const payload = pendingPlayback;\n                pendingPlayback = null;\n                sendJson(response, HTTP_OK, payload);',
        to: '                const payload = pendingPlayback;\n                sendJson(response, HTTP_OK, payload);'
    },
    {
        name: 'the activity feed stops reporting which stage a job reached',
        file: 'lib/activity.js',
        from: '        entry.stage = stage;\n        if (additional.detail !== undefined) {',
        to: '        void stage;\n        if (additional.detail !== undefined) {'
    },
    {
        name: 'a finished job is never cleared from the running list',
        file: 'lib/activity.js',
        from: '        running.delete(entry.id);',
        to: '        void entry.id;'
    },
    {
        name: 'a job that failed is reported as if it had worked',
        file: 'lib/activity.js',
        from: '        return retire(entry, OUTCOME_FAILED, detail);',
        to: '        return retire(entry, OUTCOME_DONE, detail);'
    },
    {
        name: 'the activity feed grows without bound',
        file: 'lib/activity.js',
        from: '        while (finished.length > RECENT_LIMIT) {',
        to: '        while (false) {'
    },
    {
        name: 'a snapshot hands out the journal\'s own entries to edit',
        file: 'lib/activity.js',
        from: '        return Object.assign({}, entry);',
        to: '        return entry;'
    },
    {
        name: 'a job can be filed as finished twice',
        file: 'lib/activity.js',
        from: '        if (entry === null || entry === undefined || entry.outcome !== OUTCOME_RUNNING) {',
        to: '        if (entry === null || entry === undefined) {'
    },
    {
        name: 'a download reports no progress percentage',
        file: 'server.js',
        from: '                percent: job.percent',
        to: '                percent: -1'
    },
    {
        name: 'a download never reveals the name of the file it is saving',
        file: 'server.js',
        from: '    return path.basename(destination[1]).replace(FORMAT_SUFFIX_PATTERN, EMPTY_STRING);',
        to: '    return EMPTY_STRING;'
    },
    {
        name: 'a rescan no longer says how much it found',
        file: 'server.js',
        from: '            activity.succeed(entry, `found ${count} videos`, EMPTY_STRING);',
        to: '            activity.succeed(entry, \'done\', EMPTY_STRING);'
    },
    {
        name: 'the phone is told it is playing even when the tv never took it',
        file: 'lib/tvapi.js',
        from: '            activity.succeed(entry,\n                delivery.delivered ? \'playing on the tv\' : \'waiting for the tv\',',
        to: '            activity.succeed(entry,\n                \'playing on the tv\','
    },
    {
        name: 'subtitles that refuse to load do so silently again',
        file: 'lib/tvapi.js',
        from: '        if (refusals.length > 0) {',
        to: '        if (false) {'
    },
    {
        name: 'the reason subtitles are missing never reaches the player',
        file: 'lib/tvapi.js',
        from: '            subtitleWarning: publication.subtitleWarning || EMPTY_STRING,',
        to: '            subtitleWarning: EMPTY_STRING,'
    },
    {
        name: 'every provider asks the seed service for its own seed again',
        file: 'lib/cineby.js',
        from: '    const encryptedText = await fetchEncryptedSources(provider, metadata, parsed, seed);',
        to: '    const encryptedText = await fetchEncryptedSources(provider, metadata, parsed,\n        (await requestSeed(parsed.tmdbId)).seed);'
    },
    {
        name: 'the seed cache is never consulted',
        file: 'lib/cineby.js',
        from: '    if (cached !== undefined && Date.now() < cached.expiresAt) {\n        return cached.seed;\n    }',
        to: '    void cached;'
    },
    {
        name: 'a seed is cached long past the life the service gave it',
        file: 'lib/cineby.js',
        from: '            const usableFor = issued.ttlMilliseconds - SEED_SAFETY_MARGIN_MILLISECONDS;',
        to: '            const usableFor = 900000;'
    },
    {
        name: 'a seed that comes back rate limited is given up on at once',
        file: 'lib/cineby.js',
        from: '    for (let attempt = FIRST_INDEX; attempt < SEED_ATTEMPTS; attempt += 1) {\n        if (attempt > FIRST_INDEX) {',
        to: '    for (let attempt = FIRST_INDEX; attempt < 1; attempt += 1) {\n        if (attempt > FIRST_INDEX) {'
    },
    {
        name: 'the resolver stops saying what it is doing',
        file: 'lib/cineby.js',
        from: '    reportStage(\'looking up the title\');',
        to: '    void reportStage;'
    }
];

const WINDOWS_LINE_ENDING = '\r\n';
const UNIX_LINE_ENDING = '\n';

function matchLineEndings(text, sourceText) {
    if (sourceText.includes(WINDOWS_LINE_ENDING)) {
        return text.split(UNIX_LINE_ENDING).join(WINDOWS_LINE_ENDING);
    }
    return text;
}

function runSuite() {
    const outcome = spawnSync('node',
        ['--test', '--test-timeout=25000', 'test/playlist.test.js', 'test/subtitles.test.js',
            'test/timeline.test.js', 'test/tvapi.test.js', 'test/useractions.test.js',
            'test/resolver.test.js', 'test/activity.test.js', 'test/cineby-seed.test.js'],
        { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${outcome.stdout || ''}${outcome.stderr || ''}`;
    const failed = (output.match(/^# fail (\d+)$/m) || output.match(/fail (\d+)/) || [])[1];
    const names = [];
    for (const line of output.split(/\r?\n/)) {
        const matched = /^✖ (.+?) \(\d/.exec(line.trim());
        if (matched !== null && names.includes(matched[1]) === false) {
            names.push(matched[1]);
        }
    }
    return { failCount: Number(failed || 0), names };
}

function main() {
    const baseline = runSuite();
    process.stdout.write(`baseline: ${baseline.failCount} failing\n`);
    if (baseline.failCount !== 0) {
        process.stderr.write('the suite must be green before mutating\n');
        process.exit(1);
    }

    let survivors = 0;
    for (const mutation of MUTATIONS) {
        const target = path.join(PROJECT_ROOT, mutation.file);
        const original = fs.readFileSync(target, 'utf8');
        const anchor = matchLineEndings(mutation.from, original);
        const replacement = matchLineEndings(mutation.to, original);
        if (original.indexOf(anchor) === -1) {
            process.stdout.write(`SKIPPED  ${mutation.name} (anchor not found in ${mutation.file})\n`);
            survivors += 1;
            continue;
        }
        fs.writeFileSync(target, original.replace(anchor, replacement), 'utf8');
        let result = null;
        try {
            result = runSuite();
        } finally {
            fs.writeFileSync(target, original, 'utf8');
        }
        if (result.failCount > 0) {
            process.stdout.write(`CAUGHT   ${mutation.name}\n`);
            process.stdout.write(`         ${result.failCount} test(s) died, first: ${result.names[0]}\n`);
        } else {
            process.stdout.write(`SURVIVED ${mutation.name}  <-- no test noticed\n`);
            survivors += 1;
        }
    }
    process.stdout.write(`\n${MUTATIONS.length - survivors}/${MUTATIONS.length} mutations caught\n`);
    process.exit(survivors === 0 ? 0 : 1);
}

main();
