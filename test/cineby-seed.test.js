const test = require('node:test');
const assert = require('node:assert/strict');

const cineby = require('../lib/cineby');

// Every provider needs the same seed for the same title. Asking once per provider is what
// rate limited the seed service and made "no source found" look like a broken link.

const SEED_HOST = 'api.speedracelight.com/seed';
const DECRYPT_HOST = 'enc-dec.app/api/dec-videasy';
const METADATA = { title: 'Fight Club', year: '1999', imdbId: 'tt0137523', episodeTitle: '', durationSeconds: 8340 };
const PARSED = { mediaType: 'movie', tmdbId: '550', season: '1', episode: '1' };

function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

function textResponse(body, status) {
    return new Response(body, { status: status || 200, headers: { 'Content-Type': 'text/plain' } });
}

// Counts what the resolver actually asks the network for, which is the whole point here.
function installStubbedNetwork(settings) {
    const options = settings || {};
    const seedResponses = options.seedResponses || [];
    const calls = { seed: 0, sources: 0, decrypt: 0, seedsIssued: [] };
    const realFetch = globalThis.fetch;

    globalThis.fetch = async (target) => {
        const url = String(target);
        if (url.includes(SEED_HOST)) {
            const behaviour = seedResponses[Math.min(calls.seed, seedResponses.length - 1)]
                || { seed: 'seed-default', ttlMs: 30000 };
            calls.seed += 1;
            if (behaviour.status !== undefined) {
                return textResponse('rate limited', behaviour.status);
            }
            calls.seedsIssued.push(behaviour.seed);
            return jsonResponse({ seed: behaviour.seed, ttlMs: behaviour.ttlMs });
        }
        if (url.includes('sources-with-title')) {
            calls.sources += 1;
            return textResponse('ENCRYPTEDBLOB');
        }
        if (url.includes(DECRYPT_HOST)) {
            calls.decrypt += 1;
            return jsonResponse({ result: { sources: [{ quality: '1080p', url: 'https://cdn.invalid/a.m3u8' }] } });
        }
        throw new Error(`the resolver reached for something unexpected: ${url}`);
    };

    return {
        calls,
        restore() {
            globalThis.fetch = realFetch;
        }
    };
}

test('one resolve asks the seed service once, not once per provider', async () => {
    const network = installStubbedNetwork({ seedResponses: [{ seed: 'seed-a', ttlMs: 30000 }] });
    try {
        const outcomes = await cineby.loadEveryProviderPayload(METADATA, PARSED);
        assert.equal(network.calls.seed, 1,
            `the seed was requested ${network.calls.seed} times for one title`);
        assert.equal(outcomes.length, 4, 'every provider should still be asked');
        assert.equal(network.calls.sources, 4, 'each provider should get its own sources request');
    } finally {
        network.restore();
    }
});

test('every provider is handed the same seed', async () => {
    const network = installStubbedNetwork({ seedResponses: [{ seed: 'seed-shared', ttlMs: 30000 }] });
    try {
        await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '5501' });
        assert.deepEqual(network.calls.seedsIssued, ['seed-shared']);
    } finally {
        network.restore();
    }
});

test('a seed that comes back rate limited is retried rather than given up on', async () => {
    const network = installStubbedNetwork({
        seedResponses: [{ status: 429 }, { seed: 'seed-after-retry', ttlMs: 30000 }]
    });
    try {
        const outcomes = await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '5502' });
        assert.equal(network.calls.seed, 2, 'the retry never happened');
        assert.equal(outcomes.every((outcome) => outcome.payload !== null), true,
            'a retried seed should still produce sources for every provider');
    } finally {
        network.restore();
    }
});

test('a seed that never arrives is reported once, the same way, to every provider', async () => {
    const network = installStubbedNetwork({ seedResponses: [{ status: 429 }] });
    try {
        const outcomes = await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '5503' });
        assert.equal(outcomes.length, 4);
        assert.equal(outcomes.every((outcome) => outcome.payload === null), true);
        const reasons = new Set(outcomes.map((outcome) => outcome.error.message));
        assert.equal(reasons.size, 1, 'the providers disagreed about why nothing worked');
        assert.match(Array.from(reasons)[0], /seed request returned HTTP 429/);
        assert.equal(network.calls.sources, 0,
            'no provider should be asked for sources without a seed');
    } finally {
        network.restore();
    }
});

test('a second resolve of the same title inside the ttl reuses the seed', async () => {
    const network = installStubbedNetwork({ seedResponses: [{ seed: 'seed-cached', ttlMs: 30000 }] });
    try {
        await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '4242' });
        const afterFirst = network.calls.seed;
        await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '4242' });
        assert.equal(network.calls.seed, afterFirst,
            'replaying the same title asked the seed service again');
    } finally {
        network.restore();
    }
});

// The service stamps every seed with a ttl of about half a minute. Caching one past its own
// expiry would hand the providers a seed they reject, which is worse than not caching at all.
test('a seed with no useful life left is not cached', async () => {
    const network = installStubbedNetwork({ seedResponses: [{ seed: 'seed-brief', ttlMs: 1000 }] });
    try {
        await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '9191' });
        const afterFirst = network.calls.seed;
        await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '9191' });
        assert.ok(network.calls.seed > afterFirst,
            'a seed that expires almost immediately was cached and handed out again');
    } finally {
        network.restore();
    }
});

test('two different titles do not share one seed', async () => {
    const network = installStubbedNetwork({
        seedResponses: [{ seed: 'seed-one', ttlMs: 30000 }, { seed: 'seed-two', ttlMs: 30000 }]
    });
    try {
        await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '7001' });
        await cineby.loadEveryProviderPayload(METADATA, { ...PARSED, tmdbId: '7002' });
        assert.equal(network.calls.seed, 2, 'a different title must fetch its own seed');
        assert.deepEqual(network.calls.seedsIssued, ['seed-one', 'seed-two']);
    } finally {
        network.restore();
    }
});

test('the stage reporter is told what the resolver is doing, in order', async () => {
    const network = installStubbedNetwork({ seedResponses: [{ seed: 'seed-stages', ttlMs: 30000 }] });
    const stages = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (target) => {
        const url = String(target);
        if (url.includes('api.themoviedb.org')) {
            return jsonResponse({ title: 'Fight Club', release_date: '1999-10-15', runtime: 139 });
        }
        return realFetch(target);
    };
    try {
        await cineby.resolveCineby('https://www.cineby.at/movie/8801', {
            onStage: (stage, extra) => stages.push({ stage, extra })
        }).catch(() => null);
        const announced = stages.map((entry) => entry.stage);
        assert.equal(announced[0], 'looking up the title',
            `the first thing reported was "${announced[0]}"`);
        assert.ok(announced.some((stage) => /asking \d+ sources/.test(stage)),
            `nothing reported asking the sources, saw ${JSON.stringify(announced)}`);
    } finally {
        network.restore();
    }
});
