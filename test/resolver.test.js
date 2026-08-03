const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const resolve = require('../lib/resolve');
const embeds = require('../lib/embeds');

// Nothing is stubbed here. A real HTTP server plays the part of a streaming site and
// the real resolver is pointed at it, so the probing, the HTML scraping, the iframe
// following and the height ceiling all run for real over the wire.

const MEDIA_BODY = Buffer.from('bytes that stand in for a video payload');
const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

function startSite(options) {
    const settings = options || {};
    const seen = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        seen.push({ path: url.pathname, method: request.method, headers: request.headers });
        const route = url.pathname;
        const base = `http://127.0.0.1:${server.address().port}`;

        if (route === '/stream/master.m3u8') {
            if (settings.refuseHead && request.method === 'HEAD') {
                response.writeHead(405).end();
                return;
            }
            response.writeHead(200, { 'Content-Type': HLS_CONTENT_TYPE });
            response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nlow.m3u8\n');
        } else if (route === '/files/movie.mp4') {
            response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MEDIA_BODY.length });
            if (request.method === 'HEAD') {
                response.end();
            } else {
                response.end(MEDIA_BODY);
            }
        } else if (route === '/watch/inline') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(`<!doctype html><html><head><title>Inline Player Page</title></head><body>
                <script>var config = {"sources":[{"file":"${base}/stream/master.m3u8"}]};</script>
                </body></html>`);
        } else if (route === '/watch/framed') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(`<!doctype html><html><head><title>Framed Player Page</title></head><body>
                <iframe src="${base}/embed/inner" allowfullscreen></iframe>
                </body></html>`);
        } else if (route === '/embed/inner') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(`<!doctype html><html><head><title>Inner Frame</title></head><body>
                <script>const src = "\\/stream\\/master.m3u8";</script>
                <video data-src="/stream/master.m3u8"></video>
                </body></html>`);
        } else if (route === '/watch/empty') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end('<!doctype html><html><head><title>Nothing Here</title></head><body><p>soon</p></body></html>');
        } else {
            response.writeHead(404).end('no such path');
        }
    });
    return new Promise((ready) => {
        server.listen(0, '127.0.0.1', () => {
            ready({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                seen,
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

test('a link straight to an hls manifest resolves without any extractor', async () => {
    const site = await startSite();
    try {
        const resolved = await resolve.resolveMedia(`${site.baseUrl}/stream/master.m3u8`);

        assert.strictEqual(resolved.streamKind, 'hls');
        assert.strictEqual(resolved.streamUrl, `${site.baseUrl}/stream/master.m3u8`);
        assert.ok(resolved.title.length > 0, 'the tv needs something to put on screen');
    } finally {
        await site.close();
    }
});

test('a link straight to a video file resolves as a file, not as a playlist', async () => {
    const site = await startSite();
    try {
        const resolved = await resolve.resolveMedia(`${site.baseUrl}/files/movie.mp4`);

        assert.strictEqual(resolved.streamKind, 'file');
        assert.strictEqual(resolved.streamUrl, `${site.baseUrl}/files/movie.mp4`);
        assert.strictEqual(resolved.title, 'movie');
    } finally {
        await site.close();
    }
});

test('a cdn that refuses HEAD is still probed, with a one byte range request', async () => {
    const site = await startSite({ refuseHead: true });
    try {
        const resolved = await resolve.resolveMedia(`${site.baseUrl}/stream/master.m3u8`);

        assert.strictEqual(resolved.streamKind, 'hls');
        const methods = site.seen.filter((entry) => entry.path === '/stream/master.m3u8')
            .map((entry) => entry.method);
        assert.deepStrictEqual(methods, ['HEAD', 'GET'],
            'the fallback has to be a GET, or picky cdns look like dead links');
    } finally {
        await site.close();
    }
});

test('a cineby-style page with the stream url in its javascript is resolved', async () => {
    const site = await startSite();
    try {
        const resolved = await resolve.resolveThroughEmbeds(`${site.baseUrl}/watch/inline`);

        assert.notStrictEqual(resolved, null, 'a generic site page must not be a dead end');
        assert.strictEqual(resolved.streamKind, 'hls');
        assert.strictEqual(resolved.streamUrl, `${site.baseUrl}/stream/master.m3u8`);
        assert.strictEqual(resolved.title, 'Inline Player Page',
            'the page title beats a filename scraped off the url');
    } finally {
        await site.close();
    }
});

test('a page whose player lives in an iframe is followed one level down', async () => {
    const site = await startSite();
    try {
        const resolved = await resolve.resolveThroughEmbeds(`${site.baseUrl}/watch/framed`);

        assert.notStrictEqual(resolved, null);
        assert.strictEqual(resolved.streamUrl, `${site.baseUrl}/stream/master.m3u8`);
        assert.strictEqual(resolved.title, 'Framed Player Page',
            'the outer page is what the user pasted, so its title is the one to keep');
    } finally {
        await site.close();
    }
});

test('a stream found on a page carries the referer, or the cdn will refuse it', async () => {
    const site = await startSite();
    try {
        const resolved = await resolve.resolveThroughEmbeds(`${site.baseUrl}/watch/inline`);

        assert.strictEqual(resolved.httpHeaders.Referer, `${site.baseUrl}/watch/inline`);
        assert.ok(resolved.httpHeaders['User-Agent'].length > 0);

        const probe = site.seen.find((entry) => entry.path === '/stream/master.m3u8');
        assert.strictEqual(probe.headers.referer, `${site.baseUrl}/watch/inline`,
            'the referer must be on the wire, not just in the payload');
    } finally {
        await site.close();
    }
});

test('a page with nothing playable gives up cleanly instead of inventing a stream', async () => {
    const site = await startSite();
    try {
        const resolved = await resolve.resolveThroughEmbeds(`${site.baseUrl}/watch/empty`);
        assert.strictEqual(resolved, null);
    } finally {
        await site.close();
    }
});

test('a page that cannot be fetched at all gives up cleanly', async () => {
    const resolved = await resolve.resolveThroughEmbeds('http://127.0.0.1:1/nothing');
    assert.strictEqual(resolved, null);
});

test('the html scraper finds urls however the site escaped them', async () => {
    const page = 'https://site.example/watch/1';
    const html = '<script>var a="https:\\/\\/cdn.example\\/a\\/master.m3u8?t=1&amp;u=2";'
        + 'var b = \'/local/b.mp4\';</script>'
        + '<iframe src="//frames.example/inner?id=9"></iframe>';

    assert.deepStrictEqual(embeds.findMediaUrls(html, page), [
        'https://cdn.example/a/master.m3u8?t=1&u=2',
        'https://site.example/local/b.mp4'
    ]);
    assert.deepStrictEqual(embeds.findFrameUrls(html, page), ['https://frames.example/inner?id=9']);
});

test('the height ceiling picks 1080p when it is there', () => {
    assert.strictEqual(resolve.pickHeightWithinCeiling([2160, 1440, 1080, 720, 480], 1080), 1080);
});

test('the height ceiling takes the best below 1080p when 1080p is missing', () => {
    assert.strictEqual(resolve.pickHeightWithinCeiling([2160, 1440, 720, 480], 1080), 720);
});

test('the height ceiling settles for the smallest oversized stream rather than refusing', () => {
    assert.strictEqual(resolve.pickHeightWithinCeiling([4320, 2160, 1440], 1080), 1440,
        'a 4k only source must still play, just not at 4k');
});

test('the height ceiling copes with a source that reports no heights', () => {
    assert.strictEqual(resolve.pickHeightWithinCeiling([], 1080), 0);
});

test('the format picker never hands the firestick something above 1080p when it has a choice', () => {
    const formats = [
        { height: 2160, tbr: 12000, vcodec: 'vp9', acodec: 'opus', protocol: 'https', url: 'a' },
        { height: 1080, tbr: 3000, vcodec: 'avc1', acodec: 'mp4a', protocol: 'https', url: 'b' },
        { height: 1080, tbr: 6000, vcodec: 'avc1', acodec: 'mp4a', protocol: 'https', url: 'c' },
        { height: 720, tbr: 1500, vcodec: 'avc1', acodec: 'mp4a', protocol: 'https', url: 'd' }
    ];
    const picked = resolve.pickProgressive(formats);

    assert.strictEqual(picked.height, 1080);
    assert.strictEqual(picked.tbr, 6000, 'within the ceiling, the richest stream wins');
});

test('the split picker caps the video at 1080p and takes the best audio', () => {
    const formats = [
        { height: 2160, tbr: 14000, vcodec: 'vp9', acodec: 'none', protocol: 'https', url: 'v4k' },
        { height: 1080, tbr: 4000, vcodec: 'avc1', acodec: 'none', protocol: 'https', url: 'v1080' },
        { height: 720, tbr: 1800, vcodec: 'avc1', acodec: 'none', protocol: 'https', url: 'v720' },
        { abr: 128, vcodec: 'none', acodec: 'mp4a', protocol: 'https', url: 'a128' },
        { abr: 256, vcodec: 'none', acodec: 'mp4a', protocol: 'https', url: 'a256' }
    ];
    const pair = resolve.pickSplitPair(formats);

    assert.strictEqual(pair.video.url, 'v1080');
    assert.strictEqual(pair.audio.url, 'a256');
});

// This pins the shape the user-action tests stand in for. If the real resolver ever
// stops producing these fields, the seam those tests lean on has moved and they lie.
test('an adaptive source produces exactly the shape the rest of the app consumes', () => {
    const info = {
        title: 'Some Episode',
        duration: 5432.9,
        extractor_key: 'Youtube',
        manifest_url: 'https://cdn.example/manifest.m3u8',
        http_headers: { 'User-Agent': 'something' },
        subtitles: {
            en: [{ ext: 'vtt', url: 'https://cdn.example/en.vtt', name: 'English' }],
            tr: [{ ext: 'vtt', url: 'https://cdn.example/tr.vtt', name: 'Turkish' }]
        },
        formats: [
            { height: 2160, vcodec: 'vp9', acodec: 'none', protocol: 'm3u8_native' },
            { height: 1080, vcodec: 'avc1', acodec: 'none', protocol: 'm3u8_native' }
        ]
    };
    const stream = resolve.buildStreamFromInfo(info, 'https://youtube.example/watch?v=aaaaaaaaaaa');

    assert.strictEqual(stream.streamKind, 'hls');
    assert.strictEqual(stream.streamUrl, 'https://cdn.example/manifest.m3u8');
    assert.strictEqual(stream.title, 'Some Episode');
    assert.strictEqual(stream.totalDurationSeconds, 5432);
    assert.strictEqual(stream.quality, '1080p', 'a 4k source is still capped at 1080p');
    assert.strictEqual(stream.provider, 'Youtube');
    assert.deepStrictEqual(stream.subtitleTracks.map((track) => track.identifier), ['en', 'tr']);
    assert.strictEqual(stream.httpHeaders['User-Agent'], 'something');
    assert.strictEqual(stream.audioStreamUrl, '');
});

test('a split source produces both urls so the player can merge them', () => {
    const info = {
        title: 'Split Episode',
        duration: 100,
        formats: [
            { height: 1080, tbr: 4000, vcodec: 'avc1', acodec: 'none', protocol: 'https', url: 'v', width: 1920 },
            { abr: 160, vcodec: 'none', acodec: 'mp4a', protocol: 'https', url: 'a' }
        ]
    };
    const stream = resolve.buildStreamFromInfo(info, 'https://youtube.example/watch?v=bbbbbbbbbbb');

    assert.strictEqual(stream.streamKind, 'split');
    assert.strictEqual(stream.streamUrl, 'v');
    assert.strictEqual(stream.audioStreamUrl, 'a');
    assert.strictEqual(stream.quality, '1080p');
});

test('a source with nothing playable is reported rather than half built', () => {
    const stream = resolve.buildStreamFromInfo({ title: 'Nothing', formats: [] }, 'https://x.example/y');
    assert.strictEqual(stream, null);
});

// yt-dlp writes stdout in the Windows ANSI codepage unless forced, which once turned
// "Ömer Dizisi 3. Bölüm" into "?mer Dizisi 3. B?l?m" for 48 stored titles.
test('every yt-dlp call forces utf-8 output', () => {
    const shared = resolve.buildCommonArguments({
        cookiesFromBrowser: '', impersonate: '', extraArguments: []
    });
    const encodingIndex = shared.indexOf('--encoding');

    assert.notStrictEqual(encodingIndex, -1, 'without this, accented titles come back mangled');
    assert.strictEqual(shared[encodingIndex + 1], 'UTF-8');
});

test('a download inherits the same utf-8 forcing as everything else', () => {
    const argumentList = resolve.buildDownloadArguments('B:\\Media', '%(title)s.%(ext)s',
        'https://site.example/film/1', []);
    const encodingIndex = argumentList.indexOf('--encoding');

    assert.notStrictEqual(encodingIndex, -1, 'a saved file must not land with a mangled filename');
    assert.strictEqual(argumentList[encodingIndex + 1], 'UTF-8');
    assert.ok(argumentList.includes('B:\\Media\\%(title)s.%(ext)s'),
        'downloads must land in the configured media folder');
});
