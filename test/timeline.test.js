const test = require('node:test');
const assert = require('node:assert');
const cineby = require('../lib/cineby');

function buildTrack(durations, initSegmentUrl) {
    const segments = [];
    let start = 0;
    for (let index = 0; index < durations.length; index += 1) {
        segments.push({ url: `https://cdn.example/seg${index}.ts`, duration: durations[index], start });
        start += durations[index];
    }
    return { segments, initSegmentUrl: initSegmentUrl || '' };
}

const FRACTIONAL_TRACK = buildTrack([4.171, 5.839, 6.006, 4.171, 5.339, 6.006, 4.004, 5.171]);
const WHOLE_TRACK = buildTrack([6, 6, 6, 6, 6]);

test('findSegmentIndex returns the first segment for a time before the stream starts', () => {
    assert.strictEqual(cineby.findSegmentIndex(WHOLE_TRACK.segments, -50), 0);
    assert.strictEqual(cineby.findSegmentIndex(WHOLE_TRACK.segments, 0), 0);
});

test('findSegmentIndex returns the segment containing the requested time', () => {
    assert.strictEqual(cineby.findSegmentIndex(WHOLE_TRACK.segments, 5.9), 0);
    assert.strictEqual(cineby.findSegmentIndex(WHOLE_TRACK.segments, 6), 1);
    assert.strictEqual(cineby.findSegmentIndex(WHOLE_TRACK.segments, 17.5), 2);
});

test('findSegmentIndex clamps to the last segment past the end of the stream', () => {
    const lastIndex = WHOLE_TRACK.segments.length - 1;
    assert.strictEqual(cineby.findSegmentIndex(WHOLE_TRACK.segments, 99999), lastIndex);
});

test('resolveSeekTarget reports the exact start of the segment it selected', () => {
    for (let index = 0; index < FRACTIONAL_TRACK.segments.length; index += 1) {
        const requested = FRACTIONAL_TRACK.segments[index].start + 1.5;
        const target = cineby.resolveSeekTarget(FRACTIONAL_TRACK, requested);
        assert.strictEqual(target.segmentIndex, index);
        assert.strictEqual(target.startSeconds, FRACTIONAL_TRACK.segments[index].start);
    }
});

test('a resolved seek target round-trips back to the same segment', () => {
    for (let index = 0; index < FRACTIONAL_TRACK.segments.length; index += 1) {
        const target = cineby.resolveSeekTarget(FRACTIONAL_TRACK, FRACTIONAL_TRACK.segments[index].start + 0.9);
        const reopened = cineby.findSegmentIndex(FRACTIONAL_TRACK.segments, target.startSeconds);
        assert.strictEqual(reopened, target.segmentIndex,
            `seek offset ${target.startSeconds} reopened segment ${reopened} instead of ${target.segmentIndex}`);
    }
});

test('flooring a seek offset reopens the wrong segment on fractional timelines', () => {
    const target = cineby.resolveSeekTarget(FRACTIONAL_TRACK, 20);
    const flooredOffset = Math.floor(target.startSeconds);
    const reopened = cineby.findSegmentIndex(FRACTIONAL_TRACK.segments, flooredOffset);
    assert.notStrictEqual(target.startSeconds, flooredOffset);
    assert.strictEqual(reopened, target.segmentIndex - 1);
});

test('buildTrimmedPlaylist starts at the requested segment and keeps the rest', () => {
    const playlist = cineby.buildTrimmedPlaylist(FRACTIONAL_TRACK, 3);
    const remaining = FRACTIONAL_TRACK.segments.length - 3;
    assert.match(playlist, /^#EXTM3U/);
    assert.strictEqual((playlist.match(/#EXTINF:/g) || []).length, remaining);
    assert.ok(playlist.includes(FRACTIONAL_TRACK.segments[3].url));
    assert.ok(playlist.includes(FRACTIONAL_TRACK.segments[2].url) === false);
    assert.match(playlist, /#EXT-X-ENDLIST$/);
});

test('buildTrimmedPlaylist carries the fMP4 init segment when the source had one', () => {
    const track = buildTrack([6, 6, 6], 'https://cdn.example/init.mp4');
    const playlist = cineby.buildTrimmedPlaylist(track, 1);
    assert.ok(playlist.includes('#EXT-X-MAP:URI="https://cdn.example/init.mp4"'));
    assert.ok(playlist.includes('#EXT-X-VERSION:7'));
});

test('buildTrimmedPlaylist omits the init tag when the source had none', () => {
    const playlist = cineby.buildTrimmedPlaylist(WHOLE_TRACK, 0);
    assert.ok(playlist.includes('#EXT-X-MAP') === false);
});

test('the subtitle shift matches the film time the trimmed playlist begins at', () => {
    const cueFilmTime = 22.5;
    const source = `WEBVTT\n\n00:${cueFilmTime.toFixed(3)} --> 00:25.000\nline\n`;
    for (const requested of [0, 7, 12.4, 21, 26]) {
        const target = cineby.resolveSeekTarget(FRACTIONAL_TRACK, requested);
        const shifted = cineby.buildShiftedSrt(source, -target.startSeconds);
        if (cueFilmTime < target.startSeconds) {
            assert.strictEqual(shifted.cueCount, 0);
        } else {
            const expected = cueFilmTime - target.startSeconds;
            const match = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) -->/.exec(shifted.text);
            const actual = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
            assert.ok(Math.abs(actual - expected) < 0.002,
                `seek ${requested}: cue rendered at ${actual}s, expected ${expected}s`);
        }
    }
});
