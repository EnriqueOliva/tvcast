const dgram = require('node:dgram');
const os = require('node:os');

const SSDP_MULTICAST_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const MEDIA_RENDERER_SEARCH_TARGET = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const MAX_WAIT_SECONDS = 3;
const DEFAULT_DISCOVERY_TIMEOUT = 4000;
const SEARCH_REPEAT_COUNT = 3;
const SEARCH_REPEAT_DELAY = 300;

function buildSearchMessage(searchTarget) {
    return [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        `MX: ${MAX_WAIT_SECONDS}`,
        `ST: ${searchTarget}`,
        '',
        ''
    ].join('\r\n');
}

function parseSsdpResponse(rawText) {
    const headers = {};
    const lines = rawText.split('\r\n');
    for (const line of lines) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex > 0) {
            const headerName = line.slice(0, separatorIndex).trim().toLowerCase();
            const headerValue = line.slice(separatorIndex + 1).trim();
            headers[headerName] = headerValue;
        }
    }
    return headers;
}

function listLocalIpv4Addresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();
    for (const interfaceName of Object.keys(interfaces)) {
        for (const entry of interfaces[interfaceName] || []) {
            if (entry.family === 'IPv4' && entry.internal === false) {
                addresses.push({ interfaceName, address: entry.address, netmask: entry.netmask });
            }
        }
    }
    return addresses;
}

function isSameSubnet(addressA, addressB, netmask) {
    const toNumber = (value) => value.split('.').reduce((accumulator, part) => (accumulator << 8) + Number(part), 0) >>> 0;
    const maskNumber = toNumber(netmask);
    return (toNumber(addressA) & maskNumber) === (toNumber(addressB) & maskNumber);
}

function resolveLocalAddressForPeer(peerAddress) {
    const candidates = listLocalIpv4Addresses();
    for (const candidate of candidates) {
        if (isSameSubnet(candidate.address, peerAddress, candidate.netmask)) {
            return candidate.address;
        }
    }
    if (candidates.length > 0) {
        return candidates[0].address;
    }
    return '127.0.0.1';
}

function discoverRenderers(options = {}) {
    const timeoutMilliseconds = options.timeoutMilliseconds || DEFAULT_DISCOVERY_TIMEOUT;
    const bindAddresses = options.bindAddress ? [options.bindAddress] : listLocalIpv4Addresses().map((entry) => entry.address);
    const foundByLocation = new Map();

    const searchOnAddress = (bindAddress) => new Promise((resolve) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        let finished = false;

        const finish = () => {
            if (finished === false) {
                finished = true;
                try { socket.close(); } catch (error) { void error; }
                resolve();
            }
        };

        socket.on('error', finish);

        socket.on('message', (message, remote) => {
            const headers = parseSsdpResponse(message.toString('utf8'));
            const location = headers.location;
            const searchTarget = headers.st || '';
            const looksLikeRenderer = searchTarget.includes('MediaRenderer') || (headers.server || '').length > 0;
            if (location && looksLikeRenderer && foundByLocation.has(location) === false) {
                foundByLocation.set(location, {
                    location,
                    address: remote.address,
                    usn: headers.usn || '',
                    server: headers.server || '',
                    searchTarget,
                    localAddress: bindAddress
                });
            }
        });

        socket.bind(0, bindAddress, () => {
            try {
                socket.setBroadcast(true);
                socket.setMulticastTTL(4);
            } catch (error) { void error; }
            const payload = Buffer.from(buildSearchMessage(MEDIA_RENDERER_SEARCH_TARGET));
            for (let attempt = 0; attempt < SEARCH_REPEAT_COUNT; attempt += 1) {
                setTimeout(() => {
                    try { socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS); } catch (error) { void error; }
                }, attempt * SEARCH_REPEAT_DELAY);
            }
            setTimeout(finish, timeoutMilliseconds);
        });
    });

    return Promise.all(bindAddresses.map(searchOnAddress)).then(() => Array.from(foundByLocation.values()));
}

module.exports = { discoverRenderers, resolveLocalAddressForPeer, listLocalIpv4Addresses };
