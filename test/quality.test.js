const test = require('node:test');
const assert = require('node:assert');
const cineby = require('../lib/cineby');

test('reads a height out of the usual quality labels', () => {
    assert.strictEqual(cineby.parseQualityHeight('1080p', ''), 1080);
    assert.strictEqual(cineby.parseQualityHeight('720p', ''), 720);
    assert.strictEqual(cineby.parseQualityHeight('480p', ''), 480);
});

test('treats 4K and 2160 as the same height', () => {
    assert.strictEqual(cineby.parseQualityHeight('4K', ''), 2160);
    assert.strictEqual(cineby.parseQualityHeight('4k', ''), 2160);
    assert.strictEqual(cineby.parseQualityHeight('2160p', ''), 2160);
});

test('falls back to the height embedded in the stream url', () => {
    assert.strictEqual(cineby.parseQualityHeight('', 'https://cdn.example/r2/720p/index.m3u8'), 720);
    assert.strictEqual(cineby.parseQualityHeight('auto', 'https://cdn.example/r2/1080/index.m3u8'), 1080);
});

test('reports no height for a label that carries none', () => {
    assert.strictEqual(cineby.parseQualityHeight('English', 'https://cdn.example/stream'), 0);
    assert.strictEqual(cineby.parseQualityHeight('', ''), 0);
});

test('accepts a runtime close to what the metadata promised', () => {
    const expected = 142 * 60;
    assert.strictEqual(cineby.isPlausibleDuration(expected, expected), true);
    assert.strictEqual(cineby.isPlausibleDuration(expected - 300, expected), true);
    assert.strictEqual(cineby.isPlausibleDuration(expected + 300, expected), true);
});

test('rejects a two minute trailer offered in place of a feature', () => {
    assert.strictEqual(cineby.isPlausibleDuration(135, 142 * 60), false);
});

test('rejects a source that runs far longer than the film should', () => {
    assert.strictEqual(cineby.isPlausibleDuration(300 * 60, 100 * 60), false);
});

test('falls back to a minimum length when the runtime is unknown', () => {
    assert.strictEqual(cineby.isPlausibleDuration(135, 0), false);
    assert.strictEqual(cineby.isPlausibleDuration(45 * 60, 0), true);
});

test('normalises language codes to readable names', () => {
    assert.strictEqual(cineby.describeLanguage('eng'), 'English');
    assert.strictEqual(cineby.describeLanguage('en'), 'English');
    assert.strictEqual(cineby.describeLanguage('English'), 'English');
    assert.strictEqual(cineby.describeLanguage('spa'), 'Spanish');
    assert.strictEqual(cineby.describeLanguage('pt'), 'Portuguese');
    assert.strictEqual(cineby.describeLanguage('tur'), 'Turkish');
});

test('keeps an unrecognised language readable rather than dropping it', () => {
    assert.strictEqual(cineby.describeLanguage('klingon'), 'Klingon');
    assert.strictEqual(cineby.describeLanguage(''), 'Unknown');
    assert.strictEqual(cineby.describeLanguage(undefined), 'Unknown');
});
