const { spawnSync } = require('node:child_process');

// Shared plumbing for the on-hardware suites. Everything here reads or drives a real
// device: there is no simulation and no stand-in for either app.

const ADB = process.env.CAPYTV_ADB || 'C:\\Android\\Sdk\\platform-tools\\adb.exe';
const EMPTY_STRING = '';
const POLL_MILLISECONDS = 250;
const DEFAULT_WAIT_MILLISECONDS = 15000;

function adb(serial, args, options) {
    const settings = options || {};
    const outcome = spawnSync(ADB, ['-s', serial].concat(args), {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: settings.timeout || 60000
    });
    return `${outcome.stdout || EMPTY_STRING}`;
}

function shell(serial, command, options) {
    return adb(serial, ['shell', command], options);
}

function sleep(milliseconds) {
    return new Promise((done) => setTimeout(done, milliseconds));
}

async function waitFor(description, predicate, timeoutMilliseconds) {
    const deadline = Date.now() + (timeoutMilliseconds || DEFAULT_WAIT_MILLISECONDS);
    while (Date.now() < deadline) {
        const outcome = await predicate();
        if (outcome) {
            return outcome;
        }
        await sleep(POLL_MILLISECONDS);
    }
    throw new Error(`timed out waiting for ${description}`);
}

function readAttribute(node, name) {
    const matched = new RegExp(`${name}="([^"]*)"`).exec(node);
    return matched === null ? EMPTY_STRING : matched[1];
}

function decodeText(raw) {
    return raw
        .replace(/&#10;/g, '\n')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
}

// The accessibility tree is the only place view text appears; dumpsys never carries it.
//
// uiautomator refuses to dump while the ui is animating ("could not get idle state") and then
// there is nothing to read. Returning an empty list for that looks exactly like an empty
// screen, which turns into assertions failing at random, so retry instead. The dump itself
// takes about a second, which is enough of a gap on its own.
const DUMP_ATTEMPTS = 4;

function readScreen(serial) {
    const dumpPath = '/sdcard/capytv-screen.xml';
    let dump = EMPTY_STRING;
    for (let attempt = 0; attempt < DUMP_ATTEMPTS; attempt += 1) {
        shell(serial, `rm -f ${dumpPath}`);
        const outcome = shell(serial, `uiautomator dump ${dumpPath}`);
        if (outcome.includes('could not get idle state') === false) {
            dump = shell(serial, `cat ${dumpPath}`);
            if (dump.indexOf('<node') >= 0) {
                break;
            }
        }
        dump = EMPTY_STRING;
    }
    shell(serial, `rm -f ${dumpPath}`);
    const nodes = [];
    for (const raw of dump.match(/<node[^>]*\/?>/g) || []) {
        const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(readAttribute(raw, 'bounds'));
        nodes.push({
            text: decodeText(readAttribute(raw, 'text')),
            description: decodeText(readAttribute(raw, 'content-desc')),
            className: readAttribute(raw, 'class'),
            packageName: readAttribute(raw, 'package'),
            focused: readAttribute(raw, 'focused') === 'true',
            focusable: readAttribute(raw, 'focusable') === 'true',
            clickable: readAttribute(raw, 'clickable') === 'true',
            selected: readAttribute(raw, 'selected') === 'true',
            bounds: bounds === null ? null : {
                left: Number(bounds[1]),
                top: Number(bounds[2]),
                right: Number(bounds[3]),
                bottom: Number(bounds[4])
            }
        });
    }
    return nodes;
}

function screenText(serial) {
    return readScreen(serial)
        .map((node) => node.text)
        .filter((text) => text !== EMPTY_STRING);
}

function focusedNode(serial) {
    return readScreen(serial).find((node) => node.focused) || null;
}

// Focus is briefly nobody's during a re-render, so reading it once and dereferencing the
// result is a race. Anything that needs the focused view must wait for one.
async function awaitFocus(serial, timeoutMilliseconds) {
    return waitFor('a view to hold focus', () => focusedNode(serial), timeoutMilliseconds || 8000);
}

// Accepts an exact string, a regex, or a predicate. A predicate is handed the whole node as
// well as its text, so callers can match on the content description when the label alone is
// not what makes a view identifiable.
function buildTextTest(matcher) {
    if (typeof matcher === 'string') {
        return (text) => text === matcher;
    }
    if (typeof matcher === 'function') {
        return matcher;
    }
    return (text) => matcher.test(text);
}

function describeMatcher(matcher) {
    if (typeof matcher === 'string') {
        return matcher;
    }
    if (typeof matcher === 'function') {
        return 'the wanted item';
    }
    return String(matcher);
}

function findByText(nodes, matcher) {
    const test = buildTextTest(matcher);
    return nodes.find((node) => test(node.text, node)) || null;
}

function findByDescription(nodes, description) {
    return nodes.find((node) => node.description === description) || null;
}

// A view identified by name rather than by where it happens to sit on screen. Returns the
// empty string when the view is absent or hidden, which is a real answer, not a failure.
function describedText(serial, description) {
    const found = findByDescription(readScreen(serial), description);
    return found === null ? EMPTY_STRING : found.text;
}

// uiautomator refuses to dump while anything is animating, and an indeterminate spinner
// animates forever, so a loading screen is invisible to the accessibility tree until the
// animators are stilled. This is the standard way to make an animated ui testable.
const ANIMATION_SETTINGS = [
    'window_animation_scale',
    'transition_animation_scale',
    'animator_duration_scale'
];

function setAnimationScale(serial, scale) {
    for (const name of ANIMATION_SETTINGS) {
        shell(serial, `settings put global ${name} ${scale}`);
    }
}

function stillAnimations(serial) {
    setAnimationScale(serial, 0);
}

function restoreAnimations(serial) {
    setAnimationScale(serial, 1);
}

function press(serial, keyName, times) {
    const count = times || 1;
    for (let index = 0; index < count; index += 1) {
        shell(serial, `input keyevent ${keyName}`);
    }
}

// Firing a burst of key events with no gap is not what a person does, and the list can drop
// focus trying to keep up. Pace them the way a thumb would.
async function pressRepeatedly(serial, keyName, times, gapMilliseconds) {
    for (let index = 0; index < times; index += 1) {
        shell(serial, `input keyevent ${keyName}`);
        await sleep(gapMilliseconds || 250);
    }
}

function resumedActivity(serial) {
    const dumped = shell(serial, 'dumpsys activity activities');
    const matched = /ResumedActivity: ActivityRecord\{[^}]*?\s(\S+\/\S+)\s/.exec(dumped);
    return matched === null ? EMPTY_STRING : matched[1];
}

function clearLog(serial) {
    adb(serial, ['logcat', '-c']);
}

function readLog(serial, tag) {
    return adb(serial, ['logcat', '-d', '-s', `${tag || 'capytv'}:*`]);
}

// Walks the focus ring in one direction until the wanted label has focus. Returns how many
// presses it took, or throws, so a test can also assert reachability rather than just arrival.
async function focusOn(serial, matcher, direction, maximumSteps) {
    const limit = maximumSteps || 30;
    const test = buildTextTest(matcher);
    const matches = (node) => node !== null && test(node.text, node);
    let current = focusedNode(serial);
    if (matches(current)) {
        return 0;
    }
    for (let step = 1; step <= limit; step += 1) {
        press(serial, direction);
        await sleep(350);
        current = focusedNode(serial);
        if (matches(current)) {
            return step;
        }
    }
    throw new Error(`could not reach ${describeMatcher(matcher)} with ${direction}, focus stopped on `
        + `"${current === null ? '(nothing)' : current.text}"`);
}

async function select(serial, matcher, direction) {
    const steps = await focusOn(serial, matcher, direction || 'KEYCODE_DPAD_DOWN');
    press(serial, 'KEYCODE_DPAD_CENTER');
    await sleep(900);
    return steps;
}

module.exports = {
    ADB,
    EMPTY_STRING,
    POLL_MILLISECONDS,
    adb,
    shell,
    sleep,
    waitFor,
    readScreen,
    screenText,
    focusedNode,
    awaitFocus,
    findByText,
    findByDescription,
    describedText,
    stillAnimations,
    restoreAnimations,
    press,
    pressRepeatedly,
    resumedActivity,
    clearLog,
    readLog,
    focusOn,
    select
};
