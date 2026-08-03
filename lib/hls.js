const PLAYLIST_HEADER_TAG = '#EXTM3U';
const SEGMENT_INFO_TAG = '#EXTINF:';
const INIT_SEGMENT_TAG = '#EXT-X-MAP';
const SEGMENT_DURATION_PRECISION = 6;
const DEFAULT_TARGET_DURATION = 10;
const EMPTY_STRING = '';
const FIRST_INDEX = 0;

const VIDEO_TRACK_NAME = 'video';
const AUDIO_TRACK_NAME = 'audio';

function computeTargetDuration(segments) {
    let longestSegment = 0;
    for (const segment of segments) {
        if (segment.duration > longestSegment) {
            longestSegment = segment.duration;
        }
    }
    return Math.ceil(longestSegment) || DEFAULT_TARGET_DURATION;
}

function buildMediaPlaylist(track, buildSegmentUrl, buildInitSegmentUrl) {
    const usesInitSegment = track.initSegmentUrl !== undefined && track.initSegmentUrl !== EMPTY_STRING;
    const lines = [
        PLAYLIST_HEADER_TAG,
        usesInitSegment ? '#EXT-X-VERSION:7' : '#EXT-X-VERSION:3',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        `#EXT-X-TARGETDURATION:${computeTargetDuration(track.segments)}`,
        '#EXT-X-MEDIA-SEQUENCE:0'
    ];
    if (usesInitSegment) {
        lines.push(`${INIT_SEGMENT_TAG}:URI="${buildInitSegmentUrl()}"`);
    }
    for (let index = FIRST_INDEX; index < track.segments.length; index += 1) {
        lines.push(`${SEGMENT_INFO_TAG}${track.segments[index].duration.toFixed(SEGMENT_DURATION_PRECISION)},`);
        lines.push(buildSegmentUrl(index));
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
}

function buildMasterPlaylist(publication, buildTrackPlaylistUrl) {
    const audioGroupIdentifier = 'capytv-audio';
    const lines = [
        PLAYLIST_HEADER_TAG,
        '#EXT-X-VERSION:3',
        '#EXT-X-INDEPENDENT-SEGMENTS'
    ];
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroupIdentifier}",NAME="Audio",`
        + `DEFAULT=YES,AUTOSELECT=YES,URI="${buildTrackPlaylistUrl(AUDIO_TRACK_NAME)}"`);
    const attributes = [`BANDWIDTH=${publication.estimatedBandwidth || 5000000}`];
    if (publication.height > 0 && publication.width > 0) {
        attributes.push(`RESOLUTION=${publication.width}x${publication.height}`);
    }
    attributes.push(`AUDIO="${audioGroupIdentifier}"`);
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`);
    lines.push(buildTrackPlaylistUrl(VIDEO_TRACK_NAME));
    return lines.join('\n');
}

function hasSeparateAudio(publication) {
    return publication.tracks !== undefined
        && publication.tracks.audio !== undefined
        && publication.tracks.audio !== null
        && Array.isArray(publication.tracks.audio.segments)
        && publication.tracks.audio.segments.length > 0;
}

function getTrack(publication, trackName) {
    if (trackName === AUDIO_TRACK_NAME) {
        return publication.tracks.audio || null;
    } else if (trackName === VIDEO_TRACK_NAME) {
        return publication.tracks.video || null;
    } else {
        return null;
    }
}

module.exports = {
    buildMediaPlaylist,
    buildMasterPlaylist,
    computeTargetDuration,
    hasSeparateAudio,
    getTrack,
    VIDEO_TRACK_NAME,
    AUDIO_TRACK_NAME
};
