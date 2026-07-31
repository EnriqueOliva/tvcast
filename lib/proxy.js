const { Readable } = require('node:stream');

const cineby = require('./cineby');

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;
const UPSTREAM_TIMEOUT_MILLISECONDS = 15000;
const EMPTY_STRING = '';

const TRANSPORT_STREAM_MIME_TYPE = 'video/mp2t';
const FRAGMENTED_MP4_MIME_TYPE = 'video/mp4';

function buildUpstreamHeaders(publicationHeaders, rangeHeader) {
    const headers = Object.assign({}, publicationHeaders);
    delete headers['Accept-Encoding'];
    if (headers['User-Agent'] === undefined) {
        headers['User-Agent'] = cineby.BROWSER_USER_AGENT;
    }
    if (headers.Referer === undefined) {
        headers.Referer = `${cineby.CINEBY_ORIGIN}/`;
    }
    if (headers.Origin === undefined) {
        headers.Origin = cineby.CINEBY_ORIGIN;
    }
    if (rangeHeader !== undefined && rangeHeader !== EMPTY_STRING) {
        headers.Range = rangeHeader;
    }
    return headers;
}

function chooseContentType(packaging) {
    if (packaging === 'fmp4') {
        return FRAGMENTED_MP4_MIME_TYPE;
    }
    return TRANSPORT_STREAM_MIME_TYPE;
}

async function streamUpstreamSegment(options) {
    const request = options.request;
    const response = options.response;
    const segmentUrl = options.segmentUrl;
    const fetchImplementation = options.fetchImplementation || fetch;

    let upstream = null;
    const headers = buildUpstreamHeaders(options.headers, request.headers.range);

    try {
        upstream = await fetchImplementation(segmentUrl, {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(options.timeoutMilliseconds || UPSTREAM_TIMEOUT_MILLISECONDS)
        });
    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
        const status = isTimeout ? HTTP_GATEWAY_TIMEOUT : HTTP_BAD_GATEWAY;
        response.writeHead(status, { 'Content-Type': 'text/plain' });
        response.end(isTimeout ? 'Upstream timed out' : `Upstream failed: ${error.message}`);
        return { ok: false, status, reason: error.message };
    }

    if (upstream.status === 416 && headers.Range !== undefined) {
        delete headers.Range;
        try {
            upstream = await fetchImplementation(segmentUrl, {
                headers,
                redirect: 'follow',
                signal: AbortSignal.timeout(options.timeoutMilliseconds || UPSTREAM_TIMEOUT_MILLISECONDS)
            });
        } catch (error) {
            response.writeHead(HTTP_BAD_GATEWAY, { 'Content-Type': 'text/plain' });
            response.end(`Upstream failed: ${error.message}`);
            return { ok: false, status: HTTP_BAD_GATEWAY, reason: error.message };
        }
    }

    if (upstream.status >= 400) {
        response.writeHead(HTTP_BAD_GATEWAY, { 'Content-Type': 'text/plain' });
        response.end(`Upstream HTTP ${upstream.status}`);
        return { ok: false, status: HTTP_BAD_GATEWAY, reason: `upstream ${upstream.status}` };
    }

    const outgoing = {
        'Content-Type': chooseContentType(options.packaging),
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes'
    };
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    if (contentLength !== null) {
        outgoing['Content-Length'] = contentLength;
    }
    if (contentRange !== null) {
        outgoing['Content-Range'] = contentRange;
    }

    response.writeHead(upstream.status === HTTP_PARTIAL_CONTENT ? HTTP_PARTIAL_CONTENT : HTTP_OK, outgoing);

    if (request.method === 'HEAD' || upstream.body === null) {
        response.end();
        return { ok: true, status: upstream.status };
    }

    const bodyStream = Readable.fromWeb(upstream.body);
    response.on('close', () => { bodyStream.destroy(); });
    bodyStream.on('error', () => { response.destroy(); });
    bodyStream.pipe(response);
    return { ok: true, status: upstream.status };
}

module.exports = {
    streamUpstreamSegment,
    buildUpstreamHeaders,
    chooseContentType,
    UPSTREAM_TIMEOUT_MILLISECONDS
};
