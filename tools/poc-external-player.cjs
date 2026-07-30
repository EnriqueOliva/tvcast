const adbplayer = require('../lib/adbplayer');

const DEVICE_ADDRESS = process.env.TVCAST_TV || '192.168.1.27:5555';
const SERVER_BASE = process.env.TVCAST_SERVER || 'http://127.0.0.1:8787';
const SETTLE_MILLISECONDS = 12000;
const SAMPLE_GAP_MILLISECONDS = 5000;

function log(message) {
    process.stdout.write(`${message}\n`);
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchLongestLibraryItem() {
    const response = await fetch(`${SERVER_BASE}/api/library`);
    const payload = await response.json();
    const sorted = payload.items.slice().sort((left, right) => right.sizeBytes - left.sizeBytes);
    return sorted[0] || null;
}

const POSITION_RETRY_ATTEMPTS = 6;
const POSITION_RETRY_DELAY_MILLISECONDS = 2000;

async function readPositionWithRetry() {
    for (let attempt = 0; attempt < POSITION_RETRY_ATTEMPTS; attempt += 1) {
        const seconds = await adbplayer.readPositionSeconds(DEVICE_ADDRESS);
        if (seconds !== null) {
            return seconds;
        }
        await wait(POSITION_RETRY_DELAY_MILLISECONDS);
    }
    return null;
}

async function checkStep(name, work) {
    try {
        const outcome = await work();
        log(`  PASS  ${name}${outcome ? ` — ${outcome}` : ''}`);
        return true;
    } catch (error) {
        log(`  FAIL  ${name} — ${error.message}`);
        return false;
    }
}

async function main() {
    log(`external player proof of concept against ${DEVICE_ADDRESS}`);

    const connected = await adbplayer.connect(DEVICE_ADDRESS);
    if (connected === false) {
        log('  FAIL  adb could not reach the TV. Enable network debugging and accept the prompt.');
        process.exit(1);
    }
    log('  PASS  adb connected');

    const item = await fetchLongestLibraryItem();
    if (item === null) {
        log('  FAIL  the library is empty, nothing to play');
        process.exit(1);
    }
    const mediaUrl = `${SERVER_BASE.replace('127.0.0.1', process.env.TVCAST_LAN || '192.168.1.8')}/media/${item.id}.mp4`;
    log(`  using "${item.title}"`);

    const results = [];

    results.push(await checkStep('player launches with our stream', async () => {
        await adbplayer.launch(DEVICE_ADDRESS, mediaUrl, 'video/mp4');
        await wait(SETTLE_MILLISECONDS);
        return mediaUrl;
    }));

    results.push(await checkStep('player is in the foreground', async () => {
        const foreground = await adbplayer.isForeground(DEVICE_ADDRESS);
        if (foreground === false) {
            throw new Error('MoviePlayer is not the resumed activity');
        }
        return 'MoviePlayer resumed';
    }));

    results.push(await checkStep('the player reports a playback position', async () => {
        const seconds = await readPositionWithRetry();
        if (seconds === null) {
            throw new Error('no position line appeared in the log');
        }
        return `${seconds.toFixed(1)}s`;
    }));

    results.push(await checkStep('the remote pause key stops playback', async () => {
        await adbplayer.sendKey(DEVICE_ADDRESS, 'pause');
        await wait(SAMPLE_GAP_MILLISECONDS);
        const first = await adbplayer.readPositionSeconds(DEVICE_ADDRESS);
        await wait(SAMPLE_GAP_MILLISECONDS);
        const second = await adbplayer.readPositionSeconds(DEVICE_ADDRESS);
        if (first === null || second === null) {
            throw new Error('no position reported');
        }
        if (second !== first) {
            throw new Error(`position kept moving: ${first}s -> ${second}s`);
        }
        return `frozen at ${first.toFixed(1)}s`;
    }));

    results.push(await checkStep('the remote play key resumes playback', async () => {
        await adbplayer.sendKey(DEVICE_ADDRESS, 'play');
        await wait(SAMPLE_GAP_MILLISECONDS);
        const first = await adbplayer.readPositionSeconds(DEVICE_ADDRESS);
        await wait(SAMPLE_GAP_MILLISECONDS);
        const second = await adbplayer.readPositionSeconds(DEVICE_ADDRESS);
        if (first === null || second === null) {
            throw new Error('no position reported');
        }
        if (second <= first) {
            throw new Error(`still frozen at ${first}s`);
        }
        return `${first.toFixed(1)}s -> ${second.toFixed(1)}s`;
    }));

    results.push(await checkStep('the remote forward key moves the position', async () => {
        const before = await adbplayer.readPositionSeconds(DEVICE_ADDRESS);
        await adbplayer.sendKey(DEVICE_ADDRESS, 'forward');
        await wait(SAMPLE_GAP_MILLISECONDS);
        const after = await adbplayer.readPositionSeconds(DEVICE_ADDRESS);
        if (before === null || after === null) {
            throw new Error('no position reported');
        }
        if (after <= before + 1) {
            throw new Error(`forward did nothing: ${before}s -> ${after}s`);
        }
        return `${before.toFixed(1)}s -> ${after.toFixed(1)}s`;
    }));

    await adbplayer.sendKey(DEVICE_ADDRESS, 'back').catch(() => undefined);

    const passed = results.filter(Boolean).length;
    log('');
    log(`${passed}/${results.length} checks passed`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
    log(`crashed: ${error.message}`);
    process.exit(1);
});
