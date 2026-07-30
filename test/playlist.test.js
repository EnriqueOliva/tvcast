const test = require('node:test');
const assert = require('node:assert');
const cineby = require('../lib/cineby');

const BASE = 'https://cdn.example/hls/1080p/index.m3u8';

test('parses a plain media playlist into segments with a running start time', () => {
    const text = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:7',
        '#EXTINF:6.006,',
        'a.ts',
        '#EXTINF:4.171,',
        'b.ts',
        '#EXT-X-ENDLIST'
    ].join('\n');
    const parsed = cineby.parsePlaylistText(text, BASE);
    assert.strictEqual(parsed.segments.length, 2);
    assert.strictEqual(parsed.variants.length, 0);
    assert.strictEqual(parsed.segments[0].start, 0);
    assert.ok(Math.abs(parsed.segments[1].start - 6.006) < 0.0001);
    assert.ok(Math.abs(parsed.totalSeconds - 10.177) < 0.0001);
});

test('resolves relative segment names against the playlist url', () => {
    const parsed = cineby.parsePlaylistText('#EXTM3U\n#EXTINF:4.0,\nchunk0.ts\n', BASE);
    assert.strictEqual(parsed.segments[0].url, 'https://cdn.example/hls/1080p/chunk0.ts');
});

test('keeps absolute segment urls that point at another host', () => {
    const parsed = cineby.parsePlaylistText('#EXTM3U\n#EXTINF:4.0,\nhttps://other.example/x.jpg\n', BASE);
    assert.strictEqual(parsed.segments[0].url, 'https://other.example/x.jpg');
});

test('accepts segments disguised with a non-media extension', () => {
    const parsed = cineby.parsePlaylistText('#EXTM3U\n#EXTINF:6.0,\nseg001.jpg\n', BASE);
    assert.strictEqual(parsed.segments.length, 1);
    assert.match(parsed.segments[0].url, /seg001\.jpg$/);
});

test('captures the fMP4 init segment when the playlist declares one', () => {
    const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\na.m4s\n';
    const parsed = cineby.parsePlaylistText(text, BASE);
    assert.strictEqual(parsed.initSegmentUrl, 'https://cdn.example/hls/1080p/init.mp4');
});

test('leaves the init segment empty for plain transport stream playlists', () => {
    const parsed = cineby.parsePlaylistText('#EXTM3U\n#EXTINF:6.0,\na.ts\n', BASE);
    assert.strictEqual(parsed.initSegmentUrl, '');
});

test('parses a master playlist into variants with their heights', () => {
    const text = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=15000000,RESOLUTION=3840x2160,CODECS="hvc1"',
        'uhd.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1"',
        'fhd.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1"',
        'low.m3u8'
    ].join('\n');
    const parsed = cineby.parsePlaylistText(text, BASE);
    assert.strictEqual(parsed.segments.length, 0);
    assert.deepStrictEqual(parsed.variants.map((variant) => variant.height), [2160, 1080, 360]);
    assert.strictEqual(parsed.variants[0].bandwidth, 15000000);
    assert.match(parsed.variants[1].url, /fhd\.m3u8$/);
});

test('detects a separate audio rendition so the pair can be muxed', () => {
    const text = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="ENG",DEFAULT=YES,URI="audio/eng.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="audio"',
        'video.m3u8'
    ].join('\n');
    const parsed = cineby.parsePlaylistText(text, BASE);
    assert.strictEqual(parsed.audioPlaylists.length, 1);
    assert.match(parsed.audioPlaylists[0], /audio\/eng\.m3u8$/);
    assert.strictEqual(parsed.variants.length, 1);
});

test('ignores subtitle and closed-caption media tags when hunting for audio', () => {
    const text = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="EN",URI="subs/en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720',
        'video.m3u8'
    ].join('\n');
    const parsed = cineby.parsePlaylistText(text, BASE);
    assert.strictEqual(parsed.audioPlaylists.length, 0);
});

test('returns nothing for a playlist header carrying no segments or variants', () => {
    const parsed = cineby.parsePlaylistText('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n', BASE);
    assert.strictEqual(parsed.segments.length, 0);
    assert.strictEqual(parsed.variants.length, 0);
    assert.strictEqual(parsed.totalSeconds, 0);
});

test('an untimed line still becomes a zero length segment, so callers must gate on the EXTM3U header', () => {
    const parsed = cineby.parsePlaylistText('<html><body>nope</body></html>', BASE);
    assert.strictEqual(parsed.segments.length, 1);
    assert.strictEqual(parsed.segments[0].duration, 0);
});

test('tolerates carriage returns and blank lines', () => {
    const parsed = cineby.parsePlaylistText('#EXTM3U\r\n\r\n#EXTINF:5.0,\r\na.ts\r\n\r\n', BASE);
    assert.strictEqual(parsed.segments.length, 1);
    assert.ok(Math.abs(parsed.totalSeconds - 5) < 0.0001);
});
