const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const spawnCalls = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = (file, args, options) => {
    spawnCalls.push({ file, args, options });
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stdout.pipe = () => {};
    fake.stderr = new EventEmitter();
    fake.kill = () => {};
    return fake;
};

const dlna = require('../lib/dlna');
const cineby = require('../lib/cineby');
const server = require('../server.js');

server.timing.seekResetDelayMilliseconds = 1;
server.timing.positionPollIntervalMilliseconds = 1;
server.timing.plainStartTimeoutMilliseconds = 60;
server.timing.burnStartTimeoutMilliseconds = 60;

const dlnaCalls = [];
let reportedPosition = 0;
let reportedState = 'PLAYING';
let advanceOnPoll = true;

dlna.stop = async () => { dlnaCalls.push('stop'); };
dlna.play = async () => { dlnaCalls.push('play'); };
dlna.pause = async () => { dlnaCalls.push('pause'); };
dlna.setTransportUri = async (device, payload) => { dlnaCalls.push({ setTransportUri: payload }); };
dlna.getTransportInfo = async () => ({ state: reportedState });
dlna.getPositionInfo = async () => {
    if (advanceOnPoll) {
        reportedPosition += 2;
    }
    return { positionSeconds: reportedPosition, durationSeconds: 0 };
};

const DEVICE = { id: 'uuid:test', friendlyName: 'Test TV', address: '10.0.0.9' };

function buildTrack(durations, initSegmentUrl) {
    const segments = [];
    let start = 0;
    for (let index = 0; index < durations.length; index += 1) {
        segments.push({ url: `https://cdn.example/v${index}.ts`, duration: durations[index], start });
        start += durations[index];
    }
    return { segments, initSegmentUrl: initSegmentUrl || '' };
}

function buildSession(overrides) {
    const videoTrack = buildTrack([4.171, 5.839, 6.006, 4.171, 5.339, 6.006, 4.004, 5.171]);
    return Object.assign({
        id: 'c1',
        title: 'Test Film',
        mimeType: 'video/mp2t',
        progressiveUrl: '',
        hlsUrl: 'https://cdn.example/index.m3u8',
        videoTrack,
        audioTrack: null,
        playbackMode: 'segments',
        headers: { Referer: 'https://www.cineby.at/' },
        seekOffsetSeconds: 0,
        streamGeneration: 0,
        totalDurationSeconds: 40,
        durationSeconds: 40,
        subtitleTracks: [],
        selectedSubtitleId: '',
        subtitleOffsetSeconds: 0,
        subtitleFileReady: false,
        videoOnlyUrl: '',
        audioOnlyUrl: '',
        supportsRanges: false
    }, overrides || {});
}

function installSession(session) {
    server.runtime.castSessions.clear();
    server.runtime.castSessions.set(session.id, session);
    server.runtime.currentCastSessionId = session.id;
    server.runtime.serverAddress = '10.0.0.2';
    return session;
}

function captureResponse() {
    return {
        statusCode: 0,
        headers: null,
        body: '',
        headersSent: false,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; return this; },
        end(chunk) { if (chunk) { this.body += chunk; } return this; },
        on() { return this; },
        destroy() {}
    };
}

function lastFfmpegArgs() {
    return spawnCalls[spawnCalls.length - 1].args;
}

test.beforeEach(() => {
    spawnCalls.length = 0;
    dlnaCalls.length = 0;
    reportedPosition = 0;
    reportedState = 'PLAYING';
    advanceOnPoll = true;
});

test('the cast url changes on every restart so the TV cannot reuse its stream', async () => {
    const session = installSession(buildSession());
    const first = server.buildProxyUrl(session.id, session);
    await server.restartCastAtOffset(DEVICE, session, 12);
    const second = server.buildProxyUrl(session.id, session);
    await server.restartCastAtOffset(DEVICE, session, 12);
    const third = server.buildProxyUrl(session.id, session);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(second, third);
});

test('seeking to the same position twice still produces a fresh url', async () => {
    const session = installSession(buildSession());
    await server.restartCastAtOffset(DEVICE, session, 20);
    const first = server.buildProxyUrl(session.id, session);
    await server.restartCastAtOffset(DEVICE, session, 20);
    assert.notStrictEqual(server.buildProxyUrl(session.id, session), first);
    assert.strictEqual(session.seekOffsetSeconds, first.match(/offset=([\d.]+)/)[1] * 1);
});

test('a seek lands on the exact fractional start of a segment, never floored', async () => {
    const session = installSession(buildSession());
    await server.restartCastAtOffset(DEVICE, session, 22);
    const expected = cineby.resolveSeekTarget(session.videoTrack, 22).startSeconds;
    assert.strictEqual(session.seekOffsetSeconds, expected);
    assert.notStrictEqual(session.seekOffsetSeconds, Math.floor(expected));
});

test('the playlist served after a seek starts at the very segment the offset names', async () => {
    const session = installSession(buildSession());
    await server.restartCastAtOffset(DEVICE, session, 22);
    const response = captureResponse();
    server.serveSessionPlaylist(response, session, 'video');
    const expectedIndex = cineby.findSegmentIndex(session.videoTrack.segments, session.seekOffsetSeconds);
    assert.ok(response.body.includes(session.videoTrack.segments[expectedIndex].url));
    if (expectedIndex > 0) {
        assert.ok(response.body.includes(session.videoTrack.segments[expectedIndex - 1].url) === false);
    }
});

test('a seek past the end clamps to the last segment instead of failing', async () => {
    const session = installSession(buildSession());
    await server.restartCastAtOffset(DEVICE, session, 99999);
    const lastSegment = session.videoTrack.segments[session.videoTrack.segments.length - 1];
    assert.strictEqual(session.seekOffsetSeconds, lastSegment.start);
});

test('a negative seek clamps to the start of the film', async () => {
    const session = installSession(buildSession());
    await server.restartCastAtOffset(DEVICE, session, -500);
    assert.strictEqual(session.seekOffsetSeconds, 0);
});

test('the restart stops the renderer before handing it the new stream', async () => {
    const session = installSession(buildSession());
    await server.restartCastAtOffset(DEVICE, session, 12);
    const order = dlnaCalls.map((entry) => (typeof entry === 'string' ? entry : 'setTransportUri'));
    assert.deepStrictEqual(order.slice(0, 3), ['stop', 'setTransportUri', 'play']);
});

test('the transport payload carries the remaining runtime, not the whole film', async () => {
    const session = installSession(buildSession());
    await server.restartCastAtOffset(DEVICE, session, 20);
    const payload = dlnaCalls.find((entry) => entry && entry.setTransportUri).setTransportUri;
    const remaining = session.totalDurationSeconds - session.seekOffsetSeconds;
    assert.strictEqual(payload.duration, dlna.formatClockTime(remaining));
});

test('a restart that never advances is reported as a failure rather than silently passing', async () => {
    const session = installSession(buildSession());
    advanceOnPoll = false;
    reportedState = 'PLAYING';
    await assert.rejects(() => server.restartCastAtOffset(DEVICE, session, 12), /did not resume/);
});

test('without subtitles ffmpeg copies the video instead of re-encoding', () => {
    const session = installSession(buildSession());
    server.serveMuxedRequest({ method: 'GET', headers: {} }, captureResponse(), session);
    const args = lastFfmpegArgs();
    assert.ok(args.includes('copy'));
    assert.ok(args.includes('h264_nvenc') === false);
    assert.ok(args.some((value) => String(value).includes('subtitles=')) === false);
});

test('with subtitles ffmpeg burns them in and normalises the timestamps', () => {
    const session = installSession(buildSession({ subtitleFileReady: true, selectedSubtitleId: 'english' }));
    server.serveMuxedRequest({ method: 'GET', headers: {} }, captureResponse(), session);
    const args = lastFfmpegArgs();
    const filter = args[args.indexOf('-vf') + 1];
    assert.ok(args.includes('h264_nvenc'));
    assert.ok(filter.includes(`subtitles=cache/${session.id}.srt`));
    assert.ok(filter.startsWith('setpts=PTS-STARTPTS'));
    assert.strictEqual(args[args.indexOf('-af') + 1], 'asetpts=PTS-STARTPTS');
});

test('the burn reads its subtitle relative to the project directory', () => {
    const session = installSession(buildSession({ subtitleFileReady: true }));
    server.serveMuxedRequest({ method: 'GET', headers: {} }, captureResponse(), session);
    const call = spawnCalls[spawnCalls.length - 1];
    assert.ok(call.options.cwd.endsWith('tvcast'));
});

test('a paired source is fed to ffmpeg as two inputs with the audio mapped from the second', () => {
    const session = installSession(buildSession({
        audioTrack: buildTrack([6, 6, 6]),
        playbackMode: 'paired'
    }));
    server.serveMuxedRequest({ method: 'GET', headers: {} }, captureResponse(), session);
    const args = lastFfmpegArgs();
    const inputs = args.filter((value) => value === '-i').length;
    assert.strictEqual(inputs, 2);
    assert.ok(args.includes('1:a:0'));
    assert.ok(args.join(' ').includes('/video.m3u8'));
    assert.ok(args.join(' ').includes('/audio.m3u8'));
});

test('a single source maps both streams from the one input', () => {
    const session = installSession(buildSession());
    server.serveMuxedRequest({ method: 'GET', headers: {} }, captureResponse(), session);
    const args = lastFfmpegArgs();
    assert.strictEqual(args.filter((value) => value === '-i').length, 1);
    assert.ok(args.includes('0:a:0'));
});

test('the segment allowlist stays on, since segments arrive disguised as images', () => {
    const session = installSession(buildSession());
    server.serveMuxedRequest({ method: 'GET', headers: {} }, captureResponse(), session);
    assert.ok(lastFfmpegArgs().includes('-allowed_extensions'));
});

test('the upstream referer headers are passed to ffmpeg or the CDN returns 403', () => {
    const session = installSession(buildSession());
    server.serveMuxedRequest({ method: 'GET', headers: {} }, captureResponse(), session);
    const args = lastFfmpegArgs();
    const headerIndex = args.indexOf('-headers');
    assert.ok(headerIndex > -1);
    assert.ok(args[headerIndex + 1].includes('Referer'));
});

test('a HEAD request answers without starting an encoder', () => {
    const session = installSession(buildSession());
    server.serveMuxedRequest({ method: 'HEAD', headers: {} }, captureResponse(), session);
    assert.strictEqual(spawnCalls.length, 0);
});

test('the audio playlist is trimmed to the same moment as the video playlist', async () => {
    const session = installSession(buildSession({
        audioTrack: buildTrack([3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5]),
        playbackMode: 'paired'
    }));
    await server.restartCastAtOffset(DEVICE, session, 20);
    const videoResponse = captureResponse();
    const audioResponse = captureResponse();
    server.serveSessionPlaylist(videoResponse, session, 'video');
    server.serveSessionPlaylist(audioResponse, session, 'audio');
    const audioIndex = cineby.findSegmentIndex(session.audioTrack.segments, session.seekOffsetSeconds);
    const audioStart = session.audioTrack.segments[audioIndex].start;
    assert.ok(Math.abs(audioStart - session.seekOffsetSeconds) <= 3.5);
    assert.ok(audioResponse.body.includes(session.audioTrack.segments[audioIndex].url));
});

test('asking for an audio playlist on a single-track session is refused, not guessed', () => {
    const session = installSession(buildSession());
    const response = captureResponse();
    server.serveSessionPlaylist(response, session, 'audio');
    assert.strictEqual(response.statusCode, 404);
});

test('a session without a timeline is not treated as seekable', () => {
    assert.strictEqual(server.hasSegmentTimeline({ videoTrack: null }), false);
    assert.strictEqual(server.hasSegmentTimeline({ videoTrack: { segments: [] } }), false);
    assert.strictEqual(server.hasSegmentTimeline(buildSession()), true);
});

test('the served playlist is marked no-store so the TV cannot serve a stale one', () => {
    const session = installSession(buildSession());
    const response = captureResponse();
    server.serveSessionPlaylist(response, session, 'video');
    assert.strictEqual(response.headers['Cache-Control'], 'no-store');
});

test.after(() => {
    childProcess.spawn = realSpawn;
});
