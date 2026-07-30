const test = require('node:test');
const assert = require('node:assert');
const dlna = require('../lib/dlna');
const library = require('../lib/library');

function buildItem(overrides) {
    return Object.assign({
        mediaUrl: 'http://192.168.1.8:8787/muxed/c1?g=0&offset=0',
        subtitleUrl: '',
        title: 'A Film',
        mimeType: 'video/mp2t',
        sizeBytes: 0,
        duration: ''
    }, overrides || {});
}

test('formats a duration as the zero padded clock time the renderer expects', () => {
    assert.strictEqual(dlna.formatClockTime(0), '00:00:00');
    assert.strictEqual(dlna.formatClockTime(59), '00:00:59');
    assert.strictEqual(dlna.formatClockTime(3661), '01:01:01');
    assert.strictEqual(dlna.formatClockTime(8887), '02:28:07');
});

test('reads a clock time back to seconds, padded or not', () => {
    assert.strictEqual(dlna.parseClockTime('00:00:00'), 0);
    assert.strictEqual(dlna.parseClockTime('01:01:01'), 3661);
    assert.strictEqual(dlna.parseClockTime('2:28:07'), 8887);
});

test('clock times survive a round trip', () => {
    for (const seconds of [0, 1, 59, 60, 599, 3599, 3600, 8887, 12345]) {
        assert.strictEqual(dlna.parseClockTime(dlna.formatClockTime(seconds)), seconds);
    }
});

test('treats an unusable clock time as zero rather than throwing', () => {
    assert.strictEqual(dlna.parseClockTime(''), 0);
    assert.strictEqual(dlna.parseClockTime('NOT_IMPLEMENTED'), 0);
    assert.strictEqual(dlna.parseClockTime(undefined), 0);
});

test('escapes the characters that would otherwise break the SOAP envelope', () => {
    assert.strictEqual(dlna.escapeXml('Fish & Chips'), 'Fish &amp; Chips');
    assert.strictEqual(dlna.escapeXml('a<b>c'), 'a&lt;b&gt;c');
    assert.strictEqual(dlna.escapeXml('say "hi"'), 'say &quot;hi&quot;');
});

test('a title with an ampersand does not corrupt the cast metadata', () => {
    const didl = dlna.buildDidlMetadata(buildItem({ title: 'Fast & Furious <Extended>' }));
    assert.ok(didl.includes('Fast &amp; Furious &lt;Extended&gt;'));
    assert.ok(didl.includes('Fast & Furious <Extended>') === false);
});

test('a media url with query parameters is escaped inside the metadata', () => {
    const didl = dlna.buildDidlMetadata(buildItem({ mediaUrl: 'http://host/muxed/c1?g=2&offset=600' }));
    assert.ok(didl.includes('g=2&amp;offset=600'));
});

test('advertises a sidecar subtitle every way the metadata allows', () => {
    const didl = dlna.buildDidlMetadata(buildItem({ subtitleUrl: 'http://192.168.1.8:8787/subtitle/abc.srt' }));
    assert.ok(didl.includes('sec:CaptionInfoEx'));
    assert.ok(didl.includes('sec:CaptionInfo'));
    assert.ok(didl.includes('pv:subtitleFileUri'));
    assert.ok(didl.includes('text/srt'));
});

test('omits every subtitle tag when there is no sidecar', () => {
    const didl = dlna.buildDidlMetadata(buildItem({ subtitleUrl: '' }));
    assert.ok(didl.includes('CaptionInfo') === false);
    assert.ok(didl.includes('subtitleFileUri') === false);
});

test('search matches on title and folder and needs every term', () => {
    const items = [
        { title: 'Stranger Things S01E01', folder: 'Media' },
        { title: 'Terminator 2 Judgment Day', folder: 'Media' },
        { title: 'Holiday clip', folder: 'Phone' }
    ];
    assert.strictEqual(library.filterLibrary(items, 'stranger').length, 1);
    assert.strictEqual(library.filterLibrary(items, 'STRANGER').length, 1);
    assert.strictEqual(library.filterLibrary(items, 'terminator judgment').length, 1);
    assert.strictEqual(library.filterLibrary(items, 'terminator stranger').length, 0);
    assert.strictEqual(library.filterLibrary(items, 'media').length, 2);
});

test('an empty search returns the whole library untouched', () => {
    const items = [{ title: 'One', folder: 'Media' }, { title: 'Two', folder: 'Media' }];
    assert.strictEqual(library.filterLibrary(items, '').length, 2);
    assert.strictEqual(library.filterLibrary(items, '   ').length, 2);
    assert.strictEqual(library.filterLibrary(items, null).length, 2);
});

test('maps the container extensions the TV is known to play', () => {
    assert.strictEqual(library.MIME_TYPE_BY_EXTENSION['.mp4'], 'video/mp4');
    assert.strictEqual(library.MIME_TYPE_BY_EXTENSION['.mkv'], 'video/x-matroska');
    assert.strictEqual(library.MIME_TYPE_BY_EXTENSION['.avi'], 'video/x-msvideo');
});
