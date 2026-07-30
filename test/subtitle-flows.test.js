const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const realSpawn = childProcess.spawn;
childProcess.spawn = () => {
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

let reportedPosition = 0;
let reportedState = 'PLAYING';
const requestedShifts = [];
const realFetchSubtitle = cineby.fetchSubtitleAsSrt;
const realSwitchRendition = cineby.switchRendition;

cineby.fetchSubtitleAsSrt = async (subtitleUrl, shiftSeconds) => {
    requestedShifts.push({ subtitleUrl, shiftSeconds });
    return '1\n00:00:01,000 --> 00:00:02,000\nx\n';
};

dlna.stop = async () => {};
dlna.play = async () => {};
dlna.pause = async () => {};
dlna.setTransportUri = async () => {};
dlna.getTransportInfo = async () => ({ state: reportedState });
dlna.getVolume = async () => null;
dlna.getPositionInfo = async () => { reportedPosition += 2; return { positionSeconds: reportedPosition, durationSeconds: 0 }; };

const DEVICE = { id: 'uuid:test', friendlyName: 'Test TV', address: '10.0.0.9' };

function buildTrack(durations) {
    const segments = [];
    let start = 0;
    for (let index = 0; index < durations.length; index += 1) {
        segments.push({ url: `https://cdn.example/v${index}.ts`, duration: durations[index], start });
        start += durations[index];
    }
    return { segments, initSegmentUrl: '' };
}

const TRACK_DURATIONS = [4.171, 5.839, 6.006, 4.171, 5.339, 6.006, 4.004, 5.171, 6.006, 4.171];

function installSession(overrides) {
    const session = Object.assign({
        id: 'c1',
        title: 'Test Film',
        mimeType: 'video/mp2t',
        progressiveUrl: '',
        hlsUrl: 'https://cdn.example/index.m3u8',
        videoTrack: buildTrack(TRACK_DURATIONS),
        audioTrack: null,
        playbackMode: 'segments',
        headers: {},
        seekOffsetSeconds: 0,
        streamGeneration: 0,
        totalDurationSeconds: 50,
        durationSeconds: 50,
        renditions: [
            { identifier: 'cdn:1080p', displayLabel: '1080p', height: 1080, provider: 'Yoru' },
            { identifier: 'cdn:480p', displayLabel: '480p', height: 480, provider: 'Yoru' }
        ],
        renditionUrls: { 'cdn:1080p': 'https://cdn.example/1080.m3u8', 'cdn:480p': 'https://cdn.example/480.m3u8' },
        selectedRenditionId: 'cdn:1080p',
        subtitleTracks: [
            { identifier: 'english', language: 'English', url: 'https://cdn.example/en.vtt', provider: 'Yoru' },
            { identifier: 'spanish', language: 'Spanish', url: 'https://cdn.example/es.vtt', provider: 'Breach' }
        ],
        selectedSubtitleId: '',
        subtitleOffsetSeconds: 0,
        subtitleFileReady: false,
        videoOnlyUrl: '',
        audioOnlyUrl: '',
        supportsRanges: false
    }, overrides || {});
    server.runtime.castSessions.clear();
    server.runtime.castSessions.set(session.id, session);
    server.runtime.currentCastSessionId = session.id;
    server.runtime.devices = [DEVICE];
    server.runtime.selectedDeviceId = DEVICE.id;
    server.runtime.serverAddress = '10.0.0.2';
    return session;
}

function captureJson() {
    return {
        statusCode: 0,
        payload: null,
        headersSent: false,
        writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
        end(chunk) { try { this.payload = JSON.parse(chunk); } catch (error) { void error; } return this; },
        on() { return this; },
        destroy() {}
    };
}

function fakeRequest(body) {
    const request = new EventEmitter();
    request.method = 'POST';
    request.headers = {};
    request.socket = { remoteAddress: '10.0.0.3' };
    setImmediate(() => {
        request.emit('data', Buffer.from(JSON.stringify(body || {})));
        request.emit('end');
    });
    return request;
}

async function callApi(routeName, body) {
    const response = captureJson();
    await server.handleApiRequest(fakeRequest(body), response, new URL(`http://localhost/api/${routeName}`));
    return response;
}

function lastShift() {
    return requestedShifts[requestedShifts.length - 1].shiftSeconds;
}

function segmentStartFor(session, seconds) {
    return cineby.resolveSeekTarget(session.videoTrack, seconds).startSeconds;
}

test.beforeEach(() => {
    requestedShifts.length = 0;
    reportedPosition = 0;
    reportedState = 'PLAYING';
});

test('enabling subtitles at the start of the film asks for no shift', async () => {
    installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    assert.strictEqual(lastShift(), 0);
});

test('enabling subtitles after a seek shifts by exactly where the stream begins', async () => {
    const session = installSession();
    await server.restartCastAtOffset(DEVICE, session, 26);
    await callApi('cast-subtitle', { subtitleId: 'english' });
    assert.strictEqual(lastShift(), -segmentStartFor(session, 26));
});

test('seeking with subtitles already on re-shifts for the new position', async () => {
    const session = installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    await server.restartCastAtOffset(DEVICE, session, 32);
    assert.strictEqual(lastShift(), -segmentStartFor(session, 32));
});

test('every seek regenerates the subtitle rather than reusing the previous shift', async () => {
    const session = installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    const shifts = [];
    for (const target of [10, 20, 30, 40]) {
        await server.restartCastAtOffset(DEVICE, session, target);
        shifts.push(lastShift());
    }
    assert.strictEqual(new Set(shifts).size, shifts.length);
    for (let index = 1; index < shifts.length; index += 1) {
        assert.ok(shifts[index] < shifts[index - 1]);
    }
});

test('a delay nudge is added on top of the seek shift', async () => {
    const session = installSession();
    await server.restartCastAtOffset(DEVICE, session, 26);
    await callApi('cast-subtitle', { subtitleId: 'english' });
    await callApi('subtitle-offset', { deltaSeconds: 0.5 });
    assert.ok(Math.abs(lastShift() - (0.5 - segmentStartFor(session, 26))) < 0.0001);
});

test('a delay survives a later seek instead of being silently discarded', async () => {
    const session = installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    await callApi('subtitle-offset', { deltaSeconds: -1.5 });
    await server.restartCastAtOffset(DEVICE, session, 38);
    assert.ok(Math.abs(lastShift() - (-1.5 - segmentStartFor(session, 38))) < 0.0001);
    assert.ok(Math.abs(session.subtitleOffsetSeconds + 1.5) < 0.0001);
});

test('switching language resets the delay, since it belonged to the old file', async () => {
    const session = installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    await callApi('subtitle-offset', { deltaSeconds: 2 });
    assert.ok(Math.abs(session.subtitleOffsetSeconds - 2) < 0.0001);
    await callApi('cast-subtitle', { subtitleId: 'spanish' });
    assert.strictEqual(session.subtitleOffsetSeconds, 0);
    assert.strictEqual(session.selectedSubtitleId, 'spanish');
});

test('switching language fetches the new track, not the old url', async () => {
    installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    const englishUrl = requestedShifts[requestedShifts.length - 1].subtitleUrl;
    await callApi('cast-subtitle', { subtitleId: 'spanish' });
    const spanishUrl = requestedShifts[requestedShifts.length - 1].subtitleUrl;
    assert.notStrictEqual(englishUrl, spanishUrl);
    assert.match(spanishUrl, /es\.vtt$/);
});

test('turning subtitles off and on again starts from no delay', async () => {
    const session = installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    await callApi('subtitle-offset', { deltaSeconds: 1 });
    await callApi('cast-subtitle', { subtitleId: '' });
    await callApi('cast-subtitle', { subtitleId: 'english' });
    assert.strictEqual(session.subtitleOffsetSeconds, 0);
});

test('a quality switch keeps the chosen subtitle burning', async () => {
    const session = installSession();
    cineby.switchRendition = async (target) => {
        target.videoTrack = buildTrack([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
        target.selectedRenditionId = 'cdn:480p';
        target.quality = '480p';
        return target;
    };
    try {
        await callApi('cast-subtitle', { subtitleId: 'english' });
        await callApi('cast-quality', { renditionId: 'cdn:480p' });
        assert.strictEqual(session.selectedSubtitleId, 'english');
        assert.strictEqual(session.subtitleFileReady, true);
    } finally {
        cineby.switchRendition = realSwitchRendition;
    }
});

test('a quality switch re-shifts the subtitle for the new rendition segment grid', async () => {
    const session = installSession();
    cineby.switchRendition = async (target) => {
        target.videoTrack = buildTrack([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
        return target;
    };
    try {
        await callApi('cast-subtitle', { subtitleId: 'english' });
        await server.restartCastAtOffset(DEVICE, session, 26);
        const beforeShift = lastShift();
        await callApi('cast-quality', { renditionId: 'cdn:480p' });
        const afterShift = lastShift();
        assert.notStrictEqual(beforeShift, afterShift);
        assert.strictEqual(afterShift, -segmentStartFor(session, session.seekOffsetSeconds));
    } finally {
        cineby.switchRendition = realSwitchRendition;
    }
});

test('the shift always matches the offset the playlist is actually served from', async () => {
    const session = installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    for (const target of [0, 4.5, 12.1, 25, 33.9, 49]) {
        await server.restartCastAtOffset(DEVICE, session, target);
        const servedIndex = cineby.findSegmentIndex(session.videoTrack.segments, session.seekOffsetSeconds);
        const servedStart = session.videoTrack.segments[servedIndex].start;
        assert.ok(Math.abs(lastShift() + servedStart) < 1e-9,
            `seek ${target}: subtitle shifted by ${lastShift()} but the stream starts at ${servedStart}`);
    }
});

test('seeking exactly onto a segment boundary shifts by that boundary', async () => {
    const session = installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    const boundary = session.videoTrack.segments[4].start;
    await server.restartCastAtOffset(DEVICE, session, boundary);
    assert.strictEqual(session.seekOffsetSeconds, boundary);
    assert.strictEqual(lastShift(), -boundary);
});

test('two live sessions keep their subtitle files apart', () => {
    const first = server.buildSubtitleFilePath('c1');
    const second = server.buildSubtitleFilePath('c2');
    assert.notStrictEqual(first, second);
    assert.match(first, /c1\.srt$/);
});

test('subtitles cannot be enabled on a title that offers none', async () => {
    installSession({ subtitleTracks: [] });
    const response = await callApi('cast-subtitle', { subtitleId: 'english' });
    assert.strictEqual(response.statusCode, 400);
});

test('subtitle controls are refused once nothing is casting', async () => {
    installSession();
    server.runtime.currentCastSessionId = '';
    const chosen = await callApi('cast-subtitle', { subtitleId: 'english' });
    const nudged = await callApi('subtitle-offset', { deltaSeconds: 0.5 });
    assert.strictEqual(chosen.statusCode, 400);
    assert.strictEqual(nudged.statusCode, 400);
});

test('the state route reports the delay so the phone can display it', async () => {
    installSession();
    await callApi('cast-subtitle', { subtitleId: 'english' });
    await callApi('subtitle-offset', { deltaSeconds: 0.5 });
    const response = captureJson();
    await server.handleApiRequest(fakeRequest(), response, new URL('http://localhost/api/state'));
    assert.ok(Math.abs(response.payload.playback.subtitleOffsetSeconds - 0.5) < 0.0001);
    assert.strictEqual(response.payload.playback.selectedSubtitleId, 'english');
    assert.strictEqual(response.payload.playback.subtitleTracks.length, 2);
});

test('the state route hides subtitle urls from the phone', async () => {
    installSession();
    const response = captureJson();
    await server.handleApiRequest(fakeRequest(), response, new URL('http://localhost/api/state'));
    for (const track of response.payload.playback.subtitleTracks) {
        assert.strictEqual(track.url, undefined);
    }
});

test('rapid seeks keep the stream generation strictly increasing', async () => {
    const session = installSession();
    const generations = [];
    for (const target of [5, 15, 25, 35, 45]) {
        await server.restartCastAtOffset(DEVICE, session, target);
        generations.push(session.streamGeneration);
    }
    for (let index = 1; index < generations.length; index += 1) {
        assert.ok(generations[index] > generations[index - 1]);
    }
});

test.after(() => {
    childProcess.spawn = realSpawn;
    cineby.fetchSubtitleAsSrt = realFetchSubtitle;
    cineby.switchRendition = realSwitchRendition;
});
