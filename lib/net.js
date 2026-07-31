const os = require('node:os');

const LOOPBACK_ADDRESS = '127.0.0.1';
const PRIVATE_PREFIX = '192.168.';

function listLocalIpv4Addresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && entry.internal === false) {
                addresses.push({ name, address: entry.address, netmask: entry.netmask });
            }
        }
    }
    return addresses;
}

function resolveLanAddress() {
    const addresses = listLocalIpv4Addresses();
    const preferred = addresses.find((entry) => entry.address.startsWith(PRIVATE_PREFIX));
    if (preferred !== undefined) {
        return preferred.address;
    }
    if (addresses.length > 0) {
        return addresses[0].address;
    }
    return LOOPBACK_ADDRESS;
}

module.exports = { listLocalIpv4Addresses, resolveLanAddress, LOOPBACK_ADDRESS };
