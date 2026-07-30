const AV_TRANSPORT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERING_CONTROL_SERVICE = 'urn:schemas-upnp-org:service:RenderingControl:1';
const DEFAULT_INSTANCE_ID = '0';
const MASTER_CHANNEL = 'Master';
const SOAP_TIMEOUT_MILLISECONDS = 8000;
const DLNA_STREAMING_FLAGS = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function extractTagValue(xmlText, tagName) {
    const pattern = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tagName}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tagName}>`, 'i');
    const match = xmlText.match(pattern);
    if (match) {
        return match[1].trim();
    }
    return '';
}

function extractServiceBlocks(xmlText) {
    const blocks = [];
    const pattern = /<service>([\s\S]*?)<\/service>/gi;
    let match = pattern.exec(xmlText);
    while (match !== null) {
        blocks.push(match[1]);
        match = pattern.exec(xmlText);
    }
    return blocks;
}

function resolveAbsoluteUrl(baseLocation, relativePath) {
    if (/^https?:\/\//i.test(relativePath)) {
        return relativePath;
    }
    const base = new URL(baseLocation);
    if (relativePath.startsWith('/')) {
        return `${base.protocol}//${base.host}${relativePath}`;
    }
    return `${base.protocol}//${base.host}/${relativePath}`;
}

async function fetchDeviceProfile(location) {
    const response = await fetch(location, { signal: AbortSignal.timeout(SOAP_TIMEOUT_MILLISECONDS) });
    const xmlText = await response.text();
    const friendlyName = extractTagValue(xmlText, 'friendlyName') || 'Unknown renderer';
    const manufacturer = extractTagValue(xmlText, 'manufacturer');
    const uniqueDeviceName = extractTagValue(xmlText, 'UDN');
    const services = {};
    for (const block of extractServiceBlocks(xmlText)) {
        const serviceType = extractTagValue(block, 'serviceType');
        const controlPath = extractTagValue(block, 'controlURL');
        if (serviceType && controlPath) {
            services[serviceType] = resolveAbsoluteUrl(location, controlPath);
        }
    }
    return {
        id: uniqueDeviceName || location,
        friendlyName,
        manufacturer,
        location,
        address: new URL(location).hostname,
        avTransportUrl: services[AV_TRANSPORT_SERVICE] || '',
        renderingControlUrl: services[RENDERING_CONTROL_SERVICE] || ''
    };
}

async function sendSoapAction(controlUrl, serviceType, actionName, actionArguments) {
    const argumentXml = Object.entries(actionArguments)
        .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
        .join('');
    const body = `<?xml version="1.0" encoding="utf-8"?>`
        + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
        + `<s:Body><u:${actionName} xmlns:u="${serviceType}">${argumentXml}</u:${actionName}></s:Body></s:Envelope>`;

    const response = await fetch(controlUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            'SOAPAction': `"${serviceType}#${actionName}"`,
            'Connection': 'close'
        },
        body,
        signal: AbortSignal.timeout(SOAP_TIMEOUT_MILLISECONDS)
    });

    const responseText = await response.text();
    if (response.ok === false) {
        const errorDescription = extractTagValue(responseText, 'errorDescription');
        const errorCode = extractTagValue(responseText, 'errorCode');
        throw new Error(`${actionName} failed (HTTP ${response.status}) ${errorCode} ${errorDescription}`.trim());
    }
    return responseText;
}

function buildDidlMetadata(item) {
    const mediaUrl = escapeXml(item.mediaUrl);
    const title = escapeXml(item.title);
    const protocolInfo = `http-get:*:${item.mimeType}:${DLNA_STREAMING_FLAGS}`;
    const sizeAttribute = item.sizeBytes ? ` size="${item.sizeBytes}"` : '';
    const durationAttribute = item.duration ? ` duration="${item.duration}"` : '';
    const subtitleParts = [];
    if (item.subtitleUrl) {
        const subtitleUrl = escapeXml(item.subtitleUrl);
        subtitleParts.push(`<res protocolInfo="http-get:*:text/srt:*">${subtitleUrl}</res>`);
        subtitleParts.push(`<sec:CaptionInfoEx sec:type="srt">${subtitleUrl}</sec:CaptionInfoEx>`);
        subtitleParts.push(`<sec:CaptionInfo sec:type="srt">${subtitleUrl}</sec:CaptionInfo>`);
        subtitleParts.push(`<pv:subtitleFileUri>${subtitleUrl}</pv:subtitleFileUri>`);
        subtitleParts.push(`<pv:subtitleFileType>srt</pv:subtitleFileType>`);
    }
    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"`
        + ` xmlns:dc="http://purl.org/dc/elements/1.1/"`
        + ` xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"`
        + ` xmlns:sec="http://www.sec.co.kr/"`
        + ` xmlns:pv="http://www.pv.com/pvns/">`
        + `<item id="tvcast-item" parentID="0" restricted="1">`
        + `<dc:title>${title}</dc:title>`
        + `<upnp:class>object.item.videoItem</upnp:class>`
        + `<res protocolInfo="${protocolInfo}"${sizeAttribute}${durationAttribute}>${mediaUrl}</res>`
        + subtitleParts.join('')
        + `</item></DIDL-Lite>`;
}

async function setTransportUri(device, item) {
    await sendSoapAction(device.avTransportUrl, AV_TRANSPORT_SERVICE, 'SetAVTransportURI', {
        InstanceID: DEFAULT_INSTANCE_ID,
        CurrentURI: item.mediaUrl,
        CurrentURIMetaData: buildDidlMetadata(item)
    });
}

async function play(device) {
    await sendSoapAction(device.avTransportUrl, AV_TRANSPORT_SERVICE, 'Play', {
        InstanceID: DEFAULT_INSTANCE_ID,
        Speed: '1'
    });
}

async function pause(device) {
    await sendSoapAction(device.avTransportUrl, AV_TRANSPORT_SERVICE, 'Pause', { InstanceID: DEFAULT_INSTANCE_ID });
}

async function stop(device) {
    await sendSoapAction(device.avTransportUrl, AV_TRANSPORT_SERVICE, 'Stop', { InstanceID: DEFAULT_INSTANCE_ID });
}

function formatClockTime(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function parseClockTime(clockText) {
    if (!clockText || clockText === 'NOT_IMPLEMENTED') {
        return 0;
    }
    const parts = clockText.split(':').map((part) => Number(part.split('.')[0]) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return 0;
}

async function seekToSeconds(device, seconds) {
    await sendSoapAction(device.avTransportUrl, AV_TRANSPORT_SERVICE, 'Seek', {
        InstanceID: DEFAULT_INSTANCE_ID,
        Unit: 'REL_TIME',
        Target: formatClockTime(seconds)
    });
}

async function getPositionInfo(device) {
    const responseText = await sendSoapAction(device.avTransportUrl, AV_TRANSPORT_SERVICE, 'GetPositionInfo', {
        InstanceID: DEFAULT_INSTANCE_ID
    });
    return {
        positionSeconds: parseClockTime(extractTagValue(responseText, 'RelTime')),
        durationSeconds: parseClockTime(extractTagValue(responseText, 'TrackDuration')),
        trackUri: extractTagValue(responseText, 'TrackURI')
    };
}

async function getTransportInfo(device) {
    const responseText = await sendSoapAction(device.avTransportUrl, AV_TRANSPORT_SERVICE, 'GetTransportInfo', {
        InstanceID: DEFAULT_INSTANCE_ID
    });
    return {
        state: extractTagValue(responseText, 'CurrentTransportState') || 'UNKNOWN',
        status: extractTagValue(responseText, 'CurrentTransportStatus') || ''
    };
}

async function getVolume(device) {
    if (device.renderingControlUrl === '') {
        return null;
    }
    const responseText = await sendSoapAction(device.renderingControlUrl, RENDERING_CONTROL_SERVICE, 'GetVolume', {
        InstanceID: DEFAULT_INSTANCE_ID,
        Channel: MASTER_CHANNEL
    });
    return Number(extractTagValue(responseText, 'CurrentVolume')) || 0;
}

async function setVolume(device, volumeLevel) {
    await sendSoapAction(device.renderingControlUrl, RENDERING_CONTROL_SERVICE, 'SetVolume', {
        InstanceID: DEFAULT_INSTANCE_ID,
        Channel: MASTER_CHANNEL,
        DesiredVolume: String(Math.max(0, Math.min(100, Math.round(volumeLevel))))
    });
}

module.exports = {
    fetchDeviceProfile,
    setTransportUri,
    play,
    pause,
    stop,
    seekToSeconds,
    getPositionInfo,
    getTransportInfo,
    getVolume,
    setVolume,
    formatClockTime,
    buildDidlMetadata,
    escapeXml,
    parseClockTime,
    DLNA_STREAMING_FLAGS
};
