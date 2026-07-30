const { spawn } = require('node:child_process');

const ADB_PATH = 'C:\\Users\\Enrique\\platform-tools\\adb.exe';
const PLAYER_COMPONENT = 'com.droidlogic.exoplayer2.demo/com.droidlogic.videoplayer.MoviePlayer';
const VIEW_ACTION = 'android.intent.action.VIEW';
const DEFAULT_MIME_TYPE = 'video/mp4';
const COMMAND_TIMEOUT_MILLISECONDS = 15000;
const POSITION_PATTERN = /getCurrentPosition\] position : (\d+)/g;
const MILLISECONDS_PER_SECOND = 1000;

const REMOTE_KEYS = {
    playPause: 85,
    pause: 127,
    play: 126,
    stop: 86,
    forward: 90,
    rewind: 89,
    back: 4,
    right: 22,
    left: 21,
    center: 23
};

function runAdb(deviceAddress, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(ADB_PATH, ['-s', deviceAddress].concat(args), { windowsHide: true });
        let standardOutput = '';
        let standardError = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('adb timed out'));
        }, COMMAND_TIMEOUT_MILLISECONDS);
        child.stdout.on('data', (chunk) => { standardOutput += chunk.toString(); });
        child.stderr.on('data', (chunk) => { standardError += chunk.toString(); });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(standardOutput);
            } else {
                reject(new Error(standardError.trim() || `adb exited ${code}`));
            }
        });
    });
}

function buildLaunchArguments(mediaUrl, mimeType) {
    return [
        'shell', 'am', 'start',
        '-a', VIEW_ACTION,
        '-d', mediaUrl,
        '-t', mimeType || DEFAULT_MIME_TYPE,
        '-n', PLAYER_COMPONENT
    ];
}

function buildKeyArguments(keyName) {
    const code = REMOTE_KEYS[keyName];
    if (code === undefined) {
        throw new Error(`unknown remote key "${keyName}"`);
    }
    return ['shell', 'input', 'keyevent', String(code)];
}

function parseLatestPositionMilliseconds(logText) {
    let latest = null;
    let match = POSITION_PATTERN.exec(logText);
    while (match !== null) {
        latest = Number(match[1]);
        match = POSITION_PATTERN.exec(logText);
    }
    POSITION_PATTERN.lastIndex = 0;
    return latest;
}

async function connect(deviceAddress) {
    await new Promise((resolve) => {
        const child = spawn(ADB_PATH, ['connect', deviceAddress], { windowsHide: true });
        child.on('close', resolve);
        child.on('error', resolve);
    });
    const devices = await runAdb(deviceAddress, ['get-state']).catch(() => '');
    return devices.trim() === 'device';
}

async function launch(deviceAddress, mediaUrl, mimeType) {
    const output = await runAdb(deviceAddress, buildLaunchArguments(mediaUrl, mimeType));
    if (/Error type|does not exist/i.test(output)) {
        throw new Error(output.trim().split('\n').slice(-1)[0]);
    }
    return true;
}

async function sendKey(deviceAddress, keyName) {
    await runAdb(deviceAddress, buildKeyArguments(keyName));
    return true;
}

async function readPositionSeconds(deviceAddress) {
    const log = await runAdb(deviceAddress, ['logcat', '-d', '-t', '400']);
    const milliseconds = parseLatestPositionMilliseconds(log);
    return milliseconds === null ? null : milliseconds / MILLISECONDS_PER_SECOND;
}

async function isForeground(deviceAddress) {
    const output = await runAdb(deviceAddress, ['shell', 'dumpsys', 'activity', 'activities']);
    return output.includes('com.droidlogic.videoplayer.MoviePlayer');
}

module.exports = {
    connect,
    launch,
    sendKey,
    readPositionSeconds,
    isForeground,
    buildLaunchArguments,
    buildKeyArguments,
    parseLatestPositionMilliseconds,
    REMOTE_KEYS,
    PLAYER_COMPONENT,
    ADB_PATH
};
