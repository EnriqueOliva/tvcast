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
let advanceOnPoll = true;
const transportCalls = [];

dlna.stop = async () => { transportCalls.push('stop'); };
dlna.play = async () => { transportCalls.push('play'); };
dlna.pause = async () => { transportCalls.push('pause'); };
dlna.setTransportUri = async () => { transportCalls.push('setTransportUri'); };
dlna.getTransportInfo = async () => ({ state: reportedState });
dlna.getVolume = async () => null;
dlna.getPositionInfo = async () => {
    if (advanceOnPoll) {
        reportedPosition += 2;
    }
    return { positionSeconds: reportedPosition, durationSeconds: 0 };
};

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

function installSession(overrides) {
    const session = Object.assign({
        id: 'c1',
        title: 'Test Film',
        mimeType: 'video/mp2t',
        progressiveUrl: '',
        hlsUrl: 'https://cdn.example/index.m3u8',
        videoTrack: buildTrack([6, 6, 6, 6, 6, 6, 6, 6, 6, 6]),
        audioTrack: null,
        playbackMode: 'segments',
        headers: {},
        seekOffsetSeconds: 0,
        streamGeneration: 0,
        totalDurationSeconds: 60,
        durationSeconds: 60,
        subtitleTracks: [{ identifier: 'english', language: 'English', url: 'https://cdn.example/en.vtt', provider: 'Yoru' }],
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
    server.runtime.currentItemId = '';
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

function fakeRequest(method, body) {
    const request = new EventEmitter();
    request.method = method;
    request.headers = {};
    request.socket = { remoteAddress: '10.0.0.3' };
    setImmediate(() => {
        if (body !== undefined) {
            request.emit('data', Buffer.from(JSON.stringify(body)));
        }
        request.emit('end');
    });
    return request;
}

async function callApi(routeName, method, body) {
    const response = captureJson();
    const url = new URL(`http://localhost/api/${routeName}`);
    await server.handleApiRequest(fakeRequest(method, body), response, url);
    return response;
}

test.beforeEach(() => {
    transportCalls.length = 0;
    reportedPosition = 0;
    reportedState = 'PLAYING';
    advanceOnPoll = true;
});

test('the reported position never exceeds the length of the film', async () => {
    const session = installSession();
    session.seekOffsetSeconds = 54;
    reportedPosition = 40;
    advanceOnPoll = false;
    const response = await callApi('state', 'GET');
    assert.ok(response.payload.playback.positionSeconds <= session.totalDurationSeconds,
        `reported ${response.payload.playback.positionSeconds}s for a ${session.totalDurationSeconds}s film`);
});

test('a stale renderer position during a restart does not jump the scrubber past the end', async () => {
    const session = installSession();
    session.seekOffsetSeconds = 30;
    reportedPosition = 900;
    advanceOnPoll = false;
    const response = await callApi('state', 'GET');
    const reported = response.payload.playback.positionSeconds;
    assert.ok(reported >= 0 && reported <= session.totalDurationSeconds,
        `scrubber would jump to ${reported}s on a ${session.totalDurationSeconds}s film`);
});

test('seeking still works when the subtitle file cannot be refreshed', async () => {
    const session = installSession({ selectedSubtitleId: 'english', subtitleFileReady: true });
    const originalFetch = cineby.fetchSubtitleAsSrt;
    cineby.fetchSubtitleAsSrt = async () => { throw new Error('subtitle host returned HTTP 403'); };
    try {
        await server.restartCastAtOffset(DEVICE, session, 24);
        assert.strictEqual(session.seekOffsetSeconds, 24);
    } finally {
        cineby.fetchSubtitleAsSrt = originalFetch;
    }
});

test('a failed subtitle refresh turns burning off rather than burning a stale file', async () => {
    const session = installSession({ selectedSubtitleId: 'english', subtitleFileReady: true });
    const originalFetch = cineby.fetchSubtitleAsSrt;
    cineby.fetchSubtitleAsSrt = async () => { throw new Error('subtitle host returned HTTP 403'); };
    try {
        await server.restartCastAtOffset(DEVICE, session, 24).catch(() => undefined);
        assert.strictEqual(session.subtitleFileReady, false,
            'the session still claims a subtitle is ready after the refresh failed');
    } finally {
        cineby.fetchSubtitleAsSrt = originalFetch;
    }
});

test('pausing and resuming reaches the renderer', async () => {
    installSession();
    await callApi('control', 'POST', { action: 'pause' });
    assert.ok(transportCalls.includes('pause'));
    transportCalls.length = 0;
    await callApi('control', 'POST', { action: 'resume' });
    assert.ok(transportCalls.includes('play'));
});

test('ejecting clears the session so a later play cannot resume a dead stream', async () => {
    installSession();
    await callApi('control', 'POST', { action: 'stop' });
    assert.strictEqual(server.runtime.currentCastSessionId, '');
    assert.strictEqual(server.getCurrentCastSession(), null);
});

test('the state route stops advertising subtitle and quality options once ejected', async () => {
    installSession();
    await callApi('control', 'POST', { action: 'stop' });
    const response = await callApi('state', 'GET');
    assert.strictEqual(response.payload.playback.subtitleTracks, undefined);
    assert.strictEqual(response.payload.playback.renditions, undefined);
});

test('the subtitle delay accumulates across nudges', async () => {
    const session = installSession({ selectedSubtitleId: 'english', subtitleFileReady: true });
    const originalFetch = cineby.fetchSubtitleAsSrt;
    cineby.fetchSubtitleAsSrt = async () => '1\n00:00:01,000 --> 00:00:02,000\nx\n';
    try {
        await callApi('subtitle-offset', 'POST', { deltaSeconds: 0.5 });
        await callApi('subtitle-offset', 'POST', { deltaSeconds: 0.5 });
        assert.ok(Math.abs(session.subtitleOffsetSeconds - 1) < 0.001);
        await callApi('subtitle-offset', 'POST', { deltaSeconds: -0.5 });
        assert.ok(Math.abs(session.subtitleOffsetSeconds - 0.5) < 0.001);
    } finally {
        cineby.fetchSubtitleAsSrt = originalFetch;
    }
});

test('nudging the delay is refused when no subtitle is showing', async () => {
    installSession({ selectedSubtitleId: '', subtitleFileReady: false });
    const response = await callApi('subtitle-offset', 'POST', { deltaSeconds: 0.5 });
    assert.strictEqual(response.statusCode, 400);
});

test('turning subtitles off clears the burn flag so ffmpeg goes back to copying', async () => {
    const session = installSession({ selectedSubtitleId: 'english', subtitleFileReady: true });
    await callApi('cast-subtitle', 'POST', { subtitleId: '' });
    assert.strictEqual(session.selectedSubtitleId, '');
    assert.strictEqual(session.subtitleFileReady, false);
});

test('an unknown subtitle id is refused rather than silently doing nothing', async () => {
    installSession();
    const response = await callApi('cast-subtitle', 'POST', { subtitleId: 'klingon' });
    assert.strictEqual(response.statusCode >= 400, true,
        'an unknown subtitle id was accepted');
});

test('a seek while paused leaves the renderer paused afterwards', async () => {
    const session = installSession();
    reportedState = 'PAUSED_PLAYBACK';
    transportCalls.length = 0;
    await server.restartCastAtOffset(DEVICE, session, 18);
    assert.ok(transportCalls.includes('pause'),
        'playback resumed on its own even though the user had paused');
    assert.ok(transportCalls.lastIndexOf('pause') > transportCalls.lastIndexOf('play'),
        'the pause did not come after the stream restarted');
});

test('a seek while playing does not pause anything', async () => {
    const session = installSession();
    reportedState = 'PLAYING';
    transportCalls.length = 0;
    await server.restartCastAtOffset(DEVICE, session, 18);
    assert.ok(transportCalls.includes('pause') === false);
});

test.after(() => {
    childProcess.spawn = realSpawn;
});
