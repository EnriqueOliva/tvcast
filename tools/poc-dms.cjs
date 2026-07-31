const dgram = require('node:dgram');
const http = require('node:http');
const os = require('node:os');
const library = require('../lib/library');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const HTTP_PORT = 8790;
const SERVER_UUID = 'uuid:6f2c1b90-tvcast-dms-0001';
const FRIENDLY_NAME = 'tvcast';
const ALIVE_INTERVAL_MILLISECONDS = 20000;
const ROOT_CONTAINER = '0';
const LIBRARY_ROOTS = ['B:\\Media'];

function log(message) {
    process.stdout.write(`${message}\n`);
}

function localAddress() {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && entry.internal === false && entry.address.startsWith('192.168.')) {
                return entry.address;
            }
        }
    }
    return '127.0.0.1';
}

const HOST_ADDRESS = localAddress();
const DESCRIPTION_URL = `http://${HOST_ADDRESS}:${HTTP_PORT}/desc.xml`;
const SERVER_HEADER = 'Windows/10 UPnP/1.0 tvcast/1.0';

let items = [];

function refreshItems() {
    items = library.scanLibrary(LIBRARY_ROOTS).slice(0, 50);
    return items.length;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildDescription() {
    return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${FRIENDLY_NAME}</friendlyName>
    <manufacturer>tvcast</manufacturer>
    <modelName>tvcast media server</modelName>
    <modelNumber>1</modelNumber>
    <UDN>${SERVER_UUID}</UDN>
    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/cds.xml</SCPDURL>
        <controlURL>/ctrl/cds</controlURL>
        <eventSubURL>/evt/cds</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/cms.xml</SCPDURL>
        <controlURL>/ctrl/cms</controlURL>
        <eventSubURL>/evt/cms</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

function buildContentDirectoryScpd() {
    return `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetSystemUpdateID</name><argumentList><argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument></argumentList></action>
    <action><name>GetSearchCapabilities</name><argumentList><argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument></argumentList></action>
    <action><name>GetSortCapabilities</name><argumentList><argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument></argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;
}

function buildDidl(startingIndex, requestedCount) {
    const slice = items.slice(startingIndex, requestedCount > 0 ? startingIndex + requestedCount : undefined);
    const entries = slice.map((item) => {
        const url = `http://${HOST_ADDRESS}:${HTTP_PORT}/media/${item.id}${item.extension}`;
        const protocolInfo = `http-get:*:${item.mimeType}:DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000`;
        return `&lt;item id="${item.id}" parentID="0" restricted="1"&gt;`
            + `&lt;dc:title&gt;${escapeXml(item.title)}&lt;/dc:title&gt;`
            + `&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;`
            + `&lt;res protocolInfo="${protocolInfo}" size="${item.sizeBytes}"&gt;${escapeXml(url)}&lt;/res&gt;`
            + `&lt;/item&gt;`;
    }).join('');
    const didl = `&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" `
        + `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"&gt;`
        + entries + `&lt;/DIDL-Lite&gt;`;
    return { didl, returned: slice.length };
}

function buildBrowseResponse(startingIndex, requestedCount) {
    const { didl, returned } = buildDidl(startingIndex, requestedCount);
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<Result>${didl}</Result>
<NumberReturned>${returned}</NumberReturned>
<TotalMatches>${items.length}</TotalMatches>
<UpdateID>1</UpdateID>
</u:BrowseResponse></s:Body></s:Envelope>`;
}

function readBody(request) {
    return new Promise((resolve) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${HOST_ADDRESS}:${HTTP_PORT}`);
    log(`  [http] ${request.method} ${url.pathname} from ${request.socket.remoteAddress}`);

    if (url.pathname === '/desc.xml') {
        const body = buildDescription();
        response.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body) });
        response.end(body);
    } else if (url.pathname === '/cds.xml' || url.pathname === '/cms.xml') {
        const body = buildContentDirectoryScpd();
        response.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body) });
        response.end(body);
    } else if (url.pathname.startsWith('/ctrl/')) {
        const soap = await readBody(request);
        const startingIndex = Number((/<StartingIndex>(\d+)</.exec(soap) || [])[1] || 0);
        const requestedCount = Number((/<RequestedCount>(\d+)</.exec(soap) || [])[1] || 0);
        if (/Browse/.test(soap)) {
            log(`  [cds] Browse startingIndex=${startingIndex} requestedCount=${requestedCount} -> ${items.length} items`);
            const body = buildBrowseResponse(startingIndex, requestedCount);
            response.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body) });
            response.end(body);
        } else {
            response.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
            response.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body/></s:Envelope>');
        }
    } else if (url.pathname.startsWith('/media/')) {
        const identifier = url.pathname.slice('/media/'.length).split('.')[0];
        const item = items.find((candidate) => candidate.id === identifier);
        if (item === undefined) {
            response.writeHead(404).end('unknown');
            return;
        }
        const fs = require('node:fs');
        const stat = fs.statSync(item.filePath);
        const range = request.headers.range;
        if (range) {
            const match = /bytes=(\d+)-(\d*)/.exec(range);
            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : stat.size - 1;
            response.writeHead(206, {
                'Content-Type': item.mimeType,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Content-Length': end - start + 1,
                'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(item.filePath, { start, end }).pipe(response);
        } else {
            response.writeHead(200, { 'Content-Type': item.mimeType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
            fs.createReadStream(item.filePath).pipe(response);
        }
    } else {
        response.writeHead(404).end('not found');
    }
});

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function ssdpResponse(searchTarget) {
    const usn = searchTarget === SERVER_UUID ? SERVER_UUID : `${SERVER_UUID}::${searchTarget}`;
    return Buffer.from([
        'HTTP/1.1 200 OK',
        'CACHE-CONTROL: max-age=1800',
        `DATE: ${new Date().toUTCString()}`,
        'EXT:',
        `LOCATION: ${DESCRIPTION_URL}`,
        `SERVER: ${SERVER_HEADER}`,
        `ST: ${searchTarget}`,
        `USN: ${usn}`,
        '', ''
    ].join('\r\n'));
}

const ADVERTISED_TARGETS = [
    'upnp:rootdevice',
    SERVER_UUID,
    'urn:schemas-upnp-org:device:MediaServer:1',
    'urn:schemas-upnp-org:service:ContentDirectory:1',
    'urn:schemas-upnp-org:service:ConnectionManager:1'
];

socket.on('message', (message, remote) => {
    const text = message.toString();
    if (text.startsWith('M-SEARCH') === false) {
        return;
    }
    const searchTarget = (/ST: *(.+)/i.exec(text) || [])[1];
    const wanted = searchTarget ? searchTarget.trim() : '';
    const matches = wanted === 'ssdp:all' ? ADVERTISED_TARGETS : ADVERTISED_TARGETS.filter((target) => target === wanted);
    if (matches.length === 0) {
        return;
    }
    log(`  [ssdp] M-SEARCH "${wanted}" from ${remote.address} -> answering ${matches.length}`);
    for (const target of matches) {
        socket.send(ssdpResponse(target), remote.port, remote.address);
    }
});

function announceAlive() {
    for (const target of ADVERTISED_TARGETS) {
        const usn = target === SERVER_UUID ? SERVER_UUID : `${SERVER_UUID}::${target}`;
        const notify = Buffer.from([
            'NOTIFY * HTTP/1.1',
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
            'CACHE-CONTROL: max-age=1800',
            `LOCATION: ${DESCRIPTION_URL}`,
            `SERVER: ${SERVER_HEADER}`,
            'NT: ' + target,
            'NTS: ssdp:alive',
            `USN: ${usn}`,
            '', ''
        ].join('\r\n'));
        socket.send(notify, SSDP_PORT, SSDP_ADDRESS);
    }
}

socket.bind(SSDP_PORT, () => {
    socket.addMembership(SSDP_ADDRESS, HOST_ADDRESS);
    socket.setMulticastInterface(HOST_ADDRESS);
    socket.setMulticastTTL(4);
    socket.setBroadcast(true);
    const count = refreshItems();
    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
        log(`tvcast DLNA MediaServer on ${DESCRIPTION_URL}`);
        log(`  sharing ${count} videos from ${LIBRARY_ROOTS.join(', ')}`);
        log('  on the TV: MediaCenter -> Digital Media Player -> tvcast');
        log('  waiting for the TV to browse...');
        announceAlive();
        setInterval(announceAlive, ALIVE_INTERVAL_MILLISECONDS);
    });
});
