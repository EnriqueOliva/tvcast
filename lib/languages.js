const ENGLISH = 'english';
const TURKISH = 'turkish';
const OTHER = 'other';
const EMPTY_STRING = '';
const SUBTITLE_OFF = '';
const COMBINING_MARK_PATTERN = /[̀-ͯ]/g;
const NON_LETTER_PATTERN = /[^a-z0-9]+/g;
const ENGLISH_RANK = 0;
const TURKISH_RANK = 1;
const OTHER_RANK = 2;

const ENGLISH_TOKENS = new Set(['en', 'eng', 'english', 'ingles', 'inglese', 'englisch', 'anglais']);
const TURKISH_TOKENS = new Set(['tr', 'tur', 'turkish', 'turkce', 'turco', 'turkisch']);

function foldToPlainLetters(text) {
    return String(text === undefined || text === null ? EMPTY_STRING : text)
        .normalize('NFD')
        .replace(COMBINING_MARK_PATTERN, EMPTY_STRING)
        .toLowerCase()
        .replace(NON_LETTER_PATTERN, ' ')
        .trim();
}

function tokenise(text) {
    const folded = foldToPlainLetters(text);
    if (folded === EMPTY_STRING) {
        return [];
    }
    return folded.split(' ');
}

function matchesAnyToken(candidates, tokenSet) {
    for (const candidate of candidates) {
        for (const token of tokenise(candidate)) {
            if (tokenSet.has(token)) {
                return true;
            }
        }
    }
    return false;
}

function classifyLanguage(identifier, displayName) {
    const candidates = [identifier, displayName];
    if (matchesAnyToken(candidates, ENGLISH_TOKENS)) {
        return ENGLISH;
    } else if (matchesAnyToken(candidates, TURKISH_TOKENS)) {
        return TURKISH;
    } else {
        return OTHER;
    }
}

function rankOf(classification) {
    if (classification === ENGLISH) {
        return ENGLISH_RANK;
    } else if (classification === TURKISH) {
        return TURKISH_RANK;
    } else {
        return OTHER_RANK;
    }
}

function readTrackIdentifier(track) {
    if (track.identifier !== undefined) {
        return track.identifier;
    }
    return track.id;
}

function classifyTrack(track) {
    return classifyLanguage(readTrackIdentifier(track), track.language);
}

function orderSubtitleTracks(tracks) {
    const decorated = (tracks || []).map((track, position) => ({
        track,
        position,
        rank: rankOf(classifyTrack(track))
    }));
    decorated.sort((left, right) => {
        if (left.rank !== right.rank) {
            return left.rank - right.rank;
        }
        return left.position - right.position;
    });
    return decorated.map((entry) => entry.track);
}

function pickDefaultSubtitleId(tracks) {
    const ordered = orderSubtitleTracks(tracks);
    if (ordered.length === 0) {
        return SUBTITLE_OFF;
    }
    return readTrackIdentifier(ordered[0]);
}

module.exports = {
    ENGLISH,
    TURKISH,
    OTHER,
    classifyLanguage,
    classifyTrack,
    orderSubtitleTracks,
    pickDefaultSubtitleId
};
