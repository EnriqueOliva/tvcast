const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Drives the real phone app and the real Fire TV app on the real hardware.
// Nothing here talks to a mock: taps are "adb shell input tap" at coordinates worked out
// from the live DOM, remote presses are real key events, and every assertion reads back
// either the live DOM, the device's own log, or the server's state.

const PROJECT_ROOT = path.join(__dirname, '..');
const ADB = process.env.CAPYTV_ADB || 'C:\\Android\\Sdk\\platform-tools\\adb.exe';
const PHONE_SERIAL = process.env.CAPYTV_PHONE || 'RFGYC22020B';
const TELEVISION_SERIAL = process.env.CAPYTV_TV || '192.168.1.32:5555';
const PHONE_PACKAGE = 'com.enrique.capytv';
const TELEVISION_PACKAGE = 'com.enrique.capytv';
const SERVER_BASE_URL = process.env.CAPYTV_SERVER || 'http://127.0.0.1:8787';
const DEVTOOLS_PORT = 9222;
const EMPTY_STRING = '';
const SETTLE_MILLISECONDS = 900;
const DEFAULT_WAIT_MILLISECONDS = 15000;
const POLL_MILLISECONDS = 250;

const OMER_EPISODE_ONE = 'https://www.youtube.com/watch?v=lAYMIehbdfQ';
const OMER_EPISODE_TWO = 'https://www.youtube.com/watch?v=EVoCU94v118';

function adb(serial, args, options) {
    const settings = options || {};
    const outcome = spawnSync(ADB, ['-s', serial].concat(args), {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: settings.timeout || 60000
    });
    return `${outcome.stdout || EMPTY_STRING}${settings.includeStderr ? (outcome.stderr || EMPTY_STRING) : EMPTY_STRING}`;
}

function shell(serial, command, options) {
    return adb(serial, ['shell', command], options);
}

function sleep(milliseconds) {
    return new Promise((done) => setTimeout(done, milliseconds));
}

async function waitFor(description, predicate, timeoutMilliseconds) {
    const deadline = Date.now() + (timeoutMilliseconds || DEFAULT_WAIT_MILLISECONDS);
    let last = null;
    while (Date.now() < deadline) {
        last = await predicate();
        if (last) {
            return last;
        }
        await sleep(POLL_MILLISECONDS);
    }
    throw new Error(`timed out waiting for ${description}`);
}

// ---------------------------------------------------------------------------
// A devtools connection into the real WebView, used only to read the page and
// to locate elements. Every actual interaction is a real tap or a real keystroke.
// ---------------------------------------------------------------------------

class WebViewSession {
    constructor(serial) {
        this.serial = serial;
        this.socket = null;
        this.nextId = 1;
        this.pending = new Map();
        this.viewportBounds = null;
    }

    findDevtoolsSocket() {
        const sockets = shell(this.serial, 'cat /proc/net/unix');
        const matched = /@(webview_devtools_remote_\d+)/.exec(sockets);
        if (matched === null) {
            throw new Error('the phone app is not running with webview debugging on');
        }
        return matched[1];
    }

    readWebViewBounds() {
        shell(this.serial, 'uiautomator dump /sdcard/capytv-ui.xml');
        const dump = shell(this.serial, 'cat /sdcard/capytv-ui.xml');
        shell(this.serial, 'rm -f /sdcard/capytv-ui.xml');
        const matched = /class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(dump);
        if (matched === null) {
            throw new Error('could not find the WebView on screen');
        }
        return {
            left: Number(matched[1]),
            top: Number(matched[2]),
            right: Number(matched[3]),
            bottom: Number(matched[4])
        };
    }

    // The app has to start, find the pc and load before there is anything to drive. Wait for
    // a page that has actually loaded rather than grabbing whatever socket exists first.
    async connect() {
        const page = await waitFor('the app to open a loaded page', async () => {
            let socketName = EMPTY_STRING;
            try {
                socketName = this.findDevtoolsSocket();
            } catch (error) {
                void error;
                return null;
            }
            adb(this.serial, ['forward', '--remove-all']);
            adb(this.serial, ['forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:${socketName}`]);
            await sleep(300);
            try {
                const listed = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
                const candidate = listed.find((entry) => entry.type === 'page'
                    && typeof entry.url === 'string' && entry.url.startsWith('http://'));
                return candidate === undefined ? null : candidate;
            } catch (error) {
                void error;
                return null;
            }
        }, 45000);

        this.socket = new WebSocket(page.webSocketDebuggerUrl);
        this.socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            const waiting = this.pending.get(message.id);
            if (waiting !== undefined) {
                this.pending.delete(message.id);
                if (message.error !== undefined) {
                    waiting.reject(new Error(message.error.message));
                } else {
                    waiting.resolve(message.result);
                }
            }
        });
        this.socket.addEventListener('close', () => {
            for (const waiting of this.pending.values()) {
                waiting.reject(new Error('the devtools connection to the phone closed mid-call'));
            }
            this.pending.clear();
        }, { once: true });
        await new Promise((ready, failed) => {
            this.socket.addEventListener('open', ready, { once: true });
            this.socket.addEventListener('error', () => failed(new Error('devtools refused')), { once: true });
        });
        await waitFor('the page to finish loading', async () => {
            try {
                return await this.evaluate(`
                    return document.readyState === 'complete'
                        && document.querySelector('.brand') !== null;
                `);
            } catch (error) {
                void error;
                return false;
            }
        }, 30000);
        this.viewportBounds = this.readWebViewBounds();
        return page.url;
    }

    // A closed socket leaves every pending call unsettled, the event loop empties and node
    // exits cleanly in the middle of the run, taking the results with it. Fail loudly instead.
    send(method, params) {
        const id = this.nextId;
        this.nextId += 1;
        if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('the devtools connection to the phone has gone'));
        }
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }

    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression: `(function () { ${expression} })()`,
            returnByValue: true,
            awaitPromise: true
        });
        if (result.exceptionDetails !== undefined) {
            throw new Error(`page threw: ${result.exceptionDetails.text}`);
        }
        return result.result.value;
    }

    // Where the element sits on the physical screen, so it can be tapped for real.
    // Refuses anything a finger could not actually press: hidden, zero sized, or disabled
    // while the page is busy. Returning null makes the caller wait rather than tap thin air.
    async locate(describeExpression) {
        const box = await this.evaluate(`
            var target = ${describeExpression};
            if (target === null || target === undefined) { return null; }
            if (target.disabled === true) { return null; }
            var rect = target.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) { return null; }
            if (rect.bottom <= 0 || rect.top >= window.innerHeight) { return null; }
            return {
                centreX: rect.left + rect.width / 2,
                centreY: rect.top + rect.height / 2,
                pageWidth: window.innerWidth,
                pageHeight: window.innerHeight
            };
        `);
        if (box === null) {
            return null;
        }
        // Re-read every time. The soft keyboard resizes the WebView, so bounds captured once
        // at connect send later taps to the wrong place, silently and without any error.
        const bounds = this.readWebViewBounds();
        const scaleX = (bounds.right - bounds.left) / box.pageWidth;
        const scaleY = (bounds.bottom - bounds.top) / box.pageHeight;
        return {
            x: Math.round(bounds.left + box.centreX * scaleX),
            y: Math.round(bounds.top + box.centreY * scaleY)
        };
    }

    async tap(describeExpression, label) {
        const point = await waitFor(`${label} to be pressable`, () => this.locate(describeExpression));
        shell(this.serial, `input tap ${point.x} ${point.y}`);
        await sleep(SETTLE_MILLISECONDS);
        return point;
    }

    // Same real tap, but hands control straight back. Anything that has to watch a short lived
    // state cannot afford to sleep through it first.
    async tapAndWatch(describeExpression, label, readExpression, wantedDescription, timeoutMilliseconds) {
        const point = await waitFor(`${label} to be pressable`, () => this.locate(describeExpression));
        shell(this.serial, `input tap ${point.x} ${point.y}`);
        const deadline = Date.now() + (timeoutMilliseconds || DEFAULT_WAIT_MILLISECONDS);
        while (Date.now() < deadline) {
            const seen = await this.evaluate(readExpression);
            if (seen !== null && seen !== undefined && seen !== false) {
                return seen;
            }
        }
        throw new Error(`after tapping ${label}, ${wantedDescription} never appeared`);
    }

    // Tapping and then reading the page in the next breath is a race: the tap is delivered
    // to the device asynchronously and the handler may not have run yet. Every interaction
    // that expects a visible consequence must wait for that consequence, and retry the tap
    // if the first one was swallowed.
    async tapUntil(describeExpression, label, settledExpression, description) {
        const deadline = Date.now() + DEFAULT_WAIT_MILLISECONDS;
        let attempts = 0;
        while (Date.now() < deadline) {
            await this.tap(describeExpression, label);
            attempts += 1;
            const settledBy = Date.now() + 4000;
            while (Date.now() < settledBy) {
                if (await this.evaluate(`return Boolean(${settledExpression});`)) {
                    return attempts;
                }
                await sleep(POLL_MILLISECONDS);
            }
        }
        throw new Error(`tapped ${label} ${attempts} time(s) but ${description} never happened`);
    }

    // Tap to focus for real, then insert the text as a genuine input event. "adb shell input
    // text" runs the argument through the device shell, where the ? and & in a url are
    // metacharacters, and it silently delivers a mangled string.
    async typeInto(describeExpression, text, label) {
        await this.tap(describeExpression, label);
        const focused = await this.evaluate(`
            var target = ${describeExpression};
            return document.activeElement === target;
        `);
        if (focused === false) {
            await this.evaluate(`${describeExpression}.focus(); return true;`);
        }
        await this.send('Input.insertText', { text });
        await sleep(SETTLE_MILLISECONDS);
        const landed = await this.evaluate(`return ${describeExpression}.value;`);
        if (landed !== text) {
            throw new Error(`typing into ${label} produced "${landed}"`);
        }
    }

    close() {
        if (this.socket !== null) {
            this.socket.close();
            this.socket = null;
        }
        adb(this.serial, ['forward', '--remove-all']);
    }
}

// ---------------------------------------------------------------------------
// Helpers that read the truth from somewhere other than the thing under test
// ---------------------------------------------------------------------------

async function serverGet(route) {
    const response = await fetch(`${SERVER_BASE_URL}${route}`);
    return response.json();
}

function clearTelevisionLog() {
    adb(TELEVISION_SERIAL, ['logcat', '-c']);
}

function televisionLog() {
    return adb(TELEVISION_SERIAL, ['logcat', '-d', '-s', 'capytv:*']);
}

function wakeTelevision() {
    shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_WAKEUP');
}

function televisionResumedActivity() {
    const dumped = shell(TELEVISION_SERIAL, 'dumpsys activity activities');
    const matched = /ResumedActivity: ActivityRecord\{[^}]*?\s(\S+\/\S+)\s/.exec(dumped);
    return matched === null ? EMPTY_STRING : matched[1];
}

function phoneResumedActivity() {
    const dumped = shell(PHONE_SERIAL, 'dumpsys activity activities');
    const matched = /topResumedActivity=ActivityRecord\{[^}]*?\s(\S+\/\S+)\s/.exec(dumped);
    return matched === null ? EMPTY_STRING : matched[1];
}

const AAPT2 = process.env.CAPYTV_AAPT2 || 'C:\\Android\\sdk\\build-tools\\36.0.0\\aapt2.exe';

function installedApplicationLabel(serial, packageName) {
    const paths = shell(serial, `pm path ${packageName}`);
    const matched = /package:(\S+)/.exec(paths);
    if (matched === null) {
        throw new Error(`${packageName} is not installed on ${serial}`);
    }
    const localCopy = path.join(require('node:os').tmpdir(), `capytv-label-${Date.now()}.apk`);
    adb(serial, ['pull', matched[1], localCopy]);
    try {
        const badging = spawnSync(AAPT2, ['dump', 'badging', localCopy],
            { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        const label = /application-label:'([^']*)'/.exec(badging.stdout || EMPTY_STRING);
        return label === null ? EMPTY_STRING : label[1];
    } finally {
        try {
            fs.unlinkSync(localCopy);
        } catch (error) {
            void error;
        }
    }
}

// dumpsys never carries view text, so the only way to read what is actually on the
// television is the accessibility tree.
function televisionScreenText() {
    shell(TELEVISION_SERIAL, 'uiautomator dump /sdcard/capytv-tv.xml');
    const dump = shell(TELEVISION_SERIAL, 'cat /sdcard/capytv-tv.xml');
    shell(TELEVISION_SERIAL, 'rm -f /sdcard/capytv-tv.xml');
    const found = [];
    const pattern = /text="([^"]*)"/g;
    let matched = pattern.exec(dump);
    while (matched !== null) {
        const text = matched[1].replace(/&#10;/g, '\n').trim();
        if (text !== EMPTY_STRING) {
            found.push(text);
        }
        matched = pattern.exec(dump);
    }
    return found;
}

function phoneUiDump() {
    shell(PHONE_SERIAL, 'uiautomator dump /sdcard/capytv-dialog.xml');
    const dump = shell(PHONE_SERIAL, 'cat /sdcard/capytv-dialog.xml');
    shell(PHONE_SERIAL, 'rm -f /sdcard/capytv-dialog.xml');
    return dump;
}

function findNativeButton(dump, label) {
    const pattern = new RegExp(`text="${label}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
    const matched = pattern.exec(dump);
    if (matched === null) {
        return null;
    }
    return {
        x: Math.round((Number(matched[1]) + Number(matched[3])) / 2),
        y: Math.round((Number(matched[2]) + Number(matched[4])) / 2)
    };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const results = [];

const ONLY_ARGUMENT = process.argv.find((argument) => argument.startsWith('--only='));
const ONLY_PATTERN = ONLY_ARGUMENT === undefined
    ? EMPTY_STRING
    : ONLY_ARGUMENT.slice('--only='.length);

async function runTest(name, body) {
    if (ONLY_PATTERN !== EMPTY_STRING && name.includes(ONLY_PATTERN) === false) {
        return;
    }
    const startedAt = Date.now();
    try {
        await body();
        results.push({ name, ok: true, milliseconds: Date.now() - startedAt });
        process.stdout.write(`PASS  ${name}\n`);
    } catch (error) {
        results.push({ name, ok: false, reason: error.message, milliseconds: Date.now() - startedAt });
        process.stdout.write(`FAIL  ${name}\n        ${error.message}\n`);
    }
}

function assert(condition, message) {
    if (condition === false || condition === null || condition === undefined) {
        throw new Error(message);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`);
    }
}

// The run takes long enough for the phone to sleep on its own, and a sleeping phone kills the
// webview along with the devtools socket the suite is driving it through.
function keepPhoneAwake() {
    shell(PHONE_SERIAL, 'svc power stayon true');
}

async function restartPhoneApp() {
    shell(PHONE_SERIAL, `am force-stop ${PHONE_PACKAGE}`);
    await sleep(800);
    shell(PHONE_SERIAL, 'input keyevent KEYCODE_WAKEUP');
    keepPhoneAwake();
    shell(PHONE_SERIAL, 'cmd statusbar collapse');
    shell(PHONE_SERIAL, `am start -n ${PHONE_PACKAGE}/.MainActivity`);
    await sleep(6000);
}

async function main() {
    process.stdout.write('capyTV device tests, real phone and real fire tv\n\n');

    wakeTelevision();
    shell(TELEVISION_SERIAL, `am start -n ${TELEVISION_PACKAGE}/.HomeActivity`);
    await restartPhoneApp();

    const phone = new WebViewSession(PHONE_SERIAL);
    const loadedUrl = await phone.connect();

    async function ensurePhoneConnected() {
        if (phone.socket !== null && phone.socket.readyState === WebSocket.OPEN) {
            return;
        }
        phone.close();
        await restartPhoneApp();
        await phone.connect();
    }

    try {
        await runTest('phone: the app opens on the capyTV page, having found the pc itself', async () => {
            assert(loadedUrl.startsWith('http://'), 'the webview never loaded a page');
            const state = await phone.evaluate(`
                return {
                    title: document.title,
                    brand: document.querySelector('.brand').textContent,
                    televisionLabel: document.getElementById('televisionLabel').textContent,
                    dotClass: document.getElementById('televisionDot').className
                };
            `);
            assertEqual(state.title, 'capyTV', 'the page title');
            assertEqual(state.brand, 'capyTV', 'the header on screen');
            assert(state.dotClass.includes('on'), `the tv should be found, label says "${state.televisionLabel}"`);
        });

        // Reads the label out of the apk that is actually installed, which is the string the
        // launcher puts under the icon. Renaming the web page can never change this, and
        // asserting on the page instead is exactly how the old name survived unnoticed.
        await runTest('phone: the icon in the app drawer says capyTV', async () => {
            const label = installedApplicationLabel(PHONE_SERIAL, PHONE_PACKAGE);
            assertEqual(label, 'capyTV', 'the label under the launcher icon');

            const packages = shell(PHONE_SERIAL, 'pm list packages');
            assert(packages.includes('com.enrique.tvcast') === false,
                'the old tvcast app is still installed alongside the new one');
        });

        await runTest('television: the app on the fire tv is called capyTV too', async () => {
            const label = installedApplicationLabel(TELEVISION_SERIAL, TELEVISION_PACKAGE);
            assertEqual(label, 'capyTV', 'the label on the fire tv launcher');

            const packages = shell(TELEVISION_SERIAL, 'pm list packages');
            assert(packages.includes('com.enrique.tvcast') === false,
                'the old tvcast build is still on the fire tv');
        });

        await runTest('phone: the bottom drawer offers downloads and the omer collection', async () => {
            const buttons = await phone.evaluate(`
                return Array.from(document.querySelectorAll('#drawer button')).map(function (b) { return b.textContent; });
            `);
            assert(buttons.includes('downloads'), `no downloads button, saw ${JSON.stringify(buttons)}`);
            assert(buttons.some((text) => text.startsWith('omer')),
                `no omer button, saw ${JSON.stringify(buttons)}`);
        });

        await runTest('phone: tapping the omer button opens all 50 episodes in running order', async () => {
            await phone.tapUntil(
                `Array.from(document.querySelectorAll('#drawer button')).find(function (b) { return b.textContent.indexOf('omer') === 0; })`,
                'the omer button',
                `document.getElementById('listTitle').textContent === 'omer'
                    && document.getElementById('listView').classList.contains('on')`,
                'the omer list opening');
            const listing = await waitFor('the episode list', async () => {
                const rows = await phone.evaluate(`
                    return Array.from(document.querySelectorAll('#list .item .name')).map(function (n) { return n.textContent; });
                `);
                return rows.length > 0 ? rows : null;
            });
            assertEqual(listing.length, 50, 'the episode count on screen');
            assert(listing[0].includes('1. B'), `the first row should be episode one, saw "${listing[0]}"`);
            assert(listing[49].includes('50. B'), `the last row should be episode fifty, saw "${listing[49]}"`);
            assert(listing.some((title) => title.includes('\uFFFD')) === false,
                'an episode title came back with mangled accents');
        });

        await runTest('phone: tapping play on episode two actually starts it on the television', async () => {
            clearTelevisionLog();
            await phone.tap(
                `Array.from(document.querySelectorAll('#list .item')).filter(function (row) {
                    return row.querySelector('.sub').textContent.indexOf('EVoCU94v118') >= 0;
                }).map(function (row) { return row.querySelector('button'); })[0]`,
                'play on episode two');

            await waitFor('the television to start episode two', () => {
                const log = televisionLog();
                return log.includes('contentKey=direct:855cfad0998c');
            }, 90000);

            // The cues arrive a fraction of a second after the item loads, so wait for them
            // rather than reading the log the instant the title appears.
            await waitFor('the english subtitles to load', () => {
                return /loaded \d+ cues for English/.test(televisionLog());
            }, 20000);

            const log = televisionLog();
            assert(log.includes('video capped at 1080p'), 'the television did not pin 1080p');
            assertEqual(televisionResumedActivity(), `${TELEVISION_PACKAGE}/.PlayerActivity`,
                'the television should be on the player screen');
        });

        await runTest('television: the remote shifts the subtitles with up and down', async () => {
            // Assert the change, not an absolute value: the offset carries over from whatever
            // was watched last, so a fixed expectation only passes on a fresh episode.
            const readOffset = async () => {
                clearTelevisionLog();
                const seen = await waitFor('a progress report', () => {
                    const matched = /offset=(-?\d+)/.exec(televisionLog());
                    return matched === null ? null : matched;
                }, 20000);
                return Number(seen[1]);
            };

            const before = await readOffset();

            clearTelevisionLog();
            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_DPAD_UP');
            await sleep(600);
            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_DPAD_UP');
            await sleep(600);
            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_DPAD_DOWN');
            await sleep(600);

            const pressLog = televisionLog();
            assert((pressLog.match(/KEYCODE_DPAD_UP/g) || []).length >= 2,
                'the up presses never reached the app');
            assert(pressLog.includes('KEYCODE_DPAD_DOWN'), 'the down press never reached the app');

            const after = await readOffset();
            assertEqual(after - before, 100,
                'two steps later and one earlier should move the subtitles one step later');

            // Put it back so the next episode is not left shifted by a test.
            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_DPAD_DOWN');
            await sleep(600);
            const restored = await readOffset();
            assertEqual(restored, before, 'the offset was not put back where it started');
        });

        await runTest('television: the menu button opens the captions and volume panel', async () => {
            clearTelevisionLog();
            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_MENU');
            await sleep(1500);
            const dumped = shell(TELEVISION_SERIAL, 'dumpsys activity top');
            const panelVisible = /android\.widget\.ScrollView\{[0-9a-f]+ VFED/.test(dumped);
            assert(panelVisible, 'the settings panel did not appear');
            assert(televisionLog().includes('KEYCODE_MENU'), 'the menu key never reached the app');

            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_BACK');
            await sleep(1200);
            const afterClose = shell(TELEVISION_SERIAL, 'dumpsys activity top');
            assert(/android\.widget\.ScrollView\{[0-9a-f]+ VFED/.test(afterClose) === false,
                'back did not close the panel');
            assertEqual(televisionResumedActivity(), `${TELEVISION_PACKAGE}/.PlayerActivity`,
                'closing the panel must not leave the player');
        });

        await runTest('television: leaving the player saves where you stopped', async () => {
            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_BACK');
            await sleep(2500);
            const state = await serverGet('/api/links?collection=omer');
            assert(state.items.length === 50, 'the episode list changed unexpectedly');

            const resume = await waitFor('a saved position for episode two', async () => {
                const raw = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tvstate.json'), 'utf8'));
                const entry = raw.resume['direct:855cfad0998c'];
                return entry !== undefined && entry.positionMilliseconds > 0 ? entry : null;
            }, 20000);
            assert(resume.positionMilliseconds > 0, 'nothing was remembered');
            assertEqual(resume.subtitleId, 'autoenglish', 'the language watched in was not remembered');
        });

        await runTest('phone: back returns from the collection to the main page', async () => {
            await phone.tapUntil(`document.getElementById('backButton')`, 'the back button',
                `document.getElementById('homeView').classList.contains('on')`,
                'the main page coming back');
        });

        await runTest('phone: the downloads button opens saved media with its own paste box', async () => {
            await phone.tapUntil(`document.getElementById('downloadsButton')`, 'the downloads button',
                `document.getElementById('listTitle').textContent === 'downloads'`,
                'the downloads view opening');
            const view = await phone.evaluate(`
                return {
                    title: document.getElementById('listTitle').textContent,
                    hasPasteBox: document.getElementById('downloadCompose').hidden === false,
                    hasSearch: document.getElementById('searchWrap').hidden === false,
                    rows: document.querySelectorAll('#list .item').length
                };
            `);
            assertEqual(view.title, 'downloads', 'the heading');
            assertEqual(view.hasPasteBox, true, 'the download paste box should be here, not on the main page');
            assertEqual(view.hasSearch, true, 'the search box is missing');
            assert(view.rows > 0, 'no saved media listed, expected the files already in B:\\Media');
            await phone.tapUntil(`document.getElementById('backButton')`, 'the back button',
                `document.getElementById('homeView').classList.contains('on')`,
                'the main page coming back');
        });

        await runTest('phone: typing a link and tapping send plays it on the television', async () => {
            clearTelevisionLog();
            await phone.typeInto(`document.getElementById('linkInput')`, OMER_EPISODE_ONE, 'the paste box');
            shell(PHONE_SERIAL, 'input keyevent KEYCODE_BACK');
            await sleep(500);

            const typed = await phone.evaluate(`return document.getElementById('linkInput').value;`);
            assertEqual(typed, OMER_EPISODE_ONE, 'the link did not land in the box');

            // Blank the status first, or a leftover message from the last test makes the
            // settle check pass whether or not the tap actually landed.
            await phone.evaluate(`document.getElementById('statusLine').textContent = ''; return true;`);
            await phone.tapUntil(`document.getElementById('sendButton')`, 'the send button',
                `document.getElementById('statusLine').textContent.length > 0`,
                'the phone reporting what it is doing');

            await waitFor('the television to start episode one', () => {
                return televisionLog().includes('contentKey=direct:e417044166cc');
            }, 120000);

            const status = await phone.evaluate(`return document.getElementById('statusLine').textContent;`);
            assert(status.toLowerCase().includes('playing'),
                `the phone should confirm playback, it said "${status}"`);
        });

        await runTest('phone: pasting an episode already in a series leaves it in that series', async () => {
            const omer = await serverGet('/api/links?collection=omer');
            const main = await serverGet('/api/links?collection=main');
            assertEqual(omer.items.length, 50,
                'pasting an episode into the main box tore it out of the series');
            assert(main.items.some((entry) => entry.url === OMER_EPISODE_ONE) === false,
                'the episode was duplicated into the history');
        });

        await runTest('phone: a genuinely new link lands in the main list and can be forgotten', async () => {
            // Resolvable without the internet: the pc serves its own saved media over http,
            // so this exercises the same paste-and-send path a cineby link would.
            const saved = await serverGet('/api/library');
            assert(saved.items.length > 0, 'no saved media to build a test link from');
            const testLink = `${SERVER_BASE_URL.replace('127.0.0.1', '192.168.1.8')}/file/${saved.items[0].id}.mp4`;

            await phone.evaluate(`document.getElementById('linkInput').value = ''; return true;`);
            await phone.typeInto(`document.getElementById('linkInput')`, testLink, 'the paste box');
            shell(PHONE_SERIAL, 'input keyevent KEYCODE_BACK');
            await sleep(1200);
            await phone.evaluate(`document.getElementById('statusLine').textContent = ''; return true;`);
            await phone.tapUntil(`document.getElementById('sendButton')`, 'the send button',
                `document.getElementById('statusLine').textContent.length > 0`,
                'the phone reporting what it is doing');

            const rows = await waitFor('the new link to appear in the main list', async () => {
                const found = await phone.evaluate(`
                    return Array.from(document.querySelectorAll('#homeList .item .sub')).map(function (n) { return n.textContent; });
                `);
                return found.some((url) => url === testLink) ? found : null;
            }, 90000);
            assert(rows.some((url) => url === testLink), 'the link never reached the list');

            await phone.tap(
                `Array.from(document.querySelectorAll('#homeList .item')).filter(function (row) {
                    return row.querySelector('.sub').textContent === ${JSON.stringify(testLink)};
                }).map(function (row) { return row.querySelectorAll('button')[1]; })[0]`,
                'the forget button');

            const afterForget = await waitFor('the link to disappear', async () => {
                const found = await phone.evaluate(`
                    return Array.from(document.querySelectorAll('#homeList .item .sub')).map(function (n) { return n.textContent; });
                `);
                return found.some((url) => url === testLink) ? null : found;
            });
            assert(afterForget.some((url) => url === testLink) === false, 'forget did not remove the row');
        });

        await runTest('phone: sharing a link from another app offers to play or save it', async () => {
            shell(PHONE_SERIAL, `am force-stop ${PHONE_PACKAGE}`);
            await sleep(800);
            shell(PHONE_SERIAL,
                `am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT '${OMER_EPISODE_TWO}' -n ${PHONE_PACKAGE}/.ShareActivity`);
            const dump = await waitFor('the share dialog', () => {
                const seen = phoneUiDump();
                return seen.includes('play on the tv') ? seen : null;
            }, 20000);
            assert(dump.includes('capyTV'), 'the share dialog never appeared');
            assert(dump.includes(OMER_EPISODE_TWO), 'the dialog does not show the shared link');
            assert(findNativeButton(dump, 'play on the tv') !== null, 'no play option in the share dialog');
            assert(findNativeButton(dump, 'save on the pc') !== null, 'no save option in the share dialog');
        });

        await runTest('phone: choosing play in the share dialog reaches the television', async () => {
            clearTelevisionLog();
            const dump = phoneUiDump();
            const playButton = findNativeButton(dump, 'play on the tv');
            assert(playButton !== null, 'the share dialog is not on screen');
            shell(PHONE_SERIAL, `input tap ${playButton.x} ${playButton.y}`);

            await waitFor('the television to start the shared episode', () => {
                return televisionLog().includes('contentKey=direct:855cfad0998c');
            }, 120000);
            assertEqual(televisionResumedActivity(), `${TELEVISION_PACKAGE}/.PlayerActivity`,
                'the shared link did not open the player');
        });

        await runTest('television: the shared episode resumed where it was left off', async () => {
            const stored = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tvstate.json'), 'utf8'));
            const bookmark = stored.resume['direct:855cfad0998c'];
            assert(bookmark !== undefined, 'nothing was ever saved for this episode');

            // Read the position reported *after* the episode loaded. The outgoing item files
            // one last report as it is discarded, and that one belongs to the previous video.
            const reported = await waitFor('a position report for the episode itself', () => {
                const log = televisionLog();
                const loadedAt = log.indexOf('contentKey=direct:855cfad0998c');
                if (loadedAt < 0) {
                    return null;
                }
                const matched = /position=(\d+) duration=(\d+)[^\n]*subtitle=(\S*)/.exec(log.slice(loadedAt));
                return matched === null ? null : matched;
            }, 30000);

            const position = Number(reported[1]);
            assertEqual(Number(reported[2]), bookmark.durationMilliseconds,
                'the report came from a different video');
            assertEqual(reported[3], 'autoenglish', 'the remembered language did not come back');
            assert(Math.abs(position - bookmark.positionMilliseconds) < 15000,
                `should have resumed near ${bookmark.positionMilliseconds}ms, landed at ${position}ms`);
            assert(position > 60000, 'playback restarted from the beginning');
        });

        await runTest('television: going home from the player leaves the app on its own list', async () => {
            shell(TELEVISION_SERIAL, 'input keyevent KEYCODE_BACK');
            await sleep(2500);
            assertEqual(televisionResumedActivity(), `${TELEVISION_PACKAGE}/.HomeActivity`,
                'back from the player should land on the capyTV home screen');

            const onScreen = televisionScreenText();
            assert(onScreen.includes('capyTV'), 'the home screen has no heading');
            assert(onScreen.some((text) => text === 'links'), `no links tab, saw ${JSON.stringify(onScreen)}`);
            assert(onScreen.some((text) => text === 'downloads'), 'no downloads tab');
            assert(onScreen.some((text) => text.startsWith('omer (')), 'no omer tab');

            const episodeCount = Number(/omer \((\d+)\)/.exec(onScreen.join('|'))[1]);
            const stored = await serverGet('/api/links?collection=omer');
            assertEqual(episodeCount, stored.items.length,
                'the tab count on the tv disagrees with what the pc holds');
            assertEqual(episodeCount, 50,
                'the series lost an episode, something moved it to another collection');
        });

        // --- what the phone says is happening ---

        // The share tests force-stop the app, which takes the webview and the devtools socket
        // with it. Everything after that has to be driving a live app again.
        await runTest('phone: the app comes back after the share sheet killed it', async () => {
            await ensurePhoneConnected();
            const brand = await phone.evaluate(`return document.querySelector('.brand').textContent;`);
            assertEqual(brand, 'capyTV', 'the app did not come back up');
        });

        await runTest('phone: the activity panel is out of the way when the pc is idle', async () => {
            await waitFor('the pc to go quiet', async () => {
                const snapshot = await serverGet('/api/activity');
                return snapshot.running.length === 0;
            }, 30000);
            const panel = await waitFor('the panel to fold away', async () => {
                const state = await phone.evaluate(`
                    return {
                        hidden: document.getElementById('activityPanel').hidden,
                        jobs: document.querySelectorAll('#activityPanel .job').length
                    };
                `);
                return state.hidden === true ? state : null;
            }, 15000);
            assertEqual(panel.jobs, 0, 'the activity panel is still holding a stale job');
        });

        await runTest('phone: sending a link puts a live stage on screen while the pc works',
            async () => {
                const saved = await serverGet('/api/library');
                const testLink = `${SERVER_BASE_URL.replace('127.0.0.1', '192.168.1.8')}/file/${saved.items[0].id}.mp4`;
                await phone.evaluate(`document.getElementById('linkInput').value = ''; return true;`);
                await phone.typeInto(`document.getElementById('linkInput')`, testLink, 'the paste box');
                shell(PHONE_SERIAL, 'input keyevent KEYCODE_BACK');
                await sleep(1000);

                const shown = await phone.tapAndWatch(
                    `document.getElementById('sendButton')`,
                    'the send button',
                    `
                        var job = document.querySelector('#activityPanel .job');
                        if (job === null) { return null; }
                        return {
                            stage: job.querySelector('.jobstage').textContent,
                            hasSpinner: job.querySelector('.spinner') !== null,
                            hasRail: job.querySelector('.rail') !== null
                        };
                    `,
                    'the activity panel never reported a stage',
                    25000);

                assert(shown.stage.length > 0, 'the panel appeared with no stage written on it');
                assertEqual(shown.hasSpinner, true, 'a running job should show it is running');
                assertEqual(shown.hasRail, true, 'a running job should show a progress rail');
            });

        await runTest('phone: a finished job is announced and then gets out of the way', async () => {
            const saved = await serverGet('/api/library');
            const testLink = `${SERVER_BASE_URL.replace('127.0.0.1', '192.168.1.8')}/file/${saved.items[0].id}.mp4`;
            await phone.evaluate(`
                document.getElementById('linkInput').value = '';
                document.getElementById('toast').className = 'toast';
                return true;
            `);
            await phone.typeInto(`document.getElementById('linkInput')`, testLink, 'the paste box');
            shell(PHONE_SERIAL, 'input keyevent KEYCODE_BACK');
            await sleep(1000);
            await phone.tap(`document.getElementById('sendButton')`, 'the send button');

            const announced = await waitFor('the toast to appear', async () => {
                const state = await phone.evaluate(`
                    return {
                        className: document.getElementById('toast').className,
                        body: document.getElementById('toastBody').textContent
                    };
                `);
                return state.className.indexOf(' on') >= 0 ? state : null;
            }, 40000);
            assert(announced.body.length > 0, 'the toast appeared with nothing written on it');

            const cleared = await waitFor('the toast to go away again', async () => {
                const className = await phone.evaluate(
                    `return document.getElementById('toast').className;`);
                return className.indexOf(' on') < 0 ? className : null;
            }, 15000);
            assert(cleared.indexOf(' on') < 0, 'the toast never went away');
        });

        await runTest('phone: the send button refuses anything that is not a link', async () => {
            await phone.evaluate(`document.getElementById('linkInput').value = ''; return true;`);
            await phone.typeInto(`document.getElementById('linkInput')`, 'not a link at all',
                'the paste box');
            shell(PHONE_SERIAL, 'input keyevent KEYCODE_BACK');
            await sleep(900);
            await phone.tap(`document.getElementById('sendButton')`, 'the send button');

            const complaint = await waitFor('the phone to say why it refused', async () => {
                const state = await phone.evaluate(`
                    return {
                        text: document.getElementById('statusLine').textContent,
                        tone: document.getElementById('statusLine').className
                    };
                `);
                return state.text.length > 0 ? state : null;
            }, 10000);
            assert(/link/.test(complaint.text),
                `the complaint should mention it needs a link, it said "${complaint.text}"`);
            assert(complaint.tone.includes('bad'), 'a refusal should be shown as a problem');
            await phone.evaluate(`document.getElementById('linkInput').value = ''; return true;`);
        });

        await runTest('phone: an empty box is refused without bothering the pc', async () => {
            await phone.evaluate(`document.getElementById('linkInput').value = ''; return true;`);
            const before = await serverGet('/api/links?collection=main');
            await phone.tap(`document.getElementById('sendButton')`, 'the send button');
            await sleep(1500);
            const after = await serverGet('/api/links?collection=main');
            assertEqual(after.items.length, before.items.length,
                'an empty send still reached the pc and changed the list');
        });

        await runTest('phone: the downloads button carries a live count while something downloads',
            async () => {
                const badge = await phone.evaluate(`
                    return {
                        hidden: document.getElementById('downloadsBadge').hidden,
                        width: document.getElementById('downloadsBar').style.width
                    };
                `);
                assertEqual(badge.hidden, true,
                    'the downloads badge is showing with nothing downloading');

                await phone.evaluate(`
                    var live = [{ id: 'x1', kind: 'download', label: 'A film', stage: 'saving to the pc',
                        detail: '', percent: 44, outcome: 'running', startedAt: 1, updatedAt: 1, finishedAt: 0 }];
                    var real = window.fetch;
                    window.fetch = function (path, options) {
                        if (String(path).indexOf('/api/activity') >= 0) {
                            return Promise.resolve(new Response(
                                JSON.stringify({ running: live, finished: [] }),
                                { status: 200, headers: { 'Content-Type': 'application/json' } }));
                        }
                        return real(path, options);
                    };
                    window.__capytvRestoreFetch = function () { window.fetch = real; };
                    return true;
                `);

                const live = await waitFor('the downloads badge to light up', async () => {
                    const state = await phone.evaluate(`
                        return {
                            hidden: document.getElementById('downloadsBadge').hidden,
                            text: document.getElementById('downloadsBadge').textContent,
                            width: document.getElementById('downloadsBar').style.width,
                            jobs: document.querySelectorAll('#activityPanel .job').length
                        };
                    `);
                    return state.hidden === false ? state : null;
                }, 15000);

                assertEqual(live.text, '1', 'the badge should count the running downloads');
                assertEqual(live.width, '44%', 'the bar under the button should track the progress');
                assertEqual(live.jobs, 1, 'the download should also be listed in the activity panel');

                await phone.evaluate(`window.__capytvRestoreFetch(); return true;`);
                await waitFor('the badge to go out again', async () => {
                    const hidden = await phone.evaluate(
                        `return document.getElementById('downloadsBadge').hidden;`);
                    return hidden === true ? hidden : null;
                }, 20000);
            });

        await runTest('phone: the activity panel follows you into the downloads view', async () => {
            await phone.tapUntil(`document.getElementById('downloadsButton')`, 'the downloads button',
                `document.getElementById('listView').classList.contains('on')`,
                'the downloads view opening');
            const placement = await phone.evaluate(`
                return {
                    inList: document.getElementById('listActivitySlot')
                        .contains(document.getElementById('activityPanel')),
                    inHome: document.getElementById('homeActivitySlot')
                        .contains(document.getElementById('activityPanel'))
                };
            `);
            assertEqual(placement.inList, true,
                'the activity panel stayed behind on the home view');
            assertEqual(placement.inHome, false, 'the panel is somehow in both places');

            await phone.tapUntil(`document.getElementById('backButton')`, 'the back button',
                `document.getElementById('homeView').classList.contains('on')`,
                'the main page coming back');
            const returned = await phone.evaluate(`
                return document.getElementById('homeActivitySlot')
                    .contains(document.getElementById('activityPanel'));
            `);
            assertEqual(returned, true, 'the activity panel did not come back to the home view');
        });

        await runTest('phone: searching the saved media narrows the list and clearing restores it',
            async () => {
                await phone.tapUntil(`document.getElementById('downloadsButton')`, 'the downloads button',
                    `document.getElementById('listTitle').textContent === 'downloads'`,
                    'the downloads view opening');
                const all = await waitFor('the saved media', async () => {
                    const rows = await phone.evaluate(
                        `return document.querySelectorAll('#list .item').length;`);
                    return rows > 0 ? rows : null;
                }, 20000);

                await phone.typeInto(`document.getElementById('searchInput')`, 'zzzznothing',
                    'the search box');
                const empty = await waitFor('the search to come back empty', async () => {
                    const text = await phone.evaluate(
                        `return document.getElementById('list').textContent;`);
                    return /nothing matched/.test(text) ? text : null;
                }, 15000);
                assert(/nothing matched/.test(empty),
                    'searching for nonsense should say nothing matched');

                await phone.evaluate(`
                    var box = document.getElementById('searchInput');
                    box.value = '';
                    box.dispatchEvent(new Event('input'));
                    return true;
                `);
                const restored = await waitFor('the full list to come back', async () => {
                    const rows = await phone.evaluate(
                        `return document.querySelectorAll('#list .item').length;`);
                    return rows === all ? rows : null;
                }, 20000);
                assertEqual(restored, all, 'clearing the search did not bring the list back');

                await phone.tapUntil(`document.getElementById('backButton')`, 'the back button',
                    `document.getElementById('homeView').classList.contains('on')`,
                    'the main page coming back');
            });

        await runTest('phone: opening a collection and going back twice never strands you',
            async () => {
                for (let round = 0; round < 2; round += 1) {
                    await phone.tapUntil(
                        `Array.from(document.querySelectorAll('#drawer button')).find(function (b) { return b.textContent.indexOf('omer') === 0; })`,
                        'the omer button',
                        `document.getElementById('listTitle').textContent === 'omer'`,
                        'the omer list opening');
                    await phone.tapUntil(`document.getElementById('backButton')`, 'the back button',
                        `document.getElementById('homeView').classList.contains('on')`,
                        'the main page coming back');
                }
                const state = await phone.evaluate(`
                    return {
                        home: document.getElementById('homeView').classList.contains('on'),
                        list: document.getElementById('listView').classList.contains('on'),
                        sendable: document.getElementById('sendButton').disabled
                    };
                `);
                assertEqual(state.home, true, 'the phone did not end on the main page');
                assertEqual(state.list, false, 'both views are showing at once');
                assertEqual(state.sendable, false, 'the send button is stuck disabled');
            });

        await runTest('phone: the card explains why a film has no subtitles', async () => {
            const card = await phone.evaluate(`
                window.__capytvCard = document.getElementById('card');
                return {
                    hasWarningSlot: document.getElementById('cardWarning') !== null,
                    warningHidden: document.getElementById('cardWarning').hidden
                };
            `);
            assertEqual(card.hasWarningSlot, true, 'the card has nowhere to explain a problem');

            const saved = await serverGet('/api/library');
            const withoutSubtitles = saved.items.find((item) => item.hasSubtitle === false);
            assert(withoutSubtitles !== undefined, 'no saved media without subtitles to test with');

            await phone.tapUntil(`document.getElementById('downloadsButton')`, 'the downloads button',
                `document.getElementById('listTitle').textContent === 'downloads'`,
                'the downloads view opening');
            await phone.tap(
                `Array.from(document.querySelectorAll('#list .item')).filter(function (row) {
                    return row.querySelector('.name').textContent === ${JSON.stringify(withoutSubtitles.title)};
                }).map(function (row) { return row.querySelector('button'); })[0]`,
                'play on a file with no subtitles');

            const meta = await waitFor('the card to describe what was sent', async () => {
                const text = await phone.evaluate(`
                    var card = document.getElementById('card');
                    return card.hidden ? null : document.getElementById('cardMeta').textContent;
                `);
                return text;
            }, 60000);
            assert(/no subtitles offered|subtitles off/.test(meta),
                `the card should say what happened to the subtitles, it said "${meta}"`);

            await phone.tapUntil(`document.getElementById('backButton')`, 'the back button',
                `document.getElementById('homeView').classList.contains('on')`,
                'the main page coming back');
        });

        await runTest('phone: the app survives being killed and reopened without reconfiguring', async () => {
            phone.close();
            await restartPhoneApp();
            const reconnectedUrl = await phone.connect();
            assert(reconnectedUrl.startsWith('http://'), 'the app did not reload the page');
            const state = await phone.evaluate(`
                return {
                    brand: document.querySelector('.brand').textContent,
                    dotClass: document.getElementById('televisionDot').className
                };
            `);
            assertEqual(state.brand, 'capyTV', 'the header after a restart');
            assert(state.dotClass.includes('on'), 'the tv was not found again after a restart');
        });
    } finally {
        phone.close();
    }

    reachedTheEnd = true;
    const failed = results.filter((entry) => entry.ok === false);
    process.stdout.write(`\n${results.length - failed.length}/${results.length} device tests passed\n`);
    if (failed.length > 0) {
        process.stdout.write('\nfailures:\n');
        for (const entry of failed) {
            process.stdout.write(`  ${entry.name}\n    ${entry.reason}\n`);
        }
    }
    process.exit(failed.length === 0 ? 0 : 1);
}

// An exit that never reached the summary means the run was cut short, not that it passed.
let reachedTheEnd = false;

process.on('exit', (code) => {
    if (reachedTheEnd === false) {
        process.stdout.write(`\nthe run stopped early after ${results.length} test(s), exit ${code}\n`);
    }
    shell(PHONE_SERIAL, 'svc power stayon false');
});

main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
});
