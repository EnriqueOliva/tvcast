const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApplication } = require('../server');

// Everything capyTV owns runs for real here: the real HTTP server, the real routing,
// the real publication store, the real subtitle parser, the real language ordering,
// the real link store and the real state file. The upstream site is a real HTTP server
// too, so subtitles are genuinely fetched, parsed, offset and re-served over the wire.
// The single seam is resolveMedia, the one function that reaches the public internet.
// The shapes it returns here are pinned against the real resolver in resolver.test.js.

const SEGMENT_BODY = Buffer.from('not really video, but really bytes on the wire');
const MINUTE_MILLISECONDS = 60000;

const ENGLISH_VTT = 'WEBVTT\n\n'
    + '00:00:10.000 --> 00:00:13.000\nthe first english line\n\n'
    + '00:00:20.000 --> 00:00:23.000\nthe second english line\n';
const TURKISH_VTT = 'WEBVTT\n\n'
    + '00:00:10.000 --> 00:00:13.000\nbirinci turkce satir\n\n'
    + '00:00:20.000 --> 00:00:23.000\nikinci turkce satir\n';
const SPANISH_VTT = 'WEBVTT\n\n'
    + '00:00:10.000 --> 00:00:13.000\nla primera linea\n';

function startMediaSite() {
    const requested = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        requested.push(url.pathname + url.search);
        const route = url.pathname;

        if (route === '/movie.m3u8' || route.startsWith('/watch')) {
            response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n/1080.m3u8\n');
        } else if (route === '/subs-en.vtt') {
            response.writeHead(200, { 'Content-Type': 'text/vtt' });
            response.end(ENGLISH_VTT);
        } else if (route === '/subs-tr.vtt') {
            response.writeHead(200, { 'Content-Type': 'text/vtt' });
            response.end(TURKISH_VTT);
        } else if (route === '/subs-es.vtt') {
            response.writeHead(200, { 'Content-Type': 'text/vtt' });
            response.end(SPANISH_VTT);
        } else if (route === '/gone.vtt') {
            response.writeHead(404).end('gone');
        } else if (route.endsWith('.ts')) {
            response.writeHead(200, { 'Content-Type': 'video/mp2t' });
            response.end(SEGMENT_BODY);
        } else if (route === '/clip.mp4') {
            response.writeHead(200, { 'Content-Type': 'video/mp4' });
            response.end(SEGMENT_BODY);
        } else {
            response.writeHead(404).end('no such upstream path');
        }
    });
    return new Promise((ready) => {
        server.listen(0, '127.0.0.1', () => {
            ready({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                requested,
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

function startFakeTelevision() {
    const pushed = [];
    const offsets = [];
    let reachable = true;
    const server = http.createServer((request, response) => {
        if (reachable === false) {
            request.socket.destroy();
            return;
        }
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (request.url.startsWith('/ping')) {
                response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"capytv"}');
            } else if (request.url.startsWith('/play')) {
                pushed.push(JSON.parse(raw));
                response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
            } else if (request.url.startsWith('/offset')) {
                offsets.push(JSON.parse(raw));
                response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
            } else {
                response.writeHead(404).end('no');
            }
        });
    });
    return new Promise((ready) => {
        server.listen(0, '127.0.0.1', () => {
            ready({
                port: server.address().port,
                pushed,
                offsets,
                lastPush: () => pushed[pushed.length - 1],
                goOffline: () => { reachable = false; },
                comeOnline: () => { reachable = true; },
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

async function startCapyTv(options) {
    const settings = options || {};
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stateFilePath = settings.stateFilePath
        || path.join(os.tmpdir(), `capytv-useraction-${stamp}.json`);
    const mediaDirectory = settings.mediaDirectory
        || path.join(os.tmpdir(), `capytv-media-${stamp}`);
    fs.mkdirSync(mediaDirectory, { recursive: true });

    const configuration = {
        port: 0,
        libraryRoots: [mediaDirectory],
        televisionPort: settings.televisionPort || 0
    };

    const application = createApplication({
        configuration,
        stateFilePath,
        serverAddress: '127.0.0.1',
        resolveMedia: settings.resolveMedia,
        startDownload: settings.startDownload
    });

    const server = http.createServer(application.handleRequest);
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    configuration.port = server.address().port;
    application.rescanLibrary();

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        application,
        mediaDirectory,
        stateFilePath,
        close: async (options) => {
            await new Promise((done) => server.close(done));
            if ((options || {}).keepState !== true) {
                try {
                    fs.unlinkSync(stateFilePath);
                } catch (error) {
                    void error;
                }
                fs.rmSync(mediaDirectory, { recursive: true, force: true });
            }
        }
    };
}

async function call(harness, pathName, options) {
    const settings = options || {};
    const request = { method: settings.method || 'GET' };
    if (settings.body !== undefined) {
        request.headers = { 'Content-Type': 'application/json' };
        request.body = JSON.stringify(settings.body);
    }
    const response = await fetch(`${harness.baseUrl}${pathName}`, request);
    const text = await response.text();
    let payload = null;
    if (text !== '') {
        payload = JSON.parse(text);
    }
    return { status: response.status, payload };
}

async function registerTelevision(harness) {
    await call(harness, '/api/tv/register', { method: 'POST', body: {} });
}

// The user pastes a link and taps "send to tv".
async function sendLink(harness, sourceUrl, extra) {
    const body = Object.assign({ url: sourceUrl }, extra || {});
    const result = await call(harness, '/api/send', { method: 'POST', body });
    return result.payload;
}

// The television reports where it is, every ten seconds and on exit.
async function reportProgress(harness, payload) {
    return call(harness, '/api/progress', { method: 'POST', body: payload });
}

function buildSiteStream(site, settings) {
    const options = settings || {};
    return {
        title: options.title || 'A Film On A Streaming Site',
        totalDurationSeconds: options.durationSeconds || 5400,
        durationSeconds: options.durationSeconds || 5400,
        quality: '1080p',
        provider: options.provider || 'site.example',
        width: 1920,
        height: 1080,
        streamUrl: options.streamUrl || `${site.baseUrl}/movie.m3u8`,
        audioStreamUrl: options.audioStreamUrl || '',
        streamKind: options.streamKind || 'hls',
        httpHeaders: options.httpHeaders || {},
        subtitleTracks: options.subtitleTracks === undefined
            ? [
                { identifier: 'es', language: 'Spanish', url: `${site.baseUrl}/subs-es.vtt` },
                { identifier: 'tr', language: 'Türkçe', url: `${site.baseUrl}/subs-tr.vtt` },
                { identifier: 'en', language: 'English', url: `${site.baseUrl}/subs-en.vtt` }
            ]
            : options.subtitleTracks,
        renditions: [],
        videoTrack: null,
        audioTrack: null,
        headers: {}
    };
}

function siteResolver(site, settings) {
    return async (sourceUrl) => buildSiteStream(site, settings);
}

// ---------------------------------------------------------------------------
// Sending a link
// ---------------------------------------------------------------------------

test('user action: paste a link, tap send, the film starts on the tv', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const sent = await sendLink(capy, 'https://site.example/film/42');

        assert.strictEqual(sent.ok, true);
        assert.strictEqual(sent.delivered, true, 'the tv must actually receive the push');
        assert.strictEqual(television.pushed.length, 1);
        assert.strictEqual(television.lastPush().title, 'A Film On A Streaming Site');
        assert.strictEqual(television.lastPush().mediaUrl, `${site.baseUrl}/movie.m3u8`);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: paste something that is not a link, get told, store nothing', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const result = await call(capy, '/api/send', { method: 'POST', body: { url: 'not a link' } });

        assert.strictEqual(result.payload.ok, false);
        assert.ok(result.payload.error.length > 0, 'the phone needs something to show');

        const links = await call(capy, '/api/links?collection=main');
        assert.strictEqual(links.payload.items.length, 0, 'a rejected paste must not enter the list');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: paste a link the resolver cannot open, get the reason, store nothing', async () => {
    const capy = await startCapyTv({
        resolveMedia: async () => {
            throw new Error('that site is not supported yet');
        }
    });
    try {
        const result = await call(capy, '/api/send',
            { method: 'POST', body: { url: 'https://mystery.example/thing' } });

        assert.strictEqual(result.status, 500);
        assert.strictEqual(result.payload.ok, false);
        assert.strictEqual(result.payload.error, 'that site is not supported yet');

        const links = await call(capy, '/api/links?collection=main');
        assert.strictEqual(links.payload.items.length, 0,
            'a link that never played must not clutter the list');
    } finally {
        await capy.close();
    }
});

test('user action: send the same link twice, one row in the list, one publication, fresh both times', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    let resolveCount = 0;
    const capy = await startCapyTv({
        televisionPort: television.port,
        resolveMedia: async () => {
            resolveCount += 1;
            return buildSiteStream(site, { title: `Resolve number ${resolveCount}` });
        }
    });
    try {
        await registerTelevision(capy);
        const first = await sendLink(capy, 'https://site.example/film/7');
        const second = await sendLink(capy, 'https://site.example/film/7');

        assert.strictEqual(resolveCount, 2, 'every send must re-resolve so the stream url is never stale');
        assert.strictEqual(first.publicationId, second.publicationId,
            'the same link is the same publication');
        assert.strictEqual(second.title, 'Resolve number 2', 'the second push must carry the fresh resolve');

        const links = await call(capy, '/api/links?collection=main');
        assert.strictEqual(links.payload.items.length, 1, 'sending twice must not duplicate the row');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: send while the tv is asleep, then open the app, it picks the film up', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const sent = await sendLink(capy, 'https://site.example/film/9');

        assert.strictEqual(sent.delivered, false);
        assert.strictEqual(sent.queued, true);
        assert.ok(sent.reason.length > 0, 'the phone must explain why it is queued');

        const status = await call(capy, '/api/tv/status');
        assert.strictEqual(status.payload.hasPending, true);

        const pending = await call(capy, '/api/pending');
        assert.strictEqual(pending.status, 200);
        assert.strictEqual(pending.payload.title, 'A Film On A Streaming Site');

        const drained = await call(capy, '/api/pending');
        assert.strictEqual(drained.status, 204, 'a collected item must not replay on the next open');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: a link sent into a collection stays out of the main list', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        await sendLink(capy, 'https://site.example/film/1');
        await sendLink(capy, 'https://youtube.example/watch?v=aaaaaaaaaaa', { collection: 'omer' });

        const main = await call(capy, '/api/links?collection=main');
        const omer = await call(capy, '/api/links?collection=omer');
        const collections = await call(capy, '/api/collections');

        assert.strictEqual(main.payload.items.length, 1);
        assert.strictEqual(omer.payload.items.length, 1);
        assert.deepStrictEqual(
            collections.payload.items.map((entry) => `${entry.name}:${entry.count}`).sort(),
            ['main:1', 'omer:1']);
    } finally {
        await capy.close();
        await site.close();
    }
});

// Found on the hardware: pasting an episode link into the main box moved it out of the series,
// so the collection silently went from 50 episodes to 49 and the episode reappeared in the
// history instead. The phone always names a collection, so the server has to be the one to
// refuse the move.
test('user action: pasting an episode link into the main box leaves it in its series', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const episodeUrl = 'https://youtube.example/watch?v=ccccccccccc';
        await sendLink(capy, episodeUrl, { collection: 'omer' });

        // Exactly what the phone sends when you paste into the box on the main page.
        await sendLink(capy, episodeUrl, { collection: 'main' });

        const main = await call(capy, '/api/links?collection=main');
        const omer = await call(capy, '/api/links?collection=omer');

        assert.strictEqual(omer.payload.items.length, 1,
            'the episode must stay in the series it was seeded into');
        assert.strictEqual(main.payload.items.length, 0,
            'and it must not be duplicated into the history');

        const collections = await call(capy, '/api/collections');
        assert.deepStrictEqual(collections.payload.items, [{ name: 'omer', count: 1 }]);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: replaying a collection link keeps it in that collection', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const episodeUrl = 'https://youtube.example/watch?v=bbbbbbbbbbb';
        await sendLink(capy, episodeUrl, { collection: 'omer' });
        await sendLink(capy, episodeUrl);

        const main = await call(capy, '/api/links?collection=main');
        const omer = await call(capy, '/api/links?collection=omer');

        assert.strictEqual(main.payload.items.length, 0,
            'replaying an episode must not drag it into the main list');
        assert.strictEqual(omer.payload.items.length, 1);
    } finally {
        await capy.close();
        await site.close();
    }
});

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

test('user action: send a film with three languages, english is already on', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const sent = await sendLink(capy, 'https://site.example/film/11');

        assert.strictEqual(sent.selectedSubtitleId, 'en',
            'english must be on by default even though the site listed spanish first');
        assert.deepStrictEqual(sent.subtitles.map((track) => track.id), ['en', 'tr', 'es'],
            'english first, turkish second, the rest after');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: open the captions menu on the tv and read real cues for each language', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const sent = await sendLink(capy, 'https://site.example/film/12');
        const byId = new Map(sent.subtitles.map((track) => [track.id, track.cuesUrl]));

        const english = await (await fetch(byId.get('en'))).json();
        const turkish = await (await fetch(byId.get('tr'))).json();

        assert.strictEqual(english[0].t, 'the first english line');
        assert.strictEqual(english[0].s, 10000);
        assert.strictEqual(english[0].e, 13000);
        assert.strictEqual(turkish[0].t, 'birinci turkce satir');
        assert.strictEqual(turkish.length, 2);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: a film with no english falls back rather than showing nothing', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site, {
            subtitleTracks: [
                { identifier: 'es', language: 'Spanish', url: `${site.baseUrl}/subs-es.vtt` },
                { identifier: 'tr', language: 'Türkçe', url: `${site.baseUrl}/subs-tr.vtt` }
            ]
        })
    });
    try {
        const sent = await sendLink(capy, 'https://site.example/film/13');

        assert.strictEqual(sent.selectedSubtitleId, 'tr',
            'with no english, turkish is the next preference');
        assert.deepStrictEqual(sent.subtitles.map((track) => track.id), ['tr', 'es']);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: a film with no subtitles at all still plays', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site, { subtitleTracks: [] }),
        televisionPort: television.port
    });
    try {
        await registerTelevision(capy);
        const sent = await sendLink(capy, 'https://site.example/film/14');

        assert.strictEqual(sent.delivered, true);
        assert.strictEqual(sent.selectedSubtitleId, '');
        assert.deepStrictEqual(sent.subtitles, []);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: an omer episode offers english only, from the file on the pc', async () => {
    const videoIdentifier = 'uaTESTua001';
    const subtitleDirectory = path.join(__dirname, '..', 'cache', 'subtitles');
    const subtitlePath = path.join(subtitleDirectory, `${videoIdentifier}.srt`);
    fs.mkdirSync(subtitleDirectory, { recursive: true });
    fs.writeFileSync(subtitlePath,
        '1\n00:00:05,000 --> 00:00:08,000\nthe translated line\n\n'
        + '2\n00:00:30,000 --> 00:00:33,500\nthe next translated line\n\n', 'utf8');

    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const sent = await sendLink(capy,
            `https://youtube.example/watch?v=${videoIdentifier}`, { collection: 'omer' });

        assert.strictEqual(sent.subtitles.length, 1,
            'the generated english track must be the only option for omer');
        assert.strictEqual(sent.subtitles[0].id, 'autoenglish');
        assert.strictEqual(sent.selectedSubtitleId, 'autoenglish');

        const cues = await (await fetch(sent.subtitles[0].cuesUrl)).json();
        assert.strictEqual(cues.length, 2);
        assert.strictEqual(cues[0].t, 'the translated line');
        assert.strictEqual(cues[1].e, 33500);
    } finally {
        await capy.close();
        await site.close();
        fs.unlinkSync(subtitlePath);
    }
});

test('user action: regenerating a subtitle file is picked up without restarting anything', async () => {
    const videoIdentifier = 'uaTESTua002';
    const subtitleDirectory = path.join(__dirname, '..', 'cache', 'subtitles');
    const subtitlePath = path.join(subtitleDirectory, `${videoIdentifier}.srt`);
    fs.mkdirSync(subtitleDirectory, { recursive: true });
    fs.writeFileSync(subtitlePath, '1\n00:00:05,000 --> 00:00:08,000\nthe old wording\n\n', 'utf8');

    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const first = await sendLink(capy, `https://youtube.example/watch?v=${videoIdentifier}`);
        const before = await (await fetch(first.subtitles[0].cuesUrl)).json();
        assert.strictEqual(before[0].t, 'the old wording');

        fs.writeFileSync(subtitlePath, '1\n00:00:05,000 --> 00:00:08,000\nthe new wording\n\n', 'utf8');

        const after = await (await fetch(first.subtitles[0].cuesUrl)).json();
        assert.strictEqual(after[0].t, 'the new wording',
            'a regenerated subtitle must never be served from a stale cache');
    } finally {
        await capy.close();
        await site.close();
        fs.unlinkSync(subtitlePath);
    }
});

test('user action: shifting the subtitles moves every cue by the same amount', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const sent = await sendLink(capy, 'https://site.example/film/15');
        const englishUrl = sent.subtitles.find((track) => track.id === 'en').cuesUrl;

        const plain = await (await fetch(englishUrl)).json();
        const later = await (await fetch(`${englishUrl}?offsetMs=1500`)).json();
        const earlier = await (await fetch(`${englishUrl}?offsetMs=-2000`)).json();

        assert.strictEqual(plain[0].s, 10000);
        assert.strictEqual(later[0].s, 11500, 'a positive offset delays the subtitles');
        assert.strictEqual(later[1].s, plain[1].s + 1500, 'the shift must apply to every cue');
        assert.strictEqual(later.length, plain.length);
        assert.strictEqual(earlier[0].s, 8000, 'a negative offset pulls the subtitles forward');
        assert.strictEqual(earlier[0].e, 11000, 'the end must move with the start');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: the only subtitle is broken, the film still plays with subtitles off', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({
        televisionPort: television.port,
        resolveMedia: siteResolver(site, {
            subtitleTracks: [{ identifier: 'en', language: 'English', url: `${site.baseUrl}/gone.vtt` }]
        })
    });
    try {
        await registerTelevision(capy);
        const sent = await sendLink(capy, 'https://site.example/film/16');

        assert.strictEqual(sent.ok, true, 'a dead subtitle must never block the film');
        assert.strictEqual(sent.delivered, true);
        assert.strictEqual(sent.selectedSubtitleId, '',
            'with nothing loadable the player falls back to subtitles off');

        const response = await fetch(sent.subtitles[0].cuesUrl);
        assert.strictEqual(response.status, 500,
            'asking for the broken track directly still reports the failure');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: one broken subtitle falls through to the next language rather than off', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({
        televisionPort: television.port,
        resolveMedia: siteResolver(site, {
            subtitleTracks: [
                { identifier: 'en', language: 'English', url: `${site.baseUrl}/gone.vtt` },
                { identifier: 'tr', language: 'Türkçe', url: `${site.baseUrl}/subs-tr.vtt` }
            ]
        })
    });
    try {
        await registerTelevision(capy);
        const sent = await sendLink(capy, 'https://site.example/film/16b');

        assert.strictEqual(sent.selectedSubtitleId, 'tr',
            'english was preferred but unreadable, turkish is the next best');
        const cues = await (await fetch(
            sent.subtitles.find((track) => track.id === 'tr').cuesUrl)).json();
        assert.strictEqual(cues[0].t, 'birinci turkce satir');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: choose turkish on the tv, come back tomorrow, turkish is still on', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const filmUrl = 'https://site.example/film/17';
        const first = await sendLink(capy, filmUrl);
        assert.strictEqual(first.selectedSubtitleId, 'en');

        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 12 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'tr',
            subtitleOffsetMilliseconds: 0
        });

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.selectedSubtitleId, 'tr',
            'the language the user actually watched in must come back');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: turn subtitles off on the tv, they stay off next time', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const filmUrl = 'https://site.example/film/18';
        const first = await sendLink(capy, filmUrl);
        assert.strictEqual(first.selectedSubtitleId, 'en');

        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 20 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: '',
            subtitleOffsetMilliseconds: 0
        });

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.selectedSubtitleId, '',
            'off is a choice, not an absence of one');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: the language you watched in disappears upstream, english takes over', async () => {
    const site = await startMediaSite();
    let offerTurkish = true;
    const capy = await startCapyTv({
        resolveMedia: async () => buildSiteStream(site, {
            subtitleTracks: offerTurkish
                ? [
                    { identifier: 'en', language: 'English', url: `${site.baseUrl}/subs-en.vtt` },
                    { identifier: 'tr', language: 'Türkçe', url: `${site.baseUrl}/subs-tr.vtt` }
                ]
                : [{ identifier: 'en', language: 'English', url: `${site.baseUrl}/subs-en.vtt` }]
        })
    });
    try {
        const filmUrl = 'https://site.example/film/19';
        const first = await sendLink(capy, filmUrl);
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 30 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'tr',
            subtitleOffsetMilliseconds: 0
        });

        offerTurkish = false;
        const second = await sendLink(capy, filmUrl);

        assert.strictEqual(second.selectedSubtitleId, 'en',
            'a track that vanished must fall back, not leave the viewer with nothing');
    } finally {
        await capy.close();
        await site.close();
    }
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test('user action: stop at 38:32 tonight, press play tomorrow, it resumes at 38:32', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const filmUrl = 'https://site.example/film/20';
        const first = await sendLink(capy, filmUrl);

        const stoppedAt = (38 * 60 + 32) * 1000;
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: stoppedAt,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.resumeMilliseconds, stoppedAt);
        assert.strictEqual(television.lastPush().resumeMilliseconds, stoppedAt,
            'the tv is what actually has to seek');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: bail out in the first minute, it starts from the beginning next time', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const filmUrl = 'https://site.example/film/21';
        const first = await sendLink(capy, filmUrl);
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 25000,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.resumeMilliseconds, 0,
            'nobody wants to resume twenty seconds in');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: watch to the end, next time it starts over instead of at the credits', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const filmUrl = 'https://site.example/film/22';
        const first = await sendLink(capy, filmUrl);
        const duration = 90 * MINUTE_MILLISECONDS;
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 40 * MINUTE_MILLISECONDS,
            durationMilliseconds: duration,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: duration - 20000,
            durationMilliseconds: duration,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.resumeMilliseconds, 0,
            'reaching the end must clear the bookmark');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: two films remember their own places, not each other', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const firstUrl = 'https://site.example/film/23';
        const secondUrl = 'https://site.example/film/24';
        const first = await sendLink(capy, firstUrl);
        const second = await sendLink(capy, secondUrl);

        assert.notStrictEqual(first.contentKey, second.contentKey);

        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 10 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });
        await reportProgress(capy, {
            contentKey: second.contentKey,
            positionMilliseconds: 50 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });

        const firstAgain = await sendLink(capy, firstUrl);
        const secondAgain = await sendLink(capy, secondUrl);

        assert.strictEqual(firstAgain.resumeMilliseconds, 10 * MINUTE_MILLISECONDS);
        assert.strictEqual(secondAgain.resumeMilliseconds, 50 * MINUTE_MILLISECONDS);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: everything survives the pc restarting', async () => {
    const site = await startMediaSite();
    const filmUrl = 'https://site.example/film/25';
    const sharedState = path.join(os.tmpdir(), `capytv-restart-${process.pid}-${Date.now()}.json`);

    const before = await startCapyTv({ resolveMedia: siteResolver(site), stateFilePath: sharedState });
    try {
        const sent = await sendLink(before, filmUrl, { collection: 'omer' });
        await reportProgress(before, {
            contentKey: sent.contentKey,
            positionMilliseconds: 33 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'tr',
            subtitleOffsetMilliseconds: 400
        });
    } finally {
        await before.close({ keepState: true });
    }

    const after = await startCapyTv({ resolveMedia: siteResolver(site), stateFilePath: sharedState });
    try {
        const links = await call(after, '/api/links?collection=omer');
        assert.strictEqual(links.payload.items.length, 1,
            'the links list must live in the state file, not only in memory');

        const sent = await sendLink(after, filmUrl);
        assert.strictEqual(sent.resumeMilliseconds, 33 * MINUTE_MILLISECONDS,
            'the bookmark must survive a reboot');
        assert.strictEqual(sent.selectedSubtitleId, 'tr', 'so must the language');
        assert.strictEqual(sent.subtitleOffsetMilliseconds, 400, 'so must the shift');
    } finally {
        await after.close();
        await site.close();
        try {
            fs.unlinkSync(sharedState);
        } catch (error) {
            void error;
        }
    }
});

// ---------------------------------------------------------------------------
// The links library
// ---------------------------------------------------------------------------

test('user action: the list shows every link ever pasted, most recent first', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        await sendLink(capy, 'https://site.example/film/31');
        await new Promise((done) => setTimeout(done, 5));
        await sendLink(capy, 'https://site.example/film/32');
        await new Promise((done) => setTimeout(done, 5));
        await sendLink(capy, 'https://site.example/film/33');

        const links = await call(capy, '/api/links?collection=main');
        assert.deepStrictEqual(links.payload.items.map((entry) => entry.url), [
            'https://site.example/film/33',
            'https://site.example/film/32',
            'https://site.example/film/31'
        ]);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: replaying an old link floats it back to the top', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        await sendLink(capy, 'https://site.example/film/41');
        await new Promise((done) => setTimeout(done, 5));
        await sendLink(capy, 'https://site.example/film/42');
        await new Promise((done) => setTimeout(done, 5));
        await sendLink(capy, 'https://site.example/film/41');

        const links = await call(capy, '/api/links?collection=main');
        assert.strictEqual(links.payload.items[0].url, 'https://site.example/film/41');
        assert.strictEqual(links.payload.items.length, 2);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: replaying episode three does not shuffle the series', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const episodes = [];
        for (let number = 1; number <= 5; number += 1) {
            episodes.push(`https://youtube.example/watch?v=episode000${number}`);
        }
        for (const episodeUrl of episodes.slice().reverse()) {
            await call(capy, '/api/links', {
                method: 'POST',
                body: { url: episodeUrl, title: `Episode ${episodes.indexOf(episodeUrl) + 1}`, collection: 'series' }
            });
            await new Promise((done) => setTimeout(done, 3));
        }

        const before = await call(capy, '/api/links?collection=series');
        assert.deepStrictEqual(before.payload.items.map((entry) => entry.url), episodes,
            'a seeded series must list in the order it was seeded');

        await sendLink(capy, episodes[2], { collection: 'series' });

        const after = await call(capy, '/api/links?collection=series');
        assert.deepStrictEqual(after.payload.items.map((entry) => entry.url), episodes,
            'watching an episode must leave the running order alone');
    } finally {
        await capy.close();
        await site.close();
    }
});

// The phone app's share sheet posts a bare {url} to these two routes, with no browser and no
// page involved. An earlier version posted to /api/cast-url, the server later dropped that
// route, and sharing a link silently 404ed for weeks because nothing pinned the contract.
test('user action: share a link from another app, straight to the tv', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const shared = await call(capy, '/api/send',
            { method: 'POST', body: { url: 'https://site.example/film/200' } });

        assert.strictEqual(shared.status, 200,
            'the share sheet has no way to recover from a missing route');
        assert.strictEqual(shared.payload.ok, true);
        assert.strictEqual(shared.payload.delivered, true);
        assert.ok(shared.payload.title.length > 0, 'the toast quotes the title back');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: share a link to save it on the pc instead', async () => {
    const site = await startMediaSite();
    const holder = {};
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site),
        startDownload: fakeDownloader(holder, { succeeds: true, fileName: 'Shared Save.mkv' })
    });
    try {
        const shared = await call(capy, '/api/download',
            { method: 'POST', body: { url: 'https://site.example/film/201' } });

        assert.strictEqual(shared.status, 200);
        assert.strictEqual(shared.payload.ok, true);
        assert.ok(shared.payload.jobId.length > 0);

        await new Promise((done) => setTimeout(done, 60));
        const jobs = await call(capy, '/api/downloads');
        assert.strictEqual(jobs.payload.jobs[0].done, true);
        assert.strictEqual(jobs.payload.jobs[0].failed, false);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: the routes the phone app calls all still exist', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const hello = await call(capy, '/api/hello');
        assert.strictEqual(hello.status, 200);
        assert.strictEqual(hello.payload.name, 'capytv',
            'the phone and the tv both find the pc by matching this exact name');

        const routes = ['/api/links?collection=main', '/api/collections', '/api/library',
            '/api/downloads', '/api/tv/status'];
        for (const route of routes) {
            const response = await call(capy, route);
            assert.strictEqual(response.status, 200, `${route} answered ${response.status}`);
        }
    } finally {
        await capy.close();
        await site.close();
    }
});

// An Android home screen shortcut copies its label from the manifest, or from the page title
// when there is no manifest, and freezes it. If the name is only in the title, a rename can
// never reach an icon somebody already added.
test('user action: the app names itself capyTV everywhere the phone can read it', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const page = await fetch(`${capy.baseUrl}/`);
        const html = await page.text();
        assert.strictEqual(page.status, 200);
        assert.ok(html.includes('<title>capyTV</title>'), 'the browser tab');
        assert.ok(html.includes('<span class="brand">capyTV</span>'), 'the header on screen');
        assert.strictEqual(/tvcast/i.test(html), false, 'the old name must be gone from the page');

        const manifestResponse = await fetch(`${capy.baseUrl}/manifest.webmanifest`);
        assert.strictEqual(manifestResponse.status, 200,
            'without this the home screen icon has no authoritative name');
        assert.ok(manifestResponse.headers.get('content-type').startsWith('application/manifest+json'));

        const manifest = JSON.parse(await manifestResponse.text());
        assert.strictEqual(manifest.name, 'capyTV');
        assert.strictEqual(manifest.short_name, 'capyTV');
        assert.strictEqual(manifest.start_url, '/');

        const icon = await fetch(`${capy.baseUrl}${manifest.icons[0].src}`);
        assert.strictEqual(icon.status, 200, 'the manifest must not point at a missing icon');
        assert.ok(icon.headers.get('content-type').startsWith('image/svg+xml'));
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: a title with accents survives the round trip intact', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site, { title: 'Ömer Dizisi 3. Bölüm' })
    });
    try {
        await sendLink(capy, 'https://site.example/film/62');
        const links = await call(capy, '/api/links?collection=main');

        assert.strictEqual(links.payload.items[0].title, 'Ömer Dizisi 3. Bölüm');
        assert.strictEqual(links.payload.items[0].title.includes('�'), false,
            'a mangled title means something decoded the bytes with the wrong codepage');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: forget one link, the others stay', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        await sendLink(capy, 'https://site.example/film/51');
        await sendLink(capy, 'https://site.example/film/52');

        const removed = await call(capy,
            `/api/links/${encodeURIComponent('https://site.example/film/51')}`, { method: 'DELETE' });
        assert.strictEqual(removed.payload.ok, true);

        const links = await call(capy, '/api/links?collection=main');
        assert.deepStrictEqual(links.payload.items.map((entry) => entry.url),
            ['https://site.example/film/52']);

        const again = await call(capy,
            `/api/links/${encodeURIComponent('https://site.example/film/51')}`, { method: 'DELETE' });
        assert.strictEqual(again.status, 404, 'forgetting twice must say so, not pretend it worked');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: the links list carries the title, not just the url', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site, { title: 'The Thing With A Long Name' })
    });
    try {
        await sendLink(capy, 'https://site.example/film/61');
        const links = await call(capy, '/api/links?collection=main');

        assert.strictEqual(links.payload.items[0].title, 'The Thing With A Long Name');
        assert.strictEqual(links.payload.items[0].url, 'https://site.example/film/61');
    } finally {
        await capy.close();
        await site.close();
    }
});

// ---------------------------------------------------------------------------
// Downloads and saved media
// ---------------------------------------------------------------------------

function fakeDownloader(mediaDirectoryHolder, outcome) {
    const { EventEmitter } = require('node:events');
    return (pageUrl, targetDirectory, onProgress) => {
        const facade = new EventEmitter();
        mediaDirectoryHolder.targetDirectory = targetDirectory;
        setTimeout(() => {
            onProgress({ percent: 40, line: '[download]  40.0% of 10MiB' });
            if (outcome.succeeds) {
                fs.writeFileSync(path.join(targetDirectory, outcome.fileName),
                    Buffer.alloc(3 * 1024 * 1024, 1));
                onProgress({ percent: 100, line: '[download] 100% of 10MiB' });
                facade.emit('close', 0);
            } else {
                onProgress({ line: 'ERROR: that site refused the download' });
                facade.emit('close', 1);
            }
        }, 5);
        facade.kill = () => null;
        return facade;
    };
}

test('user action: hit download, watch it progress, find it in the saved list, play it on the tv', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const holder = {};
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site),
        televisionPort: television.port,
        startDownload: fakeDownloader(holder, { succeeds: true, fileName: 'Saved Film.mkv' })
    });
    try {
        await registerTelevision(capy);
        const started = await call(capy, '/api/download',
            { method: 'POST', body: { url: 'https://site.example/film/71' } });
        assert.strictEqual(started.payload.ok, true);
        assert.strictEqual(holder.targetDirectory, capy.mediaDirectory,
            'downloads must land in the configured media folder');

        await new Promise((done) => setTimeout(done, 60));

        const jobs = await call(capy, '/api/downloads');
        assert.strictEqual(jobs.payload.jobs.length, 1);
        assert.strictEqual(jobs.payload.jobs[0].done, true);
        assert.strictEqual(jobs.payload.jobs[0].failed, false);
        assert.strictEqual(jobs.payload.jobs[0].percent, 100);

        const saved = await call(capy, '/api/library');
        assert.strictEqual(saved.payload.total, 1);
        assert.strictEqual(saved.payload.items[0].title, 'Saved Film');

        const played = await call(capy, '/api/send',
            { method: 'POST', body: { publicationId: `file:${saved.payload.items[0].id}` } });
        assert.strictEqual(played.payload.delivered, true);
        assert.strictEqual(played.payload.mediaKind, 'file');
        assert.ok(played.payload.mediaUrl.endsWith('.mkv'));
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: a download that fails says so rather than looking finished', async () => {
    const site = await startMediaSite();
    const holder = {};
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site),
        startDownload: fakeDownloader(holder, { succeeds: false, fileName: 'nothing' })
    });
    try {
        await call(capy, '/api/download', { method: 'POST', body: { url: 'https://site.example/film/72' } });
        await new Promise((done) => setTimeout(done, 60));

        const jobs = await call(capy, '/api/downloads');
        assert.strictEqual(jobs.payload.jobs[0].failed, true);
        assert.notStrictEqual(jobs.payload.jobs[0].percent, 100,
            'a failed download must not show a full bar');

        const saved = await call(capy, '/api/library');
        assert.strictEqual(saved.payload.total, 0);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: search the saved media and only matches come back', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        fs.writeFileSync(path.join(capy.mediaDirectory, 'Winter Sleep.mkv'), Buffer.alloc(3 * 1024 * 1024, 1));
        fs.writeFileSync(path.join(capy.mediaDirectory, 'Summer Rain.mp4'), Buffer.alloc(3 * 1024 * 1024, 1));
        await call(capy, '/api/scan', { method: 'POST' });

        const all = await call(capy, '/api/library');
        assert.strictEqual(all.payload.total, 2);

        const matched = await call(capy, '/api/library?q=winter');
        assert.strictEqual(matched.payload.items.length, 1);
        assert.strictEqual(matched.payload.items[0].title, 'Winter Sleep');

        const missed = await call(capy, '/api/library?q=autumn');
        assert.strictEqual(missed.payload.items.length, 0);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: a saved file streams with byte ranges so seeking works', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const body = Buffer.alloc(3 * 1024 * 1024, 7);
        fs.writeFileSync(path.join(capy.mediaDirectory, 'Seekable.mp4'), body);
        await call(capy, '/api/scan', { method: 'POST' });
        const saved = await call(capy, '/api/library');
        const played = await call(capy, '/api/send',
            { method: 'POST', body: { publicationId: `file:${saved.payload.items[0].id}` } });

        const whole = await fetch(played.payload.mediaUrl, { method: 'HEAD' });
        assert.strictEqual(whole.headers.get('accept-ranges'), 'bytes',
            'without range support the tv cannot seek in a local file');
        assert.strictEqual(Number(whole.headers.get('content-length')), body.length);

        const slice = await fetch(played.payload.mediaUrl, { headers: { Range: 'bytes=1000-1999' } });
        assert.strictEqual(slice.status, 206);
        assert.strictEqual(Number(slice.headers.get('content-length')), 1000);
        assert.strictEqual((await slice.arrayBuffer()).byteLength, 1000);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('user action: a saved file remembers where it was left off too', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        fs.writeFileSync(path.join(capy.mediaDirectory, 'Long Film.mkv'), Buffer.alloc(3 * 1024 * 1024, 1));
        await call(capy, '/api/scan', { method: 'POST' });
        const saved = await call(capy, '/api/library');
        const identifier = `file:${saved.payload.items[0].id}`;

        const first = await call(capy, '/api/send', { method: 'POST', body: { publicationId: identifier } });
        await reportProgress(capy, {
            contentKey: first.payload.contentKey,
            positionMilliseconds: 44 * MINUTE_MILLISECONDS,
            durationMilliseconds: 120 * MINUTE_MILLISECONDS,
            subtitleId: '',
            subtitleOffsetMilliseconds: 0
        });

        const second = await call(capy, '/api/send', { method: 'POST', body: { publicationId: identifier } });
        assert.strictEqual(second.payload.resumeMilliseconds, 44 * MINUTE_MILLISECONDS);
    } finally {
        await capy.close();
        await site.close();
    }
});

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

test('user action: whatever the user sends, the tv is told to stay at 1080p', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({
        resolveMedia: siteResolver(site, { quality: '2160p' }),
        televisionPort: television.port
    });
    try {
        await registerTelevision(capy);
        const sent = await sendLink(capy, 'https://site.example/film/81');

        assert.strictEqual(sent.maxVideoHeight, 1080,
            'the firestick cannot decode above 1080p');
        assert.strictEqual(television.lastPush().maxVideoHeight, 1080);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: there is no quality choice anywhere in the api', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const offer = await call(capy, '/api/resolve',
            { method: 'POST', body: { url: 'https://site.example/film/82' } });
        const sent = await sendLink(capy, 'https://site.example/film/82');
        const catalogue = await call(capy, '/api/catalogue');

        assert.strictEqual(offer.payload.renditions, undefined);
        assert.strictEqual(sent.renditions, undefined);
        assert.strictEqual(catalogue.payload.items[0].renditions, undefined);
    } finally {
        await capy.close();
        await site.close();
    }
});

// ---------------------------------------------------------------------------
// The television coming and going
// ---------------------------------------------------------------------------

test('user action: the tv drops off the network, the phone is told honestly', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const before = await sendLink(capy, 'https://site.example/film/91');
        assert.strictEqual(before.delivered, true);

        television.goOffline();
        const after = await sendLink(capy, 'https://site.example/film/92');

        assert.strictEqual(after.delivered, false);
        assert.strictEqual(after.queued, true);
        assert.ok(after.reason.length > 0);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('user action: the tv comes back and the queued film is waiting for it', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        television.goOffline();
        const queued = await sendLink(capy, 'https://site.example/film/93');
        assert.strictEqual(queued.queued, true);

        television.comeOnline();
        const pending = await call(capy, '/api/pending');
        assert.strictEqual(pending.status, 200);
        assert.strictEqual(pending.payload.title, 'A Film On A Streaming Site');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

// ---------------------------------------------------------------------------
// The sequences the user described
// ---------------------------------------------------------------------------

test('sequence: send, play, exit, send the same link again', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const filmUrl = 'https://site.example/film/101';

        const first = await sendLink(capy, filmUrl);
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 8 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });

        const second = await sendLink(capy, filmUrl);

        assert.strictEqual(television.pushed.length, 2, 'both sends must actually reach the tv');
        assert.strictEqual(second.resumeMilliseconds, 8 * MINUTE_MILLISECONDS);
        assert.strictEqual(second.publicationId, first.publicationId);

        const links = await call(capy, '/api/links?collection=main');
        assert.strictEqual(links.payload.items.length, 1);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('sequence: play, english, turkish, exit, replay lands on turkish with the right cues', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const filmUrl = 'https://site.example/film/102';

        const first = await sendLink(capy, filmUrl);
        assert.strictEqual(first.selectedSubtitleId, 'en');

        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 5 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 6 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'tr',
            subtitleOffsetMilliseconds: 0
        });

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.selectedSubtitleId, 'tr');

        const turkishUrl = second.subtitles.find((track) => track.id === 'tr').cuesUrl;
        const cues = await (await fetch(turkishUrl)).json();
        assert.strictEqual(cues[0].t, 'birinci turkce satir');
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('sequence: play, jump forward, switch language, jump again, the last position is what returns', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const filmUrl = 'https://site.example/film/103';
        const first = await sendLink(capy, filmUrl);

        const steps = [
            { positionMilliseconds: 5 * MINUTE_MILLISECONDS, subtitleId: 'en' },
            { positionMilliseconds: 25 * MINUTE_MILLISECONDS, subtitleId: 'en' },
            { positionMilliseconds: 25 * MINUTE_MILLISECONDS, subtitleId: 'tr' },
            { positionMilliseconds: 47 * MINUTE_MILLISECONDS, subtitleId: 'tr' }
        ];
        for (const step of steps) {
            await reportProgress(capy, {
                contentKey: first.contentKey,
                positionMilliseconds: step.positionMilliseconds,
                durationMilliseconds: 120 * MINUTE_MILLISECONDS,
                subtitleId: step.subtitleId,
                subtitleOffsetMilliseconds: 0
            });
        }

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.resumeMilliseconds, 47 * MINUTE_MILLISECONDS);
        assert.strictEqual(second.selectedSubtitleId, 'tr');
    } finally {
        await capy.close();
        await site.close();
    }
});

test('sequence: shift the subtitles while watching, the shift comes back next time', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const filmUrl = 'https://site.example/film/104';
        const first = await sendLink(capy, filmUrl);

        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 15 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 700
        });

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.subtitleOffsetMilliseconds, 700,
            'the shift the user dialled in must not be thrown away');
        assert.strictEqual(television.lastPush().subtitleOffsetMilliseconds, 700);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('sequence: two films alternating keep their own language and position', async () => {
    const site = await startMediaSite();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site) });
    try {
        const filmA = 'https://site.example/film/105';
        const filmB = 'https://site.example/film/106';
        const a = await sendLink(capy, filmA);
        const b = await sendLink(capy, filmB);

        await reportProgress(capy, {
            contentKey: a.contentKey,
            positionMilliseconds: 12 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'tr',
            subtitleOffsetMilliseconds: 200
        });
        await reportProgress(capy, {
            contentKey: b.contentKey,
            positionMilliseconds: 61 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'es',
            subtitleOffsetMilliseconds: 0
        });

        const aAgain = await sendLink(capy, filmA);
        const bAgain = await sendLink(capy, filmB);

        assert.strictEqual(aAgain.resumeMilliseconds, 12 * MINUTE_MILLISECONDS);
        assert.strictEqual(aAgain.selectedSubtitleId, 'tr');
        assert.strictEqual(aAgain.subtitleOffsetMilliseconds, 200);
        assert.strictEqual(bAgain.resumeMilliseconds, 61 * MINUTE_MILLISECONDS);
        assert.strictEqual(bAgain.selectedSubtitleId, 'es');
        assert.strictEqual(bAgain.subtitleOffsetMilliseconds, 0);
    } finally {
        await capy.close();
        await site.close();
    }
});

test('sequence: tv asleep, send, tv wakes, plays, reports, resume works from the queued push', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        const filmUrl = 'https://site.example/film/107';
        const queued = await sendLink(capy, filmUrl);
        assert.strictEqual(queued.delivered, false);

        await registerTelevision(capy);
        const collected = await call(capy, '/api/pending');
        assert.strictEqual(collected.status, 200);

        await reportProgress(capy, {
            contentKey: collected.payload.contentKey,
            positionMilliseconds: 19 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });

        const replayed = await sendLink(capy, filmUrl);
        assert.strictEqual(replayed.delivered, true, 'the tv is awake now');
        assert.strictEqual(replayed.resumeMilliseconds, 19 * MINUTE_MILLISECONDS);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('sequence: an omer episode and a film on the same evening do not tread on each other', async () => {
    const videoIdentifier = 'uaTESTua003';
    const subtitleDirectory = path.join(__dirname, '..', 'cache', 'subtitles');
    const subtitlePath = path.join(subtitleDirectory, `${videoIdentifier}.srt`);
    fs.mkdirSync(subtitleDirectory, { recursive: true });
    fs.writeFileSync(subtitlePath, '1\n00:00:04,000 --> 00:00:07,000\nepisode line\n\n', 'utf8');

    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const episodeUrl = `https://youtube.example/watch?v=${videoIdentifier}`;
        const filmUrl = 'https://site.example/film/108';

        const episode = await sendLink(capy, episodeUrl, { collection: 'omer' });
        assert.strictEqual(episode.selectedSubtitleId, 'autoenglish');

        const film = await sendLink(capy, filmUrl);
        assert.strictEqual(film.selectedSubtitleId, 'en');
        assert.strictEqual(film.subtitles.length, 3);

        await reportProgress(capy, {
            contentKey: episode.contentKey,
            positionMilliseconds: 40 * MINUTE_MILLISECONDS,
            durationMilliseconds: 125 * MINUTE_MILLISECONDS,
            subtitleId: 'autoenglish',
            subtitleOffsetMilliseconds: 100
        });

        const episodeAgain = await sendLink(capy, episodeUrl);
        const filmAgain = await sendLink(capy, filmUrl);

        assert.strictEqual(episodeAgain.resumeMilliseconds, 40 * MINUTE_MILLISECONDS);
        assert.strictEqual(episodeAgain.subtitleOffsetMilliseconds, 100);
        assert.strictEqual(filmAgain.resumeMilliseconds, 0, 'the film was never watched');
        assert.strictEqual(filmAgain.selectedSubtitleId, 'en');

        const main = await call(capy, '/api/links?collection=main');
        const omer = await call(capy, '/api/links?collection=omer');
        assert.deepStrictEqual(main.payload.items.map((entry) => entry.url), [filmUrl]);
        assert.deepStrictEqual(omer.payload.items.map((entry) => entry.url), [episodeUrl]);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
        fs.unlinkSync(subtitlePath);
    }
});

test('sequence: send, forget the link, send it again, it comes back clean', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const filmUrl = 'https://site.example/film/109';

        const first = await sendLink(capy, filmUrl);
        await reportProgress(capy, {
            contentKey: first.contentKey,
            positionMilliseconds: 22 * MINUTE_MILLISECONDS,
            durationMilliseconds: 90 * MINUTE_MILLISECONDS,
            subtitleId: 'en',
            subtitleOffsetMilliseconds: 0
        });

        await call(capy, `/api/links/${encodeURIComponent(filmUrl)}`, { method: 'DELETE' });
        const emptied = await call(capy, '/api/links?collection=main');
        assert.strictEqual(emptied.payload.items.length, 0);

        const second = await sendLink(capy, filmUrl);
        assert.strictEqual(second.delivered, true);
        assert.strictEqual(second.resumeMilliseconds, 22 * MINUTE_MILLISECONDS,
            'forgetting the row must not throw away where you were');

        const links = await call(capy, '/api/links?collection=main');
        assert.strictEqual(links.payload.items.length, 1);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});

test('sequence: hammering send does not corrupt the list or the state file', async () => {
    const site = await startMediaSite();
    const television = await startFakeTelevision();
    const capy = await startCapyTv({ resolveMedia: siteResolver(site), televisionPort: television.port });
    try {
        await registerTelevision(capy);
        const urls = [];
        for (let index = 0; index < 12; index += 1) {
            urls.push(`https://site.example/film/2${index}`);
        }
        await Promise.all(urls.map((sourceUrl) => sendLink(capy, sourceUrl)));

        const links = await call(capy, '/api/links?collection=main');
        assert.strictEqual(links.payload.items.length, urls.length,
            'every link must survive concurrent sends');
        assert.strictEqual(television.pushed.length, urls.length);

        const persisted = JSON.parse(fs.readFileSync(capy.stateFilePath, 'utf8'));
        assert.strictEqual(persisted.links.length, urls.length);
    } finally {
        await capy.close();
        await television.close();
        await site.close();
    }
});
