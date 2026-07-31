const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tvapi = require('../lib/tvapi');

const SEGMENT_BODY = Buffer.from('this-is-not-really-video-but-it-is-real-bytes');
const CUE_TEXT = 'the first line\nthe second line';

function startUpstream(routes) {
    const seen = [];
    const server = http.createServer((request, response) => {
        seen.push({ url: request.url, headers: request.headers });
        const handler = routes[request.url.split('?')[0]];
        if (handler === undefined) {
            response.writeHead(404).end('no such upstream path');
        } else {
            handler(request, response);
        }
    });
    return new Promise((resolveServer) => {
        server.listen(0, '127.0.0.1', () => {
            resolveServer({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                seen,
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

function buildResolved(upstreamBaseUrl, sourceUrl, packaging) {
    const segments = [];
    let elapsed = 0;
    for (let index = 0; index < 5; index += 1) {
        const duration = index === 4 ? 3.5 : 6.006;
        segments.push({ url: `${upstreamBaseUrl}/seg${index}.jpg`, duration, start: elapsed });
        elapsed += duration;
    }
    const initSegmentUrl = packaging === 'ts' ? '' : `${upstreamBaseUrl}/init.mp4`;
    return {
        title: 'A Title With & And <Angles>',
        sourceUrl,
        totalDurationSeconds: Math.floor(elapsed),
        quality: '1080p',
        provider: 'Fake',
        height: 1080,
        width: 1920,
        headers: {},
        videoTrack: { segments, initSegmentUrl },
        audioTrack: null,
        subtitleTracks: [{ identifier: 'english', language: 'English', url: `${upstreamBaseUrl}/subs.vtt` }],
        renditions: [{ identifier: 'fake:1080p', displayLabel: '1080p', height: 1080, provider: 'Fake' }]
    };
}

async function startApi(options) {
    const stateFilePath = path.join(os.tmpdir(), `tvcast-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const runtime = { serverAddress: '127.0.0.1', libraryItems: options.libraryItems || [] };
    const configuration = { port: 0 };

    const api = tvapi.createTelevisionApi({
        configuration,
        runtime,
        resolveMedia: options.resolveMedia,
        listLibraryItems: () => runtime.libraryItems,
        stateFilePath
    });

    const server = http.createServer((request, response) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        api.handleRequest(request, response, url)
            .then((handled) => {
                if (handled === false && response.headersSent === false) {
                    response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"unknown"}');
                }
            })
            .catch((error) => {
                if (response.headersSent === false) {
                    response.writeHead(500, { 'Content-Type': 'text/plain' }).end(error.message);
                }
            });
    });

    return new Promise((resolveServer) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            runtime.serverAddress = '127.0.0.1';
            configuration.port = port;
            resolveServer({
                baseUrl: `http://127.0.0.1:${port}`,
                api,
                runtime,
                close: async () => {
                    await new Promise((done) => server.close(done));
                    try {
                        fs.unlinkSync(stateFilePath);
                    } catch (error) {
                        void error;
                    }
                }
            });
        });
    });
}

async function publish(harness, sourceUrl, subtitleId) {
    const resolved = await fetch(`${harness.baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl })
    });
    const offer = await resolved.json();
    const sent = await fetch(`${harness.baseUrl}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerId: offer.offerId, subtitleId: subtitleId || '' })
    });
    return sent.json();
}

test('the playlist the television receives never mentions the upstream host', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/1');
        const playlist = await (await fetch(published.mediaUrl)).text();

        assert.ok(playlist.startsWith('#EXTM3U'));
        assert.ok(playlist.includes('#EXT-X-ENDLIST'), 'a VOD playlist must be closed');
        assert.strictEqual(playlist.includes('127.0.0.1:' + new URL(upstream.baseUrl).port), false,
            'the CDN host leaked to the television');
        assert.strictEqual(playlist.includes('.jpg'), false, 'the disguised upstream filenames leaked');
        assert.strictEqual((playlist.match(/#EXTINF/g) || []).length, 5);
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('the init segment survives into the playlist, or fragmented mp4 is undecodable', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/2');
        const playlist = await (await fetch(published.mediaUrl)).text();

        assert.ok(playlist.includes('#EXT-X-MAP:URI='), 'without EXT-X-MAP the fragments cannot be decoded');
        assert.strictEqual((playlist.match(/#EXT-X-MAP/g) || []).length, 1);
        assert.ok(playlist.indexOf('#EXT-X-MAP') < playlist.indexOf('#EXTINF'), 'the map must precede the segments');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('the segment proxy sends the headers the CDN demands, checked at the CDN', async () => {
    const upstream = await startUpstream({
        '/seg2.jpg': (request, response) => {
            response.writeHead(200, { 'Content-Type': 'image/jpeg' });
            response.end(SEGMENT_BODY);
        }
    });
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl, 'ts')
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/3');
        const segment = await fetch(`${harness.baseUrl}/seg/${published.publicationId}/video/2`);
        const body = Buffer.from(await segment.arrayBuffer());

        assert.strictEqual(segment.status, 200);
        assert.deepStrictEqual(body, SEGMENT_BODY);
        assert.strictEqual(segment.headers.get('content-type'), 'video/mp2t',
            'a transport stream segment arrives disguised as jpeg and must be corrected');

        const upstreamRequest = upstream.seen.find((entry) => entry.url === '/seg2.jpg');
        assert.ok(upstreamRequest !== undefined, 'the proxy never reached the CDN');
        assert.strictEqual(upstreamRequest.headers.referer, 'https://www.cineby.at/',
            'without exactly this Referer the CDN answers 403');
        assert.strictEqual(upstreamRequest.headers.origin, 'https://www.cineby.at',
            'without exactly this Origin the CDN answers 403');
        assert.ok(/Mozilla\/5\.0/.test(upstreamRequest.headers['user-agent']),
            'the CDN rejects anything that does not look like a browser');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('a fragmented mp4 segment is labelled mp4, not transport stream', async () => {
    const upstream = await startUpstream({
        '/seg2.jpg': (request, response) => {
            response.writeHead(200, { 'Content-Type': 'image/jpeg' });
            response.end(SEGMENT_BODY);
        }
    });
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl, 'fmp4')
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/3b');
        const segment = await fetch(`${harness.baseUrl}/seg/${published.publicationId}/video/2`);
        assert.strictEqual(segment.headers.get('content-type'), 'video/mp4');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('an upstream refusal becomes a 502, never an empty 200', async () => {
    const upstream = await startUpstream({
        '/seg1.jpg': (request, response) => {
            response.writeHead(403).end('forbidden');
        }
    });
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/4');
        const segment = await fetch(`${harness.baseUrl}/seg/${published.publicationId}/video/1`);

        assert.strictEqual(segment.status, 502, 'a silent 200 is how the old silent-segment bug hid');
        assert.ok((await segment.text()).length > 0, 'the failure must say something');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('two simultaneous requests for the same segment both complete', async () => {
    const upstream = await startUpstream({
        '/seg0.jpg': (request, response) => {
            setTimeout(() => {
                response.writeHead(200, { 'Content-Type': 'video/mp2t' });
                response.end(SEGMENT_BODY);
            }, 40);
        }
    });
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/5');
        const url = `${harness.baseUrl}/seg/${published.publicationId}/video/0`;
        const [first, second] = await Promise.all([fetch(url), fetch(url)]);
        const firstBody = Buffer.from(await first.arrayBuffer());
        const secondBody = Buffer.from(await second.arrayBuffer());

        assert.strictEqual(first.status, 200);
        assert.strictEqual(second.status, 200);
        assert.deepStrictEqual(firstBody, SEGMENT_BODY);
        assert.deepStrictEqual(secondBody, SEGMENT_BODY);
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('subtitle cues are served as json and the offset moves every cue by exactly that much', async () => {
    const upstream = await startUpstream({
        '/subs.vtt': (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/vtt' });
            response.end(`WEBVTT\n\n00:10.000 --> 00:14.000\n${CUE_TEXT}\n\n30:12.500 --> 30:15.000\nlater line here\n`);
        }
    });
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/6', 'english');
        const plain = await (await fetch(`${harness.baseUrl}/sub/${published.publicationId}/english.json`)).json();
        const shifted = await (await fetch(`${harness.baseUrl}/sub/${published.publicationId}/english.json?offsetMs=-1500`)).json();

        assert.strictEqual(plain.length, 2);
        assert.strictEqual(plain[0].s, 10000);
        assert.strictEqual(plain[1].s, 1812500, 'the MM:SS.mmm form cineby emits must parse as minutes');
        assert.strictEqual(plain[0].t, CUE_TEXT);

        assert.strictEqual(shifted.length, plain.length);
        for (let index = 0; index < plain.length; index += 1) {
            assert.strictEqual(plain[index].s - shifted[index].s, 1500);
            assert.strictEqual(plain[index].e - shifted[index].e, 1500);
        }
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('the same title sent twice with the same choices replaces rather than duplicates', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const first = await publish(harness, 'https://example.test/movie/7');
        const second = await publish(harness, 'https://example.test/movie/7');
        const catalogue = await (await fetch(`${harness.baseUrl}/api/catalogue`)).json();

        assert.strictEqual(first.publicationId, second.publicationId, 'the id must be content addressed');
        assert.strictEqual(catalogue.items.filter((item) => item.id === first.publicationId).length, 1);
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('a different subtitle choice is a different publication', async () => {
    const upstream = await startUpstream({
        '/subs.vtt': (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/vtt' });
            response.end('WEBVTT\n\n00:10.000 --> 00:14.000\nsome words here\n');
        }
    });
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const without = await publish(harness, 'https://example.test/movie/8');
        const with_ = await publish(harness, 'https://example.test/movie/8', 'english');

        assert.notStrictEqual(without.publicationId, with_.publicationId);
        assert.strictEqual(with_.selectedSubtitleId, 'english');
        assert.strictEqual(without.selectedSubtitleId, '');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('malformed json is refused and the server keeps serving afterwards', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const bad = await fetch(`${harness.baseUrl}/api/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not json'
        });
        assert.strictEqual(bad.status, 400);

        const stillAlive = await fetch(`${harness.baseUrl}/api/hello`);
        assert.strictEqual(stillAlive.status, 200, 'a bad body must not take the server down');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('a url that is not http is refused before any resolving happens', async () => {
    const upstream = await startUpstream({});
    let resolveCalls = 0;
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => {
            resolveCalls += 1;
            return buildResolved(upstream.baseUrl, sourceUrl);
        }
    });
    try {
        const refused = await fetch(`${harness.baseUrl}/api/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'file:///etc/passwd' })
        });
        assert.strictEqual(refused.status, 400);
        assert.strictEqual(resolveCalls, 0, 'a non-http url must never reach the resolver');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('library files are offered to the television and serve byte ranges', async () => {
    const filePath = path.join(os.tmpdir(), `tvcast-test-media-${Date.now()}.mp4`);
    fs.writeFileSync(filePath, Buffer.alloc(5000, 7));
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl),
        libraryItems: [{
            id: 'abc123',
            title: 'Local File',
            folder: '',
            sizeBytes: 5000,
            mimeType: 'video/mp4',
            extension: '.mp4',
            subtitlePath: '',
            filePath
        }]
    });
    try {
        const catalogue = await (await fetch(`${harness.baseUrl}/api/catalogue`)).json();
        assert.ok(catalogue.items.some((item) => item.id === 'file:abc123'), 'the library must reach the television');

        const payload = await (await fetch(`${harness.baseUrl}/api/play/file:abc123`)).json();
        assert.strictEqual(payload.mediaKind, 'file');

        const ranged = await fetch(payload.mediaUrl, { headers: { Range: 'bytes=100-199' } });
        assert.strictEqual(ranged.status, 206);
        assert.strictEqual(ranged.headers.get('content-range'), 'bytes 100-199/5000');
        assert.strictEqual((await ranged.arrayBuffer()).byteLength, 100);
    } finally {
        await harness.close();
        await upstream.close();
        fs.unlinkSync(filePath);
    }
});

test('resume positions survive a report and are cleared near the end', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/9');

        await fetch(`${harness.baseUrl}/api/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contentKey: published.contentKey,
                positionMilliseconds: 600000,
                durationMilliseconds: 3000000
            })
        });
        const midway = await (await fetch(`${harness.baseUrl}/api/play/${published.publicationId}`)).json();
        assert.strictEqual(midway.resumeMilliseconds, 600000);

        await fetch(`${harness.baseUrl}/api/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contentKey: published.contentKey,
                positionMilliseconds: 2960000,
                durationMilliseconds: 3000000
            })
        });
        const finished = await (await fetch(`${harness.baseUrl}/api/play/${published.publicationId}`)).json();
        assert.strictEqual(finished.resumeMilliseconds, 0, 'a finished film must not prompt to resume');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('a manually corrected subtitle offset is remembered for the next send', async () => {
    const upstream = await startUpstream({
        '/subs.vtt': (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/vtt' });
            response.end('WEBVTT\n\n00:10.000 --> 00:14.000\nsome words here\n');
        }
    });
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const first = await publish(harness, 'https://example.test/movie/10', 'english');
        assert.strictEqual(first.subtitleOffsetMilliseconds, 0);

        await fetch(`${harness.baseUrl}/api/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contentKey: first.contentKey,
                positionMilliseconds: 300000,
                durationMilliseconds: 3000000,
                subtitleId: 'english',
                subtitleOffsetMilliseconds: -2200
            })
        });

        const second = await publish(harness, 'https://example.test/movie/10', 'english');
        assert.strictEqual(second.subtitleOffsetMilliseconds, -2200, 'a hand correction must not be lost');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('an unknown publication is a clean 404 rather than a crash', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const playlist = await fetch(`${harness.baseUrl}/hls/nosuchthing/video.m3u8`);
        assert.strictEqual(playlist.status, 404);

        const stillAlive = await fetch(`${harness.baseUrl}/api/hello`);
        assert.strictEqual(stillAlive.status, 200);
    } finally {
        await harness.close();
        await upstream.close();
    }
});

function startFakeTelevision() {
    const pushed = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            if (request.url === '/ping') {
                response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"tvcast"}');
            } else if (request.url === '/play') {
                pushed.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
            } else {
                response.writeHead(404).end();
            }
        });
    });
    return new Promise((resolveServer) => {
        server.listen(8788, '127.0.0.1', () => {
            resolveServer({
                pushed,
                close: () => new Promise((done) => {
                    server.closeAllConnections();
                    server.close(done);
                })
            });
        });
    });
}

async function registerTelevision(harness) {
    await fetch(`${harness.baseUrl}/api/tv/register`, { method: 'POST' });
}

test('a library file can be pushed to the television, which was previously unreachable', async () => {
    const filePath = path.join(os.tmpdir(), `tvcast-test-push-${Date.now()}.mp4`);
    fs.writeFileSync(filePath, Buffer.alloc(4096, 3));
    const television = await startFakeTelevision();
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl),
        libraryItems: [{
            id: 'localfilm',
            title: 'Local Film',
            folder: 'Movies',
            sizeBytes: 4096,
            mimeType: 'video/mp4',
            extension: '.mp4',
            subtitlePath: '',
            filePath
        }]
    });
    try {
        await registerTelevision(harness);
        const sent = await (await fetch(`${harness.baseUrl}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicationId: 'file:localfilm' })
        })).json();

        assert.strictEqual(sent.delivered, true, 'the phone must be able to start a library file on the tv');
        assert.strictEqual(television.pushed.length, 1, 'the television must receive exactly one push');
        assert.strictEqual(television.pushed[0].mediaKind, 'file');
        assert.strictEqual(television.pushed[0].title, 'Local Film');
        assert.strictEqual(television.pushed[0].mediaUrl, `${harness.baseUrl}/file/localfilm.mp4`);

        const played = await fetch(television.pushed[0].mediaUrl);
        assert.strictEqual(played.status, 200, 'the url handed to the tv must actually serve the file');
        assert.strictEqual((await played.arrayBuffer()).byteLength, 4096);
    } finally {
        await harness.close();
        await upstream.close();
        await television.close();
        fs.unlinkSync(filePath);
    }
});

test('an item already on the tv can be replayed without resolving the link again', async () => {
    const television = await startFakeTelevision();
    const upstream = await startUpstream({
        '/subs.vtt': (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/vtt' });
            response.end(`WEBVTT\n\n00:10.000 --> 00:14.000\n${CUE_TEXT}\n`);
        }
    });
    let resolveCount = 0;
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => {
            resolveCount += 1;
            return buildResolved(upstream.baseUrl, sourceUrl);
        }
    });
    try {
        await registerTelevision(harness);
        const published = await publish(harness, 'https://example.test/movie/44', 'english');
        const countAfterPublish = resolveCount;

        const replayed = await (await fetch(`${harness.baseUrl}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicationId: published.publicationId })
        })).json();

        assert.strictEqual(replayed.delivered, true);
        assert.strictEqual(replayed.publicationId, published.publicationId);
        assert.strictEqual(resolveCount, countAfterPublish, 'a replay must not re-resolve the source link');
        assert.strictEqual(television.pushed.length, 2, 'both the first send and the replay must reach the tv');
        assert.strictEqual(television.pushed[1].mediaUrl, published.mediaUrl);
    } finally {
        await harness.close();
        await upstream.close();
        await television.close();
    }
});

test('removing an item that is not there reports it instead of claiming success', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => buildResolved(upstream.baseUrl, sourceUrl)
    });
    try {
        const published = await publish(harness, 'https://example.test/movie/77');

        const first = await fetch(`${harness.baseUrl}/api/catalogue/${published.publicationId}`, { method: 'DELETE' });
        assert.strictEqual(first.status, 200);
        assert.strictEqual((await first.json()).ok, true);

        const second = await fetch(`${harness.baseUrl}/api/catalogue/${published.publicationId}`, { method: 'DELETE' });
        assert.strictEqual(second.status, 404, 'deleting twice must not look like it worked twice');
        const body = await second.json();
        assert.strictEqual(body.ok, false);
        assert.ok(body.error.length > 0, 'the phone needs a reason to show');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

test('the resolve reply tells the phone which rendition is already selected', async () => {
    const upstream = await startUpstream({});
    const harness = await startApi({
        resolveMedia: async (sourceUrl) => {
            const resolved = buildResolved(upstream.baseUrl, sourceUrl);
            resolved.selectedRenditionId = 'fake:1080p';
            return resolved;
        }
    });
    try {
        const offer = await (await fetch(`${harness.baseUrl}/api/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.test/movie/91' })
        })).json();

        assert.strictEqual(offer.selectedRenditionId, 'fake:1080p',
            'without this the quality chips cannot show which one is live');
        assert.ok(offer.renditions.some((rendition) => rendition.id === offer.selectedRenditionId),
            'the selected rendition must be one of the offered ones');
    } finally {
        await harness.close();
        await upstream.close();
    }
});

function buildDirectResolved(streamUrl, options) {
    const settings = options || {};
    return {
        title: 'A Direct Stream',
        totalDurationSeconds: 8665,
        durationSeconds: 8665,
        quality: settings.quality || '1080p',
        provider: 'Youtube',
        width: 1920,
        height: 1080,
        streamUrl,
        audioStreamUrl: settings.audioStreamUrl || '',
        streamKind: settings.streamKind || 'hls',
        httpHeaders: settings.httpHeaders || {},
        subtitleTracks: [],
        renditions: [],
        videoTrack: null,
        audioTrack: null,
        headers: {}
    };
}

test('a direct stream is handed to the television untouched rather than proxied', async () => {
    const television = await startFakeTelevision();
    const harness = await startApi({
        resolveMedia: async () => buildDirectResolved('https://cdn.example.test/master.m3u8', {
            httpHeaders: { 'User-Agent': 'tvcast-test' }
        })
    });
    try {
        await registerTelevision(harness);
        const sent = await publish(harness, 'https://www.youtube.com/watch?v=abcdefghijk');

        assert.strictEqual(sent.delivered, true);
        assert.strictEqual(sent.mediaKind, 'hls');
        assert.strictEqual(sent.mediaUrl, 'https://cdn.example.test/master.m3u8',
            'a public stream must not be routed through the pc');
        assert.strictEqual(sent.httpHeaders['User-Agent'], 'tvcast-test',
            'the tv needs the headers or the cdn will refuse it');
        assert.strictEqual(television.pushed[0].mediaUrl, 'https://cdn.example.test/master.m3u8');
    } finally {
        await harness.close();
        await television.close();
    }
});

test('a split stream sends both the video and the audio url so 1080p can be merged', async () => {
    const television = await startFakeTelevision();
    const harness = await startApi({
        resolveMedia: async () => buildDirectResolved('https://cdn.example.test/video-1080p.mp4', {
            streamKind: 'split',
            audioStreamUrl: 'https://cdn.example.test/audio.m4a'
        })
    });
    try {
        await registerTelevision(harness);
        const sent = await publish(harness, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');

        assert.strictEqual(sent.mediaKind, 'split');
        assert.strictEqual(sent.mediaUrl, 'https://cdn.example.test/video-1080p.mp4');
        assert.strictEqual(sent.audioUrl, 'https://cdn.example.test/audio.m4a',
            'without the audio url the merged source plays silent video');
        assert.strictEqual(television.pushed[0].audioUrl, 'https://cdn.example.test/audio.m4a');
    } finally {
        await harness.close();
        await television.close();
    }
});

test('a generated subtitle on disk is offered and served as cues', async () => {
    const videoIdentifier = 'zzTESTzz123';
    const subtitleDirectory = path.join(__dirname, '..', 'cache', 'subtitles');
    const subtitlePath = path.join(subtitleDirectory, `${videoIdentifier}.srt`);
    fs.mkdirSync(subtitleDirectory, { recursive: true });
    fs.writeFileSync(subtitlePath,
        '1\n00:00:12,500 --> 00:00:15,000\nthe translated line\n\n'
        + '2\n00:01:40,000 --> 00:01:42,250\nthe second line\n\n', 'utf8');

    const harness = await startApi({
        resolveMedia: async () => buildDirectResolved('https://cdn.example.test/master.m3u8')
    });
    try {
        const offer = await (await fetch(`${harness.baseUrl}/api/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoIdentifier}` })
        })).json();

        assert.strictEqual(offer.subtitles.length, 1, 'the generated track must be offered to the phone');
        assert.strictEqual(offer.subtitles[0].id, 'autoenglish');

        const sent = await (await fetch(`${harness.baseUrl}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offerId: offer.offerId, subtitleId: 'autoenglish' })
        })).json();

        const cues = await (await fetch(sent.subtitles[0].cuesUrl)).json();
        assert.strictEqual(cues.length, 2);
        assert.strictEqual(cues[0].s, 12500, 'cue times must survive the srt parse exactly');
        assert.strictEqual(cues[0].t, 'the translated line');
        assert.strictEqual(cues[1].s, 100000);
    } finally {
        await harness.close();
        fs.unlinkSync(subtitlePath);
    }
});
