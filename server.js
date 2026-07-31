const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const net = require('./lib/net');
const library = require('./lib/library');
const resolve = require('./lib/resolve');
const tvapi = require('./lib/tvapi');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'tvstate.json');
const PUBLIC_DIRECTORY = path.join(__dirname, 'public');
const DEFAULT_PORT = 8787;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const DOWNLOAD_JOB_LIMIT = 20;
const EMPTY_STRING = '';

function loadJsonFile(filePath, fallbackValue) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        void error;
        return fallbackValue;
    }
}

const configuration = loadJsonFile(CONFIG_PATH, { port: DEFAULT_PORT, libraryRoots: [] });

const runtime = {
    serverAddress: net.LOOPBACK_ADDRESS,
    libraryItems: [],
    downloadJobs: new Map(),
    lastError: EMPTY_STRING,
    nextSequence: 1
};

function listLibraryItems() {
    return runtime.libraryItems;
}

function rescanLibrary() {
    runtime.libraryItems = library.scanLibrary(configuration.libraryRoots || []);
    return runtime.libraryItems.length;
}

function nextIdentifier(prefix) {
    runtime.nextSequence += 1;
    return `${prefix}${runtime.nextSequence.toString(36)}`;
}

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    response.end(body);
}

function readRequestBody(request) {
    return new Promise((resolveBody) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw === EMPTY_STRING) {
                resolveBody({});
            } else {
                try {
                    resolveBody(JSON.parse(raw));
                } catch (error) {
                    void error;
                    resolveBody({});
                }
            }
        });
    });
}

function startDownloadJob(pageUrl) {
    const jobId = nextIdentifier('d');
    const targetDirectory = (configuration.libraryRoots || [])[0] || process.cwd();
    const job = { id: jobId, url: pageUrl, percent: 0, line: 'starting', done: false, failed: false };
    runtime.downloadJobs.set(jobId, job);
    while (runtime.downloadJobs.size > DOWNLOAD_JOB_LIMIT) {
        runtime.downloadJobs.delete(runtime.downloadJobs.keys().next().value);
    }
    const child = resolve.startDownload(pageUrl, targetDirectory, (update) => {
        if (update.percent !== undefined) {
            job.percent = update.percent;
        }
        job.line = update.line;
    });
    child.on('close', (code) => {
        job.done = true;
        job.failed = code !== 0;
        job.percent = code === 0 ? 100 : job.percent;
        rescanLibrary();
    });
    return job;
}

const televisionApi = tvapi.createTelevisionApi({
    configuration,
    runtime,
    resolveMedia: resolve.resolveMedia,
    listLibraryItems,
    stateFilePath: STATE_PATH
});

async function handleLibraryRequest(request, response, url) {
    const routeName = url.pathname.slice('/api/'.length);

    if (routeName === 'library') {
        const matches = library.filterLibrary(listLibraryItems(), url.searchParams.get('q'));
        sendJson(response, HTTP_OK, {
            total: runtime.libraryItems.length,
            items: matches.slice(0, 400).map((item) => ({
                id: item.id,
                title: item.title,
                folder: item.folder,
                sizeBytes: item.sizeBytes,
                hasSubtitle: item.subtitlePath !== EMPTY_STRING
            }))
        });
        return true;
    }

    if (routeName === 'scan' && request.method === 'POST') {
        sendJson(response, HTTP_OK, { count: rescanLibrary() });
        return true;
    }

    if (routeName === 'download' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const pageUrl = String(body.url || EMPTY_STRING).trim();
        if (/^https?:\/\//i.test(pageUrl) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'Not a valid http(s) link' });
        } else {
            sendJson(response, HTTP_OK, { ok: true, jobId: startDownloadJob(pageUrl).id });
        }
        return true;
    }

    if (routeName === 'downloads') {
        sendJson(response, HTTP_OK, { jobs: Array.from(runtime.downloadJobs.values()).slice(-6) });
        return true;
    }

    if (routeName === 'diagnose' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const pageUrl = String(body.url || EMPTY_STRING).trim();
        if (/^https?:\/\//i.test(pageUrl) === false) {
            sendJson(response, HTTP_BAD_REQUEST, { ok: false, error: 'Not a valid http(s) link' });
        } else {
            const report = await resolve.diagnoseUrl(pageUrl, body.browser);
            sendJson(response, HTTP_OK, Object.assign({ ok: true }, report));
        }
        return true;
    }

    return false;
}

function serveStaticFile(response, filePath, contentType) {
    fs.readFile(filePath, (error, data) => {
        if (error) {
            response.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/plain' }).end('Not found');
        } else {
            response.writeHead(HTTP_OK, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
            response.end(data);
        }
    });
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
        serveStaticFile(response, path.join(PUBLIC_DIRECTORY, 'index.html'), 'text/html; charset=utf-8');
        return;
    }

    televisionApi.handleRequest(request, response, url)
        .then((handled) => {
            if (handled) {
                return true;
            }
            return handleLibraryRequest(request, response, url);
        })
        .then((handled) => {
            if (handled === false && response.headersSent === false) {
                sendJson(response, HTTP_NOT_FOUND, { error: 'Unknown endpoint' });
            }
        })
        .catch((error) => {
            runtime.lastError = error.message;
            process.stdout.write(`[server] ${error.message}\n`);
            if (response.headersSent === false) {
                sendJson(response, HTTP_SERVER_ERROR, { error: error.message });
            }
        });
});

const listenPort = configuration.port || DEFAULT_PORT;

function createServer(overrides) {
    return { server, runtime, televisionApi, rescanLibrary, overrides };
}

if (require.main === module) {
    runtime.serverAddress = net.resolveLanAddress();
    server.listen(listenPort, '0.0.0.0', () => {
        const itemCount = rescanLibrary();
        process.stdout.write(`tvcast listening on http://${runtime.serverAddress}:${listenPort}\n`);
        process.stdout.write(`library: ${itemCount} videos across ${(configuration.libraryRoots || []).length} root(s)\n`);
    });
}

module.exports = {
    server,
    runtime,
    televisionApi,
    createServer,
    rescanLibrary,
    listLibraryItems,
    handleLibraryRequest,
    startDownloadJob
};
