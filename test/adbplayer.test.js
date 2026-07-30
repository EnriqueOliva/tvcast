const test = require('node:test');
const assert = require('node:assert');
const adbplayer = require('../lib/adbplayer');

test('the launch intent names the player that answers the remote', () => {
    const args = adbplayer.buildLaunchArguments('http://10.0.0.2:8787/media/abc.mp4', 'video/mp4');
    assert.deepStrictEqual(args.slice(0, 4), ['shell', 'am', 'start', '-a']);
    assert.ok(args.includes('android.intent.action.VIEW'));
    assert.ok(args.includes('http://10.0.0.2:8787/media/abc.mp4'));
    assert.ok(args.includes(adbplayer.PLAYER_COMPONENT));
});

test('the launch intent falls back to a sane mime type', () => {
    const args = adbplayer.buildLaunchArguments('http://10.0.0.2:8787/muxed/c1', undefined);
    assert.strictEqual(args[args.indexOf('-t') + 1], 'video/mp4');
});

test('a transport stream can be announced as such', () => {
    const args = adbplayer.buildLaunchArguments('http://10.0.0.2:8787/muxed/c1', 'video/mp2t');
    assert.strictEqual(args[args.indexOf('-t') + 1], 'video/mp2t');
});

test('the url is passed as one argument so query strings survive', () => {
    const url = 'http://10.0.0.2:8787/muxed/c1?g=3&offset=594.4';
    const args = adbplayer.buildLaunchArguments(url, 'video/mp2t');
    assert.ok(args.includes(url));
});

test('remote keys map to the codes the TV expects', () => {
    assert.deepStrictEqual(adbplayer.buildKeyArguments('pause'), ['shell', 'input', 'keyevent', '127']);
    assert.deepStrictEqual(adbplayer.buildKeyArguments('play'), ['shell', 'input', 'keyevent', '126']);
    assert.deepStrictEqual(adbplayer.buildKeyArguments('forward'), ['shell', 'input', 'keyevent', '90']);
});

test('an unknown remote key is rejected rather than sent as garbage', () => {
    assert.throws(() => adbplayer.buildKeyArguments('eject'), /unknown remote key/);
});

test('the newest position is taken from a log full of older ones', () => {
    const log = [
        'I NU-AmNuPlayerDriver: [#2] [getCurrentPosition] position : 15383 msec',
        'I NU-AmNuPlayerDriver: [#2] [getCurrentPosition] position : 16390 msec',
        'D SomethingElse: noise',
        'I NU-AmNuPlayerDriver: [#2] [getCurrentPosition] position : 17401 msec'
    ].join('\n');
    assert.strictEqual(adbplayer.parseLatestPositionMilliseconds(log), 17401);
});

test('a log with no position line reports nothing rather than zero', () => {
    assert.strictEqual(adbplayer.parseLatestPositionMilliseconds('I Something: unrelated'), null);
    assert.strictEqual(adbplayer.parseLatestPositionMilliseconds(''), null);
});

test('parsing the same log twice gives the same answer', () => {
    const log = 'I NU-AmNuPlayerDriver: [getCurrentPosition] position : 4242 msec';
    assert.strictEqual(adbplayer.parseLatestPositionMilliseconds(log), 4242);
    assert.strictEqual(adbplayer.parseLatestPositionMilliseconds(log), 4242);
});
