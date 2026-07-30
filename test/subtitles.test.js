const test = require('node:test');
const assert = require('node:assert');
const cineby = require('../lib/cineby');

function firstCueSeconds(srtText) {
    const match = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(srtText);
    if (match === null) {
        return null;
    }
    const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    return {
        start: toSeconds(match[1], match[2], match[3], match[4]),
        end: toSeconds(match[5], match[6], match[7], match[8])
    };
}

test('converts the two-part MM:SS.mmm timestamps cineby actually serves', () => {
    const result = cineby.buildShiftedSrt('WEBVTT\n\n00:24.233 --> 00:27.319\nfirst\n', 0);
    const cue = firstCueSeconds(result.text);
    assert.strictEqual(result.cueCount, 1);
    assert.ok(Math.abs(cue.start - 24.233) < 0.001);
    assert.ok(Math.abs(cue.end - 27.319) < 0.001);
    assert.match(result.text, /^1\n00:00:24,233 --> 00:00:27,319\n/);
});

test('accepts full HH:MM:SS.mmm timestamps as well', () => {
    const result = cineby.buildShiftedSrt('WEBVTT\n\n01:02:03.456 --> 01:02:05.500\nlater\n', 0);
    const cue = firstCueSeconds(result.text);
    assert.ok(Math.abs(cue.start - 3723.456) < 0.001);
});

test('numbers cues sequentially from one', () => {
    const source = 'WEBVTT\n\n00:01.000 --> 00:02.000\na\n\n00:03.000 --> 00:04.000\nb\n\n00:05.000 --> 00:06.000\nc\n';
    const result = cineby.buildShiftedSrt(source, 0);
    assert.strictEqual(result.cueCount, 3);
    const numbers = result.text.split('\n').filter((line) => /^\d+$/.test(line));
    assert.deepStrictEqual(numbers, ['1', '2', '3']);
});

test('applies a negative shift and drops cues that end before the new zero', () => {
    const source = 'WEBVTT\n\n00:05.000 --> 00:07.000\nearly\n\n00:20.000 --> 00:22.000\nkept\n';
    const result = cineby.buildShiftedSrt(source, -15);
    assert.strictEqual(result.cueCount, 1);
    const cue = firstCueSeconds(result.text);
    assert.ok(Math.abs(cue.start - 5) < 0.001);
});

test('clamps a cue that straddles the new zero instead of going negative', () => {
    const result = cineby.buildShiftedSrt('WEBVTT\n\n00:10.000 --> 00:20.000\nstraddles\n', -15);
    const cue = firstCueSeconds(result.text);
    assert.strictEqual(result.cueCount, 1);
    assert.strictEqual(cue.start, 0);
    assert.ok(Math.abs(cue.end - 5) < 0.001);
});

test('applies a positive shift for the subtitle delay control', () => {
    const result = cineby.buildShiftedSrt('WEBVTT\n\n00:10.000 --> 00:12.000\nline\n', 0.5);
    const cue = firstCueSeconds(result.text);
    assert.ok(Math.abs(cue.start - 10.5) < 0.001);
});

test('renumbers after dropping cues so the output stays contiguous', () => {
    const source = 'WEBVTT\n\n00:01.000 --> 00:02.000\ngone\n\n00:30.000 --> 00:31.000\nx\n\n00:40.000 --> 00:41.000\ny\n';
    const result = cineby.buildShiftedSrt(source, -20);
    const numbers = result.text.split('\n').filter((line) => /^\d+$/.test(line));
    assert.deepStrictEqual(numbers, ['1', '2']);
});

test('strips styling tags but keeps basic emphasis', () => {
    const result = cineby.buildShiftedSrt('WEBVTT\n\n00:01.000 --> 00:02.000\n<c.yellow>plain</c> <i>slanted</i>\n', 0);
    assert.ok(result.text.includes('<c.yellow>') === false);
    assert.ok(result.text.includes('<i>slanted</i>'));
});

test('reads a file that is already SRT rather than VTT', () => {
    const result = cineby.buildShiftedSrt('1\n00:00:09,000 --> 00:00:11,000\nalready srt\n', 0);
    assert.strictEqual(result.cueCount, 1);
    const cue = firstCueSeconds(result.text);
    assert.ok(Math.abs(cue.start - 9) < 0.001);
});

test('reports zero cues for input that carries none', () => {
    assert.strictEqual(cineby.buildShiftedSrt('WEBVTT\n\nNOTE nothing here\n', 0).cueCount, 0);
    assert.strictEqual(cineby.buildShiftedSrt('', 0).cueCount, 0);
});

test('keeps multi-line cue text on separate lines', () => {
    const result = cineby.buildShiftedSrt('WEBVTT\n\n00:01.000 --> 00:03.000\nfirst line\nsecond line\n', 0);
    assert.ok(result.text.includes('first line\nsecond line'));
});

test('recognises cineby links and rejects everything else', () => {
    assert.strictEqual(cineby.isCinebyUrl('https://www.cineby.at/movie/27205'), true);
    assert.strictEqual(cineby.isCinebyUrl('https://cineby.app/tv/1399/1/4'), true);
    assert.strictEqual(cineby.isCinebyUrl('https://www.cineby.at/browse'), false);
    assert.strictEqual(cineby.isCinebyUrl('https://youtu.be/abc'), false);
    assert.strictEqual(cineby.isCinebyUrl('not a url'), false);
});

test('parses movie and episode links, defaulting season and episode', () => {
    assert.deepStrictEqual(cineby.parseCinebyUrl('https://www.cineby.at/movie/27205'),
        { mediaType: 'movie', tmdbId: '27205', season: '1', episode: '1' });
    assert.deepStrictEqual(cineby.parseCinebyUrl('https://cineby.at/tv/1399/2/7'),
        { mediaType: 'tv', tmdbId: '1399', season: '2', episode: '7' });
    assert.deepStrictEqual(cineby.parseCinebyUrl('https://cineby.at/tv/1399'),
        { mediaType: 'tv', tmdbId: '1399', season: '1', episode: '1' });
    assert.throws(() => cineby.parseCinebyUrl('https://cineby.at/movie/abc'), /TMDB id/);
});
