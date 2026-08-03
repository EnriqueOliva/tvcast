const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const activityJournal = require('../lib/activity');
const { createApplication } = require('../server.js');

const EMPTY_STRING = '';
const INDETERMINATE = -1;

// Every screen in capyTV asks the same endpoint what the pc is busy with. If the journal
// lies, both the phone and the television lie with it, so this is worth pinning hard.

function makeTemporaryStatePath(name) {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capytv-activity-')), `${name}.json`);
}

async function withServer(overrides, body) {
    const application = createApplication(Object.assign({
        configuration: { port: 0, libraryRoots: [] },
        stateFilePath: makeTemporaryStatePath('state'),
        fetchImplementation: async () => {
            throw new Error('no television on this network');
        }
    }, overrides));
    const server = http.createServer(application.handleRequest);
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await body({ base, application });
    } finally {
        await new Promise((closed) => server.close(closed));
    }
}

async function readJson(base, route, options) {
    const response = await fetch(`${base}${route}`, options);
    return response.json();
}

function heldOpen() {
    let release = null;
    const promise = new Promise((resolveHold) => {
        release = resolveHold;
    });
    return { promise, release };
}

test('a fresh journal is running nothing and remembers nothing', () => {
    const journal = activityJournal.createActivityJournal();
    assert.deepEqual(journal.snapshot(), { running: [], finished: [] });
    assert.equal(journal.busiest(), null);
});

test('an entry appears while it runs and moves to finished when it is done', () => {
    const journal = activityJournal.createActivityJournal();
    const entry = journal.begin(activityJournal.KIND_RESOLVE, 'a link');

    assert.equal(journal.listRunning().length, 1);
    assert.equal(journal.listRunning()[0].label, 'a link');
    assert.equal(journal.listRunning()[0].outcome, activityJournal.OUTCOME_RUNNING);
    assert.equal(journal.listFinished().length, 0);

    journal.succeed(entry, 'playing on the tv', EMPTY_STRING);
    assert.equal(journal.listRunning().length, 0);
    assert.equal(journal.listFinished().length, 1);
    assert.equal(journal.listFinished()[0].stage, 'playing on the tv');
    assert.equal(journal.listFinished()[0].outcome, activityJournal.OUTCOME_DONE);
});

test('a stage report updates what the ui would show without ending the entry', () => {
    const journal = activityJournal.createActivityJournal();
    const entry = journal.begin(activityJournal.KIND_RESOLVE, 'a link');
    const report = journal.reporterFor(entry);

    report('looking up the title');
    assert.equal(journal.listRunning()[0].stage, 'looking up the title');
    assert.equal(journal.listRunning()[0].percent, INDETERMINATE);

    report('checking 6 streams', { detail: '4 of 6 checked', percent: 67 });
    const running = journal.listRunning()[0];
    assert.equal(running.stage, 'checking 6 streams');
    assert.equal(running.detail, '4 of 6 checked');
    assert.equal(running.percent, 67);
    assert.equal(running.outcome, activityJournal.OUTCOME_RUNNING);
});

test('a reported label replaces the placeholder the url started as', () => {
    const journal = activityJournal.createActivityJournal();
    const entry = journal.begin(activityJournal.KIND_RESOLVE, 'https://example.com/watch');
    journal.reporterFor(entry)('asking 4 sources', { label: 'Fight Club' });
    assert.equal(journal.listRunning()[0].label, 'Fight Club');
});

test('an empty label report does not wipe the label already there', () => {
    const journal = activityJournal.createActivityJournal();
    const entry = journal.begin(activityJournal.KIND_RESOLVE, 'Fight Club');
    journal.reporterFor(entry)('loading subtitles', { label: EMPTY_STRING });
    assert.equal(journal.listRunning()[0].label, 'Fight Club');
});

test('a failure is kept with its reason so the ui can say what went wrong', () => {
    const journal = activityJournal.createActivityJournal();
    const entry = journal.begin(activityJournal.KIND_RESOLVE, 'a link');
    journal.fail(entry, 'the seed request returned HTTP 429');

    assert.equal(journal.listRunning().length, 0);
    const failed = journal.listFinished()[0];
    assert.equal(failed.outcome, activityJournal.OUTCOME_FAILED);
    assert.equal(failed.detail, 'the seed request returned HTTP 429');
});

test('finishing an entry twice does not file it twice', () => {
    const journal = activityJournal.createActivityJournal();
    const entry = journal.begin(activityJournal.KIND_RESOLVE, 'a link');
    journal.succeed(entry, 'done', EMPTY_STRING);
    journal.fail(entry, 'and again');
    assert.equal(journal.listFinished().length, 1);
    assert.equal(journal.listFinished()[0].outcome, activityJournal.OUTCOME_DONE);
});

test('reporting on a missing entry is ignored rather than thrown', () => {
    const journal = activityJournal.createActivityJournal();
    assert.equal(journal.step(null, 'nowhere'), null);
    assert.equal(journal.fail(undefined, 'nowhere'), null);
    assert.deepEqual(journal.snapshot(), { running: [], finished: [] });
});

test('several things running at once are all reported', () => {
    const journal = activityJournal.createActivityJournal();
    const first = journal.begin(activityJournal.KIND_RESOLVE, 'a film');
    journal.begin(activityJournal.KIND_DOWNLOAD, 'a download');
    journal.begin(activityJournal.KIND_SCAN, 'saved media');

    assert.equal(journal.listRunning().length, 3);
    assert.equal(journal.busiest().id, first.id);
    const kinds = journal.listRunning().map((entry) => entry.kind).sort();
    assert.deepEqual(kinds, ['download', 'resolve', 'scan']);
});

test('the finished list keeps the newest first and does not grow without bound', () => {
    const journal = activityJournal.createActivityJournal();
    for (let index = 0; index < 25; index += 1) {
        journal.succeed(journal.begin(activityJournal.KIND_RESOLVE, `item ${index}`), 'done', EMPTY_STRING);
    }
    const finished = journal.listFinished();
    assert.ok(finished.length <= 10, `the journal kept ${finished.length} finished entries`);
    assert.equal(finished[0].label, 'item 24');
});

test('a snapshot is a copy, so a caller cannot edit the journal by accident', () => {
    const journal = activityJournal.createActivityJournal();
    journal.begin(activityJournal.KIND_RESOLVE, 'a link');
    const snapshot = journal.snapshot();
    snapshot.running[0].stage = 'tampered';
    assert.notEqual(journal.listRunning()[0].stage, 'tampered');
});

test('user action: the activity endpoint is empty when the pc is doing nothing', async () => {
    await withServer({}, async ({ base }) => {
        const snapshot = await readJson(base, '/api/activity');
        assert.deepEqual(snapshot.running, []);
        assert.deepEqual(snapshot.finished, []);
    });
});

test('user action: sending a link shows a live stage while the pc works on it', async () => {
    const hold = heldOpen();
    await withServer({
        resolveMedia: async (pageUrl, options) => {
            options.onStage('looking up the title');
            options.onStage('checking 6 streams', { detail: '4 of 6 checked', percent: 67 });
            await hold.promise;
            return { title: 'Fight Club', streamUrl: 'http://x/y.m3u8', streamKind: 'hls', subtitleTracks: [] };
        }
    }, async ({ base }) => {
        const sending = fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.cineby.at/movie/550' })
        });
        await new Promise((settled) => setTimeout(settled, 60));

        const during = await readJson(base, '/api/activity');
        assert.equal(during.running.length, 1);
        assert.equal(during.running[0].stage, 'checking 6 streams');
        assert.equal(during.running[0].detail, '4 of 6 checked');
        assert.equal(during.running[0].percent, 67);
        assert.equal(during.running[0].kind, 'resolve');

        hold.release();
        await sending;

        const after = await readJson(base, '/api/activity');
        assert.deepEqual(after.running, []);
        assert.equal(after.finished[0].label, 'Fight Club');
        assert.equal(after.finished[0].outcome, 'done');
    });
});

test('user action: a link that cannot be resolved says so in the activity feed', async () => {
    await withServer({
        resolveMedia: async () => {
            throw new Error('Cineby found no source for that title');
        }
    }, async ({ base }) => {
        const outcome = await readJson(base, '/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.cineby.at/movie/1' })
        });
        assert.equal(outcome.ok, false);

        const snapshot = await readJson(base, '/api/activity');
        assert.deepEqual(snapshot.running, []);
        assert.equal(snapshot.finished[0].outcome, 'failed');
        assert.equal(snapshot.finished[0].detail, 'Cineby found no source for that title');
    });
});

test('user action: the feed says whether the tv actually took the film', async () => {
    await withServer({
        resolveMedia: async () => ({
            title: 'Fight Club', streamUrl: 'http://x/y.m3u8', streamKind: 'hls', subtitleTracks: []
        })
    }, async ({ base }) => {
        await readJson(base, '/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.cineby.at/movie/550' })
        });
        const snapshot = await readJson(base, '/api/activity');
        assert.equal(snapshot.finished[0].stage, 'waiting for the tv',
            'with no television reachable the feed must not claim it is playing');
        assert.equal(snapshot.finished[0].detail, 'the Fire TV app is not reachable');
    });
});

test('user action: rescanning the saved media is reported and counted', async () => {
    await withServer({}, async ({ base }) => {
        const outcome = await readJson(base, '/api/scan', { method: 'POST' });
        assert.equal(typeof outcome.count, 'number');

        const snapshot = await readJson(base, '/api/activity');
        assert.equal(snapshot.finished[0].kind, 'scan');
        assert.equal(snapshot.finished[0].stage, `found ${outcome.count} videos`);
    });
});

test('user action: a download shows its own progress separately from a resolve', async () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    await withServer({
        configuration: { port: 0, libraryRoots: [fs.mkdtempSync(path.join(os.tmpdir(), 'capytv-media-'))] },
        startDownload: (pageUrl, targetDirectory, onProgress) => {
            setTimeout(() => onProgress({ percent: 41.8, line: '[download]  41.8% of ~1.20GiB' }), 10);
            return child;
        }
    }, async ({ base }) => {
        await readJson(base, '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/video' })
        });
        await new Promise((settled) => setTimeout(settled, 60));

        const during = await readJson(base, '/api/activity');
        assert.equal(during.running.length, 1);
        assert.equal(during.running[0].kind, 'download');
        assert.equal(during.running[0].stage, 'saving to the pc');
        assert.equal(Math.round(during.running[0].percent), 42);

        child.emit('close', 0);
        await new Promise((settled) => setTimeout(settled, 40));
        const after = await readJson(base, '/api/activity');
        assert.deepEqual(after.running, []);
        assert.equal(after.finished[0].stage, 'saved on the pc');
    });
});

test('user action: a download that fails is reported as failed, not as saved', async () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    await withServer({
        configuration: { port: 0, libraryRoots: [fs.mkdtempSync(path.join(os.tmpdir(), 'capytv-media-'))] },
        startDownload: (pageUrl, targetDirectory, onProgress) => {
            setTimeout(() => onProgress({ line: 'ERROR: unable to download video data' }), 10);
            return child;
        }
    }, async ({ base }) => {
        await readJson(base, '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/video' })
        });
        await new Promise((settled) => setTimeout(settled, 40));
        child.emit('close', 1);
        await new Promise((settled) => setTimeout(settled, 40));

        const snapshot = await readJson(base, '/api/activity');
        assert.equal(snapshot.finished[0].outcome, 'failed');
        assert.match(snapshot.finished[0].detail, /unable to download video data/);
    });
});

test('user action: a download names the file once yt-dlp reveals it', async () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    await withServer({
        configuration: { port: 0, libraryRoots: [fs.mkdtempSync(path.join(os.tmpdir(), 'capytv-media-'))] },
        startDownload: (pageUrl, targetDirectory, onProgress) => {
            setTimeout(() => {
                onProgress({ line: '[download] Destination: B:\\Media\\Omer.S01E03.1080p.f137.mp4' });
                onProgress({ percent: 12, line: '[download]  12.0% of ~1.20GiB' });
            }, 10);
            return child;
        }
    }, async ({ base }) => {
        await readJson(base, '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/video' })
        });
        await new Promise((settled) => setTimeout(settled, 60));

        const during = await readJson(base, '/api/activity');
        assert.equal(during.running[0].label, 'Omer.S01E03.1080p',
            'the feed should name the file, not keep showing the raw url');
    });
});

test('user action: a download and a send at the same time are both reported', async () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    const hold = heldOpen();
    await withServer({
        configuration: { port: 0, libraryRoots: [fs.mkdtempSync(path.join(os.tmpdir(), 'capytv-media-'))] },
        startDownload: (pageUrl, targetDirectory, onProgress) => {
            setTimeout(() => onProgress({ percent: 5, line: '[download]   5.0%' }), 10);
            return child;
        },
        resolveMedia: async (pageUrl, options) => {
            options.onStage('asking 4 sources');
            await hold.promise;
            return { title: 'Fight Club', streamUrl: 'http://x/y.m3u8', streamKind: 'hls', subtitleTracks: [] };
        }
    }, async ({ base }) => {
        await readJson(base, '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/video' })
        });
        const sending = fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.cineby.at/movie/550' })
        });
        await new Promise((settled) => setTimeout(settled, 60));

        const during = await readJson(base, '/api/activity');
        assert.equal(during.running.length, 2, 'both jobs should be visible at once');
        const kinds = during.running.map((entry) => entry.kind).sort();
        assert.deepEqual(kinds, ['download', 'resolve']);

        hold.release();
        await sending;
        child.emit('close', 0);
    });
});

test('user action: the phone is told when no subtitle track would load', async () => {
    await withServer({
        resolveMedia: async () => ({
            title: 'Fight Club',
            streamUrl: 'http://x/y.m3u8',
            streamKind: 'hls',
            subtitleTracks: [{ identifier: 'english', language: 'English', url: 'http://dead.invalid/a.srt' }]
        })
    }, async ({ base }) => {
        const outcome = await readJson(base, '/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.cineby.at/movie/550' })
        });
        assert.equal(outcome.selectedSubtitleId, EMPTY_STRING,
            'a track that will not load must not be reported as selected');
        assert.match(outcome.subtitleWarning, /no subtitle track would load/,
            'the phone was given no reason for the missing subtitles');
        assert.match(outcome.subtitleWarning, /English/,
            'the warning should name the track that refused');
    });
});

test('user action: a subtitle track that loads carries no warning', async () => {
    await withServer({
        resolveMedia: async () => ({
            title: 'Fight Club',
            streamUrl: 'http://x/y.m3u8',
            streamKind: 'hls',
            subtitleTracks: [{
                identifier: 'english',
                language: 'English',
                url: EMPTY_STRING,
                localPath: writeSubtitleFixture()
            }]
        })
    }, async ({ base }) => {
        const outcome = await readJson(base, '/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.cineby.at/movie/550' })
        });
        assert.equal(outcome.selectedSubtitleId, 'english');
        assert.equal(outcome.subtitleWarning, EMPTY_STRING);
    });
});

function writeSubtitleFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capytv-subs-'));
    const filePath = path.join(directory, 'english.srt');
    fs.writeFileSync(filePath,
        '1\n00:00:01,000 --> 00:00:03,000\nhello\n\n2\n00:00:04,000 --> 00:00:06,000\nthere\n', 'utf8');
    return filePath;
}
