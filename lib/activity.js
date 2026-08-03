const EMPTY_STRING = '';
const INDETERMINATE_PERCENT = -1;
const RECENT_LIMIT = 10;
const FIRST_INDEX = 0;

const OUTCOME_RUNNING = 'running';
const OUTCOME_DONE = 'done';
const OUTCOME_FAILED = 'failed';

const KIND_RESOLVE = 'resolve';
const KIND_DOWNLOAD = 'download';
const KIND_SCAN = 'scan';

const STAGE_STARTING = 'starting';

function createActivityJournal(options) {
    const settings = options || {};
    const readClock = settings.clock || Date.now;
    const running = new Map();
    const finished = [];
    let nextSequence = 0;

    function copyEntry(entry) {
        return Object.assign({}, entry);
    }

    function begin(kind, label) {
        nextSequence += 1;
        const startedAt = readClock();
        const entry = {
            id: `${kind}-${nextSequence}`,
            kind,
            label,
            stage: STAGE_STARTING,
            detail: EMPTY_STRING,
            percent: INDETERMINATE_PERCENT,
            outcome: OUTCOME_RUNNING,
            startedAt,
            updatedAt: startedAt,
            finishedAt: 0
        };
        running.set(entry.id, entry);
        return entry;
    }

    function step(entry, stage, extra) {
        if (entry === null || entry === undefined) {
            return null;
        }
        const additional = extra || {};
        entry.stage = stage;
        if (additional.detail !== undefined) {
            entry.detail = additional.detail;
        }
        if (additional.percent !== undefined) {
            entry.percent = additional.percent;
        }
        if (additional.label !== undefined && additional.label !== EMPTY_STRING) {
            entry.label = additional.label;
        }
        entry.updatedAt = readClock();
        return entry;
    }

    function retire(entry, outcome, detail) {
        if (entry === null || entry === undefined || entry.outcome !== OUTCOME_RUNNING) {
            return null;
        }
        entry.outcome = outcome;
        if (detail !== undefined) {
            entry.detail = detail;
        }
        entry.finishedAt = readClock();
        entry.updatedAt = entry.finishedAt;
        running.delete(entry.id);
        finished.unshift(entry);
        while (finished.length > RECENT_LIMIT) {
            finished.pop();
        }
        return entry;
    }

    function succeed(entry, stage, detail) {
        if (entry !== null && entry !== undefined && stage !== undefined) {
            entry.stage = stage;
        }
        return retire(entry, OUTCOME_DONE, detail);
    }

    function fail(entry, detail) {
        return retire(entry, OUTCOME_FAILED, detail);
    }

    function reporterFor(entry) {
        return (stage, extra) => step(entry, stage, extra);
    }

    function listRunning() {
        return Array.from(running.values()).map(copyEntry);
    }

    function listFinished() {
        return finished.map(copyEntry);
    }

    function snapshot() {
        return { running: listRunning(), finished: listFinished() };
    }

    function busiest() {
        const candidates = listRunning();
        if (candidates.length === FIRST_INDEX) {
            return null;
        }
        return candidates.sort((left, right) => left.startedAt - right.startedAt)[FIRST_INDEX];
    }

    function clear() {
        running.clear();
        finished.length = 0;
    }

    return {
        begin,
        step,
        succeed,
        fail,
        reporterFor,
        snapshot,
        listRunning,
        listFinished,
        busiest,
        clear
    };
}

function ignoreStage() {
    return null;
}

module.exports = {
    createActivityJournal,
    ignoreStage,
    INDETERMINATE_PERCENT,
    OUTCOME_RUNNING,
    OUTCOME_DONE,
    OUTCOME_FAILED,
    KIND_RESOLVE,
    KIND_DOWNLOAD,
    KIND_SCAN
};
