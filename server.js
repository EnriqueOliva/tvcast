const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const net = require('./lib/net');
const library = require('./lib/library');
const resolve = require('./lib/resolve');
const tvapi = require('./lib/tvapi');
const activityJournal = require('./lib/activity');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'tvstate.json');
const PUBLIC_DIRECTORY = path.join(__dirname, 'public');
const DEFAULT_PORT = 8787;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const DOWNLOAD_JOB_LIMIT = 20;
const DOWNLOAD_JOB_WINDOW = 6;
const LIBRARY_PAGE_LIMIT = 400;
const COMPLETE_PERCENT = 100;
const EMPTY_STRING = '';
const DOWNLOAD_LINE_LIMIT = 90;
const DESTINATION_PATTERN = /^\[download\]\s+Destination:\s+(.+)$/;
const MERGE_PATTERN = /^\[Merger\]\s+Merging formats into\s+"(.+)"$/;
const FORMAT_SUFFIX_PATTERN = /\.f\d+\.[a-z0-9]+$/i;

function readDownloadTitle(line) {
    const destination = DESTINATION_PATTERN.exec(line) || MERGE_PATTERN.exec(line);
    if (destination === null) {
        return EMPTY_STRING;
    }
    return path.basename(destination[1]).replace(FORMAT_SUFFIX_PATTERN, EMPTY_STRING);
}

function shortenLine(line) {
    const text = String(line || EMPTY_STRING).trim();
    if (text.length <= DOWNLOAD_LINE_LIMIT) {
        return text;
    }
    return `${text.slice(0, DOWNLOAD_LINE_LIMIT)}...`;
}

function loadJsonFile(filePath, fallbackValue) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        void error;
        return fallbackValue;
    }
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

const STATIC_FILES = {
    '/': { name: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/index.html': { name: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/manifest.webmanifest': { name: 'manifest.webmanifest', contentType: 'application/manifest+json; charset=utf-8' },
    '/icon.svg': { name: 'icon.svg', contentType: 'image/svg+xml; charset=utf-8' }
};

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

function createApplication(overrides) {
    const settings = overrides || {};
    const configuration = settings.configuration
        || loadJsonFile(CONFIG_PATH, { port: DEFAULT_PORT, libraryRoots: [] });
    const stateFilePath = settings.stateFilePath || STATE_PATH;
    const resolveMedia = settings.resolveMedia || resolve.resolveMedia;
    const startDownload = settings.startDownload || resolve.startDownload;

    const activity = settings.activity || activityJournal.createActivityJournal();

    const runtime = {
        serverAddress: settings.serverAddress || net.LOOPBACK_ADDRESS,
        libraryItems: [],
        downloadJobs: new Map(),
        activity,
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

    function resolveDownloadDirectory() {
        const targetDirectory = (configuration.libraryRoots || [])[0] || process.cwd();
        try {
            fs.mkdirSync(targetDirectory, { recursive: true });
        } catch (error) {
            void error;
        }
        return targetDirectory;
    }

    function startDownloadJob(pageUrl) {
        const jobId = nextIdentifier('d');
        const targetDirectory = resolveDownloadDirectory();
        const job = { id: jobId, url: pageUrl, title: EMPTY_STRING, percent: 0, line: 'starting', done: false, failed: false };
        runtime.downloadJobs.set(jobId, job);
        while (runtime.downloadJobs.size > DOWNLOAD_JOB_LIMIT) {
            runtime.downloadJobs.delete(runtime.downloadJobs.keys().next().value);
        }
        const entry = activity.begin(activityJournal.KIND_DOWNLOAD, pageUrl);
        const child = startDownload(pageUrl, targetDirectory, (update) => {
            if (update.percent !== undefined) {
                job.percent = update.percent;
            }
            job.line = update.line;
            const discoveredTitle = readDownloadTitle(update.line);
            if (discoveredTitle !== EMPTY_STRING) {
                job.title = discoveredTitle;
            }
            activity.step(entry, 'saving to the pc', {
                label: job.title === EMPTY_STRING ? pageUrl : job.title,
                detail: shortenLine(update.line),
                percent: job.percent
            });
        });
        child.on('close', (code) => {
            job.done = true;
            job.failed = code !== 0;
            job.percent = code === 0 ? COMPLETE_PERCENT : job.percent;
            if (code === 0) {
                activity.succeed(entry, 'saved on the pc', job.title);
            } else {
                activity.fail(entry, shortenLine(job.line));
            }
            rescanLibrary();
        });
        return job;
    }

    const televisionApi = tvapi.createTelevisionApi({
        configuration,
        runtime,
        resolveMedia,
        listLibraryItems,
        stateFilePath,
        activity,
        fetchImplementation: settings.fetchImplementation
    });

    async function handleLibraryRequest(request, response, url) {
        const routeName = url.pathname.slice('/api/'.length);

        if (routeName === 'library') {
            const matches = library.filterLibrary(listLibraryItems(), url.searchParams.get('q'));
            sendJson(response, HTTP_OK, {
                total: runtime.libraryItems.length,
                items: matches.slice(0, LIBRARY_PAGE_LIMIT).map((item) => ({
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
            const entry = activity.begin(activityJournal.KIND_SCAN, 'saved media');
            activity.step(entry, 'scanning the pc for videos');
            const count = rescanLibrary();
            activity.succeed(entry, `found ${count} videos`, EMPTY_STRING);
            sendJson(response, HTTP_OK, { count });
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
            sendJson(response, HTTP_OK, {
                jobs: Array.from(runtime.downloadJobs.values()).slice(-DOWNLOAD_JOB_WINDOW)
            });
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

    function handleRequest(request, response) {
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

        const staticFile = STATIC_FILES[url.pathname];
        if (staticFile !== undefined) {
            serveStaticFile(response, path.join(PUBLIC_DIRECTORY, staticFile.name), staticFile.contentType);
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
    }

    return {
        handleRequest,
        handleLibraryRequest,
        televisionApi,
        activity,
        runtime,
        configuration,
        rescanLibrary,
        listLibraryItems,
        startDownloadJob,
        resolveDownloadDirectory
    };
}

const application = createApplication();
const server = http.createServer(application.handleRequest);
const listenPort = application.configuration.port || DEFAULT_PORT;

if (require.main === module) {
    application.runtime.serverAddress = net.resolveLanAddress();
    server.listen(listenPort, '0.0.0.0', () => {
        const itemCount = application.rescanLibrary();
        process.stdout.write(`capyTV listening on http://${application.runtime.serverAddress}:${listenPort}\n`);
        process.stdout.write(`saved media: ${itemCount} videos in ${application.resolveDownloadDirectory()}\n`);
    });
}

module.exports = {
    createApplication,
    server,
    application,
    runtime: application.runtime,
    televisionApi: application.televisionApi,
    rescanLibrary: application.rescanLibrary,
    listLibraryItems: application.listLibraryItems,
    startDownloadJob: application.startDownloadJob,
    resolveDownloadDirectory: application.resolveDownloadDirectory
};
