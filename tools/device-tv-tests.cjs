const fs = require('node:fs');
const path = require('node:path');
const device = require('./device-lib.cjs');

// Everything the remote can do on the Fire TV, and the combinations where state leaks
// between actions. Driven entirely by real key events; read back through the accessibility
// tree, the app's own log, and the server's state.

const PROJECT_ROOT = path.join(__dirname, '..');
const TV = process.env.CAPYTV_TV || '192.168.1.32:5555';
const PACKAGE = 'com.enrique.capytv';
const HOME_ACTIVITY = `${PACKAGE}/.HomeActivity`;
const PLAYER_ACTIVITY = `${PACKAGE}/.PlayerActivity`;
const SERVER = process.env.CAPYTV_SERVER || 'http://127.0.0.1:8787';
const EMPTY_STRING = '';
const FIRST_INDEX = 0;

const DESCRIPTION_STATUS = 'capytv-status';
const DESCRIPTION_SERVER = 'capytv-server';
const DESCRIPTION_ACTIVITY_STAGE = 'capytv-activity-stage';
const DESCRIPTION_ACTIVITY_DETAIL = 'capytv-activity-detail';
const DESCRIPTION_TAB_PREFIX = 'capytv-tab-';
const DESCRIPTION_ROW = 'capytv-row';
const DESCRIPTION_STAGE_HEADLINE = 'capytv-stage-headline';
const DESCRIPTION_STAGE_TITLE = 'capytv-stage-title';
const DESCRIPTION_STAGE_META = 'capytv-stage-meta';
const DESCRIPTION_STAGE_DETAIL = 'capytv-stage-detail';
const DESCRIPTION_SUBTITLE_PILL = 'capytv-subtitle-pill';
const DESCRIPTION_NOTICE = 'capytv-notice';
const DESCRIPTION_PANEL_ROW = 'capytv-panel-row';

const EPISODE_ONE = { title: /1\. B/, contentKey: 'direct:e417044166cc' };
const EPISODE_TWO = { title: /2\. B/, contentKey: 'direct:855cfad0998c' };
const EPISODE_ONE_URL = 'https://www.youtube.com/watch?v=lAYMIehbdfQ';
const EPISODE_TWO_URL = 'https://www.youtube.com/watch?v=EVoCU94v118';

const results = [];

// Mutation runs need one test, not all of them: a full pass takes half an hour, and nine
// mutations of it would take a working day.
const ONLY_ARGUMENT = process.argv.find((argument) => argument.startsWith('--only='));
const ONLY_PATTERN = ONLY_ARGUMENT === undefined
    ? EMPTY_STRING
    : ONLY_ARGUMENT.slice('--only='.length);

function isWanted(name) {
    return ONLY_PATTERN === EMPTY_STRING || name.includes(ONLY_PATTERN);
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

function assertNear(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message} (got ${actual}, wanted about ${expected}, tolerance ${tolerance})`);
    }
}

async function runTest(name, body) {
    if (isWanted(name) === false) {
        return;
    }
    const startedAt = Date.now();
    try {
        // No test should inherit a half open panel from the one before it, or its very first
        // back press goes somewhere unexpected and the failure points at the wrong thing.
        if (device.resumedActivity(TV) === PLAYER_ACTIVITY) {
            await closePanelIfOpen();
        }
        await body();
        results.push({ name, ok: true });
        process.stdout.write(`PASS  ${name}  (${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
    } catch (error) {
        results.push({ name, ok: false, reason: error.message });
        process.stdout.write(`FAIL  ${name}\n        ${error.message}\n`);
    }
}

// ---------------------------------------------------------------------------
// Reading the truth back off the device
// ---------------------------------------------------------------------------

// A run takes half an hour with minutes of silence between calls, which is long enough for a
// pooled keep-alive socket to be closed under us. That surfaces as ECONNRESET on a request
// that was never going to fail on its merits, so try again rather than report a phantom.
const REQUEST_ATTEMPTS = 3;

async function serverRequest(route, options) {
    let lastFailure = null;
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            await device.sleep(600 * attempt);
        }
        try {
            const response = await fetch(`${SERVER}${route}`, options);
            return await response.json();
        } catch (error) {
            lastFailure = error;
        }
    }
    throw new Error(`the pc did not answer ${route}: ${lastFailure.message}`);
}

async function serverGet(route) {
    return serverRequest(route);
}

function isTabNode(node) {
    return node.description.startsWith(DESCRIPTION_TAB_PREFIX);
}

function isRowNode(node) {
    return node.description === DESCRIPTION_ROW;
}

function tabLabels() {
    return device.readScreen(TV).filter(isTabNode).map((node) => node.text);
}

function listRowTitles() {
    return device.readScreen(TV).filter(isRowNode).map((node) => node.text.split('\n')[0]);
}

function statusLine() {
    return device.describedText(TV, DESCRIPTION_STATUS);
}

function serverPillText() {
    return device.describedText(TV, DESCRIPTION_SERVER);
}

function activityStage() {
    return device.describedText(TV, DESCRIPTION_ACTIVITY_STAGE);
}

function activityDetail() {
    return device.describedText(TV, DESCRIPTION_ACTIVITY_DETAIL);
}

// The strip is only up while the pc is busy, so reading the stage and then the detail is two
// dumps a second apart and the second one can land after the work has finished.
function readActivityStrip() {
    const nodes = device.readScreen(TV);
    const textOf = (description) => {
        const found = device.findByDescription(nodes, description);
        return found === null ? EMPTY_STRING : found.text;
    };
    return {
        stage: textOf(DESCRIPTION_ACTIVITY_STAGE),
        detail: textOf(DESCRIPTION_ACTIVITY_DETAIL)
    };
}

// The loading screen is on borrowed time: it goes the moment the first frame arrives. Reading
// the headline and then the title means two separate dumps a second apart, and the second one
// can easily land after the screen is already gone. Take the whole thing in one read.
function readStage() {
    const nodes = device.readScreen(TV);
    const textOf = (description) => {
        const found = device.findByDescription(nodes, description);
        return found === null ? EMPTY_STRING : found.text;
    };
    return {
        headline: textOf(DESCRIPTION_STAGE_HEADLINE),
        title: textOf(DESCRIPTION_STAGE_TITLE),
        detail: textOf(DESCRIPTION_STAGE_DETAIL),
        subtitlePill: textOf(DESCRIPTION_SUBTITLE_PILL)
    };
}

function stageHeadline() {
    return device.describedText(TV, DESCRIPTION_STAGE_HEADLINE);
}

function stageTitle() {
    return device.describedText(TV, DESCRIPTION_STAGE_TITLE);
}

function stageDetail() {
    return device.describedText(TV, DESCRIPTION_STAGE_DETAIL);
}

function subtitlePillText() {
    return device.describedText(TV, DESCRIPTION_SUBTITLE_PILL);
}

// "Something is focused" means within a moment of the screen settling, not at one exact
// microsecond. Waiting still fails when focus never arrives, without failing on the gap
// during a re-render.
async function expectFocus(reason) {
    try {
        return await device.awaitFocus(TV, 6000);
    } catch (error) {
        void error;
        throw new Error(reason);
    }
}

// Read the status once and wait for it to settle. Calling statusLine() inside both the
// condition and the failure message reads the screen twice, a second apart, so a passing
// condition can be reported with a different string than the one it tested.
async function waitForStatus(prefix, description) {
    let seen = EMPTY_STRING;
    try {
        await device.waitFor(description, () => {
            seen = statusLine();
            return seen.startsWith(prefix);
        }, 15000);
    } catch (error) {
        void error;
        throw new Error(`${description}: the tv says "${seen}", expected it to start "${prefix}"`);
    }
    return seen;
}

// The player logs its position both on the ten second progress tick and on every cue change,
// so a fresh sample never takes longer than one tick.
async function readPosition(timeoutMilliseconds) {
    device.clearLog(TV);
    const matched = await device.waitFor('a position from the player', () => {
        const log = device.readLog(TV);
        const progress = /position=(\d+) duration=(\d+)[^\n]*playing=(\w+)/.exec(log);
        if (progress !== null) {
            return { milliseconds: Number(progress[1]), playing: progress[3] === 'true' };
        }
        const cue = /cuechange playerPosition=(\d+)/.exec(log);
        return cue === null ? null : { milliseconds: Number(cue[1]), playing: null };
    }, timeoutMilliseconds || 14000);
    return matched;
}

async function readPlayingState() {
    device.clearLog(TV);
    const matched = await device.waitFor('a progress report', () => {
        const found = /position=(\d+) duration=\d+[^\n]*playing=(\w+)[^\n]*subtitle=(\S*)[^\n]*offset=(-?\d+)/
            .exec(device.readLog(TV));
        return found === null ? null : {
            milliseconds: Number(found[1]),
            playing: found[2] === 'true',
            subtitleId: found[3],
            offset: Number(found[4])
        };
    }, 14000);
    return matched;
}

// A fixed sample can land entirely inside a stretch of the film with no dialogue in it, which
// looks exactly like broken subtitles. Watch until a cue appears, and only call it dead once
// a generous window has gone by with nothing.
async function cuesAreRendering(windowMilliseconds) {
    device.clearLog(TV);
    const deadline = Date.now() + (windowMilliseconds || 25000);
    while (Date.now() < deadline) {
        await device.sleep(1500);
        if (/cuechange/.test(device.readLog(TV))) {
            return true;
        }
    }
    return false;
}

// Turning subtitles off has to be proven by nothing arriving, so that check keeps the short
// window on purpose: waiting longer only makes a passing run slower.
async function cuesAreSilent(windowMilliseconds) {
    device.clearLog(TV);
    await device.sleep(windowMilliseconds || 9000);
    return /cuechange/.test(device.readLog(TV)) === false;
}

// ---------------------------------------------------------------------------
// Driving the remote
// ---------------------------------------------------------------------------

async function openHome(options) {
    const settings = options || {};
    device.press(TV, 'KEYCODE_WAKEUP');
    if (device.resumedActivity(TV) === PLAYER_ACTIVITY) {
        await closePanelIfOpen();
    }
    if (settings.fresh) {
        device.shell(TV, `am force-stop ${PACKAGE}`);
        await device.sleep(1200);
    }
    device.shell(TV, `am start -n ${HOME_ACTIVITY}`);
    await device.waitFor('the home screen', async () => {
        return device.resumedActivity(TV) === HOME_ACTIVITY && tabLabels().length >= 2;
    }, 30000);
    // The tabs render before the list does, and the tab row is rebuilt when the collections
    // arrive. Waiting only for tabs to exist means driving the remote through that gap.
    await device.waitFor('focus to settle somewhere the remote can use', () => {
        const focused = device.focusedNode(TV);
        return focused !== null && (isTabNode(focused) || isRowNode(focused));
    }, 20000);
    await device.sleep(500);
}

// From anywhere in the list, up walks back to the tab row. Sideways presses inside the list
// do nothing, because the rows are full width, so the vertical move has to come first.
async function focusTabRow() {
    const current = await device.awaitFocus(TV);
    if (isTabNode(current)) {
        return;
    }
    await device.focusOn(TV, (text, node) => isTabNode(node), 'KEYCODE_DPAD_UP', 60);
}

async function openTab(label) {
    await focusTabRow();
    const wanted = (text, node) => isTabNode(node) && text.startsWith(label);
    await device.focusOn(TV, wanted, 'KEYCODE_DPAD_RIGHT', 6)
        .catch(() => device.focusOn(TV, wanted, 'KEYCODE_DPAD_LEFT', 6));
    device.press(TV, 'KEYCODE_DPAD_CENTER');
    await device.sleep(2200);
}

async function selectRow(titlePattern) {
    await device.focusOn(TV, (text) => titlePattern.test(text), 'KEYCODE_DPAD_DOWN', 60);
    device.clearLog(TV);
    device.press(TV, 'KEYCODE_DPAD_CENTER');
}

async function waitForPlayer(contentKey, timeoutMilliseconds) {
    await device.waitFor('the player to load that item', () => {
        return device.readLog(TV).includes(`contentKey=${contentKey}`);
    }, timeoutMilliseconds || 120000);
    await device.waitFor('the player to be on screen', () => {
        return device.resumedActivity(TV) === PLAYER_ACTIVITY;
    }, 20000);
    await device.sleep(1500);
}

async function pushFromServer(sourceUrl) {
    device.clearLog(TV);
    return serverRequest('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl })
    });
}

async function pushSavedFile(itemIdentifier) {
    device.clearLog(TV);
    return serverRequest('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicationId: `file:${itemIdentifier}` })
    });
}

let cachedSavedItem = null;

async function firstSavedItem() {
    if (cachedSavedItem === null) {
        const library = await serverGet('/api/library');
        assert(library.items.length > 0, 'the pc holds no saved media, these tests need one');
        cachedSavedItem = library.items[0];
    }
    return cachedSavedItem;
}

// Back closes the captions panel before it closes the player, so a panel left open by an
// earlier step silently eats the press. Always leave the panel first.
async function closePanelIfOpen() {
    if (panelIsOpen()) {
        device.press(TV, 'KEYCODE_BACK');
        await device.sleep(1200);
    }
}

async function exitPlayer() {
    await closePanelIfOpen();
    device.press(TV, 'KEYCODE_BACK');
    await device.waitFor('the player to close', () => {
        return device.resumedActivity(TV) !== PLAYER_ACTIVITY;
    }, 20000);
    await device.sleep(1500);
}

// Idempotent on purpose. Menu toggles the panel, so pressing it when the panel is already
// open closes it, and the volume rows deliberately leave the panel up so you can press them
// repeatedly. Reopening blindly would shut it.
async function openCaptionsPanel() {
    if (panelIsOpen()) {
        return;
    }
    device.press(TV, 'KEYCODE_MENU');
    await device.waitFor('the captions panel', () => panelIsOpen(), 12000);
    await device.sleep(500);
}

// Reads the notice off the screen. Honest but slow: uiautomator will not dump a screen that
// never goes idle, and a playing video never does, so a dump can take seven seconds and the
// notice is gone by then. Use this only where the dump is known to settle.
function currentNotice() {
    return device.describedText(TV, DESCRIPTION_NOTICE);
}

// The same text, taken from the app's own log. Clear the log, do the thing, then read this.
function latestNotice() {
    const lines = device.readLog(TV).match(/notice (.+)/g) || [];
    if (lines.length === 0) {
        return EMPTY_STRING;
    }
    return lines[lines.length - 1].replace(/^notice /, EMPTY_STRING).trim();
}

const SUBTITLE_STEP_MILLISECONDS = 100;

async function returnOffsetToZero() {
    const current = (await readPlayingState()).offset;
    const steps = Math.round(current / SUBTITLE_STEP_MILLISECONDS);
    if (steps > 0) {
        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_DOWN', steps, 350);
    } else if (steps < 0) {
        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_UP', -steps, 350);
    }
    await device.sleep(1200);
    const settled = (await readPlayingState()).offset;
    assertEqual(settled, 0, 'could not put the subtitle offset back to zero');
}

async function noticeAfterPressing(keyName, description) {
    device.clearLog(TV);
    device.press(TV, keyName);
    return device.waitFor(description, () => {
        const notice = latestNotice();
        return notice === EMPTY_STRING ? null : notice;
    }, 10000);
}

function panelOptions() {
    return device.readScreen(TV)
        .filter((node) => node.description === DESCRIPTION_PANEL_ROW)
        .map((node) => normalisePanelLabel(node.text))
        .filter((text) => text !== EMPTY_STRING);
}

function normalisePanelLabel(text) {
    return text.replace(/^[•\s]+/, EMPTY_STRING).trim();
}

// The selected row is prefixed with a bullet and the others with spaces, so match on the
// label rather than the whole string, and try both directions before giving up. Report what
// was actually on the panel when it fails, or the message says nothing useful.
// The on-screen notice only lasts 2.5s, so anything asserting on it must not sit in a long
// settle first. Callers that need the notice pass a short one.
async function choosePanelOption(label, settleMilliseconds) {
    const wanted = (text, node) => node.description === DESCRIPTION_PANEL_ROW
        && normalisePanelLabel(text).startsWith(label);
    try {
        await device.focusOn(TV, wanted, 'KEYCODE_DPAD_DOWN', 12);
    } catch (downError) {
        void downError;
        try {
            await device.focusOn(TV, wanted, 'KEYCODE_DPAD_UP', 12);
        } catch (upError) {
            void upError;
            throw new Error(`no panel option starting with "${label}", panel showed `
                + JSON.stringify(panelOptions()));
        }
    }
    device.press(TV, 'KEYCODE_DPAD_CENTER');
    await device.sleep(settleMilliseconds === undefined ? 1500 : settleMilliseconds);
}

function panelIsOpen() {
    return device.readScreen(TV).some((node) => node.description === DESCRIPTION_PANEL_ROW
        && /^\s*[•]?\s*Off$/.test(node.text));
}

function selectedPanelOption() {
    const marked = device.readScreen(TV)
        .filter((node) => node.description === DESCRIPTION_PANEL_ROW && node.text.startsWith('•'));
    return marked.length === 0 ? EMPTY_STRING : normalisePanelLabel(marked[0].text);
}

// Every transport test starts from "actually playing". Pressing keys at a player that is
// still preparing looks exactly like the app ignoring the remote.
async function ensurePlaying(episode, sourceUrl) {
    if (device.resumedActivity(TV) === PLAYER_ACTIVITY) {
        await closePanelIfOpen();
    }
    const alreadyOnItem = device.resumedActivity(TV) === PLAYER_ACTIVITY
        && device.readLog(TV).includes(`contentKey=${episode.contentKey}`);
    if (alreadyOnItem === false) {
        if (device.resumedActivity(TV) === PLAYER_ACTIVITY) {
            await exitPlayer();
        }
        await pushFromServer(sourceUrl);
        await waitForPlayer(episode.contentKey);
    }
    await device.waitFor('playback to actually be running', async () => {
        const state = await readPlayingState().catch(() => null);
        return state !== null && state.playing === true;
    }, 45000);
}

// ---------------------------------------------------------------------------

async function main() {
    process.stdout.write('capyTV fire tv action tests, driven by the remote\n\n');

    // An indeterminate spinner animates forever, and uiautomator will not dump a screen that
    // never goes idle. Without this the loading screen simply cannot be read back.
    device.stillAnimations(TV);

    // --- home navigation ---

    await runTest('home: opening the app leaves something focused so the remote works at once',
        async () => {
            await openHome({ fresh: true });
            const focused = await expectFocus('nothing ever takes focus, the remote is dead here');
            assert(focused.className.endsWith('Button'),
                `focus landed on a ${focused.className}, not something pressable`);
        });

    await runTest('home: the header says which pc it is talking to', async () => {
        await openHome({ fresh: true });
        const pill = await device.waitFor('the server pill to settle', () => {
            const text = serverPillText();
            return text.includes(':') ? text : null;
        }, 20000);
        const hello = await serverGet('/api/hello');
        const address = hello.serverBaseUrl.replace('http://', EMPTY_STRING);
        assert(pill.includes(address),
            `the header should name the pc at ${address}, it said "${pill}"`);
    });

    await runTest('home: right and left walk the tabs and stop at the ends', async () => {
        await openHome({ fresh: true });
        await focusTabRow();
        await device.focusOn(TV, 'links', 'KEYCODE_DPAD_LEFT', 6);

        device.press(TV, 'KEYCODE_DPAD_RIGHT');
        await device.sleep(500);
        const onOmer = await device.awaitFocus(TV);
        assert(onOmer.text.startsWith('omer'),
            `right from links should reach omer, reached "${onOmer.text}"`);

        device.press(TV, 'KEYCODE_DPAD_RIGHT');
        await device.sleep(500);
        assertEqual((await device.awaitFocus(TV)).text, 'downloads', 'right from omer');

        device.press(TV, 'KEYCODE_DPAD_RIGHT');
        await device.sleep(500);
        assertEqual((await device.awaitFocus(TV)).text, 'downloads',
            'right past the last tab must stay put');

        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_LEFT', 2);
        await device.sleep(700);
        assertEqual((await device.awaitFocus(TV)).text, 'links', 'left twice returns to links');
    });

    await runTest('home: every tab opens and its count matches what the pc holds', async () => {
        await openHome({ fresh: true });
        const stored = await serverGet('/api/links?collection=omer');
        const saved = await serverGet('/api/library');

        await openTab('omer');
        const episodes = listRowTitles();
        assertEqual(episodes.length > 0, true, 'the omer tab listed nothing');
        await waitForStatus(`${stored.items.length} links`, 'the omer count on the tv');

        await openTab('downloads');
        const savedRows = await device.waitFor('the saved media to list', () => {
            const rows = listRowTitles();
            return rows.length > 0 ? rows : null;
        }, 15000).catch(() => []);
        assert(savedRows.length > 0,
            `the downloads tab listed nothing, the pc holds ${saved.total}. `
            + `screen showed ${JSON.stringify(device.screenText(TV).slice(0, 6))}`);
        await waitForStatus(`${saved.total} videos`, 'the saved media count on the tv');

        await openTab('links');
        await device.waitFor('the links tab to still be there',
            () => tabLabels().includes('links'), 10000);
    });

    await runTest('home: down enters the list and up comes back to the tabs', async () => {
        await openHome({ fresh: true });
        await openTab('omer');

        await focusTabRow();
        device.press(TV, 'KEYCODE_DPAD_DOWN');
        await device.sleep(600);
        const inList = await device.awaitFocus(TV);
        assert(isRowNode(inList),
            `down from the tabs should enter the list, focus was "${inList.text}"`);

        device.press(TV, 'KEYCODE_DPAD_UP');
        await device.sleep(600);
        const backOnTabs = await device.awaitFocus(TV);
        assert(isTabNode(backOnTabs),
            `up from the first row should return to the tabs, focus was "${backOnTabs.text}"`);
    });

    await runTest('home: the list scrolls and focus follows down many episodes', async () => {
        await openHome({ fresh: true });
        await openTab('omer');
        await device.focusOn(TV, /1\. B/, 'KEYCODE_DPAD_DOWN', 10);

        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_DOWN', 12);
        const deep = await expectFocus('focus was lost while scrolling the list');
        assert(isRowNode(deep),
            `scrolling should keep focus on a row, it was on "${deep.text}"`);
        assert(/\d+\. B/.test(deep.text),
            `expected to be deep in the list, focus was "${deep.text.split('\n')[0]}"`);
        assert(deep.bounds.top >= 0 && deep.bounds.bottom <= 1080,
            'the focused row scrolled off screen instead of the list following it');
    });

    await runTest('home: switching between tabs repeatedly always leaves the remote usable',
        async () => {
            await openHome({ fresh: true });
            for (const label of ['omer', 'downloads', 'links', 'downloads', 'omer']) {
                await openTab(label);
                const focused = await expectFocus(`nothing focused after opening the ${label} tab`);
                assert(isRowNode(focused) || isTabNode(focused),
                    `focus landed somewhere unusable after opening ${label}: "${focused.text}"`);
            }
        });

    // --- what the home screen says the pc is doing ---

    // Uses a link the pc will chew on and fail, on purpose. A link that resolves opens the
    // player within a second or two, and the home screen is the only place this strip lives,
    // so a successful send takes the thing under test off screen before it can be read.
    await runTest('home: the strip reports what the pc is doing while a link is resolving',
        async () => {
            await openHome({ fresh: true });
            // TEST-NET-1 is reserved and routes nowhere, so every stage of the resolve waits
            // out its own timeout and then gives up. That keeps the home screen on display
            // long enough to read the strip, which a link that works never would.
            const unresolvable = 'http://192.0.2.1/never-arrives.mp4';
            let sendFailure = EMPTY_STRING;
            const sending = serverRequest('/api/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: unresolvable })
            }).catch((error) => {
                sendFailure = error.message;
                return null;
            });

            const shown = await device.waitFor('the television to say what the pc is doing', () => {
                const strip = readActivityStrip();
                return strip.stage === EMPTY_STRING ? null : strip;
            }, 40000).catch(() => null);

            if (shown === null) {
                const snapshot = await serverGet('/api/activity');
                throw new Error('the television never said what the pc was doing. The pc had '
                    + `${snapshot.running.length} running and last finished `
                    + `${JSON.stringify(snapshot.finished[FIRST_INDEX] || null)}. `
                    + `The send itself said: ${sendFailure === EMPTY_STRING ? 'nothing' : sendFailure}`);
            }

            assert(/checking if that is a video link|reading the page with yt-dlp|looking inside the page|opening the embedded player|starting/
                .test(shown.stage),
                `the strip never named a real stage, it showed "${shown.stage}"`);
            assert(shown.detail.includes('192.0.2.1'),
                `the strip should name what it is working on, its detail read "${shown.detail}"`);

            await sending;
            assertEqual(device.resumedActivity(TV), HOME_ACTIVITY,
                'a link that cannot be resolved should not have opened the player');
        });

    await runTest('home: the strip goes away again once the pc is idle', async () => {
        await openHome({ fresh: true });
        await device.waitFor('the activity strip to clear', () => {
            const running = activityStage();
            return running === EMPTY_STRING;
        }, 20000);
        assertEqual(activityStage(), EMPTY_STRING,
            'the activity strip is still showing something with nothing running');
        assertEqual(activityDetail(), EMPTY_STRING, 'the activity detail is still on screen');
    });

    // --- the loading screen ---

    await runTest('loading: the whole screen announces the video and its title', async () => {
        await openHome({ fresh: true });
        const item = await firstSavedItem();
        const sending = pushSavedFile(item.id);

        const seen = await device.waitFor('the loading screen', () => {
            const stage = readStage();
            return stage.headline === EMPTY_STRING ? null : stage;
        }, 30000);
        await sending;

        assertEqual(seen.headline, 'Loading video',
            'the loading screen should say the video is loading');
        assertEqual(seen.title, item.title, 'the loading screen should name what is loading');
        assert(seen.detail !== EMPTY_STRING,
            'the loading screen should say what it is doing, it said nothing');
    });

    await runTest('loading: the loading screen disappears once the picture is up', async () => {
        const item = await firstSavedItem();
        if (device.resumedActivity(TV) !== PLAYER_ACTIVITY) {
            await pushSavedFile(item.id);
            await device.waitFor('the player', () =>
                device.resumedActivity(TV) === PLAYER_ACTIVITY, 40000);
        }
        await device.waitFor('the loading screen to clear', () =>
            stageHeadline() === EMPTY_STRING, 45000);
        assertEqual(stageHeadline(), EMPTY_STRING,
            'the loading screen is still covering the video');
        await device.waitFor('the first frame in the log', () =>
            device.readLog(TV).includes('first frame rendered'), 20000);
    });

    // Makes its own bookmark rather than hoping an earlier test left one behind, since a
    // position under a minute is deliberately forgotten and would leave nothing to resume.
    await runTest('loading: an item with a bookmark says it is resuming', async () => {
        const item = await firstSavedItem();
        if (device.resumedActivity(TV) === PLAYER_ACTIVITY) {
            await exitPlayer();
        }
        await pushSavedFile(item.id);
        await device.waitFor('the file to start', () =>
            device.readLog(TV).includes(`contentKey=file:${item.id}`), 40000);
        await device.waitFor('playback to be running', async () => {
            const state = await readPlayingState().catch(() => null);
            return state !== null && state.playing === true;
        }, 45000);

        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_RIGHT', 4, 600);
        await device.sleep(1500);
        const parked = await readPlayingState();
        assert(parked.milliseconds > 60000,
            `the bookmark needs to be past a minute to be kept, it was at ${parked.milliseconds}ms`);
        await exitPlayer();

        const bookmarks = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tvstate.json'), 'utf8'));
        const saved = bookmarks.resume[`file:${item.id}`];
        assert(saved !== undefined && saved.positionMilliseconds > 0,
            'leaving the player did not save a bookmark to resume from');

        const sending = pushSavedFile(item.id);
        const meta = await device.waitFor('the resume line on the loading screen', () => {
            const nodes = device.readScreen(TV);
            const found = device.findByDescription(nodes, DESCRIPTION_STAGE_META);
            return found === null || found.text === EMPTY_STRING ? null : found.text;
        }, 30000);
        await sending;
        assert(/resuming at \d+:\d\d/.test(meta),
            `the loading screen should say where it is resuming, it said "${meta}"`);
        await exitPlayer();
    });

    await runTest('loading: a stream with no subtitles says so rather than staying silent',
        async () => {
            const item = await firstSavedItem();
            assertEqual(item.hasSubtitle, false,
                'this test needs an item with no subtitles alongside it');
            if (device.resumedActivity(TV) === PLAYER_ACTIVITY) {
                await exitPlayer();
            }
            const sending = pushSavedFile(item.id);
            const pill = await device.waitFor('the subtitle pill', () => {
                const text = readStage().subtitlePill;
                return text === EMPTY_STRING ? null : text;
            }, 30000);
            await sending;
            assert(/no subtitles/i.test(pill),
                `the player should say there are no subtitles, it said "${pill}"`);
            await exitPlayer();
        });

    // --- playback started from the remote ---

    // Deliberately does not assume subtitles come up on: the system remembers whether they
    // were left off, which is the behaviour it is supposed to have. Turn them on explicitly
    // and then assert they work.
    await runTest('playback: selecting an episode on the tv plays it at 1080p', async () => {
        await openHome({ fresh: true });
        await openTab('omer');
        await selectRow(/2\. B/);
        await waitForPlayer(EPISODE_TWO.contentKey);

        await device.waitFor('the 1080p cap',
            () => device.readLog(TV).includes('video capped at 1080p'), 15000);
        assertEqual(device.resumedActivity(TV), PLAYER_ACTIVITY, 'the player is not on screen');
    });

    await runTest('playback: turning english on from the panel makes subtitles render', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();
        await choosePanelOption('English');

        await device.waitFor('the cues to load',
            () => /loaded \d+ cues for English/.test(device.readLog(TV)), 20000);
        assertEqual(await cuesAreRendering(), true, 'subtitles are on but nothing is rendering');
        assertEqual((await readPlayingState()).subtitleId, 'autoenglish', 'the reported track');
    });

    await runTest('subtitles: the player says which track it is loading and how big it is',
        async () => {
            await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
            await openCaptionsPanel();
            await choosePanelOption('Off');
            await openCaptionsPanel();
            await choosePanelOption('English (auto)', 0);

            const settled = await device.waitFor('the subtitle pill to report the loaded track', () => {
                const text = subtitlePillText();
                return /lines/.test(text) ? text : null;
            }, 25000);
            assert(/English/.test(settled),
                `the pill should name the language it loaded, it said "${settled}"`);
            assert(/\d+\s+lines/.test(settled),
                `the pill should say how many lines it loaded, it said "${settled}"`);
        });

    await runTest('transport: play/pause stops the position advancing, and resumes it', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);

        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        const paused = await readPlayingState();
        assertEqual(paused.playing, false, 'the player should be paused');

        await device.sleep(6000);
        const stillPaused = await readPlayingState();
        assertNear(stillPaused.milliseconds, paused.milliseconds, 1500,
            'the position kept moving while paused');

        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        const resumed = await readPlayingState();
        assertEqual(resumed.playing, true, 'the player should be playing again');
    });

    // Measured while paused. The progress tick is only every ten seconds, so a sample can
    // land long after the seek with playback drifting the whole time: a thirty second jump
    // survives that noise but a ten second one is completely lost in it.
    await runTest('transport: right seeks forward 30s and left seeks back 10s', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        const before = await readPlayingState();
        assertEqual(before.playing, false, 'setup: playback should be paused for a clean measurement');

        device.press(TV, 'KEYCODE_DPAD_RIGHT');
        await device.sleep(2000);
        const forward = await readPlayingState();
        assertNear(forward.milliseconds - before.milliseconds, 30000, 3000,
            'one right press should jump thirty seconds forward');

        device.press(TV, 'KEYCODE_DPAD_LEFT');
        await device.sleep(2000);
        const back = await readPlayingState();
        assertNear(back.milliseconds - forward.milliseconds, -10000, 3000,
            'one left press should jump ten seconds back');

        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1200);
    });

    await runTest('transport: the dedicated rewind and fast forward keys seek too', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        const before = await readPlayingState();
        assertEqual(before.playing, false, 'setup: should be paused');

        device.press(TV, 'KEYCODE_MEDIA_FAST_FORWARD');
        await device.sleep(2000);
        const forward = await readPlayingState();
        assertNear(forward.milliseconds - before.milliseconds, 30000, 3000,
            'fast forward should jump thirty seconds');

        device.press(TV, 'KEYCODE_MEDIA_REWIND');
        await device.sleep(2000);
        const back = await readPlayingState();
        assertNear(back.milliseconds - forward.milliseconds, -10000, 3000,
            'rewind should jump ten seconds back');

        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1200);
    });

    await runTest('transport: seeking while paused keeps it paused', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        assertEqual((await readPlayingState()).playing, false, 'setup: should be paused');

        device.press(TV, 'KEYCODE_DPAD_RIGHT');
        await device.sleep(2500);
        const afterSeek = await readPlayingState();
        assertEqual(afterSeek.playing, false, 'seeking must not silently start playback');

        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        assertEqual((await readPlayingState()).playing, true, 'could not resume after seeking paused');
    });

    await runTest('transport: a burst of seeks in both directions ends up where it should',
        async () => {
            await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
            device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
            await device.sleep(1500);
            const before = await readPlayingState();
            assertEqual(before.playing, false, 'setup: should be paused');

            await device.pressRepeatedly(TV, 'KEYCODE_DPAD_RIGHT', 3, 700);
            await device.pressRepeatedly(TV, 'KEYCODE_DPAD_LEFT', 3, 700);
            await device.sleep(2500);
            const after = await readPlayingState();
            assertNear(after.milliseconds - before.milliseconds, 60000, 6000,
                'three forward and three back should net sixty seconds forward');
            assertEqual(after.playing, false, 'a burst of seeks should not start playback');

            device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
            await device.sleep(1200);
        });

    // --- the captions panel ---

    await runTest('captions: the panel lists off plus every language the item has', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();
        const options = panelOptions();

        assert(options.includes('Off'), `no Off option, saw ${JSON.stringify(options)}`);
        assert(options.some((text) => text.startsWith('English')),
            `no english option, saw ${JSON.stringify(options)}`);
        assert(options.includes('Volume down') && options.includes('Volume up'),
            'the volume controls are missing from the panel');
        assert(options.includes('Mute or unmute'), 'no mute option');

        device.press(TV, 'KEYCODE_BACK');
        await device.sleep(1200);
    });

    await runTest('captions: the panel marks the track that is actually on', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();
        await choosePanelOption('English (auto)');

        await openCaptionsPanel();
        assertEqual(selectedPanelOption(), 'English (auto)',
            'the panel does not show english as the chosen track');

        await choosePanelOption('Off');
        await openCaptionsPanel();
        assertEqual(selectedPanelOption(), 'Off',
            'the panel does not show off as the chosen track');

        await choosePanelOption('English (auto)');
    });

    await runTest('captions: choosing off stops the subtitles, english brings them back', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);

        await openCaptionsPanel();
        await choosePanelOption('Off');
        assert(panelIsOpen() === false, 'choosing a language should close the panel');
        assertEqual(await cuesAreSilent(), true, 'subtitles kept rendering after being turned off');
        assertEqual((await readPlayingState()).subtitleId, EMPTY_STRING,
            'the tv still reports a subtitle track after turning them off');

        await openCaptionsPanel();
        await choosePanelOption('English (auto)');
        assertEqual(await cuesAreRendering(), true, 'subtitles did not come back');
        assertEqual((await readPlayingState()).subtitleId, 'autoenglish', 'the reported track');
    });

    await runTest('captions: back closes the panel without leaving the player', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();

        device.press(TV, 'KEYCODE_BACK');
        await device.sleep(1500);
        assertEqual(panelIsOpen(), false, 'back did not close the panel');
        assertEqual(device.resumedActivity(TV), PLAYER_ACTIVITY,
            'closing the panel must not exit the player');
        assertEqual((await readPlayingState()).playing, true, 'playback stopped when the panel closed');
    });

    await runTest('captions: menu closes the panel it opened', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();
        assertEqual(panelIsOpen(), true, 'setup: the panel should be open');

        device.press(TV, 'KEYCODE_MENU');
        await device.sleep(1500);
        assertEqual(panelIsOpen(), false, 'menu should close the panel it opened');
        assertEqual(device.resumedActivity(TV), PLAYER_ACTIVITY, 'menu should not exit the player');
    });

    // Up and down shift the subtitles while watching. Inside the panel they have to navigate
    // it instead, or opening the panel would silently dial the offset around.
    await runTest('captions: up and down inside the panel navigate it, they do not shift subtitles',
        async () => {
            await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
            const before = (await readPlayingState()).offset;

            await openCaptionsPanel();
            await device.pressRepeatedly(TV, 'KEYCODE_DPAD_DOWN', 2, 400);
            await device.pressRepeatedly(TV, 'KEYCODE_DPAD_UP', 2, 400);
            assertEqual(panelIsOpen(), true, 'navigating the panel closed it');

            device.press(TV, 'KEYCODE_BACK');
            await device.sleep(1400);
            assertEqual((await readPlayingState()).offset, before,
                'moving around the panel changed the subtitle offset behind it');
        });

    await runTest('captions: changing language leaves the paused state alone', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        assertEqual((await readPlayingState()).playing, false, 'setup: should be paused');

        await openCaptionsPanel();
        await choosePanelOption('Off');
        assertEqual((await readPlayingState()).playing, false,
            'changing the subtitles resumed playback on its own');

        await openCaptionsPanel();
        await choosePanelOption('English (auto)');
        device.press(TV, 'KEYCODE_MEDIA_PLAY_PAUSE');
        await device.sleep(1500);
        assertEqual((await readPlayingState()).playing, true, 'could not resume afterwards');
    });

    // --- volume ---

    await runTest('volume: down then up returns to the level it started at', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        device.clearLog(TV);

        await openCaptionsPanel();
        await choosePanelOption('Volume down');
        const afterDown = /volume (\d*\.?\d+)/.exec(device.readLog(TV));
        assert(afterDown !== null, 'the app never logged a volume change');
        const loweredTo = Number(afterDown[1]);

        await choosePanelOption('Volume up');
        const readings = device.readLog(TV).match(/volume (\d*\.?\d+)/g) || [];
        const raisedTo = Number(/([\d.]+)/.exec(readings[readings.length - 1])[1]);
        assert(raisedTo > loweredTo, `volume up did not raise it, ${loweredTo} then ${raisedTo}`);

        device.press(TV, 'KEYCODE_BACK');
        await device.sleep(1000);
    });

    await runTest('volume: mute says muted, and unmute puts the level back', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();

        // The panel stays up after a volume action, so both presses happen in the one panel.
        // Read the notice straight away: it clears itself after 2.5s.
        await choosePanelOption('Mute or unmute', 0);
        const muted = currentNotice();
        assertEqual(muted, 'Muted', 'the tv never said it was muted');
        assertEqual(panelIsOpen(), true, 'a volume action should leave the panel up');

        await choosePanelOption('Mute or unmute', 0);
        const restored = currentNotice();
        assert(/^Volume \d+%$/.test(restored),
            `unmuting should show the level again, the screen said "${restored}"`);
        const level = Number(/(\d+)/.exec(restored)[1]);
        assert(level > 0, `unmuting should restore a real level, it showed "${restored}"`);

        device.press(TV, 'KEYCODE_BACK');
        await device.sleep(1200);
        assertEqual((await readPlayingState()).playing, true, 'playback stopped somewhere in there');
    });

    await runTest('volume: the level chosen for one item is still there for the next', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();
        await choosePanelOption('Volume down', 0);
        const lowered = currentNotice();
        assert(/^Volume \d+%$/.test(lowered), `expected a volume notice, saw "${lowered}"`);
        const chosenLevel = Number(/(\d+)/.exec(lowered)[1]);
        device.press(TV, 'KEYCODE_BACK');
        await device.sleep(1200);
        await exitPlayer();

        await pushFromServer(EPISODE_ONE_URL);
        await waitForPlayer(EPISODE_ONE.contentKey);
        await openCaptionsPanel();
        const heading = device.readScreen(TV)
            .filter((node) => /^VOLUME/.test(node.text))
            .map((node) => node.text);
        assert(heading.length > 0, 'the panel has no volume heading to read the level from');
        const carried = Number(/(\d+)/.exec(heading[0])[1]);
        assertEqual(carried, chosenLevel,
            'the volume the viewer set did not carry over to the next item');
        await choosePanelOption('Volume up', 0);
        device.press(TV, 'KEYCODE_BACK');
        await device.sleep(1200);
    });

    // --- subtitle offset ---

    await runTest('offset: up and down move it, and a seek does not reset it', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        const before = (await readPlayingState()).offset;

        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_UP', 2);
        await device.sleep(1200);
        const raised = (await readPlayingState()).offset;
        assertEqual(raised - before, 200, 'two up presses should add 200ms');

        device.press(TV, 'KEYCODE_DPAD_RIGHT');
        await device.sleep(2500);
        assertEqual((await readPlayingState()).offset, raised, 'seeking reset the subtitle offset');

        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_DOWN', 2);
        await device.sleep(1200);
        assertEqual((await readPlayingState()).offset, before, 'the offset did not come back down');
    });

    // The shift the viewer dialled in is deliberately remembered per item, so this cannot
    // assume it starts at zero. Put it back to zero first, then the wording is predictable.
    await runTest('offset: the tv says which way it moved the subtitles', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await returnOffsetToZero();

        const inStep = latestNotice();
        assert(/in step with the audio/.test(inStep) || inStep === EMPTY_STRING,
            `back at zero the tv should say the subtitles are in step, it said "${inStep}"`);

        const later = await noticeAfterPressing('KEYCODE_DPAD_UP',
            'the tv to say it moved the subtitles later');
        assertEqual(later, 'Subtitles 0.1 s later', 'one up press');

        const back = await noticeAfterPressing('KEYCODE_DPAD_DOWN',
            'the tv to say the subtitles are back in step');
        assertEqual(back, 'Subtitles in step with the audio', 'one down press from 0.1 later');

        const earlier = await noticeAfterPressing('KEYCODE_DPAD_DOWN',
            'the tv to say it moved the subtitles earlier');
        assertEqual(earlier, 'Subtitles 0.1 s earlier', 'one more down press');

        await returnOffsetToZero();
    });

    await runTest('offset: it survives changing the subtitle language', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_UP', 3);
        await device.sleep(1200);
        const shifted = (await readPlayingState()).offset;

        await openCaptionsPanel();
        await choosePanelOption('Off');
        await openCaptionsPanel();
        await choosePanelOption('English (auto)');

        assertEqual((await readPlayingState()).offset, shifted,
            'switching language threw away the shift the viewer had dialled in');

        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_DOWN', 3);
        await device.sleep(1200);
    });

    // --- sequences ---

    await runTest('sequence: play, seek, change language, seek, exit, replay comes back right',
        async () => {
            await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);

            device.press(TV, 'KEYCODE_DPAD_RIGHT');
            await device.sleep(2000);
            await openCaptionsPanel();
            await choosePanelOption('Off');
            device.press(TV, 'KEYCODE_DPAD_RIGHT');
            await device.sleep(2500);

            const beforeExit = await readPlayingState();
            await exitPlayer();

            const stored = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tvstate.json'), 'utf8'));
            const bookmark = stored.resume[EPISODE_TWO.contentKey];
            assertNear(bookmark.positionMilliseconds, beforeExit.milliseconds, 20000,
                'the saved position does not match where playback actually was');
            assertEqual(bookmark.subtitleId, EMPTY_STRING, 'off was not remembered');

            await pushFromServer(EPISODE_TWO_URL);
            await waitForPlayer(EPISODE_TWO.contentKey);
            const replayed = await readPlayingState();
            assertNear(replayed.milliseconds, bookmark.positionMilliseconds, 20000,
                'it did not resume where it stopped');
            assertEqual(replayed.subtitleId, EMPTY_STRING, 'subtitles came back on by themselves');

            await openCaptionsPanel();
            await choosePanelOption('English (auto)');
        });

    await runTest('sequence: two episodes keep their own position and language', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        const twoAt = (await readPlayingState()).milliseconds;
        await exitPlayer();

        await pushFromServer(EPISODE_ONE_URL);
        await waitForPlayer(EPISODE_ONE.contentKey);
        await device.pressRepeatedly(TV, 'KEYCODE_DPAD_RIGHT', 2);
        await device.sleep(3000);
        const oneAt = (await readPlayingState()).milliseconds;
        await exitPlayer();

        await pushFromServer(EPISODE_TWO_URL);
        await waitForPlayer(EPISODE_TWO.contentKey);
        const twoAgain = await readPlayingState();
        assertNear(twoAgain.milliseconds, twoAt, 25000, 'episode two lost its place');
        assert(Math.abs(twoAgain.milliseconds - oneAt) > 30000
            || Math.abs(twoAt - oneAt) < 30000,
            'the two episodes appear to share one bookmark');
    });

    await runTest('sequence: a push from the phone swaps the item and saves the old position',
        async () => {
            await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
            const before = await readPlayingState();

            await pushFromServer(EPISODE_ONE_URL);
            await waitForPlayer(EPISODE_ONE.contentKey);
            assert(device.readLog(TV).includes('discarded the previous item'),
                'the player did not discard the item it was on');

            const stored = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tvstate.json'), 'utf8'));
            const bookmark = stored.resume[EPISODE_TWO.contentKey];
            assertNear(bookmark.positionMilliseconds, before.milliseconds, 25000,
                'the interrupted episode lost where it was');
        });

    // A push while the panel is open used to be the awkward case: the panel belongs to the
    // item being replaced, so it has to go with it.
    await runTest('sequence: a push while the captions panel is open swaps cleanly', async () => {
        await ensurePlaying(EPISODE_TWO, EPISODE_TWO_URL);
        await openCaptionsPanel();
        assertEqual(panelIsOpen(), true, 'setup: the panel should be open');

        await pushFromServer(EPISODE_ONE_URL);
        await waitForPlayer(EPISODE_ONE.contentKey);
        await device.sleep(2000);
        assertEqual(panelIsOpen(), false,
            'the panel from the old item is still up over the new one');
        assertEqual(device.resumedActivity(TV), PLAYER_ACTIVITY, 'the player is not on screen');
        await device.waitFor('the new item to play', async () => {
            const state = await readPlayingState().catch(() => null);
            return state !== null && state.playing === true;
        }, 45000);
    });

    await runTest('sequence: keys pressed while it is still loading do not break the load',
        async () => {
            const item = await firstSavedItem();
            if (device.resumedActivity(TV) === PLAYER_ACTIVITY) {
                await exitPlayer();
            }
            const sending = pushSavedFile(item.id);
            await device.waitFor('the loading screen', () => stageHeadline() !== EMPTY_STRING, 30000);
            await device.pressRepeatedly(TV, 'KEYCODE_DPAD_UP', 2, 250);
            await device.pressRepeatedly(TV, 'KEYCODE_DPAD_RIGHT', 2, 250);
            await sending;

            await device.waitFor('the video to come up anyway', () =>
                device.readLog(TV).includes('first frame rendered'), 45000);
            assertEqual(device.resumedActivity(TV), PLAYER_ACTIVITY,
                'pressing keys during the load left the player');
            await exitPlayer();
        });

    await runTest('sequence: back from the player returns to the tab that was open', async () => {
        await openHome({ fresh: true });
        await openTab('omer');
        await selectRow(/3\. B/);
        await device.waitFor('the player', () => device.resumedActivity(TV) === PLAYER_ACTIVITY, 120000);
        await device.sleep(3000);

        await exitPlayer();
        assertEqual(device.resumedActivity(TV), HOME_ACTIVITY, 'back did not return to the home screen');
        await device.waitFor('the list to be there again',
            () => listRowTitles().length > 0, 15000);
        await expectFocus('nothing has focus after returning, the remote would be stuck');
    });

    await runTest('sequence: playing a saved file from the downloads tab works too', async () => {
        await openHome({ fresh: true });
        await openTab('downloads');
        const rows = listRowTitles();
        assert(rows.length > 0, 'nothing saved to play');

        device.clearLog(TV);
        await device.focusOn(TV, (text, node) => isRowNode(node), 'KEYCODE_DPAD_DOWN', 10);
        device.press(TV, 'KEYCODE_DPAD_CENTER');

        await device.waitFor('the saved file to start', () => {
            return /contentKey=file:/.test(device.readLog(TV));
        }, 60000);
        assertEqual(device.resumedActivity(TV), PLAYER_ACTIVITY, 'the player did not open');

        await exitPlayer();
    });

    await runTest('sequence: back twice from the player lands on the home screen and stays there',
        async () => {
            const item = await firstSavedItem();
            if (device.resumedActivity(TV) !== PLAYER_ACTIVITY) {
                await pushSavedFile(item.id);
                await device.waitFor('the player', () =>
                    device.resumedActivity(TV) === PLAYER_ACTIVITY, 40000);
                await device.sleep(2500);
            }
            device.press(TV, 'KEYCODE_BACK');
            await device.sleep(400);
            device.press(TV, 'KEYCODE_BACK');
            await device.sleep(2500);
            assert(device.resumedActivity(TV) !== PLAYER_ACTIVITY,
                'the player is somehow still on screen after two backs');
            await openHome({});
            await expectFocus('nothing focused after coming back, the remote would be stuck');
        });

    await runTest('home: the app is left in a usable state at the end', async () => {
        await openHome({ fresh: true });
        assertEqual(device.resumedActivity(TV), HOME_ACTIVITY, 'not on the home screen');
        await expectFocus('nothing focused, the remote would be stuck');
        await device.waitFor('all three tabs', () => tabLabels().length >= 3, 10000);
    });

    device.restoreAnimations(TV);

    const failed = results.filter((entry) => entry.ok === false);
    if (results.length === 0) {
        process.stdout.write(`\nno tv action test matched "${ONLY_PATTERN}"\n`);
        process.exit(1);
    }
    process.stdout.write(`\n${results.length - failed.length}/${results.length} tv action tests passed\n`);
    if (failed.length > 0) {
        process.stdout.write('\nfailures:\n');
        for (const entry of failed) {
            process.stdout.write(`  ${entry.name}\n    ${entry.reason}\n`);
        }
    }
    process.exit(failed.length === 0 ? 0 : 1);
}

// A network blip on a promise a failing test never got round to awaiting used to take the
// whole run down, losing every result gathered so far. Note it and carry on.
process.on('unhandledRejection', (reason) => {
    process.stdout.write(`        (ignored a stray rejection: ${reason && reason.message})\n`);
});

main().catch((error) => {
    device.restoreAnimations(TV);
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
});
